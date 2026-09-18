#!/bin/bash
# 硅侣2.0 — 服务端部署脚本
# 部署到VPS2 (鬼子虾2号)
#
# 使用方法: bash deploy.sh [VPS_IP] [AUTH_TOKEN]
#
# 功能:
# 1. 安装free-code binary
# 2. 配置settings.json (GLM Fetch Adapter + AgentChat + OfficeCLI)
# 3. 配置MCP servers
# 4. 部署AgentChat三skill
# 5. 配置Playwright Chromium
# 6. 配置systemd守护
# 7. 启动服务

set -e

VPS_IP="${1:-<VPS_IP>}"
AUTH_TOKEN="${2:-siliconmate-auth-token-2026}"
GLM_API_KEY="${GLM_API_KEY:-<YOUR_GLM_API_KEY>}"
GLM_BASE_URL="https://open.bigmodel.cn/api/paas/v4"
SERVER_DIR="/opt/siliconmate-server"
FREE_CODE_PORT=8080
MAX_SESSIONS=32

echo "=== 硅侣2.0 服务端部署 ==="
echo "VPS: $VPS_IP"
echo "Port: $FREE_CODE_PORT"
echo "Max Sessions: $MAX_SESSIONS"

# 1. 安装free-code binary
echo ""
echo "--- Step 1: 安装free-code ---"
ssh "root@$VPS_IP" "which claude || (curl -fsSL https://storage.googleapis.com/anthropic-tools/free-code-latest-linux-x64 -o /usr/local/bin/claude && chmod +x /usr/local/bin/claude)"
ssh "root@$VPS_IP" "claude --version || echo 'free-code installed'"

# 2. 创建目录结构
echo ""
echo "--- Step 2: 创建目录 ---"
ssh "root@$VPS_IP" "mkdir -p $SERVER_DIR/{config,skills,workspace,.claude/skills}"

# 3. 配置settings.json
echo ""
echo "--- Step 3: 配置free-code settings ---"
ssh "root@$VPS_IP" "cat > $SERVER_DIR/config/settings.json << 'SETTINGS_EOF'
{
  \"model\": \"glm-4-flash\",
  \"customFetch\": \"require('/opt/siliconmate-server/glm-fetch-adapter/dist/index.js').createGlmFetch({apiKey: '$GLM_API_KEY', baseUrl: '$GLM_BASE_URL'})\",
  \"systemPrompt\": \"你是硅侣服务端Agent，负责处理深度思考和Office文档任务。你可以使用AgentChat进行多AI协作，使用OfficeCLI处理Office文档。回答要简洁专业。\",
  \"enableAllProjectMcpServers\": true,
  \"mcpServers\": {
    \"agentchat\": {
      \"command\": \"python3\",
      \"args\": [\"/opt/siliconmate-server/agentchat/mcp-server/server.py\"],
      \"env\": {
        \"CHROME_CDP_URL\": \"http://127.0.0.1:9222\"
      }
    },
    \"officecli\": {
      \"command\": \"npx\",
      \"args\": [\"-y\", \"officecli-mcp@latest\"],
      \"env\": {}
    }
  }
}
SETTINGS_EOF"

# 4. 配置MCP servers
echo ""
echo "--- Step 4: 配置MCP servers ---"
ssh "root@$VPS_IP" "cat > $SERVER_DIR/config/mcp-servers.json << 'MCP_EOF'
{
  \"mcpServers\": {
    \"agentchat\": {
      \"command\": \"python3\",
      \"args\": [\"/opt/siliconmate-server/agentchat/mcp-server/server.py\"],
      \"env\": {
        \"CHROME_CDP_URL\": \"http://127.0.0.1:9222\"
      },
      \"description\": \"AgentChat MCP Server — 多AI协作\"
    },
    \"officecli\": {
      \"command\": \"npx\",
      \"args\": [\"-y\", \"officecli-mcp@latest\"],
      \"env\": {},
      \"description\": \"OfficeCLI MCP Server — Office文档处理\"
    }
  }
}
MCP_EOF"

# 5. 部署AgentChat skills
echo ""
echo "--- Step 5: 部署AgentChat skills ---"
# Copy from local /tmp/AgentChat/skills/
scp -r /tmp/AgentChat/skills/AgentChat-OneWeb "root@$VPS_IP:$SERVER_DIR/skills/" 2>/dev/null || echo "Warning: AgentChat-OneWeb not found locally"
scp -r /tmp/AgentChat/skills/AgentChat-WebSubAgent "root@$VPS_IP:$SERVER_DIR/skills/" 2>/dev/null || echo "Warning: AgentChat-WebSubAgent not found locally"
scp -r /tmp/AgentChat/skills/AgentChat-IndependentTasks "root@$VPS_IP:$SERVER_DIR/skills/" 2>/dev/null || echo "Warning: AgentChat-IndependentTasks not found locally"

# Also copy AgentChat lib and mcp-server
scp -r /tmp/AgentChat/agentchat "root@$VPS_IP:$SERVER_DIR/" 2>/dev/null || echo "Warning: AgentChat lib not found locally"

# Configure .claude/skills/
ssh "root@$VPS_IP" "ln -sf $SERVER_DIR/skills/AgentChat-OneWeb $SERVER_DIR/.claude/skills/AgentChat-OneWeb 2>/dev/null || true"
ssh "root@$VPS_IP" "ln -sf $SERVER_DIR/skills/AgentChat-WebSubAgent $SERVER_DIR/.claude/skills/AgentChat-WebSubAgent 2>/dev/null || true"
ssh "root@$VPS_IP" "ln -sf $SERVER_DIR/skills/AgentChat-IndependentTasks $SERVER_DIR/.claude/skills/AgentChat-IndependentTasks 2>/dev/null || true"

# 6. 安装GLM Fetch Adapter
echo ""
echo "--- Step 6: 安装GLM Fetch Adapter ---"
scp -r /Users/apple/.openclaw/workspace-deveco/siliconmate-v2/shared/glm-fetch-adapter "root@$VPS_IP:$SERVER_DIR/glm-fetch-adapter" 2>/dev/null || echo "Warning: GLM adapter not found locally"
ssh "root@$VPS_IP" "cd $SERVER_DIR/glm-fetch-adapter && npm install && npm run build 2>/dev/null || echo 'GLM adapter build skipped'"

# 7. 配置Playwright Chromium
echo ""
echo "--- Step 7: 配置Playwright Chromium ---"
ssh "root@$VPS_IP" "pip3 install playwright 2>/dev/null || pip install playwright 2>/dev/null || true"
ssh "root@$VPS_IP" "playwright install chromium 2>/dev/null || echo 'Playwright install skipped (may need manual setup)'"

# Create start-chrome-debug script
ssh "root@$VPS_IP" "cat > $SERVER_DIR/start-chrome-debug.py << 'CHROME_EOF'
#!/usr/bin/env python3
import subprocess, os
chrome_path = os.path.expanduser('~/.cache/ms-playwright/chromium-*/chrome-linux/chrome')
import glob
chrome = glob.glob(chrome_path)
if chrome:
    subprocess.Popen([chrome[0], '--remote-debugging-port=9222', '--no-sandbox', '--headless', '--disable-gpu', '--disable-dev-shm-usage', 'about:blank'])
    print('Chrome started on CDP :9222')
else:
    print('Chrome not found, trying chromium-browser...')
    subprocess.Popen(['chromium-browser', '--remote-debugging-port=9222', '--no-sandbox', '--headless', '--disable-gpu', '--disable-dev-shm-usage', 'about:blank'])
CHROME_EOF"
ssh "root@$VPS_IP" "chmod +x $SERVER_DIR/start-chrome-debug.py"

# 8. 配置systemd守护（Playwright Chrome + SSH就绪检查）
echo ""
echo "--- Step 8: 配置systemd守护 ---"
ssh "root@$VPS_IP" "cat > /etc/systemd/system/siliconmate-chrome.service << 'SYSTEMD_EOF'
[Unit]
Description=硅侣2.0 Playwright Chrome (CDP :9222)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$SERVER_DIR
ExecStart=/usr/bin/python3 $SERVER_DIR/start-chrome-debug.py
Restart=always
RestartSec=5
Environment=HOME=/root
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=DISPLAY=:99

[Install]
WantedBy=multi-user.target
SYSTEMD_EOF"

ssh "root@$VPS_IP" "systemctl daemon-reload"
ssh "root@$VPS_IP" "systemctl enable siliconmate-chrome"
ssh "root@$VPS_IP" "systemctl restart siliconmate-chrome || true"

# 9. 验证
echo ""
echo "--- Step 9: 验证 ---"
sleep 3
ssh "root@$VPS_IP" "systemctl status siliconmate-chrome --no-pager || echo 'Chrome service may need manual start'"
ssh "root@$VPS_IP" "which claude && claude --version || echo 'free-code not installed'"
ssh "root@$VPS_IP" "ls $SERVER_DIR/config/settings.json && echo 'settings.json OK' || echo 'settings.json missing'"

echo ""
echo "=== 部署完成 ==="
echo "服务端模式: SSH exec (客户端按需调用)"
echo "VPS: $VPS_IP"
echo "Chrome CDP: http://$VPS_IP:9222"
echo ""
echo "客户端配置:"
echo "  SILICONMATE_SERVER_HOST=$VPS_IP"
echo "  SILICONMATE_SSH_KEY=~/.ssh/id_ed25519"
echo ""
echo "注意: 服务端无需常驻daemon, 客户端通过SSH exec按需调用claude -p"
