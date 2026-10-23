#!/usr/bin/env bash
# Stops what start.sh started.
cd "$(dirname "$0")"
shopt -s nullglob
for pidf in .run/*.pid; do
  name=$(basename "$pidf" .pid)
  pid=$(cat "$pidf" 2>/dev/null || true)
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    echo "[$name] stopped (pid $pid)"
  fi
  rm -f "$pidf"
done
