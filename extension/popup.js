const API_URL = "http://127.0.0.1:19827";
const ARXIV2MD_MARKDOWN_API = "https://arxiv2md.org/api/markdown";
const ARXIV2MD_METADATA_API = "https://arxiv2md.org/api/json";

const statusBar = document.getElementById("statusBar");
const titleInput = document.getElementById("titleInput");
const urlPreview = document.getElementById("urlPreview");
const contentPreview = document.getElementById("contentPreview");
const clipBtn = document.getElementById("clipBtn");
const projectSelect = document.getElementById("projectSelect");
const webModeBtn = document.getElementById("webModeBtn");
const paperModeBtn = document.getElementById("paperModeBtn");
const webFields = document.getElementById("webFields");
const paperFields = document.getElementById("paperFields");
const arxivFields = document.getElementById("arxivFields");
const tweetFields = document.getElementById("tweetFields");
const paperInput = document.getElementById("paperInput");
const paperPreview = document.getElementById("paperPreview");
const sourceTypePreview = document.getElementById("sourceTypePreview");
const sourceUrlPreview = document.getElementById("sourceUrlPreview");
const tweetPreview = document.getElementById("tweetPreview");
const paperSettingsSummary = document.getElementById("paperSettingsSummary");
const removeRefsCheckbox = document.getElementById("removeRefsCheckbox");
const removeTocCheckbox = document.getElementById("removeTocCheckbox");
const removeCitationsCheckbox = document.getElementById("removeCitationsCheckbox");
const paperAddBtn = document.getElementById("paperAddBtn");
const refreshQueueBtn = document.getElementById("refreshQueueBtn");
const clearDoneBtn = document.getElementById("clearDoneBtn");
const paperQueueSummary = document.getElementById("paperQueueSummary");
const paperQueueList = document.getElementById("paperQueueList");

let extractedContent = "";
let extractedAssets = [];
let pageUrl = "";
let activeTabId = null;
let appConnected = false;
let currentMode = "web";
let currentSourceKind = "arxiv";
let webExtractionStarted = false;
let queueTasks = [];
let queueStateVersion = 0;
let queueLoadRequestId = 0;
let extractedTweet = null;
const ARXIV_SETTINGS_KEY = "llmWikiArxiv2mdSettingsV1";
const DEFAULT_ARXIV_SETTINGS = {
  removeRefs: false,
  removeToc: false,
  removeCitations: false,
};
let currentArxivSettings = { ...DEFAULT_ARXIV_SETTINGS };

function normalizeArxivSettings(value) {
  return {
    removeRefs: Boolean(value?.removeRefs),
    removeToc: Boolean(value?.removeToc),
    removeCitations: Boolean(value?.removeCitations),
  };
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

function syncArxivSettingsInputs() {
  removeRefsCheckbox.checked = currentArxivSettings.removeRefs;
  removeTocCheckbox.checked = currentArxivSettings.removeToc;
  removeCitationsCheckbox.checked = currentArxivSettings.removeCitations;
  paperSettingsSummary.textContent = [
    `refs: ${currentArxivSettings.removeRefs ? "on" : "off"}`,
    `toc: ${currentArxivSettings.removeToc ? "on" : "off"}`,
    `citations: ${currentArxivSettings.removeCitations ? "on" : "off"}`,
  ].join(" · ");
}

async function loadArxivSettings() {
  try {
    const stored = await storageGet(ARXIV_SETTINGS_KEY);
    currentArxivSettings = normalizeArxivSettings(stored || DEFAULT_ARXIV_SETTINGS);
  } catch {
    currentArxivSettings = { ...DEFAULT_ARXIV_SETTINGS };
  }
  syncArxivSettingsInputs();
}

async function persistArxivSettings() {
  currentArxivSettings = normalizeArxivSettings({
    removeRefs: removeRefsCheckbox.checked,
    removeToc: removeTocCheckbox.checked,
    removeCitations: removeCitationsCheckbox.checked,
  });
  syncArxivSettingsInputs();
  await storageSet({ [ARXIV_SETTINGS_KEY]: currentArxivSettings });
}

function setStatus(kind, text) {
  statusBar.className = `status ${kind}`;
  statusBar.textContent = text;
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

function parseTwitterStatusUrl(value) {
  const text = (value || "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const host = url.hostname.replace(/^www\./, "");
    if (host !== "x.com" && host !== "twitter.com") return null;
    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
    if (!match) return null;
    return {
      handle: `@${match[1]}`,
      tweetId: match[2],
      url: `https://${host}/${match[1]}/status/${match[2]}`,
    };
  } catch {
    return null;
  }
}

function detectSourceKind() {
  const tweetStatus = parseTwitterStatusUrl(pageUrl);
  const arxivId = parseArxivInput(paperInput.value || pageUrl);
  if (tweetStatus && !paperInput.value.trim()) return "tweet";
  if (arxivId) return "arxiv";
  return tweetStatus ? "tweet" : "arxiv";
}

function setSourceKind(kind) {
  currentSourceKind = kind === "tweet" ? "tweet" : "arxiv";
  arxivFields.classList.toggle("hidden", currentSourceKind !== "arxiv");
  tweetFields.classList.toggle("hidden", currentSourceKind !== "tweet");
  sourceTypePreview.textContent = currentSourceKind === "tweet" ? "X / Twitter Tweet" : "arXiv Paper";
}

function safeArxivFileStem(arxivId) {
  return arxivId.replace(/[^A-Za-z0-9._-]/g, "-");
}

function paperUrls(arxivId, settings = DEFAULT_ARXIV_SETTINGS) {
  const absUrl = `https://arxiv.org/abs/${arxivId}`;
  const encoded = arxivId
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
    pdf: `https://arxiv.org/pdf/${encoded}.pdf`,
  };
}

function queueStatusOrder(status) {
  return {
    fetching: 0,
    saving: 1,
    queued: 2,
    failed: 3,
    done: 4,
  }[status] ?? 5;
}

function sortQueueTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const statusDiff = queueStatusOrder(a.status) - queueStatusOrder(b.status);
    if (statusDiff !== 0) return statusDiff;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function queueStatusLabel(status) {
  return {
    queued: "Queued",
    fetching: "Fetching",
    saving: "Saving",
    failed: "Failed",
    done: "Done",
  }[status] || status || "Unknown";
}

function updateQueueSummary() {
  const counts = {
    queued: queueTasks.filter((task) => task.status === "queued").length,
    fetching: queueTasks.filter((task) => task.status === "fetching" || task.status === "saving").length,
    failed: queueTasks.filter((task) => task.status === "failed").length,
    done: queueTasks.filter((task) => task.status === "done").length,
  };
  if (queueTasks.length === 0) {
    paperQueueSummary.textContent = "No structured sources queued yet.";
  } else {
    paperQueueSummary.textContent = [
      `${counts.queued} queued`,
      `${counts.fetching} active`,
      `${counts.failed} failed`,
      `${counts.done} done`,
    ].join(" · ");
  }
  clearDoneBtn.disabled = counts.done === 0;
}

function renderPaperQueue() {
  updateQueueSummary();

  if (queueTasks.length === 0) {
    paperQueueList.innerHTML = '<div class="queue-empty">No structured sources queued yet.</div>';
    return;
  }

  paperQueueList.innerHTML = queueTasks.map((task) => {
    const sourceLabel = task.kind === "tweet"
      ? `${task.tweet?.authorHandle || "Tweet"} · ${task.tweet?.tweetId || task.tweetId || task.id}`
      : `arXiv ${task.arxivId}`;
    const detail = task.paperPath
      ? task.paperPath
      : task.fileName
        ? `Artifact: ${task.fileName}`
        : task.statusText || "";
    const actions = [];
    if (task.status === "failed") {
      actions.push(`<button class="mini-btn" type="button" data-queue-action="retry" data-task-id="${escapeHtml(task.id)}">Retry</button>`);
    }
    if (task.status !== "fetching" && task.status !== "saving") {
      actions.push(`<button class="mini-btn" type="button" data-queue-action="remove" data-task-id="${escapeHtml(task.id)}">Remove</button>`);
    }

    return `
      <div class="queue-item">
        <div class="queue-item-head">
          <div class="queue-title">${escapeHtml(sourceLabel)}</div>
          <span class="queue-badge ${escapeHtml(task.status)}">${escapeHtml(queueStatusLabel(task.status))}</span>
        </div>
        <div class="queue-meta">${escapeHtml(task.kind === "tweet" ? "Tweet" : "arXiv")} · ${escapeHtml(task.projectName || task.projectPath)}</div>
        <div class="queue-detail">${escapeHtml(task.statusText || detail || "Queued")}</div>
        ${detail && detail !== task.statusText ? `<div class="queue-detail">${escapeHtml(detail)}</div>` : ""}
        ${task.error ? `<div class="queue-error">${escapeHtml(task.error)}</div>` : ""}
        ${actions.length > 0 ? `<div class="queue-item-actions">${actions.join("")}</div>` : ""}
      </div>
    `;
  }).join("");
}

function setQueueTasks(tasks, bumpVersion = false) {
  if (bumpVersion) queueStateVersion += 1;
  queueTasks = sortQueueTasks(tasks || []);
  renderPaperQueue();
}

function sendBackgroundMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Extension request failed"));
        return;
      }
      resolve(response);
    });
  });
}

async function loadPaperQueue() {
  const requestId = ++queueLoadRequestId;
  const versionAtStart = queueStateVersion;

  try {
    const response = await sendBackgroundMessage({ type: "paperQueue/get" });
    if (requestId !== queueLoadRequestId || versionAtStart !== queueStateVersion) return;
    setQueueTasks(response.tasks || []);
  } catch (err) {
    if (requestId !== queueLoadRequestId || versionAtStart !== queueStateVersion) return;
    queueTasks = [];
    renderPaperQueue();
    if (currentMode === "source") {
      setStatus("error", `✗ Failed to load background queue: ${err.message}`);
    }
  }
}

function tweetAuthorLabel(tweet) {
  if (!tweet) return "";
  if (tweet.authorName && tweet.authorHandle) return `${tweet.authorName} (${tweet.authorHandle})`;
  return tweet.authorName || tweet.authorHandle || "Unknown author";
}

function renderTweetPreview() {
  const status = parseTwitterStatusUrl(pageUrl);
  sourceUrlPreview.textContent = status?.url || pageUrl || "—";

  if (!status) {
    tweetPreview.textContent = "Open an x.com/twitter.com status page to parse the current tweet.";
    updateActionState();
    return;
  }

  if (!extractedTweet) {
    tweetPreview.textContent = "Extracting tweet...";
    updateActionState();
    return;
  }

  const lines = [
    `Tweet ID: ${extractedTweet.tweetId || status.tweetId}`,
    `Author: ${tweetAuthorLabel(extractedTweet)}`,
    extractedTweet.createdAt ? `Created: ${extractedTweet.createdAt}` : "",
    "",
    extractedTweet.text || "(No text found)",
  ];

  if (extractedTweet.media?.length) {
    lines.push("", `Media: ${extractedTweet.media.length} image${extractedTweet.media.length === 1 ? "" : "s"}`);
  }

  if (extractedTweet.quotedTweet?.url) {
    lines.push(
      "",
      "Quoted Tweet:",
      `${tweetAuthorLabel(extractedTweet.quotedTweet) || extractedTweet.quotedTweet.url}`,
      extractedTweet.quotedTweet.text || extractedTweet.quotedTweet.url,
    );
  }

  tweetPreview.textContent = lines.filter(Boolean).join("\n");
  updateActionState();
}

function updateActionState() {
  if (!appConnected) {
    clipBtn.disabled = true;
    clipBtn.textContent = "📎 App not running — cannot save";
    paperAddBtn.disabled = true;
    paperAddBtn.textContent = "➕ App not running — cannot queue";
    return;
  }

  if (currentMode === "source") {
    if (currentSourceKind === "tweet") {
      paperAddBtn.disabled = !extractedTweet || !projectSelect.value;
    } else {
      const arxivId = parseArxivInput(paperInput.value || pageUrl);
      paperAddBtn.disabled = !arxivId || !projectSelect.value;
    }
    paperAddBtn.textContent = "➕ Add to Background Queue";
    clipBtn.disabled = true;
    return;
  }

  clipBtn.disabled = !extractedContent || !projectSelect.value;
  clipBtn.textContent = "📎 Save Raw Source";
  paperAddBtn.disabled = true;
}

function updatePaperPreview() {
  const arxivId = parseArxivInput(paperInput.value || pageUrl);
  sourceUrlPreview.textContent = arxivId ? paperUrls(arxivId, currentArxivSettings).abs : pageUrl || "—";
  if (!arxivId) {
    paperPreview.textContent = "Enter an arXiv URL, alphaXiv URL, or paper ID.";
    updateActionState();
    return;
  }

  const urls = paperUrls(arxivId, currentArxivSettings);
  paperPreview.textContent = [
    `ID: ${arxivId}`,
    `Paper URL: ${urls.abs}`,
    `Markdown API: ${ARXIV2MD_MARKDOWN_API}`,
    `Metadata API: ${ARXIV2MD_METADATA_API}`,
    `remove_refs: ${currentArxivSettings.removeRefs}`,
    `remove_toc: ${currentArxivSettings.removeToc}`,
    `remove_citations: ${currentArxivSettings.removeCitations}`,
    `Paper bundle: ${safeArxivFileStem(arxivId)}-paper.md`,
    `PDF fallback: ${urls.pdf}`,
  ].join("\n");
  updateActionState();
}

function setMode(mode) {
  currentMode = mode;
  webModeBtn.classList.toggle("active", mode === "web");
  paperModeBtn.classList.toggle("active", mode === "source");
  webFields.classList.toggle("hidden", mode !== "web");
  paperFields.classList.toggle("hidden", mode !== "source");
  clipBtn.classList.toggle("hidden", mode === "source");
  paperAddBtn.classList.toggle("hidden", mode !== "source");

  if (mode === "source") {
    setSourceKind(detectSourceKind());
    const currentId = parseArxivInput(pageUrl);
    if (currentSourceKind === "arxiv") {
      if (!paperInput.value && currentId) paperInput.value = currentId;
      updatePaperPreview();
    } else {
      renderTweetPreview();
      if (activeTabId) extractTweet();
    }
    loadPaperQueue();
  } else {
    updateActionState();
    if (activeTabId && !webExtractionStarted) extractContent();
  }
  setTimeout(resizePreview, 100);
}

async function checkConnection() {
  try {
    const res = await fetch(`${API_URL}/status`, { method: "GET" });
    const data = await res.json();
    if (data.ok) {
      appConnected = true;
      setStatus("connected", "✓ Connected to LLM Wiki");
      await loadProjects();
      updateActionState();
      return true;
    }
  } catch {}
  appConnected = false;
  setStatus("disconnected", "✗ LLM Wiki app is not running");
  projectSelect.innerHTML = '<option value="">App not running</option>';
  updateActionState();
  return false;
}

async function loadProjects() {
  try {
    const res = await fetch(`${API_URL}/projects`, { method: "GET" });
    const data = await res.json();
    if (data.ok && data.projects?.length > 0) {
      projectSelect.innerHTML = "";
      for (const proj of data.projects) {
        const opt = document.createElement("option");
        opt.value = proj.path;
        opt.textContent = proj.name + (proj.current ? " (current)" : "");
        if (proj.current) opt.selected = true;
        projectSelect.appendChild(opt);
      }
      updateActionState();
      return;
    }
  } catch {}

  try {
    const res = await fetch(`${API_URL}/project`, { method: "GET" });
    const data = await res.json();
    if (data.ok && data.path) {
      const name = data.path.replace(/\\/g, "/").split("/").pop() || data.path;
      projectSelect.innerHTML = "";
      const opt = document.createElement("option");
      opt.value = data.path;
      opt.textContent = name;
      projectSelect.appendChild(opt);
    }
  } catch {
    projectSelect.innerHTML = '<option value="">No projects</option>';
  }
  updateActionState();
}

async function loadCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  activeTabId = tab.id;
  pageUrl = tab.url || "";
  titleInput.value = tab.title || "Untitled";
  urlPreview.textContent = pageUrl;

  const tweetStatus = parseTwitterStatusUrl(pageUrl);
  const arxivId = parseArxivInput(pageUrl);
  if (tweetStatus) {
    setMode("source");
  } else if (arxivId) {
    paperInput.value = arxivId;
    setMode("source");
  } else {
    setMode("web");
  }
}

async function extractTweet() {
  if (!activeTabId) return;
  const status = parseTwitterStatusUrl(pageUrl);
  if (!status) {
    extractedTweet = null;
    renderTweetPreview();
    return;
  }

  extractedTweet = null;
  renderTweetPreview();

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: (targetTweetId) => {
        try {
          function absoluteUrl(raw) {
            const value = (raw || "").trim();
            if (!value) return "";
            try {
              return new URL(value, location.href).href;
            } catch {
              return "";
            }
          }

          function statusIdFromUrl(raw) {
            const url = absoluteUrl(raw);
            const match = url.match(/\/status\/(\d+)/);
            return match ? match[1] : "";
          }

          function uniqueStrings(values) {
            return [...new Set(values.filter(Boolean))];
          }

          function collectAuthor(article, skipFirst = false) {
            const blocks = Array.from(article.querySelectorAll('div[data-testid="User-Name"]'));
            const block = skipFirst ? blocks[1] : blocks[0];
            if (!block) return { authorName: "", authorHandle: "" };
            const spans = Array.from(block.querySelectorAll("span"))
              .map((node) => node.textContent?.trim() || "")
              .filter(Boolean);
            return {
              authorName: spans.find((value) => !value.startsWith("@") && value !== "·") || "",
              authorHandle: spans.find((value) => value.startsWith("@")) || "",
            };
          }

          const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
          const mainArticle = articles.find((article) =>
            Array.from(article.querySelectorAll('a[href*="/status/"]')).some((link) => statusIdFromUrl(link.href) === targetTweetId),
          );

          if (!mainArticle) {
            return { error: "Could not find the main tweet on this page." };
          }

          const statusLinks = uniqueStrings(
            Array.from(mainArticle.querySelectorAll('a[href*="/status/"]')).map((link) => absoluteUrl(link.href)),
          );
          const primaryUrl =
            statusLinks.find((url) => statusIdFromUrl(url) === targetTweetId) ||
            absoluteUrl(location.href);
          const textNodes = Array.from(mainArticle.querySelectorAll('div[data-testid="tweetText"]'))
            .map((node) => node.innerText.trim())
            .filter(Boolean);
          const timeNode = mainArticle.querySelector("time");
          const media = uniqueStrings(
            Array.from(mainArticle.querySelectorAll('[data-testid="tweetPhoto"] img'))
              .map((img) => absoluteUrl(img.getAttribute("src") || img.currentSrc || ""))
              .filter(Boolean),
          ).map((url, index) => ({ url, alt: `tweet-image-${index + 1}` }));

          const quoteUrl = statusLinks.find((url) => statusIdFromUrl(url) && statusIdFromUrl(url) !== targetTweetId) || "";
          const quoteText = textNodes.length > 1 ? textNodes[textNodes.length - 1] : "";
          const quotedAuthor = quoteUrl ? collectAuthor(mainArticle, true) : { authorName: "", authorHandle: "" };

          return {
            tweetId: targetTweetId,
            url: primaryUrl,
            authorName: collectAuthor(mainArticle).authorName,
            authorHandle: collectAuthor(mainArticle).authorHandle,
            createdAt: timeNode?.getAttribute("datetime") || "",
            text: textNodes[0] || "",
            media,
            quotedTweet: quoteUrl
              ? {
                  url: quoteUrl,
                  authorName: quotedAuthor.authorName,
                  authorHandle: quotedAuthor.authorHandle,
                  text: quoteText,
                }
              : null,
          };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      args: [status.tweetId],
    });

    const result = results?.[0]?.result;
    if (!result) {
      throw new Error("No tweet data returned from the page");
    }
    if (result.error) {
      throw new Error(result.error);
    }

    extractedTweet = result;
    renderTweetPreview();
  } catch (err) {
    extractedTweet = null;
    tweetPreview.textContent = `Tweet extraction failed: ${err.message}`;
    updateActionState();
  }
}

async function extractContent() {
  if (!activeTabId) return;
  webExtractionStarted = true;
  extractedContent = "";
  extractedAssets = [];
  contentPreview.textContent = "Extracting content...";
  updateActionState();

  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ["Readability.js", "Turndown.js"],
    });

    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: () => {
        try {
          const documentClone = document.cloneNode(true);
          const pageBaseUrl = document.baseURI || location.href;

          function toAbsoluteUrl(raw) {
            const value = (raw || "").trim();
            if (!value || value.startsWith("data:") || value.startsWith("blob:")) return "";
            return new URL(value, pageBaseUrl).href;
          }

          function bestSrcFromSet(srcset) {
            const candidates = (srcset || "")
              .split(",")
              .map((part) => {
                const pieces = part.trim().split(/\s+/);
                const url = pieces[0] || "";
                const descriptor = pieces[1] || "0w";
                const score = parseFloat(descriptor) || 0;
                return { url, score };
              })
              .filter((item) => item.url);
            candidates.sort((a, b) => b.score - a.score);
            return candidates[0]?.url || "";
          }

          function imageSource(img) {
            const directAttrs = ["src", "data-src", "data-original", "data-lazy-src", "data-url"];
            for (const attr of directAttrs) {
              const absolute = toAbsoluteUrl(img.getAttribute(attr));
              if (absolute) return absolute;
            }
            const srcset = img.getAttribute("srcset") || img.getAttribute("data-srcset") || "";
            return toAbsoluteUrl(bestSrcFromSet(srcset));
          }

          function mathNode(tex, display) {
            const node = documentClone.createElement(display ? "div" : "span");
            node.setAttribute("data-llm-math", tex.trim());
            node.setAttribute("data-llm-display", display ? "true" : "false");
            node.textContent = display ? `$$\n${tex.trim()}\n$$` : `$${tex.trim()}$`;
            return node;
          }

          documentClone.querySelectorAll('script[type^="math/tex"]').forEach((node) => {
            const tex = node.textContent || "";
            const display = (node.getAttribute("type") || "").includes("mode=display");
            if (tex.trim()) node.replaceWith(mathNode(tex, display));
          });

          documentClone.querySelectorAll(".katex").forEach((node) => {
            if (node.closest("[data-llm-math]")) return;
            const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
            const tex = annotation?.textContent || "";
            if (!tex.trim()) return;
            node.replaceWith(mathNode(tex, Boolean(node.closest(".katex-display"))));
          });

          documentClone.querySelectorAll("math").forEach((node) => {
            const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
            const tex = annotation?.textContent || "";
            if (tex.trim()) node.replaceWith(mathNode(tex, node.getAttribute("display") === "block"));
          });

          documentClone.querySelectorAll("a[href]").forEach((a) => {
            const href = toAbsoluteUrl(a.getAttribute("href"));
            if (href) a.setAttribute("href", href);
          });

          documentClone.querySelectorAll("img").forEach((img) => {
            const w = parseInt(img.getAttribute("width") || "999");
            const h = parseInt(img.getAttribute("height") || "999");
            if (w < 10 || h < 10) {
              img.remove();
              return;
            }
            const src = imageSource(img);
            if (src) img.setAttribute("src", src);
          });

          const reader = new window.Readability(documentClone);
          const article = reader.parse();

          if (!article || !article.content) {
            return { error: "Readability could not extract content" };
          }

          const container = document.createElement("div");
          container.innerHTML = article.content;
          const assets = [];
          const seenAssets = new Set();

          container.querySelectorAll("a[href]").forEach((a) => {
            const href = toAbsoluteUrl(a.getAttribute("href"));
            if (href) a.setAttribute("href", href);
          });

          container.querySelectorAll("img").forEach((img) => {
            const w = parseInt(img.getAttribute("width") || "999");
            const h = parseInt(img.getAttribute("height") || "999");
            if (w < 10 || h < 10) {
              img.remove();
              return;
            }
            const src = imageSource(img);
            if (!src) {
              img.remove();
              return;
            }
            img.setAttribute("src", src);
            img.removeAttribute("srcset");
            img.removeAttribute("data-srcset");
            if (!seenAssets.has(src)) {
              seenAssets.add(src);
              assets.push({ url: src, alt: img.getAttribute("alt") || "" });
            }
          });

          const turndown = new window.TurndownService({
            headingStyle: "atx",
            codeBlockStyle: "fenced",
            bulletListMarker: "-",
          });

          turndown.addRule("absoluteLink", {
            filter: (node) => node.nodeName === "A" && node.getAttribute("href"),
            replacement: (content, node) => {
              const href = node.getAttribute("href");
              const text = content.trim() || href;
              const title = node.getAttribute("title");
              const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
              return `[${text.replace(/\]/g, "\\]")}](${href.replace(/\)/g, "%29")}${titlePart})`;
            },
          });
          turndown.addRule("math", {
            filter: (node) => node.hasAttribute?.("data-llm-math"),
            replacement: (_content, node) => {
              const tex = node.getAttribute("data-llm-math").trim();
              if (node.getAttribute("data-llm-display") === "true") {
                return `\n\n$$\n${tex}\n$$\n\n`;
              }
              return `$${tex}$`;
            },
          });
          turndown.addRule("mathml", {
            filter: "math",
            replacement: (_content, node) => `\n\n${node.outerHTML}\n\n`,
          });
          turndown.addRule("figureCaption", {
            filter: "figcaption",
            replacement: (content) => {
              const text = content.trim();
              return text ? `\n\n_${text}_\n\n` : "";
            },
          });
          turndown.addRule("figure", {
            filter: "figure",
            replacement: (content) => `\n\n${content.trim()}\n\n`,
          });
          turndown.addRule("tableCell", {
            filter: ["th", "td"],
            replacement: (content) => ` ${content.trim()} |`,
          });
          turndown.addRule("tableRow", {
            filter: "tr",
            replacement: (content) => `|${content}\n`,
          });
          turndown.addRule("table", {
            filter: "table",
            replacement: (content) => {
              const lines = content.trim().split("\n");
              if (lines.length > 0) {
                const cols = (lines[0].match(/\|/g) || []).length - 1;
                const separator = "|" + " --- |".repeat(cols);
                lines.splice(1, 0, separator);
              }
              return "\n\n" + lines.join("\n") + "\n\n";
            },
          });

          turndown.addRule("removeSmallImages", {
            filter: (node) => {
              if (node.nodeName !== "IMG") return false;
              const w = parseInt(node.getAttribute("width") || "999");
              const h = parseInt(node.getAttribute("height") || "999");
              return w < 10 || h < 10;
            },
            replacement: () => "",
          });

          const markdown = turndown.turndown(container.innerHTML);

          return {
            title: article.title,
            content: markdown,
            assets,
            excerpt: article.excerpt || "",
            siteName: article.siteName || "",
            length: article.length || 0,
          };
        } catch (err) {
          return { error: err.message };
        }
      },
    });

    if (results?.[0]?.result) {
      const result = results[0].result;

      if (result.error) {
        contentPreview.textContent = `Extraction failed: ${result.error}. Falling back...`;
        await fallbackExtract(activeTabId);
        return;
      }

      if (result.title && result.title.length > 5) titleInput.value = result.title;

      extractedContent = result.content;
      extractedAssets = result.assets || [];
      contentPreview.textContent = result.excerpt
        ? "📝 " + result.excerpt + "\n\n---\n\n" + extractedContent
        : extractedContent;
      updateActionState();
    } else {
      await fallbackExtract(activeTabId);
    }
  } catch (err) {
    contentPreview.textContent = `Error: ${err.message}`;
    updateActionState();
  }
}

async function fallbackExtract(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["Turndown.js"],
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const clone = document.body.cloneNode(true);
      const pageBaseUrl = document.baseURI || location.href;

      function toAbsoluteUrl(raw) {
        const value = (raw || "").trim();
        if (!value || value.startsWith("data:") || value.startsWith("blob:")) return "";
        return new URL(value, pageBaseUrl).href;
      }

      function bestSrcFromSet(srcset) {
        const candidates = (srcset || "")
          .split(",")
          .map((part) => {
            const pieces = part.trim().split(/\s+/);
            const url = pieces[0] || "";
            const descriptor = pieces[1] || "0w";
            const score = parseFloat(descriptor) || 0;
            return { url, score };
          })
          .filter((item) => item.url);
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0]?.url || "";
      }

      function imageSource(img) {
        const directAttrs = ["src", "data-src", "data-original", "data-lazy-src", "data-url"];
        for (const attr of directAttrs) {
          const absolute = toAbsoluteUrl(img.getAttribute(attr));
          if (absolute) return absolute;
        }
        const srcset = img.getAttribute("srcset") || img.getAttribute("data-srcset") || "";
        return toAbsoluteUrl(bestSrcFromSet(srcset));
      }

      function mathNode(tex, display) {
        const node = document.createElement(display ? "div" : "span");
        node.setAttribute("data-llm-math", tex.trim());
        node.setAttribute("data-llm-display", display ? "true" : "false");
        node.textContent = display ? `$$\n${tex.trim()}\n$$` : `$${tex.trim()}$`;
        return node;
      }

      ["script:not([type^=\"math/tex\"])", "style", "nav", "header", "footer", ".sidebar", ".ad", ".comments"]
        .forEach((sel) => clone.querySelectorAll(sel).forEach((el) => el.remove()));

      clone.querySelectorAll('script[type^="math/tex"]').forEach((node) => {
        const tex = node.textContent || "";
        const display = (node.getAttribute("type") || "").includes("mode=display");
        if (tex.trim()) node.replaceWith(mathNode(tex, display));
      });

      clone.querySelectorAll(".katex").forEach((node) => {
        if (node.closest("[data-llm-math]")) return;
        const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
        const tex = annotation?.textContent || "";
        if (!tex.trim()) return;
        node.replaceWith(mathNode(tex, Boolean(node.closest(".katex-display"))));
      });

      clone.querySelectorAll("math").forEach((node) => {
        const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
        const tex = annotation?.textContent || "";
        if (tex.trim()) node.replaceWith(mathNode(tex, node.getAttribute("display") === "block"));
      });

      clone.querySelectorAll("a[href]").forEach((a) => {
        const href = toAbsoluteUrl(a.getAttribute("href"));
        if (href) a.setAttribute("href", href);
      });

      const assets = [];
      const seenAssets = new Set();
      clone.querySelectorAll("img").forEach((img) => {
        const w = parseInt(img.getAttribute("width") || "999");
        const h = parseInt(img.getAttribute("height") || "999");
        if (w < 10 || h < 10) {
          img.remove();
          return;
        }
        const src = imageSource(img);
        if (!src) {
          img.remove();
          return;
        }
        img.setAttribute("src", src);
        img.removeAttribute("srcset");
        img.removeAttribute("data-srcset");
        if (!seenAssets.has(src)) {
          seenAssets.add(src);
          assets.push({ url: src, alt: img.getAttribute("alt") || "" });
        }
      });

      const turndown = new window.TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        bulletListMarker: "-",
      });
      turndown.addRule("absoluteLink", {
        filter: (node) => node.nodeName === "A" && node.getAttribute("href"),
        replacement: (content, node) => {
          const href = node.getAttribute("href");
          const text = content.trim() || href;
          const title = node.getAttribute("title");
          const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
          return `[${text.replace(/\]/g, "\\]")}](${href.replace(/\)/g, "%29")}${titlePart})`;
        },
      });
      turndown.addRule("math", {
        filter: (node) => node.hasAttribute?.("data-llm-math"),
        replacement: (_content, node) => {
          const tex = node.getAttribute("data-llm-math").trim();
          if (node.getAttribute("data-llm-display") === "true") {
            return `\n\n$$\n${tex}\n$$\n\n`;
          }
          return `$${tex}$`;
        },
      });
      turndown.addRule("mathml", {
        filter: "math",
        replacement: (_content, node) => `\n\n${node.outerHTML}\n\n`,
      });
      turndown.addRule("figureCaption", {
        filter: "figcaption",
        replacement: (content) => {
          const text = content.trim();
          return text ? `\n\n_${text}_\n\n` : "";
        },
      });
      turndown.addRule("figure", {
        filter: "figure",
        replacement: (content) => `\n\n${content.trim()}\n\n`,
      });

      return {
        content: turndown.turndown(clone.innerHTML).slice(0, 50000),
        assets,
      };
    },
  });

  if (results?.[0]?.result) {
    extractedAssets = results[0].result.assets || [];
    extractedContent = results[0].result.content;
    contentPreview.textContent = extractedContent;
  } else {
    contentPreview.textContent = "Failed to extract content";
  }
  updateActionState();
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    let chunk = "";
    const end = Math.min(i + chunkSize, bytes.length);
    for (let j = i; j < end; j++) chunk += String.fromCharCode(bytes[j]);
    binary += chunk;
  }
  return btoa(binary);
}

function extensionForMime(mimeType) {
  const mime = (mimeType || "").split(";")[0].trim().toLowerCase();
  const map = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "image/avif": "avif",
  };
  return map[mime] || "img";
}

function sanitizeAssetFileName(name) {
  return (name || "image")
    .replace(/[?#].*$/, "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "image";
}

function clipAssetFileName(asset, index, mimeType) {
  let name = "";
  try {
    name = decodeURIComponent(new URL(asset.url).pathname.split("/").pop() || "");
  } catch {
    name = "";
  }
  name = sanitizeAssetFileName(name || asset.alt || `image-${index + 1}`);
  if (!/\.[A-Za-z0-9]{2,5}$/.test(name)) {
    name += `.${extensionForMime(mimeType)}`;
  }
  return `${String(index + 1).padStart(3, "0")}-${name}`;
}

async function downloadClipAssets(assets) {
  const downloaded = [];
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    setStatus("sending", `⏳ Downloading image ${i + 1}/${assets.length}...`);
    const res = await fetch(asset.url, { method: "GET" });
    if (!res.ok) throw new Error(`image HTTP ${res.status}: ${asset.url}`);
    const mimeType = res.headers.get("Content-Type") || "application/octet-stream";
    if (!mimeType.toLowerCase().startsWith("image/")) {
      throw new Error(`image URL returned ${mimeType}: ${asset.url}`);
    }
    const buffer = await res.arrayBuffer();
    downloaded.push({
      originalUrl: asset.url,
      fileName: clipAssetFileName(asset, i, mimeType),
      mimeType,
      dataBase64: arrayBufferToBase64(buffer),
    });
  }
  return downloaded;
}

async function sendClip() {
  const selectedProject = projectSelect.value;
  if (!selectedProject) {
    setStatus("error", "✗ Please select a project");
    return;
  }

  clipBtn.disabled = true;
  setStatus("sending", "⏳ Sending to LLM Wiki...");

  try {
    const assets = await downloadClipAssets(extractedAssets);
    if (assets.length > 0) setStatus("sending", "⏳ Sending page and images to LLM Wiki...");
    const res = await fetch(`${API_URL}/clip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: titleInput.value,
        url: pageUrl,
        content: extractedContent,
        projectPath: selectedProject,
        assets,
      }),
    });

    const data = await res.json();

    if (data.ok) {
      const projectName = projectSelect.options[projectSelect.selectedIndex]?.textContent || "project";
      setStatus("success", `✓ Saved to ${projectName}`);
      clipBtn.textContent = "✓ Clipped!";
    } else {
      setStatus("error", `✗ Error: ${data.error}`);
      updateActionState();
    }
  } catch (err) {
    setStatus("error", `✗ Connection failed: ${err.message}`);
    updateActionState();
  }
}

async function queueArxivSource() {
  const selectedProject = projectSelect.value;
  if (!selectedProject) {
    setStatus("error", "✗ Please select a project");
    return;
  }

  const arxivId = parseArxivInput(paperInput.value || pageUrl);
  if (!arxivId) {
    setStatus("error", "✗ Enter a valid arXiv URL, alphaXiv URL, or ID");
    return;
  }

  paperAddBtn.disabled = true;

  try {
    const projectName = projectSelect.options[projectSelect.selectedIndex]?.textContent || selectedProject;
    const response = await sendBackgroundMessage({
      type: "paperQueue/enqueue",
      kind: "arxiv",
      arxivId,
      projectPath: selectedProject,
      projectName,
      arxivSettings: currentArxivSettings,
    });
    setQueueTasks(response.tasks || queueTasks, true);
    setStatus(
      "success",
      response.duplicate
        ? `↺ ${arxivId} is already in the background queue`
        : `✓ Added ${arxivId} to the background queue`,
    );
    await sendBackgroundMessage({ type: "paperQueue/process" });
  } catch (err) {
    setStatus("error", `✗ Failed to queue source: ${err.message}`);
  } finally {
    updateActionState();
  }
}

async function queueTweetSource() {
  const selectedProject = projectSelect.value;
  if (!selectedProject) {
    setStatus("error", "✗ Please select a project");
    return;
  }
  if (!extractedTweet?.tweetId) {
    setStatus("error", "✗ Open a tweet status page and wait for it to parse");
    return;
  }

  paperAddBtn.disabled = true;
  try {
    const projectName = projectSelect.options[projectSelect.selectedIndex]?.textContent || selectedProject;
    const response = await sendBackgroundMessage({
      type: "paperQueue/enqueue",
      kind: "tweet",
      tweet: extractedTweet,
      projectPath: selectedProject,
      projectName,
    });
    setQueueTasks(response.tasks || queueTasks, true);
    setStatus(
      "success",
      response.duplicate
        ? `↺ Tweet ${extractedTweet.tweetId} is already in the background queue`
        : `✓ Added tweet ${extractedTweet.tweetId} to the background queue`,
    );
    await sendBackgroundMessage({ type: "paperQueue/process" });
  } catch (err) {
    setStatus("error", `✗ Failed to queue tweet: ${err.message}`);
  } finally {
    updateActionState();
  }
}

async function queueSource() {
  if (currentSourceKind === "tweet") {
    await queueTweetSource();
    return;
  }
  await queueArxivSource();
}

async function handlePaperQueueAction(action, taskId) {
  try {
    if (action === "retry") {
      await sendBackgroundMessage({ type: "paperQueue/retry", taskId });
      setStatus("success", "✓ Re-queued failed source");
    } else if (action === "remove") {
      await sendBackgroundMessage({ type: "paperQueue/remove", taskId });
      setStatus("success", "✓ Removed source from queue");
    } else {
      return;
    }
    queueStateVersion += 1;
    await loadPaperQueue();
    await sendBackgroundMessage({ type: "paperQueue/process" });
  } catch (err) {
    setStatus("error", `✗ Queue action failed: ${err.message}`);
  }
}

function resizePreview() {
  const totalHeight = 500;
  if (currentMode !== "web") return;
  const preview = document.getElementById("contentPreview");
  if (!preview) return;

  const previewRect = preview.getBoundingClientRect();
  const bottomSpace = totalHeight - previewRect.top - 60;
  const maxH = Math.max(100, Math.min(300, bottomSpace));
  preview.style.maxHeight = maxH + "px";
}

clipBtn.addEventListener("click", () => {
  sendClip();
});
paperAddBtn.addEventListener("click", () => queueSource());
webModeBtn.addEventListener("click", () => setMode("web"));
paperModeBtn.addEventListener("click", () => setMode("source"));
paperInput.addEventListener("input", () => {
  if (currentMode !== "source") return;
  setSourceKind("arxiv");
  updatePaperPreview();
});
paperInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && currentMode === "source" && currentSourceKind === "arxiv") {
    event.preventDefault();
    queueSource();
  }
});
for (const checkbox of [removeRefsCheckbox, removeTocCheckbox, removeCitationsCheckbox]) {
  checkbox.addEventListener("change", async () => {
    try {
      await persistArxivSettings();
      updatePaperPreview();
    } catch (err) {
      setStatus("error", `✗ Failed to save arXiv settings: ${err.message}`);
    }
  });
}
projectSelect.addEventListener("change", updateActionState);
refreshQueueBtn.addEventListener("click", () => loadPaperQueue());
clearDoneBtn.addEventListener("click", async () => {
  try {
    await sendBackgroundMessage({ type: "paperQueue/clearDone" });
    queueStateVersion += 1;
    await loadPaperQueue();
    setStatus("success", "✓ Cleared completed downloads");
  } catch (err) {
    setStatus("error", `✗ Failed to clear completed downloads: ${err.message}`);
  }
});
paperQueueList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-queue-action]");
  if (!button) return;
  handlePaperQueueAction(button.dataset.queueAction, button.dataset.taskId);
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "paperQueueUpdated") return;
  setQueueTasks(message.tasks || [], true);
});

(async () => {
  await loadArxivSettings();
  await checkConnection();
  await loadCurrentTab();
  await loadPaperQueue();
  updateActionState();
  setTimeout(resizePreview, 100);
})();
