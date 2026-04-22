#!/usr/bin/env python3
import argparse
import asyncio
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


DEFAULT_EXCLUDED_TAGS = ["header", "nav", "footer", "aside", "form"]
DEFAULT_WORD_COUNT_THRESHOLD = 10
DEFAULT_TIMEOUT_SECONDS = 120


def json_bytes(payload):
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def markdown_text(markdown):
    fit = getattr(markdown, "fit_markdown", None)
    if isinstance(fit, str) and fit.strip():
        return fit
    raw = getattr(markdown, "raw_markdown", None)
    if isinstance(raw, str) and raw.strip():
        return raw
    if isinstance(markdown, str):
        return markdown
    return str(markdown)


def result_title(result, fallback_title, url):
    metadata = getattr(result, "metadata", None)
    if isinstance(metadata, dict):
        title = metadata.get("title")
        if isinstance(title, str) and title.strip():
            return title.strip()
    title = getattr(result, "title", None)
    if isinstance(title, str) and title.strip():
        return title.strip()
    if fallback_title:
        return fallback_title
    parsed = urlparse(url)
    return parsed.netloc or "Blog Article"


async def crawl_once(payload):
    try:
        from crawl4ai import AsyncWebCrawler
        from crawl4ai.async_configs import BrowserConfig, CrawlerRunConfig, CacheMode
    except Exception as exc:
        raise RuntimeError(
            "crawl4ai is not installed or initialized. Run: "
            "python3 -m pip install -U crawl4ai && crawl4ai-setup && "
            "python3 -m playwright install chromium"
        ) from exc

    url = payload["url"].strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise RuntimeError("url must be http(s)")

    excluded_tags = payload.get("excludedTags") or DEFAULT_EXCLUDED_TAGS
    word_count_threshold = payload.get("wordCountThreshold") or DEFAULT_WORD_COUNT_THRESHOLD
    title_hint = (payload.get("title") or "").strip()

    run_kwargs = {
        "cache_mode": CacheMode.BYPASS,
        "excluded_tags": excluded_tags,
        "word_count_threshold": int(word_count_threshold),
    }
    css_selector = (payload.get("cssSelector") or "").strip()
    if css_selector:
        run_kwargs["css_selector"] = css_selector
    wait_for = (payload.get("waitFor") or "").strip()
    if wait_for:
        run_kwargs["wait_for"] = wait_for

    browser_config = BrowserConfig(headless=True)
    run_config = CrawlerRunConfig(**run_kwargs)

    async with AsyncWebCrawler(config=browser_config) as crawler:
        result = await asyncio.wait_for(
            crawler.arun(url=url, config=run_config),
            timeout=DEFAULT_TIMEOUT_SECONDS,
        )

    if not result.success:
        error_message = getattr(result, "error_message", "") or "unknown crawl4ai error"
        status_code = getattr(result, "status_code", None)
        status_text = f" HTTP {status_code}" if status_code else ""
        raise RuntimeError(f"crawl4ai success=false{status_text}: {error_message}")

    markdown = markdown_text(result.markdown).strip()
    if not markdown:
        raise RuntimeError("crawl4ai returned empty markdown")

    return {
        "ok": True,
        "title": result_title(result, title_hint, url),
        "url": url,
        "markdown": markdown,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "LLMWikiCrawl4AI/0.1"

    def send_json(self, status, payload):
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/status":
            self.send_json(200, {"ok": True, "service": "crawl4ai-helper"})
        else:
            self.send_json(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        if self.path != "/crawl":
            self.send_json(404, {"ok": False, "error": "Not found"})
            return

        length = int(self.headers.get("Content-Length") or "0")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
            result = asyncio.run(crawl_once(payload))
            self.send_json(200, result)
        except asyncio.TimeoutError:
            self.send_json(504, {"ok": False, "error": "crawl4ai timed out after 120 seconds"})
        except Exception as exc:
            self.send_json(500, {"ok": False, "error": str(exc)})

    def log_message(self, fmt, *args):
        print("[crawl4ai-helper] " + (fmt % args), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=19828)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[crawl4ai-helper] listening on http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
