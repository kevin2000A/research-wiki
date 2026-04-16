const API_URL = "http://127.0.0.1:19827";
const QUEUE_STORAGE_KEY = "llmWikiPaperQueueV1";
const QUEUE_ALARM = "llmWikiPaperQueueTick";

let processing = false;

function now() {
  return Date.now();
}

function parseArxivInput(value) {
  const text = (value || "").trim();
  if (!text) return "";
  const decoded = decodeURIComponent(text);
  const oldMatch = decoded.match(/([a-z-]+(?:\.[a-z]+)?\/\d{7}(?:v\d+)?)/i);
  if (oldMatch) return oldMatch[1];
  const newMatch = decoded.match(/(\d{4}\.\d{4,5}(?:v\d+)?)/i);
  return newMatch ? newMatch[1] : "";
}

function encodeArxivPath(arxivId) {
  return arxivId
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function safeArxivFileStem(arxivId) {
  return arxivId.replace(/[^A-Za-z0-9._-]/g, "-");
}

function queueTaskKey(task) {
  return `${task.projectPath}::${task.arxivId}`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function storageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result[key]);
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function createAlarm(name, when) {
  chrome.alarms.create(name, { when });
  return Promise.resolve();
}

function sendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response || null);
    });
  });
}

function emptyQueueState() {
  return { tasks: [] };
}

function normalizeTask(task) {
  return {
    id: typeof task?.id === "string" ? task.id : `paper-${now()}-${Math.random().toString(36).slice(2, 8)}`,
    arxivId: parseArxivInput(task?.arxivId || ""),
    projectPath: typeof task?.projectPath === "string" ? task.projectPath : "",
    projectName: typeof task?.projectName === "string" ? task.projectName : "",
    status: typeof task?.status === "string" ? task.status : "queued",
    statusText: typeof task?.statusText === "string" ? task.statusText : "Queued",
    error: typeof task?.error === "string" ? task.error : "",
    createdAt: typeof task?.createdAt === "number" ? task.createdAt : now(),
    updatedAt: typeof task?.updatedAt === "number" ? task.updatedAt : now(),
    attemptCount: typeof task?.attemptCount === "number" ? task.attemptCount : 0,
    artifactKind: typeof task?.artifactKind === "string" ? task.artifactKind : "",
    fileName: typeof task?.fileName === "string" ? task.fileName : "",
    paperPath: typeof task?.paperPath === "string" ? task.paperPath : "",
  };
}

async function getQueueState() {
  const stored = await storageGet(QUEUE_STORAGE_KEY);
  if (!stored || !Array.isArray(stored.tasks)) return emptyQueueState();
  return {
    tasks: stored.tasks
      .map(normalizeTask)
      .filter((task) => task.arxivId && task.projectPath),
  };
}

async function saveQueueState(state) {
  const normalized = { tasks: state.tasks.map(normalizeTask) };
  await storageSet({ [QUEUE_STORAGE_KEY]: normalized });
  await sendRuntimeMessage({ type: "paperQueueUpdated", tasks: normalized.tasks });
}

async function scheduleQueue(delayMs = 100) {
  await createAlarm(QUEUE_ALARM, Date.now() + Math.max(1, delayMs));
}

async function resetInterruptedTasks() {
  const state = await getQueueState();
  let changed = false;
  for (const task of state.tasks) {
    if (task.status === "fetching" || task.status === "saving") {
      task.status = "queued";
      task.statusText = "Queued after worker restart";
      task.error = "";
      task.updatedAt = now();
      changed = true;
    }
  }
  if (changed) {
    await saveQueueState(state);
  }
  if (state.tasks.some((task) => task.status === "queued")) {
    await scheduleQueue(100);
  }
}

async function updateTask(taskId, updater) {
  const state = await getQueueState();
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return null;
  updater(task, state.tasks);
  task.updatedAt = now();
  await saveQueueState(state);
  return task;
}

async function enqueuePaperTask(payload) {
  const arxivId = parseArxivInput(payload?.arxivId || "");
  const projectPath = (payload?.projectPath || "").trim();
  const projectName = (payload?.projectName || "").trim();
  if (!arxivId) throw new Error("Invalid arXiv ID");
  if (!projectPath) throw new Error("projectPath is required");

  const state = await getQueueState();
  const duplicate = state.tasks.find((task) => queueTaskKey(task) === `${projectPath}::${arxivId}`);
  if (duplicate) {
    return { ok: true, added: false, duplicate: true, task: duplicate, tasks: state.tasks };
  }

  const task = normalizeTask({
    id: `paper-${now()}-${Math.random().toString(36).slice(2, 8)}`,
    arxivId,
    projectPath,
    projectName,
    status: "queued",
    statusText: "Queued",
    error: "",
    createdAt: now(),
    updatedAt: now(),
    attemptCount: 0,
    artifactKind: "",
    fileName: "",
    paperPath: "",
  });

  state.tasks.push(task);
  await saveQueueState(state);
  await scheduleQueue(50);
  return { ok: true, added: true, duplicate: false, task, tasks: state.tasks };
}

async function retryPaperTask(taskId) {
  const task = await updateTask(taskId, (item) => {
    item.status = "queued";
    item.statusText = "Queued";
    item.error = "";
    item.paperPath = "";
  });
  if (!task) throw new Error("Task not found");
  await scheduleQueue(50);
  return { ok: true, task };
}

async function removePaperTask(taskId) {
  const state = await getQueueState();
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error("Task not found");
  if (task.status === "fetching" || task.status === "saving") {
    throw new Error("Cannot remove a paper while it is downloading or saving");
  }
  state.tasks = state.tasks.filter((item) => item.id !== taskId);
  await saveQueueState(state);
  return { ok: true };
}

async function clearDoneTasks() {
  const state = await getQueueState();
  state.tasks = state.tasks.filter((task) => task.status !== "done");
  await saveQueueState(state);
  return { ok: true, tasks: state.tasks };
}

async function fetchBinaryArtifact(url, defaultMimeType) {
  const response = await fetch(url, { method: "GET", redirect: "follow" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  const mimeType = (response.headers.get("Content-Type") || defaultMimeType || "application/octet-stream").split(";")[0].trim();
  const buffer = await response.arrayBuffer();
  if (!buffer.byteLength) {
    throw new Error(`Empty response for ${url}`);
  }
  if (mimeType.toLowerCase().includes("text/html")) {
    throw new Error(`HTML response for ${url}`);
  }
  return { buffer, mimeType };
}

async function saveArtifactToApp(task, artifact) {
  const response = await fetch(`${API_URL}/paper`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectPath: task.projectPath,
      arxivId: task.arxivId,
      artifactKind: artifact.artifactKind,
      fileName: artifact.fileName,
      mimeType: artifact.mimeType,
      sourceUrl: artifact.sourceUrl,
      dataBase64: artifact.dataBase64,
    }),
  });

  const bodyText = await response.text();
  let data = null;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`Invalid JSON from LLM Wiki: ${bodyText.slice(0, 240)}`);
  }

  if (!response.ok || !data?.ok) {
    throw new Error(data?.error || `LLM Wiki HTTP ${response.status}`);
  }

  return data;
}

async function processPaperTask(task) {
  const encodedId = encodeArxivPath(task.arxivId);
  const stem = safeArxivFileStem(task.arxivId);
  const sourceUrl = `https://arxiv.org/e-print/${encodedId}`;

  await updateTask(task.id, (item) => {
    item.status = "fetching";
    item.statusText = "Downloading arXiv source package";
    item.error = "";
    item.attemptCount += 1;
  });

  let sourceArtifact = null;
  let sourceDownloadError = "";
  try {
    const sourceDownload = await fetchBinaryArtifact(sourceUrl, "application/gzip");
    sourceArtifact = {
      artifactKind: "source",
      fileName: `${stem}-source.tar.gz`,
      mimeType: sourceDownload.mimeType || "application/gzip",
      sourceUrl,
      dataBase64: arrayBufferToBase64(sourceDownload.buffer),
    };
  } catch (error) {
    sourceDownloadError = error instanceof Error ? error.message : String(error);
  }

  if (sourceArtifact) {
    await updateTask(task.id, (item) => {
      item.status = "saving";
      item.statusText = "Saving arXiv source package to LLM Wiki";
      item.artifactKind = "source";
      item.fileName = sourceArtifact.fileName;
      item.error = "";
    });

    const result = await saveArtifactToApp(task, sourceArtifact);
    return {
      artifactKind: "source",
      fileName: sourceArtifact.fileName,
      paperPath: result.paperPath || "",
      statusText: result.paperPath
        ? `Saved source bundle to ${result.paperPath}`
        : "Saved source bundle",
    };
  }

  await updateTask(task.id, (item) => {
    item.status = "fetching";
    item.statusText = sourceDownloadError
      ? `Source unavailable (${sourceDownloadError}); downloading PDF fallback`
      : "Source unavailable; downloading PDF fallback";
    item.error = "";
  });

  const pdfUrl = `https://arxiv.org/pdf/${encodedId}.pdf`;
  const pdfDownload = await fetchBinaryArtifact(pdfUrl, "application/pdf");
  const pdfArtifact = {
    artifactKind: "pdf",
    fileName: `${stem}.pdf`,
    mimeType: pdfDownload.mimeType || "application/pdf",
    sourceUrl: pdfUrl,
    dataBase64: arrayBufferToBase64(pdfDownload.buffer),
  };

  await updateTask(task.id, (item) => {
    item.status = "saving";
    item.statusText = "Saving PDF fallback to LLM Wiki";
    item.artifactKind = "pdf";
    item.fileName = pdfArtifact.fileName;
    item.error = "";
  });

  const result = await saveArtifactToApp(task, pdfArtifact);
  return {
    artifactKind: "pdf",
    fileName: pdfArtifact.fileName,
    paperPath: result.paperPath || "",
    statusText: result.paperPath
      ? `Saved PDF fallback to ${result.paperPath}`
      : "Saved PDF fallback",
  };
}

async function processQueue() {
  if (processing) return;
  processing = true;

  try {
    const state = await getQueueState();
    const nextTask = state.tasks.find((task) => task.status === "queued");
    if (!nextTask) return;

    try {
      const result = await processPaperTask(nextTask);
      await updateTask(nextTask.id, (item) => {
        item.status = "done";
        item.statusText = result.statusText;
        item.error = "";
        item.artifactKind = result.artifactKind;
        item.fileName = result.fileName;
        item.paperPath = result.paperPath;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateTask(nextTask.id, (item) => {
        item.status = "failed";
        item.statusText = "Failed";
        item.error = message;
      });
    }
  } finally {
    processing = false;
    const state = await getQueueState();
    if (state.tasks.some((task) => task.status === "queued")) {
      await scheduleQueue(100);
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message || typeof message.type !== "string") {
      throw new Error("Invalid message");
    }

    if (message.type === "paperQueue/get") {
      const state = await getQueueState();
      sendResponse({ ok: true, tasks: state.tasks });
      return;
    }

    if (message.type === "paperQueueUpdated") {
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "paperQueue/enqueue") {
      const result = await enqueuePaperTask(message);
      sendResponse(result);
      return;
    }

    if (message.type === "paperQueue/retry") {
      const result = await retryPaperTask(message.taskId);
      sendResponse(result);
      return;
    }

    if (message.type === "paperQueue/remove") {
      const result = await removePaperTask(message.taskId);
      sendResponse(result);
      return;
    }

    if (message.type === "paperQueue/clearDone") {
      const result = await clearDoneTasks();
      sendResponse(result);
      return;
    }

    if (message.type === "paperQueue/process") {
      await scheduleQueue(10);
      sendResponse({ ok: true });
      return;
    }

    throw new Error(`Unsupported message: ${message.type}`);
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    sendResponse({ ok: false, error: message });
  });

  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== QUEUE_ALARM) return;
  processQueue().catch((error) => {
    console.error("[LLM Wiki Clipper] Failed to process paper queue:", error);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  resetInterruptedTasks().catch((error) => {
    console.error("[LLM Wiki Clipper] Failed to reset queue on install:", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  resetInterruptedTasks().catch((error) => {
    console.error("[LLM Wiki Clipper] Failed to reset queue on startup:", error);
  });
});

resetInterruptedTasks().catch((error) => {
  console.error("[LLM Wiki Clipper] Failed to restore queue:", error);
});
