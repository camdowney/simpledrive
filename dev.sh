#!/bin/bash
# Dev watcher: rebuilds and restarts simpledrive whenever anything in web/ changes.
# Usage: ./dev.sh   (Ctrl-C to stop)
set -euo pipefail
cd "$(dirname "$0")"

PID=""

build_and_run() {
  echo "[dev] building..."
  if ! go build -o simpledrive . ; then
    echo "[dev] build failed; keeping previous instance running"
    return
  fi
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  ./simpledrive &
  PID=$!
  echo "[dev] running (pid $PID)"
}

cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# Fingerprint of all files in web/ (path + mtime).
snapshot() { find web -type f -printf '%T@ %p\n' 2>/dev/null | sort | md5sum; }

build_and_run
last=$(snapshot)
echo "[dev] watching web/ for changes..."
while true; do
  sleep 1
  cur=$(snapshot)
  if [ "$cur" != "$last" ]; then
    echo "[dev] change detected in web/ — rebuilding"
    last=$cur
    build_and_run
  fi
done
