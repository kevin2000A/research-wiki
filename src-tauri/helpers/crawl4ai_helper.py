#!/usr/bin/env python3
import argparse
import asyncio
import http.cookiejar
import json
import os
import shutil
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPCookieProcessor, Request, build_opener


DEFAULT_EXCLUDED_TAGS = ["header", "nav", "footer", "aside", "form"]
DEFAULT_WORD_COUNT_THRESHOLD = 10
DEFAULT_TIMEOUT_SECONDS = 120
DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
SPACES_EXCLUDED_SELECTOR = "#content_tips,#pay,#how_to_cite"


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


def ensure_markdown_title(markdown, title):
    markdown = markdown.strip()
    title = " ".join((title or "").split())
    if not title or has_initial_markdown_h1(markdown):
        return markdown
    return f"# {title}\n\n{markdown}"


def has_initial_markdown_h1(markdown):
    for line in markdown.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("!["):
            continue
        return stripped.startswith("# ")
    return False


def site_defaults(url):
    host = (urlparse(url).hostname or "").lower()
    if host == "spaces.ac.cn" or host.endswith(".spaces.ac.cn") or host == "kexue.fm" or host.endswith(".kexue.fm"):
        return {
            "cssSelector": "#PostContent",
            "excludedSelector": SPACES_EXCLUDED_SELECTOR,
        }
    if host == "shashankshekhar.com" or host.endswith(".shashankshekhar.com"):
        return {
            "cssSelector": "div.prose",
        }
    return {}


def merged_option(payload, defaults, key):
    value = payload.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return defaults.get(key, "")


def is_x_status_url(url):
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return host in ("x.com", "twitter.com") or host.endswith(".x.com") or host.endswith(".twitter.com")


def fetch_with_cookie_retry(url):
    curl_path = shutil.which("curl")
    if curl_path:
        return fetch_with_curl_cookie_retry(curl_path, url)

    cookie_jar = http.cookiejar.CookieJar()
    opener = build_opener(HTTPCookieProcessor(cookie_jar))

    def fetch_once():
        request = Request(
            url,
            headers={
                "User-Agent": DEFAULT_USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            },
        )
        try:
            response = opener.open(request, timeout=30)
            raw = response.read()
            charset = response.headers.get_content_charset() or "utf-8"
            return response.status, raw.decode(charset, errors="replace")
        except HTTPError as exc:
            raw = exc.read()
            charset = exc.headers.get_content_charset() or "utf-8"
            return exc.code, raw.decode(charset, errors="replace")
        except URLError as exc:
            raise RuntimeError(f"raw HTML fetch failed: {exc}") from exc

    first_status, first_html = fetch_once()
    second_status, second_html = fetch_once()
    if len(second_html.strip()) >= len(first_html.strip()):
        return second_status, second_html
    return first_status, first_html


def fetch_with_curl_cookie_retry(curl_path, url):
    cookie_file = tempfile.NamedTemporaryFile(prefix="llmwiki-crawl4ai-cookies-", delete=False)
    cookie_file.close()
    try:
        def fetch_once():
            marker = "\n__LLMWIKI_STATUS__:%{http_code}"
            completed = subprocess.run(
                [
                    curl_path,
                    "--silent",
                    "--show-error",
                    "--location",
                    "--max-time",
                    "30",
                    "--user-agent",
                    DEFAULT_USER_AGENT,
                    "--header",
                    "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "--header",
                    "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8",
                    "--cookie-jar",
                    cookie_file.name,
                    "--cookie",
                    cookie_file.name,
                    "--write-out",
                    marker,
                    url,
                ],
                check=True,
                capture_output=True,
            )
            text = completed.stdout.decode("utf-8", errors="replace")
            body, status = text.rsplit("\n__LLMWIKI_STATUS__:", 1)
            return int(status.strip()), body

        first_status, first_html = fetch_once()
        second_status, second_html = fetch_once()
        if len(second_html.strip()) >= len(first_html.strip()):
            return second_status, second_html
        return first_status, first_html
    finally:
        os.unlink(cookie_file.name)


def extract_html_title(soup, fallback_title, url):
    for selector in ["article h1", "main h1", "h1"]:
        node = soup.select_one(selector)
        if node:
            value = node.get_text(" ", strip=True).strip()
            if value:
                return value

    for selector, attr in [
        ('meta[property="og:title"]', "content"),
        ('meta[name="twitter:title"]', "content"),
        ("title", None),
    ]:
        node = soup.select_one(selector)
        if not node:
            continue
        value = node.get(attr, "") if attr else node.get_text(" ", strip=True)
        value = value.strip()
        if value:
            return value
    if fallback_title:
        return fallback_title
    parsed = urlparse(url)
    return parsed.netloc or "Blog Article"


def remove_noise(root, excluded_tags, excluded_selector):
    for selector in ["script", "style"]:
        for node in root.select(selector):
            node.decompose()
    for tag in excluded_tags:
        for node in root.find_all(tag):
            node.decompose()
    if excluded_selector:
        for node in root.select(excluded_selector):
            node.decompose()


def reject_known_stub_page(url, soup):
    if not is_x_status_url(url):
        return
    page_text = soup.get_text(" ", strip=True)
    if "JavaScript" in page_text and ("disabled" in page_text or "不可用" in page_text):
        raise RuntimeError("raw HTML returned X JavaScript-disabled shell")


def class_names(node):
    classes = node.get("class") or []
    if isinstance(classes, str):
        return classes.split()
    return classes


def preserve_tex_annotations(root):
    from bs4 import NavigableString

    for annotation in list(root.select('annotation[encoding="application/x-tex"]')):
        tex = annotation.get_text("", strip=False).strip()
        if not tex:
            continue

        math = annotation.find_parent("math")
        if math is None:
            continue

        container = math
        display = math.get("display") == "block"
        for parent in math.parents:
            classes = class_names(parent)
            if "katex" in classes:
                container = parent
            if "katex-display" in classes:
                container = parent
                display = True
                break
            if parent is root:
                break

        if display:
            replacement = f"\n\n$$\n{tex}\n$$\n\n"
        else:
            replacement = f"${tex}$"
        container.replace_with(NavigableString(replacement))


def raw_html_markdown(payload, url, title_hint, excluded_tags, css_selector, excluded_selector):
    from bs4 import BeautifulSoup
    from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator

    status_code, html = fetch_with_cookie_retry(url)
    if len(html.strip()) < 200:
        raise RuntimeError(f"raw HTML fetch returned too little content (HTTP {status_code}, {len(html)} bytes)")

    soup = BeautifulSoup(html, "html.parser")
    reject_known_stub_page(url, soup)
    if css_selector:
        root = soup.select_one(css_selector)
        if root is None:
            raise RuntimeError(f"raw HTML selector not found: {css_selector}")
    else:
        root = soup
    title = extract_html_title(soup, title_hint, url)
    remove_noise(root, excluded_tags, excluded_selector)
    preserve_tex_annotations(root)

    generator = DefaultMarkdownGenerator()
    markdown = markdown_text(generator.generate_markdown(str(root), base_url=url)).strip()
    if not markdown:
        raise RuntimeError("raw HTML markdown was empty")
    return {
        "ok": True,
        "title": title,
        "url": url,
        "markdown": ensure_markdown_title(markdown, title),
        "extractor": "crawl4ai-raw-html",
        "statusCode": status_code,
    }


async def browser_crawl_markdown(payload, url, title_hint, excluded_tags, word_count_threshold, css_selector, excluded_selector):
    from crawl4ai import AsyncWebCrawler
    from crawl4ai.async_configs import BrowserConfig, CrawlerRunConfig, CacheMode

    run_kwargs = {
        "cache_mode": CacheMode.BYPASS,
        "excluded_tags": excluded_tags,
        "word_count_threshold": int(word_count_threshold),
    }
    if css_selector:
        run_kwargs["css_selector"] = css_selector
    if excluded_selector:
        run_kwargs["excluded_selector"] = excluded_selector
    wait_for = (payload.get("waitFor") or "").strip()
    if wait_for:
        run_kwargs["wait_for"] = wait_for

    browser_config = BrowserConfig(
        headless=True,
        enable_stealth=True,
        user_agent=DEFAULT_USER_AGENT,
    )
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
        "markdown": ensure_markdown_title(markdown, result_title(result, title_hint, url)),
        "extractor": "crawl4ai-browser",
        "statusCode": getattr(result, "status_code", None),
    }


async def crawl_once(payload):
    try:
        import crawl4ai  # noqa: F401
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

    defaults = site_defaults(url)
    excluded_tags = payload.get("excludedTags") or DEFAULT_EXCLUDED_TAGS
    word_count_threshold = payload.get("wordCountThreshold") or DEFAULT_WORD_COUNT_THRESHOLD
    title_hint = (payload.get("title") or "").strip()
    css_selector = merged_option(payload, defaults, "cssSelector")
    excluded_selector = merged_option(payload, defaults, "excludedSelector")

    try:
        return raw_html_markdown(
            payload,
            url,
            title_hint,
            excluded_tags,
            css_selector,
            excluded_selector,
        )
    except Exception as raw_exc:
        result = await browser_crawl_markdown(
            payload,
            url,
            title_hint,
            excluded_tags,
            word_count_threshold,
            css_selector,
            excluded_selector,
        )
        result["rawHtmlError"] = str(raw_exc)
        return result


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
