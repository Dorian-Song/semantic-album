#!/usr/bin/env bash
# Starts Album in the background: optional vLLM embedding server, API, and web app. Logs go to .run/. Stop with ./stop.sh.
# n8n runs separately (see ../n8n).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .run
set -a; . ./.env; set +a

[ -d node_modules ] || pnpm install

start_proc() {
  local name="$1" cmd="$2"
  local pidf=".run/$name.pid"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
    echo "[$name] already running (pid $(cat "$pidf"))"
    return
  fi
  # setsid puts the process and its children in one group so stop.sh can stop them together.
  setsid bash -c "$cmd" > ".run/$name.log" 2>&1 &
  echo $! > "$pidf"
  echo "[$name] started (pid $!) -> .run/$name.log"
}

if [ "${VLLM_ENABLED:-false}" = true ]; then
  vllm_bin="${VLLM_BIN:-vllm}"
  if [ -x "$vllm_bin" ] || command -v "$vllm_bin" >/dev/null; then
    # Measured on an 8 GB RTX 4060 desktop GPU: about 6.1 GB in use at 0.8, ~80 s cold start.
    start_proc vllm "'$vllm_bin' serve '$VLLM_MODEL' --runner pooling \
      --served-model-name qwen3-vl-embedding-2b --host 127.0.0.1 --port '${VLLM_PORT:-8000}' \
      --gpu-memory-utilization '${VLLM_GPU_MEMORY_UTILIZATION:-0.8}' --max-model-len '${VLLM_MAX_MODEL_LEN:-4096}' \
      --limit-mm-per-prompt '{\"image\":1,\"video\":0}'"
  else
    echo "[vllm] VLLM_ENABLED=true but $vllm_bin is not installed; Meaning search will be unavailable"
  fi
fi

start_proc api "pnpm dev:api"
start_proc web "pnpm dev:web"

echo
echo "App:  http://localhost:${WEB_PORT:-5173}"
echo "API:  http://localhost:${API_PORT:-3200}/api/health"
echo "Stop: ./stop.sh"
