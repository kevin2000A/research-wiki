#!/usr/bin/env bash
set -euo pipefail

VENV_DIR="${LLM_WIKI_CRAWL4AI_VENV:-$HOME/.llm-wiki/crawl4ai-venv}"

if [[ -n "${LLM_WIKI_PYTHON:-}" ]]; then
  PYTHON_BIN="$LLM_WIKI_PYTHON"
elif command -v python3.12 >/dev/null 2>&1; then
  PYTHON_BIN="python3.12"
elif command -v python3.11 >/dev/null 2>&1; then
  PYTHON_BIN="python3.11"
else
  PYTHON_BIN="python3"
fi

mkdir -p "$(dirname "$VENV_DIR")"
"$PYTHON_BIN" -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install -U pip setuptools wheel
"$VENV_DIR/bin/python" -m pip install -U crawl4ai
"$VENV_DIR/bin/crawl4ai-setup"
"$VENV_DIR/bin/python" -m playwright install chromium

echo "crawl4ai helper environment ready: $VENV_DIR/bin/python"
