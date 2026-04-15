use std::sync::Mutex;
use std::sync::atomic::{AtomicU8, Ordering};
use std::thread;
use std::io::Read;
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
                    let body = format!(r#"{{"ok":true,"path":"{}"}}"#, path);
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
                    let items: Vec<String> = projects.iter()
                        .map(|(name, path)| format!(r#"{{"name":"{}","path":"{}","current":{}}}"#,
                            name.replace('"', r#"\""#),
                            path.replace('"', r#"\""#),
                            path == &current))
                        .collect();
                    let body = format!(r#"{{"ok":true,"projects":[{}]}}"#, items.join(","));
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
                    let items: Vec<String> = pending.iter()
                        .map(|(proj, file, auto_ingest)| serde_json::json!({
                            "projectPath": proj,
                            "filePath": file,
                            "autoIngest": auto_ingest,
                        }).to_string())
                        .collect();
                    let body = format!(r#"{{"ok":true,"clips":[{}]}}"#, items.join(","));
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
        Some(p) => p.to_string(),
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
    let file_path = file_path.to_string_lossy().to_string();
    let source_stem = std::path::Path::new(&file_path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

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
        let full = std::path::Path::new(&file_path);
        let base = std::path::Path::new(&project_path);
        full.strip_prefix(base)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| file_path.replace('\\', "/"))
    };

    // Add to pending clips for frontend to pick up and auto-ingest
    if let Ok(mut pending) = PENDING_CLIPS.lock() {
        pending.push((project_path, file_path.clone(), true));
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

fn handle_paper(body: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"ok":false,"error":"Invalid JSON: {}"}}"#, e),
    };

    let project_path = match parsed["projectPath"].as_str() {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => return r#"{"ok":false,"error":"projectPath is required"}"#.to_string(),
    };
    let arxiv_id = match parsed["arxivId"].as_str() {
        Some(id) if !id.is_empty() => id,
        _ => return r#"{"ok":false,"error":"arxivId is required"}"#.to_string(),
    };
    let source_url = parsed["sourceUrl"].as_str().unwrap_or("");
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

    let file_path = unique_file_path(&dir_path, &file_name);
    if let Err(e) = std::fs::write(&file_path, bytes) {
        return format!(
            r#"{{"ok":false,"error":"Failed to write paper file: {}"}}"#,
            e
        );
    }

    let file_path_str = file_path.to_string_lossy().to_string();
    let relative_path = {
        let base = std::path::Path::new(&project_path);
        file_path
            .strip_prefix(base)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| file_path_str.replace('\\', "/"))
    };

    let mut parsed_source_path: Option<std::path::PathBuf> = None;
    if artifact_kind == "source" {
        match parse_arxiv_source_package(&project_path, arxiv_id, source_url, mime_type, &file_path) {
            Ok(path) => parsed_source_path = Some(path),
            Err(e) => {
                return serde_json::json!({
                    "ok": false,
                    "error": format!("Saved source package, but LaTeXML parsing failed: {}", e),
                    "path": relative_path,
                    "arxivId": arxiv_id,
                    "artifactKind": artifact_kind,
                }).to_string();
            }
        }
    }

    let auto_ingest = artifact_kind == "pdf";
    if let Ok(mut pending) = PENDING_CLIPS.lock() {
        pending.push((project_path.clone(), file_path_str, auto_ingest));
        if let Some(path) = &parsed_source_path {
            pending.push((project_path.clone(), path.to_string_lossy().to_string(), true));
        }
    }

    let parsed_relative_path = parsed_source_path.as_ref().map(|path| {
        let base = std::path::Path::new(&project_path);
        path.strip_prefix(base)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
    });

    serde_json::json!({
        "ok": true,
        "path": relative_path,
        "parsedPath": parsed_relative_path,
        "arxivId": arxiv_id,
        "artifactKind": artifact_kind,
        "autoIngest": auto_ingest || parsed_source_path.is_some(),
    }).to_string()
}

fn parse_arxiv_source_package(
    project_path: &str,
    arxiv_id: &str,
    source_url: &str,
    mime_type: &str,
    source_package_path: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
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

    let source_dir = std::path::Path::new(project_path).join("raw").join("sources");
    std::fs::create_dir_all(&source_dir)
        .map_err(|e| format!("Failed to create source directory: {}", e))?;
    let output_path = unique_file_path(&source_dir, &format!("{}-arxiv-source.md", stem));

    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let markdown = format!(
        "---\ntype: arxiv-source\ntitle: \"arXiv {} source\"\narxiv_id: \"{}\"\nurl: \"{}\"\nclipped: {}\norigin: arxiv-source\nartifact_mime: \"{}\"\nsources: []\ntags: [arxiv, paper]\n---\n\n# arXiv {} source\n\nSource package: `{}`\nExtracted source files and figures: `{}`\n\n{}\n",
        arxiv_id.replace('"', r#"\""#),
        arxiv_id.replace('"', r#"\""#),
        source_url.replace('"', r#"\""#),
        date,
        mime_type.replace('"', r#"\""#),
        arxiv_id,
        source_package_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy(),
        format!("raw/assets/arxiv/{}", asset_dir_name),
        converted,
    );
    std::fs::write(&output_path, markdown)
        .map_err(|e| format!("Failed to write converted arXiv Markdown: {}", e))?;

    Ok(output_path)
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
