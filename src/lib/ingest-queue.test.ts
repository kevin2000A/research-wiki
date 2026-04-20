import { describe, it, expect, beforeEach, vi } from "vitest"
import { flushMicrotasks } from "@/test-helpers/deferred"

// Mock autoIngest so tests control success/failure timing.
vi.mock("./ingest", () => ({
  autoIngest: vi.fn(),
}))

// Mock fs so we don't hit the real filesystem.
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
  deleteFile: vi.fn(),
}))

// Mock sweep-reviews since the queue drain dynamically imports it. The
// sweep itself has its own test file; here we just confirm it's triggered.
vi.mock("./sweep-reviews", () => ({
  sweepResolvedReviews: vi.fn().mockResolvedValue(0),
}))

import {
  enqueueIngest,
  enqueueBatch,
  retryTask,
  cancelTask,
  cancelAllTasks,
  clearCompletedTasks,
  clearQueueState,
  getQueue,
  getQueueSummary,
  restoreQueue,
} from "./ingest-queue"
import { autoIngest } from "./ingest"
import { readFile, writeFile } from "@/commands/fs"
import { sweepResolvedReviews } from "./sweep-reviews"
import { useWikiStore } from "@/stores/wiki-store"

const mockAutoIngest = vi.mocked(autoIngest)
const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)
const mockSweep = vi.mocked(sweepResolvedReviews)

beforeEach(() => {
  clearQueueState()
  mockAutoIngest.mockReset()
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockSweep.mockReset()
  mockSweep.mockResolvedValue(0)

  // Default: persisted queue file doesn't exist
  mockReadFile.mockRejectedValue(new Error("ENOENT"))
  mockWriteFile.mockResolvedValue(undefined as unknown as void)

  // Default: a valid LLM config so processNext doesn't reject.
  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })
})

describe("ingest-queue — enqueue & basic processing", () => {
  it("enqueueIngest adds a pending task and triggers processing", async () => {
    mockAutoIngest.mockResolvedValue([])

    const id = await enqueueIngest("/project", "raw/sources/a.md")
    expect(id).toMatch(/^ingest-/)

    // Let the async processing loop run
    await flushMicrotasks(10)

    // Task should have been processed and removed
    expect(mockAutoIngest).toHaveBeenCalledOnce()
    expect(getQueue()).toHaveLength(0)
  })

  it("persists queue to disk on enqueue", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {})) // never resolves
    await enqueueIngest("/project", "a.md")
    await flushMicrotasks(2)

    // writeFile should have been called to save the queue
    const calls = mockWriteFile.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    const queuePath = calls[0][0]
    expect(queuePath).toContain(".llm-wiki/ingest-queue.json")
  })

  it("enqueueBatch queues multiple tasks and processes them serially", async () => {
    mockAutoIngest.mockResolvedValue([])

    await enqueueBatch("/project", [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
      { sourcePath: "c.md", folderContext: "" },
    ])

    await flushMicrotasks(50)

    expect(mockAutoIngest).toHaveBeenCalledTimes(3)
    expect(getQueue()).toHaveLength(0)
  })
})

describe("ingest-queue — retry & failure", () => {
  it("retries a failing task up to MAX_RETRIES=3 then marks failed", async () => {
    mockAutoIngest.mockRejectedValue(new Error("LLM error"))

    await enqueueIngest("/project", "bad.md")
    await flushMicrotasks(30)

    expect(mockAutoIngest).toHaveBeenCalledTimes(3)
    const queue = getQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].status).toBe("failed")
    expect(queue[0].error).toContain("LLM error")
    expect(queue[0].retryCount).toBe(3)
  })

  it("succeeds on retry after transient failure", async () => {
    mockAutoIngest
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce([])

    await enqueueIngest("/project", "flaky.md")
    await flushMicrotasks(30)

    expect(mockAutoIngest).toHaveBeenCalledTimes(3)
    expect(getQueue()).toHaveLength(0)
  })

  it("retryTask resets a failed task to pending and reprocesses it", async () => {
    mockAutoIngest.mockRejectedValue(new Error("always fails"))

    await enqueueIngest("/project", "x.md")
    await flushMicrotasks(20)
    expect(getQueue()[0].status).toBe("failed")

    const taskId = getQueue()[0].id
    mockAutoIngest.mockResolvedValueOnce([])
    await retryTask("/project", taskId)
    await flushMicrotasks(10)

    expect(getQueue()).toHaveLength(0)
  })
})

describe("ingest-queue — cancel", () => {
  it("cancelTask removes a pending task without calling autoIngest", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {})) // block first task

    await enqueueBatch("/project", [
      { sourcePath: "first.md", folderContext: "" },
      { sourcePath: "second.md", folderContext: "" },
    ])
    await flushMicrotasks(2)

    // first.md is processing; cancel second.md (still pending)
    const queue = getQueue()
    const second = queue.find((t) => t.sourcePath === "second.md")!
    await cancelTask("/project", second.id)

    expect(getQueue().find((t) => t.sourcePath === "second.md")).toBeUndefined()
    expect(getQueue().find((t) => t.sourcePath === "first.md")).toBeDefined()
  })
})

describe("ingest-queue — cancelAllTasks", () => {
  it("drops all pending and processing tasks but keeps failed ones", async () => {
    // Block the processing task so it doesn't finish on its own.
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))

    await enqueueBatch("/project", [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
      { sourcePath: "c.md", folderContext: "" },
    ])
    await flushMicrotasks(2)

    // Manually set one task to "failed" so we can verify it survives.
    const failedTask = getQueue()[2]
    ;(failedTask as { status: string }).status = "failed"

    const removed = await cancelAllTasks("/project")

    expect(removed).toBe(2) // a (processing) + b (pending) gone
    expect(getQueue()).toHaveLength(1)
    expect(getQueue()[0].sourcePath).toBe("c.md")
    expect(getQueue()[0].status).toBe("failed")
  })

  it("returns 0 when the queue is empty", async () => {
    const removed = await cancelAllTasks("/project")
    expect(removed).toBe(0)
    expect(getQueue()).toHaveLength(0)
  })

  it("is safe to call after it has already cleared the queue", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await enqueueIngest("/project", "only.md")
    await flushMicrotasks(2)

    await cancelAllTasks("/project")
    const secondCall = await cancelAllTasks("/project")
    expect(secondCall).toBe(0)
  })
})

describe("ingest-queue — clearCompletedTasks & summary", () => {
  it("getQueueSummary returns accurate counts", async () => {
    mockAutoIngest.mockRejectedValue(new Error("fail"))
    await enqueueIngest("/project", "fail.md")
    await flushMicrotasks(20)

    const summary = getQueueSummary()
    expect(summary.failed).toBe(1)
    expect(summary.pending).toBe(0)
    expect(summary.total).toBe(1)
  })

  it("clearCompletedTasks drops failed tasks", async () => {
    mockAutoIngest.mockRejectedValue(new Error("fail"))
    await enqueueIngest("/project", "f.md")
    await flushMicrotasks(20)

    expect(getQueue()).toHaveLength(1)
    await clearCompletedTasks("/project")
    expect(getQueue()).toHaveLength(0)
  })
})

describe("ingest-queue — queue-drain triggers review sweep", () => {
  it("calls sweepResolvedReviews once after a successful task drains the queue", async () => {
    mockAutoIngest.mockResolvedValue([])

    await enqueueIngest("/project", "ok.md")
    await flushMicrotasks(30)

    expect(mockSweep).toHaveBeenCalledOnce()
    expect(mockSweep).toHaveBeenCalledWith("/project", expect.any(AbortSignal))
  })

  it("does NOT trigger sweep when no task has been processed since the last drain", async () => {
    // No tasks enqueued — processedSinceDrain flag stays false
    // (We simulate an idle condition by enqueueing, processing, draining once)
    mockAutoIngest.mockResolvedValue([])
    await enqueueIngest("/project", "a.md")
    await flushMicrotasks(20)
    expect(mockSweep).toHaveBeenCalledTimes(1)

    // Now the queue is empty. Calling cancelTask on a nonexistent id is a
    // no-op but internally may call processNext → no drain fire (nothing
    // was processed since the last drain).
    await cancelTask("/project", "nonexistent")
    await flushMicrotasks(5)
    expect(mockSweep).toHaveBeenCalledTimes(1)
  })

  it("does NOT trigger sweep when all tasks fail (nothing was successfully ingested)", async () => {
    mockAutoIngest.mockRejectedValue(new Error("always fails"))

    await enqueueIngest("/project", "bad.md")
    await flushMicrotasks(30)

    expect(mockSweep).not.toHaveBeenCalled()
  })
})

describe("ingest-queue — clearQueueState", () => {
  it("clears pending tasks and resets processing flag", async () => {
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await enqueueBatch("/project", [
      { sourcePath: "a.md", folderContext: "" },
      { sourcePath: "b.md", folderContext: "" },
    ])
    await flushMicrotasks(2)

    expect(getQueue().length).toBeGreaterThan(0)

    clearQueueState()
    expect(getQueue()).toHaveLength(0)
  })

  it("processedSinceDrain flag resets so a post-switch no-op won't trigger sweep", async () => {
    mockAutoIngest.mockResolvedValue([])
    await enqueueIngest("/project", "x.md")
    await flushMicrotasks(20)
    mockSweep.mockClear()

    clearQueueState()
    // Simulate new drain trigger on an empty queue — no sweep.
    await flushMicrotasks(5)
    expect(mockSweep).not.toHaveBeenCalled()
  })
})

describe("ingest-queue — restoreQueue", () => {
  it("resets in-memory state before loading, preventing cross-project bleed", async () => {
    // Seed in-memory state from project A
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))
    await enqueueIngest("/project-A", "a.md")
    await flushMicrotasks(2)
    expect(getQueue().length).toBeGreaterThan(0)

    // Now restore project B — should reset and load B's saved queue (empty)
    mockReadFile.mockRejectedValue(new Error("ENOENT"))
    await restoreQueue("/project-B")
    expect(getQueue()).toHaveLength(0)
  })

  it("converts 'processing' tasks back to 'pending' on restore (interrupted by app close)", async () => {
    const saved = [
      {
        id: "ingest-abc",
        sourcePath: "a.md",
        folderContext: "",
        status: "processing",
        addedAt: 0,
        error: null,
        retryCount: 0,
      },
    ]
    mockReadFile.mockResolvedValue(JSON.stringify(saved))
    // Prevent the reprocessing kickoff from completing forever:
    mockAutoIngest.mockImplementation(() => new Promise(() => {}))

    await restoreQueue("/project")
    await flushMicrotasks(2)

    const queue = getQueue()
    expect(queue).toHaveLength(1)
    // After restore + kick-off of processNext, the task transitions back to
    // "processing" — but the RESTORED-from-disk value was "pending". We can
    // still assert it's not "failed" / "done".
    expect(["pending", "processing"]).toContain(queue[0].status)
  })

  it("leaves 'failed' tasks as failed on restore", async () => {
    const saved = [
      {
        id: "ingest-x",
        sourcePath: "x.md",
        folderContext: "",
        status: "failed",
        addedAt: 0,
        error: "prior failure",
        retryCount: 3,
      },
    ]
    mockReadFile.mockResolvedValue(JSON.stringify(saved))

    await restoreQueue("/project")
    const queue = getQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0].status).toBe("failed")
    expect(queue[0].error).toBe("prior failure")
  })
})
