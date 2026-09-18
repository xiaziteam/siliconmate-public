#!/usr/bin/env bash
# ============================================================
# 硅侣 v4.1.0 服务端一键部署脚本
#
# 三段式:
#   Stage 1 (opencode): VPS2 启动硅侣专用 opencode serve 实例 (:4103, 仅 127.0.0.1, systemd 守护)
#   Stage 2 (app):      推送 server/account-service/app.py → VPS2 → docker 重建 account-service (保留原 env/挂载)
#   Stage 3 (smoke):    冒烟 /v1/chat (200 + reply 非空) + /v1/chat/history + 既有端点回归
#
# 用法:
#   ./scripts/deploy-v4_1-server.sh [stage]
#     stage = opencode | app | smoke | all (默认 all)
#
# 端口说明: 4102 已被 hongxia-web 占用, 硅侣 v4.1 使用 4103 (偏差已在报告中记录)
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_PY_LOCAL="$REPO_ROOT/server/account-service/app.py"

# T031 脱敏: 凭证不入仓 — 从 git-ignored ./scripts/.deploy.env 或环境变量注入
# 模板见 scripts/.deploy.env.example
[ -f "$SCRIPT_DIR/.deploy.env" ] && . "$SCRIPT_DIR/.deploy.env"

if [ -z "${SILICONMATE_VPS_HOST:-}" ]; then
  fail "缺少 SILICONMATE_VPS_HOST (VPS SSH目标, 如 root@<vps-ip>). 请 export 或写入 scripts/.deploy.env"
fi
VPS_HOST="$SILICONMATE_VPS_HOST"
OPENCODE_PORT="4103"
# 绑定 docker0 网关: 宿主机与 bridge 容器均可访问, 且不对公网暴露
OPENCODE_BIND="172.17.0.1"
OPENCODE_BASE_URL="http://${OPENCODE_BIND}:${OPENCODE_PORT}"
OPENCODE_HOME="/root/siliconmate-ai"
# T030: 独立 machine-id(opencode 免费额度指纹隔离, 与宿主/其他实例互不挤占)
MACHINE_ID_FILE="/var/lib/siliconmate/machine-id"
SERVICE_NAME="siliconmate-opencode"
REMOTE_APP_DIR="/root/account-service"
CONTAINER_NAME="account-service"
CHAT_BASE="https://example.com"
# T031 脱敏: X-Account-Id 即服务端身份凭证, 测试账号 ID 不入仓
SMOKE_ACCOUNT_ID="${SMOKE_ACCOUNT_ID:-}"

log() { echo -e "\033[1;32m[deploy]\033[0m $*"; }
fail() { echo -e "\033[1;31m[deploy:FAIL]\033[0m $*" >&2; exit 1; }

vps() { ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=no "$VPS_HOST" "$@"; }

# ------------------------------------------------------------
# Stage 1: opencode 实例 (:4103)
# ------------------------------------------------------------
stage_opencode() {
  log "Stage 1: 启动 opencode serve :$OPENCODE_PORT (systemd ${SERVICE_NAME})"

  # 杀掉旧的裸进程实例(如有), 交给 systemd 接管 ([o] 防止 pkill 自匹配 ssh 命令行)
  vps "pkill -f '[o]pencode serve --port $OPENCODE_PORT' 2>/dev/null; sleep 1; true"
  vps "mkdir -p $OPENCODE_HOME"
  # T030: 确保独立 machine-id 存在(额度指纹隔离; 幂等, 已有则复用)
  vps "mkdir -p \$(dirname $MACHINE_ID_FILE) && [ -f $MACHINE_ID_FILE ] || uuidgen > $MACHINE_ID_FILE"

  vps "cat > /etc/systemd/system/${SERVICE_NAME}.service <<'UNIT'
[Unit]
Description=SiliconMate opencode AI backend (v4.1 cloud compute)
After=network.target

[Service]
Type=simple
WorkingDirectory=$OPENCODE_HOME
ExecStart=/usr/bin/opencode serve --port $OPENCODE_PORT --hostname $OPENCODE_BIND
BindReadOnlyPaths=$MACHINE_ID_FILE:/etc/machine-id
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT"

  vps "systemctl daemon-reload && systemctl enable ${SERVICE_NAME}.service >/dev/null 2>&1; systemctl restart ${SERVICE_NAME}.service"

  local ok=""
  for i in $(seq 1 20); do
    if vps "curl -sf http://${OPENCODE_BIND}:${OPENCODE_PORT}/doc >/dev/null" 2>/dev/null; then
      ok="1"; break
    fi
    sleep 1
  done
  [ -n "$ok" ] || fail "opencode :$OPENCODE_PORT 未就绪, 查: journalctl -u ${SERVICE_NAME} -n 50"
  log "Stage 1 OK: opencode $OPENCODE_BASE_URL 就绪"

  # 模型冒烟: 建会话 + 发消息 (阻塞至完成)
  vps "SID=\$(curl -sf -X POST $OPENCODE_BASE_URL/session -H 'Content-Type: application/json' -d '{}' | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"id\"])') && \
       curl -sf -m 100 -X POST $OPENCODE_BASE_URL/session/\$SID/message -H 'Content-Type: application/json' \
       -d '{\"model\":{\"providerID\":\"opencode\",\"modelID\":\"nemotron-3-ultra-free\"},\"agent\":\"build\",\"parts\":[{\"type\":\"text\",\"text\":\"回复两个字:收到\"}]}' \
       | python3 -c 'import json,sys; d=json.load(sys.stdin); t=\"\".join(p.get(\"text\",\"\") for p in d.get(\"parts\",[]) if p.get(\"type\")==\"text\"); print(\"MODEL_REPLY:\", t[:50] if t.strip() else \"<EMPTY>\")'" \
    || fail "opencode 模型冒烟失败"
  log "Stage 1 冒烟通过"
}

# ------------------------------------------------------------
# Stage 2: 推送 app.py + docker 重建 (保留原容器 env / 挂载 / 端口)
# ------------------------------------------------------------
stage_app() {
  log "Stage 2: 推送 app.py → VPS2 并重建 $CONTAINER_NAME"

  [ -f "$APP_PY_LOCAL" ] || fail "本地 app.py 不存在: $APP_PY_LOCAL"
  python3 -c "import ast; ast.parse(open('$APP_PY_LOCAL').read())" || fail "本地 app.py 语法错误"

  scp -o ConnectTimeout=15 -o StrictHostKeyChecking=no "$APP_PY_LOCAL" "$VPS_HOST:$REMOTE_APP_DIR/app.py.new" \
    || fail "scp 推送失败"

  # 远端原子替换 + 备份 + 重建 (env 从现有容器继承, 不落盘到仓库)
  vps "set -e
    cd $REMOTE_APP_DIR
    [ -f app.py.bak-v4_1 ] || cp app.py app.py.bak-v4_1
    python3 -c 'import ast; ast.parse(open(\"app.py.new\").read())'
    mv app.py.new app.py
    docker inspect $CONTAINER_NAME --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -v '^PATH=' > /tmp/container.env
    echo 'OPENCODE_BASE=$OPENCODE_BASE_URL' >> /tmp/container.env
    docker build -q -t account-service:latest .
    docker rm -f $CONTAINER_NAME >/dev/null 2>&1 || true
    docker run -d --name $CONTAINER_NAME --restart always \\
      -p 8444:8444 \\
      --env-file /tmp/container.env \\
      -v $REMOTE_APP_DIR/data:/srv/data \\
      -v $REMOTE_APP_DIR/certs:/srv/certs \\
      -v $REMOTE_APP_DIR/uploads:/srv/uploads \\
      account-service:latest >/dev/null
    rm -f /tmp/container.env
  " || fail "远端重建失败"

  local ok=""
  for i in $(seq 1 30); do
    if vps "curl -sf -k https://127.0.0.1:8444/health >/dev/null" 2>/dev/null; then
      ok="1"; break
    fi
    sleep 1
  done
  [ -n "$ok" ] || fail "account-service /health 未就绪, 查: docker logs $CONTAINER_NAME --tail 50"
  log "Stage 2 OK: 容器已重建, /health 就绪"
}

# ------------------------------------------------------------
# Stage 3: 冒烟 /v1/chat + /v1/chat/history + 回归
# ------------------------------------------------------------
stage_smoke() {
  # T031: 冒烟需测试账号(服务端身份凭证), 未提供则跳过冒烟并提示
  if [ -z "$SMOKE_ACCOUNT_ID" ]; then
    log "Stage 3 跳过: 未设置 SMOKE_ACCOUNT_ID (写入 scripts/.deploy.env 可启用冒烟)"
    return 0
  fi
  log "Stage 3: 冒烟 /v1/chat"

  echo "--- POST /v1/chat ---"
  vps "curl -s -m 100 -X POST $CHAT_BASE/v1/chat -H 'Content-Type: application/json' -H 'X-Account-Id: $SMOKE_ACCOUNT_ID' -d '{\"message\":\"回复两个字:收到\"}'" \
    | tee /tmp/smoke_chat.json
  python3 - <<'PYEOF'
import json
try:
    d = json.load(open('/tmp/smoke_chat.json'))
except Exception as e:
    print("SMOKE FAIL: 响应非 JSON:", e); raise SystemExit(1)
if not d.get("ok") or not (d.get("data", {}).get("reply") or "").strip():
    print("SMOKE FAIL: /v1/chat 异常:", json.dumps(d, ensure_ascii=False)[:300]); raise SystemExit(1)
print("CHAT_SMOKE_OK reply[:50] =", d["data"]["reply"][:50], "| session:", d["data"].get("session_id"))
PYEOF

  echo "--- GET /v1/chat/history ---"
  vps "curl -s -m 30 $CHAT_BASE/v1/chat/history -H 'X-Account-Id: $SMOKE_ACCOUNT_ID'" \
    | tee /tmp/smoke_history.json
  python3 - <<'PYEOF'
import json
d = json.load(open('/tmp/smoke_history.json'))
if not d.get("ok"):
    print("HISTORY_SMOKE_FAIL:", json.dumps(d, ensure_ascii=False)[:300]); raise SystemExit(1)
msgs = d.get("data", {}).get("messages", [])
print(f"HISTORY_SMOKE_OK messages={len(msgs)}")
PYEOF

  echo "--- 回归: /health + /v1/smcp/ping + /v1/smcp/friend/list ---"
  vps "curl -sf $CHAT_BASE/v1/smcp/ping && echo ''"
  vps "curl -s -X POST $CHAT_BASE/v1/smcp/friend/list -H 'X-Account-Id: $SMOKE_ACCOUNT_ID' | head -c 300; echo"
  log "Stage 3 完成 — 证据: /tmp/smoke_chat.json /tmp/smoke_history.json"
}

main() {
  local stage="${1:-all}"
  case "$stage" in
    opencode) stage_opencode ;;
    app)      stage_app ;;
    smoke)    stage_smoke ;;
    all)      stage_opencode; stage_app; stage_smoke ;;
    *)        echo "用法: $0 [opencode|app|smoke|all]"; exit 1 ;;
  esac
  log "部署完成: $stage"
}

main "$@"
