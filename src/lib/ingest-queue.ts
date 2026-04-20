import { readFile, writeFile } from "@/commands/fs"
import { autoIngest } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath, isAbsolutePath } from "@/lib/path-utils"

// ── Types ─────────────────────────────────────────────────────────────────

export interface IngestTask {
  id: string
  sourcePath: string  // relative to project: "raw/sources/folder/file.pdf"
  folderContext: string  // e.g. "AI-Research > papers" or ""
  status: "pending" | "processing" | "done" | "failed"
  addedAt: number
  error: string | null
  retryCount: number
}

// ── State ─────────────────────────────────────────────────────────────────

let queue: IngestTask[] = []
let processing = false
let currentProjectPath = ""
let currentAbortController: AbortController | null = null
let lastWrittenFiles: string[] = []  // track files written by current ingest for cleanup
// Track whether any task has been processed since the last drain.
// Prevents the sweep from running on every idle/no-op call.
let processedSinceDrain = false
// Abort controller for the review-sweep LLM call so switching projects
// cancels a long-running judgment instead of burning tokens.
let sweepAbortController: AbortController | null = null

// ── Persistence ───────────────────────────────────────────────────────────

function queueFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-queue.json`
}

async function saveQueue(projectPath: string): Promise<void> {
  try {
    // Only save pending and failed tasks (done tasks are removed)
    const toSave = queue.filter((t) => t.status !== "done")
    await writeFile(queueFilePath(projectPath), JSON.stringify(toSave, null, 2))
  } catch {
    // non-critical
  }
}

async function loadQueue(projectPath: string): Promise<IngestTask[]> {
  try {
    const raw = await readFile(queueFilePath(projectPath))
    return JSON.parse(raw) as IngestTask[]
  } catch {
    return []
  }
}

// ── Queue Operations ──────────────────────────────────────────────────────

function generateId(): string {
  return `ingest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Add a file to the ingest queue.
 */
export async function enqueueIngest(
  projectPath: string,
  sourcePath: string,
  folderContext: string = "",
): Promise<string> {
  const pp = normalizePath(projectPath)
  currentProjectPath = pp

  const task: IngestTask = {
    id: generateId(),
    sourcePath,
    folderContext,
    status: "pending",
    addedAt: Date.now(),
    error: null,
    retryCount: 0,
  }

  queue.push(task)
  await saveQueue(pp)

  // Start processing if not already running
  processNext(pp)

  return task.id
}

/**
 * Add multiple files to the queue at once.
 */
export async function enqueueBatch(
  projectPath: string,
  files: Array<{ sourcePath: string; folderContext: string }>,
): Promise<string[]> {
  const pp = normalizePath(projectPath)
  currentProjectPath = pp
  const ids: string[] = []

  for (const file of files) {
    const task: IngestTask = {
      id: generateId(),
      sourcePath: file.sourcePath,
      folderContext: file.folderContext,
      status: "pending",
      addedAt: Date.now(),
      error: null,
      retryCount: 0,
    }
    queue.push(task)
    ids.push(task.id)
  }

  await saveQueue(pp)
  console.log(`[Ingest Queue] Enqueued ${files.length} files`)
  processNext(pp)

  return ids
}

/**
 * Retry a failed task.
 */
export async function retryTask(projectPath: string, taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return

  task.status = "pending"
  task.error = null
  await saveQueue(projectPath)
  processNext(normalizePath(projectPath))
}

/**
 * Cancel a pending or processing task.
 * If processing, aborts the LLM call and cleans up generated files.
 */
export async function cancelTask(projectPath: string, taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return

  if (task.status === "processing") {
    // Abort the in-progress LLM call
    if (currentAbortController) {
      currentAbortController.abort()
      currentAbortController = null
    }

    // Clean up any files written by the interrupted ingest
    if (lastWrittenFiles.length > 0) {
      const { deleteFile } = await import("@/commands/fs")
      for (const filePath of lastWrittenFiles) {
        try {
          const fullPath = isAbsolutePath(filePath)
            ? normalizePath(filePath)
            : `${normalizePath(projectPath)}/${filePath}`
          await deleteFile(fullPath)
        } catch {
          // file may not exist
        }
      }
      console.log(`[Ingest Queue] Cleaned up ${lastWrittenFiles.length} files from cancelled task`)
      lastWrittenFiles = []
    }

    processing = false
  }

  queue = queue.filter((t) => t.id !== taskId)
  await saveQueue(projectPath)
  console.log(`[Ingest Queue] Cancelled: ${task.sourcePath}`)

  // Continue with next task
  processNext(normalizePath(projectPath))
}

/**
 * Clear all done/failed tasks from the queue.
 */
export async function clearCompletedTasks(projectPath: string): Promise<void> {
  queue = queue.filter((t) => t.status === "pending" || t.status === "processing")
  await saveQueue(projectPath)
}

/**
 * Cancel everything that's not finished: aborts the running task (if any),
 * cleans up its partial output, and drops every pending + processing item.
 *
 * Failed tasks are retained so the user can still see / retry them.
 * Returns the number of tasks removed from the queue.
 */
export async function cancelAllTasks(projectPath: string): Promise<number> {
  const pp = normalizePath(projectPath)

  // Abort any in-progress LLM call first so it stops burning tokens.
  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
  }
  processing = false

  // Clean up partial files from the task that was processing, if any.
  if (lastWrittenFiles.length > 0) {
    const { deleteFile } = await import("@/commands/fs")
    for (const filePath of lastWrittenFiles) {
      try {
        const fullPath = isAbsolutePath(filePath)
          ? normalizePath(filePath)
          : `${pp}/${filePath}`
        await deleteFile(fullPath)
      } catch {
        // file may not exist
      }
    }
    lastWrittenFiles = []
  }

  const before = queue.length
  queue = queue.filter((t) => t.status === "failed")
  const removed = before - queue.length

  await saveQueue(pp)
  console.log(`[Ingest Queue] Cancelled all: ${removed} tasks removed`)
  return removed
}

/**
 * Get current queue state.
 */
export function getQueue(): readonly IngestTask[] {
  return queue
}

/**
 * Get queue summary.
 */
export function getQueueSummary(): { pending: number; processing: number; failed: number; total: number } {
  return {
    pending: queue.filter((t) => t.status === "pending").length,
    processing: queue.filter((t) => t.status === "processing").length,
    failed: queue.filter((t) => t.status === "failed").length,
    total: queue.length,
  }
}

/**
 * Clear all in-memory queue state without touching disk.
 * Called when switching projects to prevent cross-project contamination.
 */
export function clearQueueState(): void {
  // Abort any in-progress ingest
  if (currentAbortController) {
    currentAbortController.abort()
  }
  // Abort any in-progress review sweep LLM call
  if (sweepAbortController) {
    sweepAbortController.abort()
  }
  queue = []
  processing = false
  currentProjectPath = ""
  currentAbortController = null
  sweepAbortController = null
  lastWrittenFiles = []
  processedSinceDrain = false
}

// ── Restore on startup ───────────────────────────────────────────────────

/**
 * Load queue from disk and resume processing.
 * Called on app startup.
 */
export async function restoreQueue(projectPath: string): Promise<void> {
  const pp = normalizePath(projectPath)
  // Always reset in-memory state FIRST to prevent cross-project contamination
  queue = []
  processing = false
  currentAbortController = null
  lastWrittenFiles = []
  currentProjectPath = pp

  const saved = await loadQueue(pp)

  if (saved.length === 0) return

  // Reset any "processing" tasks back to "pending" (interrupted by app close)
  let restored = 0
  for (const task of saved) {
    if (task.status === "processing") {
      task.status = "pending"
      restored++
    }
  }

  queue = saved
  await saveQueue(pp)

  const pending = queue.filter((t) => t.status === "pending").length
  const failed = queue.filter((t) => t.status === "failed").length

  if (pending > 0 || restored > 0) {
    console.log(`[Ingest Queue] Restored: ${pending} pending, ${failed} failed, ${restored} resumed from interrupted`)
    processNext(pp)
  }
}

// ── Processing ────────────────────────────────────────────────────────────

const MAX_RETRIES = 3

async function onQueueDrained(projectPath: string): Promise<void> {
  if (!processedSinceDrain) return
  processedSinceDrain = false

  sweepAbortController = new AbortController()
  const signal = sweepAbortController.signal

  try {
    const { sweepResolvedReviews } = await import("@/lib/sweep-reviews")
    await sweepResolvedReviews(projectPath, signal)
  } catch (err) {
    console.error("[Ingest Queue] Failed to load sweep-reviews:", err)
  } finally {
    if (sweepAbortController && sweepAbortController.signal === signal) {
      sweepAbortController = null
    }
  }
}

async function processNext(projectPath: string): Promise<void> {
  if (processing) return

  const next = queue.find((t) => t.status === "pending")
  if (!next) {
    // Queue drained — trigger review cleanup (auto-resolve stale items)
    onQueueDrained(projectPath).catch((err) =>
      console.error("[Ingest Queue] sweep failed:", err)
    )
    return
  }

  processing = true
  next.status = "processing"
  await saveQueue(projectPath)

  const pp = normalizePath(projectPath)
  const llmConfig = useWikiStore.getState().llmConfig

  // Check if LLM is configured
  if (!llmConfig.apiKey && llmConfig.provider !== "ollama" && llmConfig.provider !== "custom") {
    next.status = "failed"
    next.error = "LLM not configured — set API key in Settings"
    processing = false
    await saveQueue(pp)
    processNext(pp)
    return
  }

  const fullSourcePath = isAbsolutePath(next.sourcePath)
    ? normalizePath(next.sourcePath)
    : `${pp}/${next.sourcePath}`

  console.log(`[Ingest Queue] Processing: ${next.sourcePath} (${queue.filter((t) => t.status === "pending").length} remaining)`)

  // Create abort controller for this task
  currentAbortController = new AbortController()
  lastWrittenFiles = []

  try {
    const writtenFiles = await autoIngest(pp, fullSourcePath, llmConfig, currentAbortController.signal, next.folderContext)
    lastWrittenFiles = writtenFiles

    // Success: remove from queue
    currentAbortController = null
    lastWrittenFiles = []
    queue = queue.filter((t) => t.id !== next.id)
    processedSinceDrain = true
    await saveQueue(pp)

    console.log(`[Ingest Queue] Done: ${next.sourcePath}`)
  } catch (err) {
    currentAbortController = null
    const message = err instanceof Error ? err.message : String(err)
    next.retryCount++
    next.error = message

    if (next.retryCount >= MAX_RETRIES) {
      next.status = "failed"
      console.log(`[Ingest Queue] Failed (${next.retryCount}x): ${next.sourcePath} — ${message}`)
    } else {
      next.status = "pending" // will retry
      console.log(`[Ingest Queue] Error (retry ${next.retryCount}/${MAX_RETRIES}): ${next.sourcePath} — ${message}`)
    }

    await saveQueue(pp)
  }

  processing = false
  processNext(pp)
}
