#!/usr/bin/env bash
set -euo pipefail

python3 -m pip install -U crawl4ai
crawl4ai-setup
python3 -m playwright install chromium
