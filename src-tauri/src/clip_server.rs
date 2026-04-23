use std::sync::Mutex;
use std::sync::atomic::{AtomicU8, Ordering};
use std::thread;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;
use flate2::read::GzDecoder;
use base64::{engine::general_purpose, Engine as _};
use tiny_http::{Header, Method, Response, Server};

static CURRENT_PROJECT: Mutex<String> = Mutex::new(String::new());
static ALL_PROJECTS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new()); // (name, path)
static PENDING_CLIPS: Mutex<Vec<(String, String, bool)>> = Mutex::new(Vec::new()); // (projectPath, filePath, autoIngest)

/// Daemon status: 0=starting, 1=running, 2=port_conflict, 3=error
static DAEMON_STATUS: AtomicU8 = AtomicU8::new(0);

const PORT: u16 = 19827;
const MAX_BIND_RETRIES: u32 = 3;
const MAX_RESTART_RETRIES: u32 = 10;
const BIND_RETRY_DELAY_SECS: u64 = 2;
const RESTART_DELAY_SECS: u64 = 5;
const ARXIV2MD_MARKDOWN_API: &str = "https://arxiv2md.org/api/markdown";
const ARXIV2MD_METADATA_API: &str = "https://arxiv2md.org/api/json";
const CRAWL4AI_HELPER_PORT: u16 = 19828;

/// Get current daemon status as a string
pub fn get_daemon_status() -> &'static str {
    match DAEMON_STATUS.load(Ordering::Relaxed) {
        0 => "starting",
        1 => "running",
        2 => "port_conflict",
        _ => "error",
    }
}

pub fn start_clip_server() {
    thread::spawn(|| {
        let mut restart_count: u32 = 0;

        loop {
            // Try to bind the port with retries
            let server = {
                let mut last_err = String::new();
                let mut bound = None;
                for attempt in 1..=MAX_BIND_RETRIES {
                    match Server::http(format!("127.0.0.1:{}", PORT)) {
                        Ok(s) => {
                            bound = Some(s);
                            break;
                        }
                        Err(e) => {
                            last_err = format!("{}", e);
                            eprintln!(
                                "[Clip Server] Bind attempt {}/{} failed: {}",
                                attempt, MAX_BIND_RETRIES, e
                            );
                            if attempt < MAX_BIND_RETRIES {
                                thread::sleep(std::time::Duration::from_secs(BIND_RETRY_DELAY_SECS));
                            }
                        }
                    }
                }
                match bound {
                    Some(s) => s,
                    None => {
                        eprintln!(
                            "[Clip Server] Port {} unavailable after {} attempts: {}",
                            PORT, MAX_BIND_RETRIES, last_err
                        );
                        DAEMON_STATUS.store(2, Ordering::Relaxed); // port_conflict
                        return; // Don't retry on port conflict — needs user action
                    }
                }
            };

            DAEMON_STATUS.store(1, Ordering::Relaxed); // running
            restart_count = 0; // Reset on successful bind
            println!("[Clip Server] Listening on http://127.0.0.1:{}", PORT);

        for mut request in server.incoming_requests() {
            let cors_headers = vec![
                Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap(),
                Header::from_bytes("Access-Control-Allow-Methods", "GET, POST, OPTIONS").unwrap(),
                Header::from_bytes("Access-Control-Allow-Headers", "Content-Type").unwrap(),
                Header::from_bytes("Content-Type", "application/json").unwrap(),
            ];

            // Handle CORS preflight
            if request.method() == &Method::Options {
                let mut response = Response::from_string("").with_status_code(204);
                for h in &cors_headers {
                    response.add_header(h.clone());
                }
                let _ = request.respond(response);
                continue;
            }

            let url = request.url().to_string();

            match (request.method(), url.as_str()) {
                (&Method::Get, "/status") => {
                    let body = r#"{"ok":true,"version":"0.1.0"}"#;
                    let mut response = Response::from_string(body);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
                (&Method::Get, "/project") => {
                    let path = CURRENT_PROJECT.lock().unwrap().clone();
                    // serde_json handles backslash escaping so a Windows
                    // path that somehow still contains `\` won't break
                    // the JSON parser on the client.
                    let body = serde_json::json!({
                        "ok": true,
                        "path": path,
                    }).to_string();
                    let mut response = Response::from_string(body);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
                (&Method::Post, "/project") => {
                    let mut body = String::new();
                    if let Err(e) = request.as_reader().read_to_string(&mut body) {
                        let err =
                            format!(r#"{{"ok":false,"error":"Failed to read body: {}"}}"#, e);
                        let mut response = Response::from_string(err).with_status_code(400);
                        for h in &cors_headers {
                            response.add_header(h.clone());
                        }
                        let _ = request.respond(response);
                        continue;
                    }

                    let result = handle_set_project(&body);
                    let status = if result.contains(r#""ok":true"#) {
                        200
                    } else {
                        400
                    };
                    let mut response = Response::from_string(result).with_status_code(status);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
                (&Method::Get, "/projects") => {
                    let projects = ALL_PROJECTS.lock().unwrap().clone();
                    let current = CURRENT_PROJECT.lock().unwrap().clone();
                    // serde_json for proper escaping of `\`, `"`, and any
                    // other characters that might appear in a project name
                    // or path. Previously only `"` was escaped by hand,
                    // which broke on Windows paths containing backslashes.
                    let items: Vec<serde_json::Value> = projects.iter()
                        .map(|(name, path)| serde_json::json!({
                            "name": name,
                            "path": path,
                            "current": path == &current,
                        }))
                        .collect();
                    let body = serde_json::json!({
                        "ok": true,
                        "projects": items,
                    }).to_string();
                    let mut response = Response::from_string(body);
                    for h in &cors_headers { response.add_header(h.clone()); }
                    let _ = request.respond(response);
                }
                (&Method::Post, "/projects") => {
                    let mut body = String::new();
                    if request.as_reader().read_to_string(&mut body).is_ok() {
                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) {
                            if let Some(arr) = parsed["projects"].as_array() {
                                let mut projects = ALL_PROJECTS.lock().unwrap();
                                projects.clear();
                                for item in arr {
                                    let name = item["name"].as_str().unwrap_or("").to_string();
                                    let path = item["path"].as_str().unwrap_or("").to_string();
                                    if !path.is_empty() {
                                        projects.push((name, path));
                                    }
                                }
                            }
                        }
                    }
                    let mut response = Response::from_string(r#"{"ok":true}"#);
                    for h in &cors_headers { response.add_header(h.clone()); }
                    let _ = request.respond(response);
                }
                (&Method::Get, "/clips/pending") => {
                    let mut pending = PENDING_CLIPS.lock().unwrap();
                    let clips_json: Vec<serde_json::Value> = pending.iter()
                        .map(|(proj, file, auto_ingest)| serde_json::json!({
                            "projectPath": proj,
                            "filePath": file,
                            "autoIngest": auto_ingest,
                        }))
                        .collect();
                    let body = serde_json::json!({
                        "ok": true,
                        "clips": clips_json,
                    }).to_string();
                    pending.clear();
                    let mut response = Response::from_string(body);
                    for h in &cors_headers { response.add_header(h.clone()); }
                    let _ = request.respond(response);
                }
                (&Method::Post, "/clip") => {
                    let mut body = String::new();
                    if let Err(e) = request.as_reader().read_to_string(&mut body) {
                        let err =
                            format!(r#"{{"ok":false,"error":"Failed to read body: {}"}}"#, e);
                        let mut response = Response::from_string(err).with_status_code(400);
                        for h in &cors_headers {
                            response.add_header(h.clone());
                        }
                        let _ = request.respond(response);
                        continue;
                    }

                    let result = handle_clip(&body);
                    let status = if result.contains(r#""ok":true"#) {
                        200
                    } else {
                        500
                    };
                    let mut response = Response::from_string(result).with_status_code(status);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
                (&Method::Post, "/blog") => {
                    let mut body = String::new();
                    if let Err(e) = request.as_reader().read_to_string(&mut body) {
                        let err =
                            format!(r#"{{"ok":false,"error":"Failed to read body: {}"}}"#, e);
                        let mut response = Response::from_string(err).with_status_code(400);
                        for h in &cors_headers {
                            response.add_header(h.clone());
                        }
                        let _ = request.respond(response);
                        continue;
                    }

                    let result = handle_blog(&body);
                    let status = if result.contains(r#""ok":true"#) {
                        200
                    } else {
                        500
                    };
                    let mut response = Response::from_string(result).with_status_code(status);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
                (&Method::Post, "/paper") => {
                    let mut body = String::new();
                    if let Err(e) = request.as_reader().read_to_string(&mut body) {
                        let err =
                            format!(r#"{{"ok":false,"error":"Failed to read body: {}"}}"#, e);
                        let mut response = Response::from_string(err).with_status_code(400);
                        for h in &cors_headers {
                            response.add_header(h.clone());
                        }
                        let _ = request.respond(response);
                        continue;
                    }

                    let result = handle_paper(&body);
                    let status = if result.contains(r#""ok":true"#) {
                        200
                    } else {
                        500
                    };
                    let mut response = Response::from_string(result).with_status_code(status);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
                (&Method::Post, "/tweet") => {
                    let mut body = String::new();
                    if let Err(e) = request.as_reader().read_to_string(&mut body) {
                        let err =
                            format!(r#"{{"ok":false,"error":"Failed to read body: {}"}}"#, e);
                        let mut response = Response::from_string(err).with_status_code(400);
                        for h in &cors_headers {
                            response.add_header(h.clone());
                        }
                        let _ = request.respond(response);
                        continue;
                    }

                    let result = handle_tweet(&body);
                    let status = if result.contains(r#""ok":true"#) {
                        200
                    } else {
                        500
                    };
                    let mut response = Response::from_string(result).with_status_code(status);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
                _ => {
                    let body = r#"{"ok":false,"error":"Not found"}"#;
                    let mut response = Response::from_string(body).with_status_code(404);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    let _ = request.respond(response);
                }
            }
        }

            // Server loop exited (shouldn't happen normally)
            DAEMON_STATUS.store(3, Ordering::Relaxed); // error
            restart_count += 1;

            if restart_count >= MAX_RESTART_RETRIES {
                eprintln!(
                    "[Clip Server] Exceeded max restarts ({}). Giving up.",
                    MAX_RESTART_RETRIES
                );
                return;
            }

            eprintln!(
                "[Clip Server] Crashed. Restarting in {}s (attempt {}/{})",
                RESTART_DELAY_SECS, restart_count, MAX_RESTART_RETRIES
            );
            thread::sleep(std::time::Duration::from_secs(RESTART_DELAY_SECS));
        }
    });
}

fn handle_set_project(body: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"ok":false,"error":"Invalid JSON: {}"}}"#, e),
    };

    let path = match parsed["path"].as_str() {
        // Normalize to forward slashes on ingress so downstream
        // comparisons against frontend-normalized paths succeed.
        Some(p) => p.replace('\\', "/"),
        None => return r#"{"ok":false,"error":"path field is required"}"#.to_string(),
    };

    match CURRENT_PROJECT.lock() {
        Ok(mut guard) => {
            *guard = path;
            r#"{"ok":true}"#.to_string()
        }
        Err(e) => format!(r#"{{"ok":false,"error":"Lock error: {}"}}"#, e),
    }
}

fn handle_clip(body: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"ok":false,"error":"Invalid JSON: {}"}}"#, e),
    };

    let title = parsed["title"].as_str().unwrap_or("Untitled");
    let url = parsed["url"].as_str().unwrap_or("");
    let mut content = parsed["content"].as_str().unwrap_or("").to_string();

    // Use projectPath from request body, or fall back to globally-set project path
    let project_path_from_body = parsed["projectPath"].as_str().unwrap_or("").to_string();
    let project_path = if project_path_from_body.is_empty() {
        match CURRENT_PROJECT.lock() {
            Ok(guard) => guard.clone(),
            Err(e) => return format!(r#"{{"ok":false,"error":"Lock error: {}"}}"#, e),
        }
    } else {
        project_path_from_body
    };
    // Normalize to forward slashes so string comparisons against the
    // frontend-side project path (already normalized) succeed on Windows.
    let project_path = project_path.replace('\\', "/");

    if project_path.is_empty() {
        return r#"{"ok":false,"error":"projectPath is required (set via POST /project or include in request body)"}"#
            .to_string();
    }

    if content.is_empty() {
        return r#"{"ok":false,"error":"content is required"}"#.to_string();
    }

    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let date_compact = chrono::Local::now().format("%Y%m%d").to_string();

    // Generate slug from title
    let slug_raw: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase();
    let slug: String = slug_raw.chars().take(50).collect();

    let base_name = format!("{}-{}", slug, date_compact);
    // Use PathBuf for cross-platform path construction
    let dir_path = std::path::Path::new(&project_path).join("raw").join("sources");

    // Ensure directory exists
    if let Err(e) = std::fs::create_dir_all(&dir_path) {
        return format!(
            r#"{{"ok":false,"error":"Failed to create directory: {}"}}"#,
            e
        );
    }

    // Find unique filename
    let mut file_path = dir_path.join(format!("{}.md", base_name));
    let mut counter = 2u32;
    while file_path.exists() {
        file_path = dir_path.join(format!("{}-{}.md", base_name, counter));
        counter += 1;
    }
    let source_stem = file_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let file_path_str = file_path.to_string_lossy().replace('\\', "/");

    if let Some(assets) = parsed["assets"].as_array() {
        match save_clip_assets(&project_path, &source_stem, &content, assets) {
            Ok(updated) => content = updated,
            Err(e) => {
                return format!(
                    r#"{{"ok":false,"error":"Failed to save clip assets: {}"}}"#,
                    e
                );
            }
        }
    }

    // Build markdown content with web-clip origin
    let markdown = format!(
        "---\ntype: clip\ntitle: \"{}\"\nurl: \"{}\"\nclipped: {}\norigin: web-clip\nsources: []\ntags: [web-clip]\n---\n\n# {}\n\nSource: {}\n\n{}\n",
        title.replace('"', r#"\""#),
        url.replace('"', r#"\""#),
        date,
        title,
        url,
        content,
    );

    if let Err(e) = std::fs::write(&file_path, &markdown) {
        return format!(
            r#"{{"ok":false,"error":"Failed to write file: {}"}}"#,
            e
        );
    }

    // Compute relative path using Path for cross-platform separator handling
    let relative_path = {
        let full = &file_path;
        let base = std::path::Path::new(&project_path);
        full.strip_prefix(base)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| file_path_str.clone())
    };

    // Add to pending clips so frontend refreshes raw sources. Ingest is queued manually.
    if let Ok(mut pending) = PENDING_CLIPS.lock() {
        pending.push((project_path, file_path_str.clone(), false));
    }

    serde_json::json!({
        "ok": true,
        "path": relative_path,
    }).to_string()
}

fn handle_blog(body: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"ok":false,"error":"Invalid JSON: {}"}}"#, e),
    };

    let project_path = match parsed["projectPath"].as_str() {
        Some(p) if !p.is_empty() => p.replace('\\', "/"),
        _ => return r#"{"ok":false,"error":"projectPath is required"}"#.to_string(),
    };
    let url = match parsed["url"].as_str() {
        Some(u) if !u.is_empty() => u,
        _ => return r#"{"ok":false,"error":"url is required"}"#.to_string(),
    };
    let title = parsed["title"].as_str().unwrap_or("");

    let mut crawl_payload = serde_json::Map::new();
    crawl_payload.insert("url".to_string(), serde_json::Value::String(url.to_string()));
    if !title.is_empty() {
        crawl_payload.insert("title".to_string(), serde_json::Value::String(title.to_string()));
    }
    if let Some(options) = parsed["crawlOptions"].as_object() {
        for key in [
            "cssSelector",
            "excludedSelector",
            "waitFor",
            "excludedTags",
            "wordCountThreshold",
        ] {
            if let Some(value) = options.get(key) {
                crawl_payload.insert(key.to_string(), value.clone());
            }
        }
    }

    let crawled = match call_crawl4ai_helper(&serde_json::Value::Object(crawl_payload)) {
        Ok(value) => value,
        Err(error) => {
            return serde_json::json!({
                "ok": false,
                "error": error,
            })
            .to_string()
        }
    };

    let markdown = match crawled["markdown"].as_str() {
        Some(m) if !m.trim().is_empty() => m,
        _ => return r#"{"ok":false,"error":"crawl4ai helper returned empty markdown"}"#.to_string(),
    };
    let crawled_title = crawled["title"]
        .as_str()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("Blog Article");
    let crawled_url = crawled["url"].as_str().unwrap_or(url);

    let clip_body = serde_json::json!({
        "title": crawled_title,
        "url": crawled_url,
        "content": markdown,
        "projectPath": project_path,
        "assets": [],
    })
    .to_string();
    let result = handle_clip(&clip_body);
    let mut response: serde_json::Value = match serde_json::from_str(&result) {
        Ok(value) => value,
        Err(_) => return result,
    };
    if response["ok"].as_bool().unwrap_or(false) {
        response["title"] = serde_json::Value::String(crawled_title.to_string());
        response["url"] = serde_json::Value::String(crawled_url.to_string());
        response["extractor"] = serde_json::Value::String("crawl4ai-local".to_string());
    }
    response.to_string()
}

fn call_crawl4ai_helper(payload: &serde_json::Value) -> Result<serde_json::Value, String> {
    let body = payload.to_string();
    let addr = SocketAddr::from(([127, 0, 0, 1], CRAWL4AI_HELPER_PORT));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|e| {
        format!(
            "crawl4ai helper is not running on http://127.0.0.1:{}. Install dependencies with: python3 -m pip install -U crawl4ai && crawl4ai-setup && python3 -m playwright install chromium. Connection error: {}",
            CRAWL4AI_HELPER_PORT, e
        )
    })?;
    stream
        .set_read_timeout(Some(Duration::from_secs(180)))
        .map_err(|e| format!("Failed to set crawl4ai helper read timeout: {}", e))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(30)))
        .map_err(|e| format!("Failed to set crawl4ai helper write timeout: {}", e))?;

    let request = format!(
        "POST /crawl HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        CRAWL4AI_HELPER_PORT,
        body.as_bytes().len(),
        body
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("Failed to write crawl4ai helper request: {}", e))?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|e| format!("Failed to read crawl4ai helper response: {}", e))?;

    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "Invalid crawl4ai helper HTTP response".to_string())?;
    let status_code = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(500);
    let parsed: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("Invalid JSON from crawl4ai helper: {}", e))?;
    if status_code >= 400 || !parsed["ok"].as_bool().unwrap_or(false) {
        let error = parsed["error"]
            .as_str()
            .unwrap_or("crawl4ai helper request failed");
        return Err(format!("crawl4ai helper HTTP {}: {}", status_code, error));
    }
    Ok(parsed)
}

fn handle_tweet(body: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"ok":false,"error":"Invalid JSON: {}"}}"#, e),
    };

    let project_path = match parsed["projectPath"].as_str() {
        Some(p) if !p.is_empty() => p.replace('\\', "/"),
        _ => return r#"{"ok":false,"error":"projectPath is required"}"#.to_string(),
    };
    let tweet = &parsed["tweet"];
    let tweet_id = match tweet["tweetId"].as_str() {
        Some(id) if !id.is_empty() => id,
        _ => return r#"{"ok":false,"error":"tweet.tweetId is required"}"#.to_string(),
    };
    let url = tweet["url"].as_str().unwrap_or("");
    let author_name = tweet["authorName"].as_str().unwrap_or("");
    let author_handle = tweet["authorHandle"].as_str().unwrap_or("");
    let created_at = tweet["createdAt"].as_str().unwrap_or("");
    let text = tweet["text"].as_str().unwrap_or("").trim();

    let dir_path = std::path::Path::new(&project_path).join("raw").join("sources");
    if let Err(e) = std::fs::create_dir_all(&dir_path) {
        return format!(
            r#"{{"ok":false,"error":"Failed to create directory: {}"}}"#,
            e
        );
    }

    let handle_slug = sanitize_file_name(author_handle.trim_start_matches('@'));
    let stem = if handle_slug.is_empty() {
        format!("tweet-{}", sanitize_file_name(tweet_id))
    } else {
        format!("{}-{}", handle_slug, sanitize_file_name(tweet_id))
    };
    let file_path = unique_file_path(&dir_path, &format!("{}.md", stem));
    let file_path_str = file_path.to_string_lossy().replace('\\', "/");
    let source_stem = file_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let media_markdown = tweet["media"]
        .as_array()
        .map(|items| {
            items.iter()
                .filter_map(|item| item["url"].as_str())
                .map(|media_url| format!("![tweet media]({})", media_url))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let related_tweet = if tweet["relatedTweet"].is_object() {
        &tweet["relatedTweet"]
    } else {
        &tweet["quotedTweet"]
    };
    let related_markdown = if related_tweet.is_object() {
        let related_kind = related_tweet["kind"].as_str().unwrap_or("quote");
        let related_heading = if related_kind == "repost" {
            "Reposted Tweet"
        } else {
            "Quoted Tweet"
        };
        let related_url = related_tweet["url"].as_str().unwrap_or("");
        let related_author_name = related_tweet["authorName"].as_str().unwrap_or("");
        let related_author_handle = related_tweet["authorHandle"].as_str().unwrap_or("");
        let related_created_at = related_tweet["createdAt"].as_str().unwrap_or("");
        let related_text = related_tweet["text"].as_str().unwrap_or("").trim();
        let related_media_markdown = related_tweet["media"]
            .as_array()
            .map(|items| {
                items.iter()
                    .filter_map(|item| item["url"].as_str())
                    .map(|media_url| format!("![tweet media]({})", media_url))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if related_url.is_empty() && related_text.is_empty() && related_media_markdown.is_empty() {
            String::new()
        } else {
            let mut related_section = format!(
                "\n## {}\n\nAuthor: {} {}\n\nURL: {}\n\nCreated: {}\n\n### Content\n\n{}\n",
                related_heading,
                related_author_name,
                related_author_handle,
                related_url,
                related_created_at,
                related_text
            );
            if !related_media_markdown.is_empty() {
                related_section.push_str("\n### Media\n\n");
                related_section.push_str(&related_media_markdown.join("\n\n"));
                related_section.push('\n');
            }
            related_section
        }
    } else {
        String::new()
    };

    let mut content = format!(
        "# Tweet\n\nSource: {}\n\nAuthor: {} {}\n\nCreated: {}\n\n## Content\n\n{}\n",
        url,
        author_name,
        author_handle,
        created_at,
        text,
    );
    if !media_markdown.is_empty() {
        content.push_str("\n## Media\n\n");
        content.push_str(&media_markdown.join("\n\n"));
        content.push('\n');
    }
    content.push_str(&related_markdown);

    if let Some(assets) = parsed["assets"].as_array() {
        match save_tweet_assets(&project_path, &source_stem, &content, assets) {
            Ok(updated) => content = updated,
            Err(e) => {
                return format!(
                    r#"{{"ok":false,"error":"Failed to save tweet assets: {}"}}"#,
                    e
                );
            }
        }
    }

    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let title = if author_name.is_empty() {
        format!("Tweet {}", tweet_id)
    } else {
        format!("Tweet by {}", author_name)
    };
    let markdown = format!(
        "---\ntype: twitter-post\ntitle: \"{}\"\ntweet_id: \"{}\"\nurl: \"{}\"\nauthor_name: \"{}\"\nauthor_handle: \"{}\"\ncreated_at: \"{}\"\nclipped: {}\norigin: twitter\nsources: []\ntags: [twitter, x, social]\n---\n\n{}",
        yaml_escape(&title),
        yaml_escape(tweet_id),
        yaml_escape(url),
        yaml_escape(author_name),
        yaml_escape(author_handle),
        yaml_escape(created_at),
        date,
        content,
    );

    if let Err(e) = std::fs::write(&file_path, markdown) {
        return format!(
            r#"{{"ok":false,"error":"Failed to write tweet file: {}"}}"#,
            e
        );
    }

    let relative_path = {
        let base = std::path::Path::new(&project_path);
        file_path
            .strip_prefix(base)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| file_path_str.replace('\\', "/"))
    };

    if let Ok(mut pending) = PENDING_CLIPS.lock() {
        pending.push((project_path, file_path_str, false));
    }

    format!(r#"{{"ok":true,"path":"{}"}}"#, relative_path)
}

fn save_clip_assets(
    project_path: &str,
    source_stem: &str,
    content: &str,
    assets: &[serde_json::Value],
) -> Result<String, String> {
    if assets.is_empty() {
        return Ok(content.to_string());
    }

    let asset_dir_name = sanitize_file_name(source_stem);
    let asset_dir = std::path::Path::new(project_path)
        .join("raw")
        .join("assets")
        .join("web-clips")
        .join(&asset_dir_name);
    std::fs::create_dir_all(&asset_dir)
        .map_err(|e| format!("Failed to create clip asset directory: {}", e))?;

    let mut updated = content.to_string();
    for asset in assets {
        let original_url = asset["originalUrl"]
            .as_str()
            .ok_or_else(|| "asset originalUrl is required".to_string())?;
        let file_name = asset["fileName"]
            .as_str()
            .map(sanitize_file_name)
            .ok_or_else(|| "asset fileName is required".to_string())?;
        let data_base64 = asset["dataBase64"]
            .as_str()
            .ok_or_else(|| "asset dataBase64 is required".to_string())?;
        let bytes = general_purpose::STANDARD
            .decode(data_base64)
            .map_err(|e| format!("Invalid asset base64 data: {}", e))?;

        let saved_path = unique_file_path(&asset_dir, &file_name);
        std::fs::write(&saved_path, bytes)
            .map_err(|e| format!("Failed to write clip asset: {}", e))?;

        let saved_name = saved_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        let relative = format!(
            "../assets/web-clips/{}/{}",
            asset_dir_name,
            saved_name
        );
        updated = updated.replace(original_url, &relative);
    }

    Ok(updated)
}

fn save_tweet_assets(
    project_path: &str,
    source_stem: &str,
    content: &str,
    assets: &[serde_json::Value],
) -> Result<String, String> {
    if assets.is_empty() {
        return Ok(content.to_string());
    }

    let asset_dir_name = sanitize_file_name(source_stem);
    let asset_dir = std::path::Path::new(project_path)
        .join("raw")
        .join("assets")
        .join("twitter")
        .join(&asset_dir_name);
    std::fs::create_dir_all(&asset_dir)
        .map_err(|e| format!("Failed to create tweet asset directory: {}", e))?;

    let mut updated = content.to_string();
    for asset in assets {
        let original_url = asset["originalUrl"]
            .as_str()
            .ok_or_else(|| "asset originalUrl is required".to_string())?;
        let file_name = asset["fileName"]
            .as_str()
            .map(sanitize_file_name)
            .ok_or_else(|| "asset fileName is required".to_string())?;
        let data_base64 = asset["dataBase64"]
            .as_str()
            .ok_or_else(|| "asset dataBase64 is required".to_string())?;
        let bytes = general_purpose::STANDARD
            .decode(data_base64)
            .map_err(|e| format!("Invalid asset base64 data: {}", e))?;

        let saved_path = unique_file_path(&asset_dir, &file_name);
        std::fs::write(&saved_path, bytes)
            .map_err(|e| format!("Failed to write tweet asset: {}", e))?;

        let saved_name = saved_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        let relative = format!("../assets/twitter/{}/{}", asset_dir_name, saved_name);
        updated = updated.replace(original_url, &relative);
    }

    Ok(updated)
}

fn handle_paper(body: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"ok":false,"error":"Invalid JSON: {}"}}"#, e),
    };

    let project_path = match parsed["projectPath"].as_str() {
        Some(p) if !p.is_empty() => p.replace('\\', "/"),
        _ => return r#"{"ok":false,"error":"projectPath is required"}"#.to_string(),
    };
    let arxiv_id = match parsed["arxivId"].as_str() {
        Some(id) if !id.is_empty() => id,
        _ => return r#"{"ok":false,"error":"arxivId is required"}"#.to_string(),
    };
    let source_url = parsed["sourceUrl"].as_str().unwrap_or("");
    let paper_title = parsed["paperTitle"]
        .as_str()
        .map(|title| title.trim())
        .filter(|title| !title.is_empty())
        .map(|title| title.to_string())
        .unwrap_or_else(|| format!("arXiv {}", arxiv_id));
    let paper_source_url = parsed["paperUrl"]
        .as_str()
        .or_else(|| parsed["paperSourceUrl"].as_str())
        .map(|url| url.trim())
        .filter(|url| !url.is_empty())
        .map(|url| url.to_string())
        .unwrap_or_else(|| format!("https://arxiv.org/abs/{}", arxiv_id));
    let arxiv_settings = &parsed["arxivSettings"];
    let arxiv_remove_refs = arxiv_settings["removeRefs"].as_bool().unwrap_or(false);
    let arxiv_remove_toc = arxiv_settings["removeToc"].as_bool().unwrap_or(false);
    let arxiv_remove_citations = arxiv_settings["removeCitations"].as_bool().unwrap_or(false);
    let overview_url = parsed["overviewUrl"].as_str().unwrap_or("");
    let overview_markdown = parsed["overviewMarkdown"].as_str().unwrap_or("").trim();
    let overview_error = parsed["overviewError"].as_str().unwrap_or("");
    let mime_type = parsed["mimeType"].as_str().unwrap_or("");
    let artifact_kind = match parsed["artifactKind"].as_str() {
        Some(k) if !k.is_empty() => k,
        _ => return r#"{"ok":false,"error":"artifactKind is required"}"#.to_string(),
    };
    let file_name = match parsed["fileName"].as_str() {
        Some(n) if !n.is_empty() => sanitize_file_name(n),
        _ => return r#"{"ok":false,"error":"fileName is required"}"#.to_string(),
    };
    let data_base64 = match parsed["dataBase64"].as_str() {
        Some(d) if !d.is_empty() => d,
        _ => return r#"{"ok":false,"error":"dataBase64 is required"}"#.to_string(),
    };

    let bytes = match general_purpose::STANDARD.decode(data_base64) {
        Ok(b) => b,
        Err(e) => return format!(r#"{{"ok":false,"error":"Invalid base64 data: {}"}}"#, e),
    };

    let dir_path = std::path::Path::new(&project_path).join("raw").join("sources");
    if let Err(e) = std::fs::create_dir_all(&dir_path) {
        return format!(
            r#"{{"ok":false,"error":"Failed to create directory: {}"}}"#,
            e
        );
    }

    let stem = sanitize_file_name(&arxiv_id.replace('/', "-"));
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();

    if artifact_kind == "arxiv2md" {
        let paper_content = match String::from_utf8(bytes) {
            Ok(markdown) => markdown,
            Err(e) => {
                return format!(
                    r#"{{"ok":false,"error":"arxiv2md markdown is not UTF-8: {}"}}"#,
                    e
                )
            }
        };

        let paper_path = unique_file_path(&dir_path, &format!("{}-paper.md", stem));
        let paper_path_str = paper_path.to_string_lossy().replace('\\', "/");
        let paper_relative_path = {
            let base = std::path::Path::new(&project_path);
            paper_path
                .strip_prefix(base)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| paper_path_str.replace('\\', "/"))
        };

        let combined_markdown = format!(
            "---\ntype: arxiv-paper\ntitle: \"{}\"\narxiv_id: \"{}\"\nurl: \"{}\"\narxiv2md_markdown_api: \"{}\"\narxiv2md_metadata_api: \"{}\"\narxiv2md_remove_refs: {}\narxiv2md_remove_toc: {}\narxiv2md_remove_citations: {}\nartifact_path: \"\"\nartifact_kind: \"{}\"\nartifact_mime: \"{}\"\nclipped: {}\norigin: arxiv2md\nsources: []\ntags: [arxiv, paper]\n---\n\n# {}\n\n## Paper Content\n\n{}\n\n## Original Artifact\n\n- Artifact kind: `{}`\n- Embedded in this file: `yes`\n- Paper URL: `{}`\n- arxiv2md Markdown API: `{}`\n- arxiv2md Metadata API: `{}`\n- Options: `remove_refs={}`, `remove_toc={}`, `remove_citations={}`\n",
            yaml_escape(&paper_title),
            yaml_escape(arxiv_id),
            yaml_escape(&paper_source_url),
            ARXIV2MD_MARKDOWN_API,
            ARXIV2MD_METADATA_API,
            arxiv_remove_refs,
            arxiv_remove_toc,
            arxiv_remove_citations,
            yaml_escape(artifact_kind),
            yaml_escape(mime_type),
            date,
            paper_title,
            paper_content,
            artifact_kind,
            paper_source_url,
            ARXIV2MD_MARKDOWN_API,
            ARXIV2MD_METADATA_API,
            arxiv_remove_refs,
            arxiv_remove_toc,
            arxiv_remove_citations,
        );
        if let Err(e) = std::fs::write(&paper_path, combined_markdown) {
            return format!(
                r#"{{"ok":false,"error":"Failed to write combined paper markdown: {}"}}"#,
                e
            );
        }

        if let Ok(mut pending) = PENDING_CLIPS.lock() {
            pending.push((project_path.clone(), paper_path_str, false));
        }

        return serde_json::json!({
            "ok": true,
            "path": paper_relative_path,
            "paperPath": paper_relative_path,
            "arxivId": arxiv_id,
            "artifactKind": artifact_kind,
            "autoIngest": false,
        }).to_string();
    }

    let file_path = unique_file_path(&dir_path, &file_name);
    if let Err(e) = std::fs::write(&file_path, &bytes) {
        return format!(
            r#"{{"ok":false,"error":"Failed to write paper file: {}"}}"#,
            e
        );
    }

    let file_path_str = file_path.to_string_lossy().replace('\\', "/");
    let relative_path = {
        let base = std::path::Path::new(&project_path);
        file_path
            .strip_prefix(base)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| file_path_str.replace('\\', "/"))
    };

    if artifact_kind == "pdf" {
        if let Ok(mut pending) = PENDING_CLIPS.lock() {
            pending.push((project_path.clone(), file_path_str, false));
        }

        return serde_json::json!({
            "ok": true,
            "path": relative_path,
            "paperPath": relative_path,
            "arxivId": arxiv_id,
            "artifactKind": artifact_kind,
            "autoIngest": false,
        }).to_string();
    }

    let mut extracted_assets_path: Option<String> = None;
    let mut parse_error: Option<String> = None;
    let paper_content = if artifact_kind == "source" {
        match parse_arxiv_source_package(&project_path, arxiv_id, &file_path) {
            Ok(parsed) => {
                extracted_assets_path = Some(parsed.assets_relative_path);
                parsed.markdown
            }
            Err(e) => {
                parse_error = Some(e.clone());
                format!(
                    "Source package was saved at `{}` but LaTeXML conversion failed.\n\nConversion error:\n\n```text\n{}\n```",
                    relative_path,
                    e
                )
            }
        }
    } else {
        format!(
            "PDF artifact was saved at `{}`. PDF-aware paper parsing is pending, so use the alphaXiv overview plus this original PDF path for now.",
            relative_path
        )
    };

    let paper_path = unique_file_path(&dir_path, &format!("{}-paper.md", stem));
        let paper_path_str = paper_path.to_string_lossy().replace('\\', "/");
    let paper_relative_path = {
        let base = std::path::Path::new(&project_path);
        paper_path
            .strip_prefix(base)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| paper_path_str.replace('\\', "/"))
    };

    let overview_section = if overview_markdown.is_empty() {
        if overview_error.is_empty() {
            "alphaXiv overview was not provided.".to_string()
        } else {
            format!("alphaXiv overview unavailable.\n\n```text\n{}\n```", overview_error)
        }
    } else {
        overview_markdown.to_string()
    };
    let extracted_assets_line = extracted_assets_path
        .as_ref()
        .map(|path| format!("- Extracted source files and figures: `{}`", path))
        .unwrap_or_else(|| "- Extracted source files and figures: not available".to_string());
    let parse_error_line = parse_error
        .as_ref()
        .map(|error| format!("- Source conversion error: `{}`", error.replace('`', "'")))
        .unwrap_or_else(|| "- Source conversion error: none".to_string());
    let combined_markdown = format!(
        "---\ntype: arxiv-paper\ntitle: \"arXiv {}\"\narxiv_id: \"{}\"\nurl: \"https://arxiv.org/abs/{}\"\noverview_url: \"{}\"\nartifact_url: \"{}\"\nartifact_path: \"{}\"\nartifact_kind: \"{}\"\nartifact_mime: \"{}\"\nclipped: {}\norigin: arxiv-paper\nsources: []\ntags: [arxiv, paper]\n---\n\n# arXiv {}\n\n## alphaXiv Overview\n\n{}\n\n## Paper Content\n\n{}\n\n## Original Artifact\n\n- Artifact kind: `{}`\n- Artifact path: `{}`\n- Artifact URL: `{}`\n{}\n{}\n",
        yaml_escape(arxiv_id),
        yaml_escape(arxiv_id),
        yaml_escape(arxiv_id),
        yaml_escape(overview_url),
        yaml_escape(source_url),
        yaml_escape(&relative_path),
        yaml_escape(artifact_kind),
        yaml_escape(mime_type),
        date,
        arxiv_id,
        overview_section,
        paper_content,
        artifact_kind,
        relative_path,
        source_url,
        extracted_assets_line,
        parse_error_line,
    );
    if let Err(e) = std::fs::write(&paper_path, combined_markdown) {
        return format!(
            r#"{{"ok":false,"error":"Failed to write combined paper markdown: {}"}}"#,
            e
        );
    }

    if let Ok(mut pending) = PENDING_CLIPS.lock() {
        pending.push((project_path.clone(), file_path_str, false));
        pending.push((project_path.clone(), paper_path_str, false));
    }

    serde_json::json!({
        "ok": true,
        "path": relative_path,
        "paperPath": paper_relative_path,
        "arxivId": arxiv_id,
        "artifactKind": artifact_kind,
        "autoIngest": false,
    }).to_string()
}

struct ArxivSourceParse {
    markdown: String,
    assets_relative_path: String,
}

fn parse_arxiv_source_package(
    project_path: &str,
    arxiv_id: &str,
    source_package_path: &std::path::Path,
) -> Result<ArxivSourceParse, String> {
    let stem = sanitize_file_name(&arxiv_id.replace('/', "-"));
    let assets_dir = std::path::Path::new(project_path)
        .join("raw")
        .join("assets")
        .join("arxiv");
    std::fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("Failed to create arXiv assets directory: {}", e))?;

    let extract_dir = unique_dir_path(&assets_dir, &stem);
    std::fs::create_dir_all(&extract_dir)
        .map_err(|e| format!("Failed to create extraction directory: {}", e))?;
    extract_arxiv_source(source_package_path, &extract_dir)?;

    let main_tex = find_main_tex(&extract_dir)?;
    let html_path = extract_dir.join("paper.html");
    let md_path = extract_dir.join("paper.md");

    run_command(
        "latexmlc",
        &[
            "--format=html5".to_string(),
            "--destination".to_string(),
            html_path.to_string_lossy().to_string(),
            main_tex.to_string_lossy().to_string(),
        ],
        &extract_dir,
    )?;
    run_command(
        "pandoc",
        &[
            html_path.to_string_lossy().to_string(),
            "-f".to_string(),
            "html".to_string(),
            "-t".to_string(),
            "gfm-raw_html".to_string(),
            "--wrap=none".to_string(),
            "-o".to_string(),
            md_path.to_string_lossy().to_string(),
        ],
        &extract_dir,
    )?;

    let converted = std::fs::read_to_string(&md_path)
        .map_err(|e| format!("Failed to read converted Markdown: {}", e))?;
    let asset_dir_name = extract_dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let image_prefix = format!("../assets/arxiv/{}/", asset_dir_name);
    let converted = rewrite_markdown_image_paths(&cleanup_latexml_markdown(&converted), &image_prefix);

    Ok(ArxivSourceParse {
        markdown: converted,
        assets_relative_path: format!("raw/assets/arxiv/{}", asset_dir_name),
    })
}

fn extract_arxiv_source(source_package_path: &std::path::Path, extract_dir: &std::path::Path) -> Result<(), String> {
    let raw = std::fs::read(source_package_path)
        .map_err(|e| format!("Failed to read source package: {}", e))?;

    let gz = GzDecoder::new(std::io::Cursor::new(&raw));
    let mut archive = tar::Archive::new(gz);
    match archive.unpack(extract_dir) {
        Ok(()) => Ok(()),
        Err(_) => {
            let mut gzipped_tex = String::new();
            if GzDecoder::new(std::io::Cursor::new(&raw))
                .read_to_string(&mut gzipped_tex)
                .is_ok()
            {
                std::fs::write(extract_dir.join("main.tex"), gzipped_tex)
                    .map_err(|e| format!("Failed to write gzipped TeX source: {}", e))?;
                return Ok(());
            }
            let text = String::from_utf8(raw)
                .map_err(|e| format!("Source package is neither .tar.gz, gzip TeX, nor UTF-8 TeX: {}", e))?;
            std::fs::write(extract_dir.join("main.tex"), text)
                .map_err(|e| format!("Failed to write raw TeX source: {}", e))
        }
    }
}

fn find_main_tex(extract_dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let mut candidates = Vec::new();
    collect_tex_files(extract_dir, &mut candidates)?;
    candidates.sort();

    let documentclass: Vec<std::path::PathBuf> = candidates
        .iter()
        .filter(|path| {
            std::fs::read_to_string(path)
                .map(|s| s.contains("\\documentclass") || s.contains("\\begin{document}"))
                .unwrap_or(false)
        })
        .cloned()
        .collect();

    let pool = if documentclass.is_empty() { candidates } else { documentclass };
    for preferred in ["main.tex", "ms.tex", "paper.tex", "article.tex"] {
        if let Some(path) = pool.iter().find(|p| {
            p.file_name()
                .map(|name| name.to_string_lossy().eq_ignore_ascii_case(preferred))
                .unwrap_or(false)
        }) {
            return Ok(path.clone());
        }
    }
    pool.into_iter()
        .next()
        .ok_or_else(|| "No .tex file found in arXiv source package".to_string())
}

fn collect_tex_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("Failed to read extracted source directory: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read extracted source entry: {}", e))?;
        let path = entry.path();
        if path.is_dir() {
            collect_tex_files(&path, out)?;
        } else if path
            .extension()
            .map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("tex"))
            .unwrap_or(false)
        {
            out.push(path);
        }
    }
    Ok(())
}

fn run_command(name: &str, args: &[String], cwd: &std::path::Path) -> Result<(), String> {
    let executable = resolve_executable(name);
    let output = std::process::Command::new(&executable)
        .args(args)
        .current_dir(cwd)
        .env("PATH", "/opt/homebrew/bin:/usr/local/bin:/Library/TeX/texbin:/usr/bin:/bin:/usr/sbin:/sbin")
        .output()
        .map_err(|e| format!("Failed to run {}: {}", name, e))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{} failed with status {}\nstdout:\n{}\nstderr:\n{}",
            name,
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

fn resolve_executable(name: &str) -> std::path::PathBuf {
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        let candidate = std::path::Path::new(dir).join(name);
        if candidate.exists() {
            return candidate;
        }
    }
    std::path::PathBuf::from(name)
}

fn rewrite_markdown_image_paths(markdown: &str, image_prefix: &str) -> String {
    markdown
        .lines()
        .map(|line| rewrite_markdown_image_paths_in_line(line, image_prefix))
        .collect::<Vec<_>>()
        .join("\n")
}

fn cleanup_latexml_markdown(markdown: &str) -> String {
    markdown
        .lines()
        .filter(|line| !(line.starts_with("Generated on ") && line.contains("LaTeXML")))
        .collect::<Vec<_>>()
        .join("\n")
}

fn rewrite_markdown_image_paths_in_line(line: &str, image_prefix: &str) -> String {
    let mut out = String::new();
    let mut rest = line;
    while let Some(img_start) = rest.find("![") {
        out.push_str(&rest[..img_start]);
        let after_img = &rest[img_start..];
        let Some(label_end) = after_img.find("](") else {
            out.push_str(after_img);
            return out;
        };
        let path_start = img_start + label_end + 2;
        let before_path = &rest[img_start..path_start];
        out.push_str(before_path);
        let after_path = &rest[path_start..];
        let Some(path_end) = after_path.find(')') else {
            out.push_str(after_path);
            return out;
        };
        let path = &after_path[..path_end];
        out.push_str(&rewrite_local_image_path(path, image_prefix));
        out.push(')');
        rest = &after_path[path_end + 1..];
    }
    out.push_str(rest);
    out
}

fn rewrite_local_image_path(path: &str, image_prefix: &str) -> String {
    let lower = path.to_lowercase();
    if path.starts_with("http://")
        || path.starts_with("https://")
        || path.starts_with("data:")
        || path.starts_with('/')
        || path.starts_with('#')
        || path.starts_with("../assets/")
    {
        return path.to_string();
    }
    let is_image = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf"]
        .iter()
        .any(|ext| lower.ends_with(ext));
    if is_image {
        format!("{}{}", image_prefix, path)
    } else {
        path.to_string()
    }
}

fn sanitize_file_name(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn yaml_escape(raw: &str) -> String {
    raw.replace('\\', "\\\\").replace('"', "\\\"")
}

fn unique_file_path(dir_path: &std::path::Path, file_name: &str) -> std::path::PathBuf {
    let mut file_path = dir_path.join(file_name);
    let mut counter = 2u32;
    while file_path.exists() {
        let path = std::path::Path::new(file_name);
        let stem = path.file_stem().unwrap_or_default().to_string_lossy();
        let ext = path.extension().map(|e| e.to_string_lossy().to_string());
        let next = match ext {
            Some(ext) => format!("{}-{}.{}", stem, counter, ext),
            None => format!("{}-{}", stem, counter),
        };
        file_path = dir_path.join(next);
        counter += 1;
    }
    file_path
}

fn unique_dir_path(parent: &std::path::Path, dir_name: &str) -> std::path::PathBuf {
    let mut dir_path = parent.join(dir_name);
    let mut counter = 2u32;
    while dir_path.exists() {
        dir_path = parent.join(format!("{}-{}", dir_name, counter));
        counter += 1;
    }
    dir_path
}
