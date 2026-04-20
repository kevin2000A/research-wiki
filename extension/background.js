const API_URL = "http://127.0.0.1:19827";
const ARXIV2MD_MARKDOWN_API = "https://arxiv2md.org/api/markdown";
const ARXIV2MD_METADATA_API = "https://arxiv2md.org/api/json";
const QUEUE_STORAGE_KEY = "llmWikiPaperQueueV1";
const QUEUE_ALARM = "llmWikiPaperQueueTick";
const DEFAULT_ARXIV_SETTINGS = {
  removeRefs: false,
  removeToc: false,
  removeCitations: false,
};

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

function safeArxivFileStem(arxivId) {
  return arxivId.replace(/[^A-Za-z0-9._-]/g, "-");
}

function sanitizeFileStem(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "") || "asset";
}

function extensionForMime(mimeType) {
  const mime = (mimeType || "").split(";")[0].trim().toLowerCase();
  return {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "image/avif": "avif",
  }[mime] || "img";
}

function normalizeTweetMedia(value) {
  return Array.isArray(value)
    ? value
      .filter((item) => item && typeof item.url === "string" && item.url)
      .map((item) => ({
        url: item.url,
        alt: typeof item.alt === "string" ? item.alt : "",
      }))
    : [];
}

function normalizeTweetSnapshot(value) {
  const quoted = value?.quotedTweet && typeof value.quotedTweet === "object"
    ? {
        url: typeof value.quotedTweet.url === "string" ? value.quotedTweet.url : "",
        authorName: typeof value.quotedTweet.authorName === "string" ? value.quotedTweet.authorName : "",
        authorHandle: typeof value.quotedTweet.authorHandle === "string" ? value.quotedTweet.authorHandle : "",
        text: typeof value.quotedTweet.text === "string" ? value.quotedTweet.text : "",
      }
    : null;
  return {
    tweetId: typeof value?.tweetId === "string" ? value.tweetId : "",
    url: typeof value?.url === "string" ? value.url : "",
    authorName: typeof value?.authorName === "string" ? value.authorName : "",
    authorHandle: typeof value?.authorHandle === "string" ? value.authorHandle : "",
    createdAt: typeof value?.createdAt === "string" ? value.createdAt : "",
    text: typeof value?.text === "string" ? value.text : "",
    media: normalizeTweetMedia(value?.media),
    quotedTweet: quoted && (quoted.url || quoted.text) ? quoted : null,
  };
}

function normalizeArxivSettings(value) {
  return {
    removeRefs: Boolean(value?.removeRefs),
    removeToc: Boolean(value?.removeToc),
    removeCitations: Boolean(value?.removeCitations),
  };
}

function paperUrls(arxivId, settings = DEFAULT_ARXIV_SETTINGS) {
  const absUrl = `https://arxiv.org/abs/${arxivId}`;
  const encodedArxivId = arxivId
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const flags = normalizeArxivSettings(settings);
  const commonParams = [
    `url=${encodeURIComponent(absUrl)}`,
    `remove_refs=${flags.removeRefs}`,
    `remove_toc=${flags.removeToc}`,
    `remove_citations=${flags.removeCitations}`,
  ].join("&");
  return {
    abs: absUrl,
    arxiv2mdMarkdown: `${ARXIV2MD_MARKDOWN_API}?${commonParams}`,
    arxiv2mdJson: `${ARXIV2MD_METADATA_API}?${commonParams}`,
    pdf: `https://arxiv.org/pdf/${encodedArxivId}.pdf`,
  };
}

function queueTaskKey(task) {
  if (task.kind === "tweet") {
    return `${task.projectPath}::tweet::${task.tweet?.tweetId || ""}`;
  }
  return `${task.projectPath}::arxiv::${task.arxivId}`;
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

function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  return arrayBufferToBase64(bytes.buffer);
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
  const kind = task?.kind === "tweet" ? "tweet" : "arxiv";
  return {
    id: typeof task?.id === "string" ? task.id : `source-${now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    arxivId: parseArxivInput(task?.arxivId || ""),
    tweet: normalizeTweetSnapshot(task?.tweet),
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
    arxivSettings: normalizeArxivSettings(task?.arxivSettings || DEFAULT_ARXIV_SETTINGS),
  };
}

async function getQueueState() {
  const stored = await storageGet(QUEUE_STORAGE_KEY);
  if (!stored || !Array.isArray(stored.tasks)) return emptyQueueState();
  return {
    tasks: stored.tasks
      .map(normalizeTask)
      .filter((task) => task.projectPath && (task.kind === "tweet" ? task.tweet.tweetId : task.arxivId)),
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

async function enqueueSourceTask(payload) {
  const kind = payload?.kind === "tweet" ? "tweet" : "arxiv";
  const arxivId = parseArxivInput(payload?.arxivId || "");
  const tweet = normalizeTweetSnapshot(payload?.tweet);
  const projectPath = (payload?.projectPath || "").trim();
  const projectName = (payload?.projectName || "").trim();
  if (!projectPath) throw new Error("projectPath is required");
  if (kind === "tweet") {
    if (!tweet.tweetId || !tweet.url) throw new Error("Invalid tweet snapshot");
  } else if (!arxivId) {
    throw new Error("Invalid arXiv ID");
  }

  const state = await getQueueState();
  const duplicateKey = kind === "tweet"
    ? `${projectPath}::tweet::${tweet.tweetId}`
    : `${projectPath}::arxiv::${arxivId}`;
  const duplicate = state.tasks.find((task) => queueTaskKey(task) === duplicateKey);
  if (duplicate) {
    return { ok: true, added: false, duplicate: true, task: duplicate, tasks: state.tasks };
  }

  const task = normalizeTask({
    id: `source-${now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    arxivId,
    tweet,
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
    arxivSettings: normalizeArxivSettings(payload?.arxivSettings || DEFAULT_ARXIV_SETTINGS),
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
    throw new Error("Cannot remove a source while it is downloading or saving");
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

async function fetchArxiv2mdArtifact(task) {
  const urls = paperUrls(task.arxivId, task.arxivSettings);
  const markdownResponse = await fetch(urls.arxiv2mdMarkdown, { method: "GET", redirect: "follow" });
  if (!markdownResponse.ok) {
    throw new Error(`arxiv2md markdown HTTP ${markdownResponse.status}`);
  }
  const markdown = await markdownResponse.text();
  if (!markdown.trim()) {
    throw new Error("arxiv2md markdown was empty");
  }

  let paperTitle = `arXiv ${task.arxivId}`;
  let paperSourceUrl = urls.abs;
  let metadataError = "";
  try {
    const metadataResponse = await fetch(urls.arxiv2mdJson, { method: "GET", redirect: "follow" });
    if (!metadataResponse.ok) {
      throw new Error(`arxiv2md metadata HTTP ${metadataResponse.status}`);
    }
    const metadata = await metadataResponse.json();
    if (typeof metadata?.title === "string" && metadata.title.trim()) {
      paperTitle = metadata.title.trim();
    }
    if (typeof metadata?.source_url === "string" && metadata.source_url.trim()) {
      paperSourceUrl = metadata.source_url.trim();
    }
  } catch (error) {
    metadataError = error instanceof Error ? error.message : String(error);
  }

  return {
    artifactKind: "arxiv2md",
    fileName: `${safeArxivFileStem(task.arxivId)}-arxiv2md.md`,
    mimeType: "text/markdown",
    sourceUrl: urls.arxiv2mdMarkdown,
    metadataUrl: urls.arxiv2mdJson,
    paperTitle,
    paperSourceUrl,
    metadataError,
    dataBase64: textToBase64(markdown),
  };
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
      metadataUrl: artifact.metadataUrl,
      paperTitle: artifact.paperTitle,
      paperUrl: artifact.paperSourceUrl,
      paperSourceUrl: artifact.paperSourceUrl,
      arxivSettings: task.arxivSettings,
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

async function saveTweetToApp(task, tweet, assets) {
  const response = await fetch(`${API_URL}/tweet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectPath: task.projectPath,
      tweet,
      assets,
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
  const urls = paperUrls(task.arxivId, task.arxivSettings);
  const stem = safeArxivFileStem(task.arxivId);

  await updateTask(task.id, (item) => {
    item.status = "fetching";
    item.statusText = "Downloading arxiv2md markdown";
    item.error = "";
    item.attemptCount += 1;
  });

  let markdownArtifact = null;
  let markdownDownloadError = "";
  try {
    markdownArtifact = await fetchArxiv2mdArtifact(task);
  } catch (error) {
    markdownDownloadError = error instanceof Error ? error.message : String(error);
  }

  if (markdownArtifact) {
    await updateTask(task.id, (item) => {
      item.status = "saving";
      item.statusText = markdownArtifact.metadataError
        ? `Saving arxiv2md markdown (metadata unavailable: ${markdownArtifact.metadataError})`
        : "Saving arxiv2md markdown to LLM Wiki";
      item.artifactKind = "arxiv2md";
      item.fileName = markdownArtifact.fileName;
      item.error = "";
    });

    const result = await saveArtifactToApp(task, markdownArtifact);
    return {
      artifactKind: "arxiv2md",
      fileName: markdownArtifact.fileName,
      paperPath: result.paperPath || "",
      statusText: result.paperPath
        ? `Saved arxiv2md bundle to ${result.paperPath}`
        : "Saved arxiv2md bundle",
    };
  }

  await updateTask(task.id, (item) => {
    item.status = "fetching";
    item.statusText = markdownDownloadError
      ? `arxiv2md unavailable (${markdownDownloadError}); downloading PDF fallback`
      : "arxiv2md unavailable; downloading PDF fallback";
    item.error = "";
  });

  const pdfDownload = await fetchBinaryArtifact(urls.pdf, "application/pdf");
  const pdfArtifact = {
    artifactKind: "pdf",
    fileName: `${stem}.pdf`,
    mimeType: pdfDownload.mimeType || "application/pdf",
    sourceUrl: urls.pdf,
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

async function processTweetTask(task) {
  if (!task.tweet?.tweetId || !task.tweet?.url) {
    throw new Error("Tweet snapshot is missing required fields");
  }

  const mediaItems = Array.isArray(task.tweet.media) ? task.tweet.media : [];
  await updateTask(task.id, (item) => {
    item.status = "fetching";
    item.statusText = mediaItems.length > 0
      ? `Downloading tweet media (${mediaItems.length})`
      : "Preparing tweet snapshot";
    item.error = "";
    item.attemptCount += 1;
  });

  const successfulAssets = [];
  const successfulMedia = [];
  let failedMediaCount = 0;

  for (let index = 0; index < mediaItems.length; index += 1) {
    const media = mediaItems[index];
    try {
      const download = await fetchBinaryArtifact(media.url, "image/jpeg");
      if (!download.mimeType.toLowerCase().startsWith("image/")) {
        throw new Error(`Unexpected media type ${download.mimeType}`);
      }
      const fileName = `${String(index + 1).padStart(3, "0")}-${sanitizeFileStem(task.tweet.tweetId)}.${extensionForMime(download.mimeType)}`;
      successfulAssets.push({
        originalUrl: media.url,
        fileName,
        mimeType: download.mimeType,
        dataBase64: arrayBufferToBase64(download.buffer),
      });
      successfulMedia.push(media);
    } catch {
      failedMediaCount += 1;
    }
  }

  await updateTask(task.id, (item) => {
    item.status = "saving";
    item.statusText = successfulAssets.length > 0
      ? `Saving tweet with ${successfulAssets.length}/${mediaItems.length} images`
      : "Saving tweet to LLM Wiki";
    item.artifactKind = "tweet";
    item.fileName = `${sanitizeFileStem(task.tweet.authorHandle || "tweet")}-${sanitizeFileStem(task.tweet.tweetId)}.md`;
    item.error = "";
  });

  const result = await saveTweetToApp(
    task,
    {
      ...task.tweet,
      media: successfulMedia,
    },
    successfulAssets,
  );

  return {
    artifactKind: "tweet",
    fileName: result.path || "",
    paperPath: result.path || "",
    statusText: failedMediaCount > 0
      ? `Saved tweet to ${result.path} (${successfulAssets.length}/${mediaItems.length} images downloaded)`
      : `Saved tweet to ${result.path}`,
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
      const result = nextTask.kind === "tweet"
        ? await processTweetTask(nextTask)
        : await processPaperTask(nextTask);
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
      const result = await enqueueSourceTask(message);
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
    console.error("[LLM Wiki Clipper] Failed to process source queue:", error);
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
