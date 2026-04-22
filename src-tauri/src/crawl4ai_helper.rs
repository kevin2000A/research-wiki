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

    let python = std::env::var("LLM_WIKI_PYTHON").unwrap_or_else(|_| "python3".to_string());
    let child = Command::new(python)
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
                "[crawl4ai-helper] spawned local helper on http://127.0.0.1:{}",
                HELPER_PORT
            );
            *child_guard = Some(child);
        }
        Err(error) => {
            eprintln!(
                "[crawl4ai-helper] failed to spawn helper: {}. Blog extraction will fail until python3 and crawl4ai are installed.",
                error
            );
        }
    }
}

pub fn stop_crawl4ai_helper() {
    let mut child_guard = CRAWL4AI_HELPER.lock().unwrap();
    if let Some(mut child) = child_guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}
