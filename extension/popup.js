const API_URL = "http://127.0.0.1:19827";

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
const paperInput = document.getElementById("paperInput");
const paperPreview = document.getElementById("paperPreview");

let extractedContent = "";
let extractedAssets = [];
let pageUrl = "";
let activeTabId = null;
let appConnected = false;
let currentMode = "web";
let webExtractionStarted = false;

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

function safeArxivFileStem(arxivId) {
  return arxivId.replace(/[^A-Za-z0-9._-]/g, "-");
}

function paperUrls(arxivId) {
  return {
    abs: `https://arxiv.org/abs/${arxivId}`,
    source: `https://arxiv.org/e-print/${arxivId}`,
    pdf: `https://arxiv.org/pdf/${arxivId}`,
  };
}

function updateActionState() {
  if (!appConnected) {
    clipBtn.disabled = true;
    clipBtn.textContent = currentMode === "paper"
      ? "📄 App not running — cannot save"
      : "📎 App not running — cannot save";
    return;
  }

  if (currentMode === "paper") {
    const arxivId = parseArxivInput(paperInput.value || pageUrl);
    clipBtn.disabled = !arxivId || !projectSelect.value;
    clipBtn.textContent = "📄 Save arXiv Paper";
    return;
  }

  clipBtn.disabled = !extractedContent || !projectSelect.value;
  clipBtn.textContent = "📎 Clip to Wiki";
}

function updatePaperPreview() {
  const arxivId = parseArxivInput(paperInput.value || pageUrl);
  if (!arxivId) {
    paperPreview.textContent = "Enter an arXiv URL, alphaXiv URL, or paper ID.";
    updateActionState();
    return;
  }

  const urls = paperUrls(arxivId);
  paperPreview.textContent = [
    `ID: ${arxivId}`,
    `Source: ${urls.source}`,
    `PDF fallback: ${urls.pdf}`,
  ].join("\n");
  updateActionState();
}

function setMode(mode) {
  currentMode = mode;
  webModeBtn.classList.toggle("active", mode === "web");
  paperModeBtn.classList.toggle("active", mode === "paper");
  webFields.classList.toggle("hidden", mode !== "web");
  paperFields.classList.toggle("hidden", mode !== "paper");

  if (mode === "paper") {
    const currentId = parseArxivInput(pageUrl);
    if (!paperInput.value && currentId) paperInput.value = currentId;
    updatePaperPreview();
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

  const arxivId = parseArxivInput(pageUrl);
  if (arxivId) {
    paperInput.value = arxivId;
    setMode("paper");
  } else {
    setMode("web");
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

async function downloadPaperArtifact(arxivId) {
  const urls = paperUrls(arxivId);
  const stem = safeArxivFileStem(arxivId);

  try {
    setStatus("sending", "⏳ Downloading arXiv source package...");
    const sourceRes = await fetch(urls.source, { method: "GET" });
    if (!sourceRes.ok) throw new Error(`source HTTP ${sourceRes.status}`);
    const sourceType = sourceRes.headers.get("Content-Type") || "application/gzip";
    if (sourceType.toLowerCase().includes("text/html")) throw new Error("source returned HTML");
    const sourceBuffer = await sourceRes.arrayBuffer();
    return {
      artifactKind: "source",
      fileName: `${stem}-source.tar.gz`,
      mimeType: sourceType,
      sourceUrl: urls.source,
      buffer: sourceBuffer,
    };
  } catch (sourceErr) {
    setStatus("sending", `⏳ Source unavailable (${sourceErr.message}); downloading PDF...`);
    const pdfRes = await fetch(urls.pdf, { method: "GET" });
    if (!pdfRes.ok) throw new Error(`PDF HTTP ${pdfRes.status}`);
    const pdfBuffer = await pdfRes.arrayBuffer();
    return {
      artifactKind: "pdf",
      fileName: `${stem}.pdf`,
      mimeType: pdfRes.headers.get("Content-Type") || "application/pdf",
      sourceUrl: urls.pdf,
      buffer: pdfBuffer,
    };
  }
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

async function sendPaper() {
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

  clipBtn.disabled = true;

  try {
    const artifact = await downloadPaperArtifact(arxivId);
    setStatus("sending", `⏳ Sending ${artifact.artifactKind} to LLM Wiki...`);
    const res = await fetch(`${API_URL}/paper`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectPath: selectedProject,
        arxivId,
        artifactKind: artifact.artifactKind,
        fileName: artifact.fileName,
        mimeType: artifact.mimeType,
        sourceUrl: artifact.sourceUrl,
        dataBase64: arrayBufferToBase64(artifact.buffer),
      }),
    });

    const data = await res.json();
    if (data.ok) {
      const projectName = projectSelect.options[projectSelect.selectedIndex]?.textContent || "project";
      setStatus("success", `✓ Saved ${artifact.fileName} to ${projectName}`);
      clipBtn.textContent = "✓ Saved!";
    } else {
      setStatus("error", `✗ Error: ${data.error}`);
      updateActionState();
    }
  } catch (err) {
    setStatus("error", `✗ Paper clipping failed: ${err.message}`);
    updateActionState();
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
  if (currentMode === "paper") {
    sendPaper();
  } else {
    sendClip();
  }
});
webModeBtn.addEventListener("click", () => setMode("web"));
paperModeBtn.addEventListener("click", () => setMode("paper"));
paperInput.addEventListener("input", updatePaperPreview);
projectSelect.addEventListener("change", updateActionState);

(async () => {
  await checkConnection();
  await loadCurrentTab();
  updateActionState();
  setTimeout(resizePreview, 100);
})();
