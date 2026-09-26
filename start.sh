#!/usr/bin/env bash
# Start the Album stack in the background; logs go to .run/. Stop with ./stop.sh.
# Processes: API, web dev server, optional local n8n container, optional vLLM embedding server.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .run

[ -f .env ] || { cp .env.example .env; echo "[config] created .env from .env.example"; }
set -a; . ./.env; set +a

[ -d node_modules ] || pnpm install

start_proc() {
  local name="$1" cmd="$2"
  local pidf=".run/$name.pid"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
    echo "[$name] already running (pid $(cat "$pidf"))"
    return
  fi
  # setsid puts pnpm and its children in one process group so stop.sh can stop them together.
  setsid bash -c "$cmd" > ".run/$name.log" 2>&1 &
  echo $! > "$pidf"
  echo "[$name] started (pid $!) -> .run/$name.log"
}

if [ "${N8N_MODE:-local}" = local ]; then
  n8n_env=automation/n8n/.env
  if [ ! -f "$n8n_env" ]; then
    key=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    sed "s/^N8N_ENCRYPTION_KEY=.*/N8N_ENCRYPTION_KEY=$key/" automation/n8n/.env.example > "$n8n_env"
    chmod 600 "$n8n_env"
    echo "[n8n] created $n8n_env with a new encryption key; back this file up"
  fi
  docker compose -f automation/n8n/compose.yaml up -d --quiet-pull
  echo "[n8n] container album-n8n up"
fi

if [ "${VLLM_ENABLED:-false}" = true ]; then
  if command -v vllm >/dev/null; then
    # Flags are verified in build step 6; memory settings are conservative for an 8 GB GPU.
    start_proc vllm "vllm serve '$VLLM_MODEL' ${VLLM_REVISION:+--revision '$VLLM_REVISION'} --runner pooling \
      --host 127.0.0.1 --port '${VLLM_PORT:-8000}' \
      --gpu-memory-utilization '${VLLM_GPU_MEMORY_UTILIZATION:-0.6}' --max-model-len '${VLLM_MAX_MODEL_LEN:-4096}'"
  else
    echo "[vllm] VLLM_ENABLED=true but vllm is not installed; Meaning search will be unavailable"
  fi
fi

start_proc api "pnpm dev:api"
start_proc web "pnpm dev:web"

echo
echo "App:  http://localhost:${WEB_PORT:-5173}"
echo "API:  http://localhost:${API_PORT:-3200}/api/health"
[ "${N8N_MODE:-local}" = local ] && echo "n8n:  http://localhost:5678"
echo "Stop: ./stop.sh"
