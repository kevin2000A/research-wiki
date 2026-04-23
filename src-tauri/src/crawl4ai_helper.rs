use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

static CRAWL4AI_HELPER: Mutex<Option<Child>> = Mutex::new(None);

const HELPER_SCRIPT: &str = include_str!("../helpers/crawl4ai_helper.py");
const HELPER_PORT: u16 = 19828;

pub fn start_crawl4ai_helper() {
    let mut child_guard = CRAWL4AI_HELPER.lock().unwrap();
    if child_guard.is_some() {
        return;
    }

    let script_path = std::env::temp_dir().join("llm-wiki-crawl4ai-helper.py");
    std::fs::write(&script_path, HELPER_SCRIPT)
        .expect("failed to write crawl4ai helper script");

    let Some(python) = select_python() else {
        eprintln!(
            "[crawl4ai-helper] no Python with crawl4ai found. Run: bash scripts/setup-crawl4ai-helper.sh"
        );
        return;
    };

    let child = Command::new(&python)
        .arg("-u")
        .arg(&script_path)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(HELPER_PORT.to_string())
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn();

    match child {
        Ok(child) => {
            println!(
                "[crawl4ai-helper] spawned local helper on http://127.0.0.1:{} with {}",
                HELPER_PORT,
                python
            );
            *child_guard = Some(child);
        }
        Err(error) => {
            eprintln!(
                "[crawl4ai-helper] failed to spawn helper: {}. Run: bash scripts/setup-crawl4ai-helper.sh",
                error
            );
        }
    }
}

fn select_python() -> Option<String> {
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("LLM_WIKI_PYTHON") {
        if !path.trim().is_empty() {
            candidates.push(path);
        }
    }
    if let Ok(path) = std::env::var("LLM_WIKI_CRAWL4AI_PYTHON") {
        if !path.trim().is_empty() {
            candidates.push(path);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(
            PathBuf::from(home)
                .join(".llm-wiki")
                .join("crawl4ai-venv")
                .join("bin")
                .join("python")
                .to_string_lossy()
                .to_string(),
        );
    }
    candidates.extend([
        "python3.12".to_string(),
        "python3.11".to_string(),
        "python3".to_string(),
    ]);

    let mut seen = std::collections::HashSet::new();
    for candidate in candidates {
        if !seen.insert(candidate.clone()) {
            continue;
        }
        let status = Command::new(&candidate)
            .arg("-c")
            .arg("import crawl4ai")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if status.map(|status| status.success()).unwrap_or(false) {
            return Some(candidate);
        }
    }
    None
}

pub fn stop_crawl4ai_helper() {
    let mut child_guard = CRAWL4AI_HELPER.lock().unwrap();
    if let Some(mut child) = child_guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}
