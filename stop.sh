#!/usr/bin/env bash
# Stop what start.sh started: background process groups, then the local n8n container.
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

n8n_mode=$( (set -a; [ -f .env ] && . ./.env; echo "${N8N_MODE:-local}") )
if [ "$n8n_mode" = local ] && [ -f automation/n8n/.env ]; then
  docker compose -f automation/n8n/compose.yaml stop && echo "[n8n] container stopped"
fi
