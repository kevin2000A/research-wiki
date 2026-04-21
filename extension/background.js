const API_URL = "http://127.0.0.1:19827";
const ARXIV2MD_MARKDOWN_API = "https://arxiv2md.org/api/markdown";
const ARXIV2MD_METADATA_API = "https://arxiv2md.org/api/json";
const JINA_READER_PREFIX = "https://r.jina.ai/";
const JINA_SETTINGS_KEY = "llmWikiJinaSettingsV1";
const DEFAULT_JINA_SETTINGS = {
  apiKey: "",
  removeSelector: "header, nav, footer, aside, .sidebar, .comments, #comments",
  timeoutSeconds: "60",
  readerLmV2: true,
};
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

function normalizeBlogUrl(value) {
  let text = (value || "").trim();
  if (!text) return "";
  if (text.startsWith(JINA_READER_PREFIX)) {
    text = decodeURIComponent(text.slice(JINA_READER_PREFIX.length));
  }
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch {
    return "";
  }
}

function normalizeJinaSettings(value) {
  return {
    apiKey: typeof value?.apiKey === "string" ? value.apiKey.trim() : DEFAULT_JINA_SETTINGS.apiKey,
    removeSelector: typeof value?.removeSelector === "string"
      ? value.removeSelector.trim()
      : DEFAULT_JINA_SETTINGS.removeSelector,
    timeoutSeconds: typeof value?.timeoutSeconds === "string"
      ? value.timeoutSeconds.trim()
      : DEFAULT_JINA_SETTINGS.timeoutSeconds,
    readerLmV2: typeof value?.readerLmV2 === "boolean"
      ? value.readerLmV2
      : DEFAULT_JINA_SETTINGS.readerLmV2,
  };
}

function jinaReaderUrl(url) {
  return `${JINA_READER_PREFIX}${url.replaceAll("#", "%23")}`;
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

function normalizeRelatedTweet(value, fallbackKind = "quote") {
  if (!value || typeof value !== "object") return null;
  const normalized = {
    kind: value.kind === "repost" ? "repost" : fallbackKind,
    tweetId: typeof value.tweetId === "string" ? value.tweetId : "",
    url: typeof value.url === "string" ? value.url : "",
    authorName: typeof value.authorName === "string" ? value.authorName : "",
    authorHandle: typeof value.authorHandle === "string" ? value.authorHandle : "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    text: typeof value.text === "string" ? value.text : "",
    media: normalizeTweetMedia(value.media),
  };
  return normalized.url || normalized.text || normalized.media.length > 0 ? normalized : null;
}

function normalizeTweetSnapshot(value) {
  const related = normalizeRelatedTweet(value?.relatedTweet, "quote")
    || normalizeRelatedTweet(value?.quotedTweet, "quote");
  return {
    tweetId: typeof value?.tweetId === "string" ? value.tweetId : "",
    url: typeof value?.url === "string" ? value.url : "",
    authorName: typeof value?.authorName === "string" ? value.authorName : "",
    authorHandle: typeof value?.authorHandle === "string" ? value.authorHandle : "",
    createdAt: typeof value?.createdAt === "string" ? value.createdAt : "",
    text: typeof value?.text === "string" ? value.text : "",
    media: normalizeTweetMedia(value?.media),
    relatedTweet: related,
    quotedTweet: related && related.kind === "quote"
      ? {
          url: related.url,
          authorName: related.authorName,
          authorHandle: related.authorHandle,
          text: related.text,
        }
      : null,
  };
}

function normalizeBlogSnapshot(value) {
  return {
    url: normalizeBlogUrl(value?.url || ""),
    title: typeof value?.title === "string" ? value.title.trim() : "",
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
  if (task.kind === "blog") {
    return `${task.projectPath}::blog::${task.blog?.url || ""}`;
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

async function getJinaSettings() {
  return normalizeJinaSettings(await storageGet(JINA_SETTINGS_KEY));
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
  const kind = task?.kind === "tweet" ? "tweet" : task?.kind === "blog" ? "blog" : "arxiv";
  return {
    id: typeof task?.id === "string" ? task.id : `source-${now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    arxivId: parseArxivInput(task?.arxivId || ""),
    tweet: normalizeTweetSnapshot(task?.tweet),
    blog: normalizeBlogSnapshot(task?.blog),
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
      .filter((task) => task.projectPath && (
        task.kind === "tweet"
          ? task.tweet.tweetId
          : task.kind === "blog"
            ? task.blog.url
            : task.arxivId
      )),
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
  const kind = payload?.kind === "tweet" ? "tweet" : payload?.kind === "blog" ? "blog" : "arxiv";
  const arxivId = parseArxivInput(payload?.arxivId || "");
  const tweet = normalizeTweetSnapshot(payload?.tweet);
  const blog = normalizeBlogSnapshot(payload?.blog);
  const projectPath = (payload?.projectPath || "").trim();
  const projectName = (payload?.projectName || "").trim();
  if (!projectPath) throw new Error("projectPath is required");
  if (kind === "tweet") {
    if (!tweet.tweetId || !tweet.url) throw new Error("Invalid tweet snapshot");
  } else if (kind === "blog") {
    if (!blog.url) throw new Error("Invalid blog URL");
  } else if (!arxivId) {
    throw new Error("Invalid arXiv ID");
  }

  const state = await getQueueState();
  const duplicateKey = kind === "tweet"
    ? `${projectPath}::tweet::${tweet.tweetId}`
    : kind === "blog"
      ? `${projectPath}::blog::${blog.url}`
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
    blog,
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

function parseJinaReaderMarkdown(markdown, fallbackTitle) {
  const titleMatch = markdown.match(/^Title:\s*(.+)$/m);
  const marker = "Markdown Content:";
  const markerIndex = markdown.indexOf(marker);
  const content = markerIndex >= 0
    ? markdown.slice(markerIndex + marker.length).trim()
    : markdown.trim();
  return {
    title: titleMatch?.[1]?.trim() || fallbackTitle || "Blog Article",
    content,
  };
}

function jinaReaderErrorLine(markdown) {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("Warning: Target URL returned error") || line.startsWith("Error:"));
}

function parseJinaEventStream(text) {
  const chunks = [];
  let eventName = "message";
  let dataLines = [];

  function eventText(value) {
    if (typeof value === "string") return value;
    if (typeof value?.text === "string") return value.text;
    if (typeof value?.content === "string") return value.content;
    if (typeof value?.data === "string") return value.data;
    if (typeof value?.delta === "string") return value.delta;
    if (typeof value?.choices?.[0]?.delta?.content === "string") return value.choices[0].delta.content;
    if (typeof value?.choices?.[0]?.message?.content === "string") return value.choices[0].message.content;
    return "";
  }

  function flushEvent() {
    if (dataLines.length === 0) return;
    const rawData = dataLines.join("\n");
    dataLines = [];
    if (rawData === "[DONE]") return;
    let value = rawData;
    try {
      value = JSON.parse(rawData);
    } catch {
      value = rawData;
    }
    if (eventName === "error") {
      throw new Error(eventText(value) || rawData);
    }
    const chunk = eventText(value);
    if (!chunk) return;
    const previous = chunks.length > 0 ? chunks[chunks.length - 1] : "";
    if (previous && chunk.startsWith(previous)) {
      chunks[chunks.length - 1] = chunk;
      return;
    }
    chunks.push(chunk);
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      flushEvent();
      eventName = "message";
    } else if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  flushEvent();

  return chunks.join("\n");
}

function jinaErrorDetail(bodyText) {
  try {
    const bodyJson = JSON.parse(bodyText);
    return bodyJson?.readableMessage || bodyJson?.message || "";
  } catch {
    try {
      return parseJinaEventStream(bodyText) || bodyText.trim().slice(0, 500);
    } catch (err) {
      return err.message;
    }
  }
}

async function fetchJinaBlogMarkdown(task) {
  const readerUrl = jinaReaderUrl(task.blog.url);
  const jinaSettings = await getJinaSettings();
  const headers = {};
  if (jinaSettings.removeSelector) {
    headers["X-Remove-Selector"] = jinaSettings.removeSelector;
  }
  if (jinaSettings.timeoutSeconds) {
    headers["X-Timeout"] = jinaSettings.timeoutSeconds;
  }
  if (jinaSettings.apiKey) {
    headers.Authorization = jinaSettings.apiKey.toLowerCase().startsWith("bearer ")
      ? jinaSettings.apiKey
      : `Bearer ${jinaSettings.apiKey}`;
    if (jinaSettings.readerLmV2) {
      headers.Accept = "text/event-stream";
      headers["X-Respond-With"] = "readerlm-v2";
    }
  }
  let response;
  try {
    response = await fetch(readerUrl, { method: "GET", redirect: "follow", headers });
  } catch (err) {
    throw new Error(`Jina Reader fetch failed for ${readerUrl}: ${err.message}`);
  }
  if (!response.ok) {
    const bodyText = await response.text();
    const detail = jinaErrorDetail(bodyText).trim().slice(0, 500);
    const suffix = detail ? `: ${detail}` : "";
    if (!jinaSettings.apiKey && [401, 403, 429, 451].includes(response.status)) {
      throw new Error(`Jina Reader HTTP ${response.status}${suffix}; configure a Jina API key in Blog settings and retry`);
    }
    throw new Error(`Jina Reader HTTP ${response.status}${suffix}`);
  }
  const bodyText = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const markdown = contentType.includes("text/event-stream")
    ? parseJinaEventStream(bodyText)
    : bodyText;
  if (!markdown.trim()) {
    throw new Error("Jina Reader markdown was empty");
  }
  const errorLine = jinaReaderErrorLine(markdown);
  if (errorLine) {
    if (!jinaSettings.apiKey) {
      throw new Error(`${errorLine}; configure a Jina API key in Blog settings and retry`);
    }
    throw new Error(errorLine);
  }
  const parsed = parseJinaReaderMarkdown(markdown, task.blog.title);
  if (!parsed.content.trim()) {
    throw new Error("Jina Reader markdown content was empty");
  }
  return {
    readerUrl,
    ...parsed,
  };
}

async function saveBlogToApp(task, blog) {
  const response = await fetch(`${API_URL}/clip`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: blog.title,
      url: task.blog.url,
      content: blog.content,
      projectPath: task.projectPath,
      assets: [],
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

async function processBlogTask(task) {
  if (!task.blog?.url) {
    throw new Error("Blog task is missing URL");
  }

  await updateTask(task.id, (item) => {
    item.status = "fetching";
    item.statusText = "Downloading Markdown from Jina Reader only";
    item.error = "";
    item.attemptCount += 1;
  });

  const blog = await fetchJinaBlogMarkdown(task);

  await updateTask(task.id, (item) => {
    item.status = "saving";
    item.statusText = "Saving blog Markdown to LLM Wiki";
    item.artifactKind = "blog";
    item.fileName = `${sanitizeFileStem(blog.title)}.md`;
    item.blog.title = blog.title;
    item.error = "";
  });

  const result = await saveBlogToApp(task, blog);
  return {
    artifactKind: "blog",
    fileName: result.path || "",
    paperPath: result.path || "",
    statusText: result.path
      ? `Saved blog to ${result.path}`
      : "Saved blog",
  };
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

async function downloadTweetMedia(mediaItems, fileStem, filePrefix = "") {
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
      const fileName = `${filePrefix}${String(index + 1).padStart(3, "0")}-${fileStem}.${extensionForMime(download.mimeType)}`;
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

  return {
    assets: successfulAssets,
    media: successfulMedia,
    failedMediaCount,
  };
}

async function processTweetTask(task) {
  if (!task.tweet?.tweetId || !task.tweet?.url) {
    throw new Error("Tweet snapshot is missing required fields");
  }

  const mediaItems = Array.isArray(task.tweet.media) ? task.tweet.media : [];
  const relatedTweet = task.tweet.relatedTweet || task.tweet.quotedTweet || null;
  const relatedMediaItems = Array.isArray(relatedTweet?.media) ? relatedTweet.media : [];
  const totalMediaCount = mediaItems.length + relatedMediaItems.length;
  await updateTask(task.id, (item) => {
    item.status = "fetching";
    item.statusText = totalMediaCount > 0
      ? `Downloading tweet media (${totalMediaCount})`
      : "Preparing tweet snapshot";
    item.error = "";
    item.attemptCount += 1;
  });

  const mainDownload = await downloadTweetMedia(
    mediaItems,
    sanitizeFileStem(task.tweet.tweetId),
    "",
  );
  const relatedDownload = relatedTweet
    ? await downloadTweetMedia(
        relatedMediaItems,
        sanitizeFileStem(relatedTweet.tweetId || task.tweet.tweetId),
        "related-",
      )
    : { assets: [], media: [], failedMediaCount: 0 };
  const successfulAssets = [...mainDownload.assets, ...relatedDownload.assets];
  const failedMediaCount = mainDownload.failedMediaCount + relatedDownload.failedMediaCount;

  await updateTask(task.id, (item) => {
    item.status = "saving";
    item.statusText = successfulAssets.length > 0
      ? `Saving tweet with ${successfulAssets.length}/${totalMediaCount} images`
      : "Saving tweet to LLM Wiki";
    item.artifactKind = "tweet";
    item.fileName = `${sanitizeFileStem(task.tweet.authorHandle || "tweet")}-${sanitizeFileStem(task.tweet.tweetId)}.md`;
    item.error = "";
  });

  const result = await saveTweetToApp(
    task,
    {
      ...task.tweet,
      media: mainDownload.media,
      relatedTweet: relatedTweet
        ? {
            ...relatedTweet,
            media: relatedDownload.media,
          }
        : null,
    },
    successfulAssets,
  );

  return {
    artifactKind: "tweet",
    fileName: result.path || "",
    paperPath: result.path || "",
    statusText: failedMediaCount > 0
      ? `Saved tweet to ${result.path} (${successfulAssets.length}/${totalMediaCount} images downloaded)`
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
        : nextTask.kind === "blog"
          ? await processBlogTask(nextTask)
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
