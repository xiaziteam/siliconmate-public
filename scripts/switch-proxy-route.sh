#!/bin/bash
# ============================================================
# 路由器passwall2代理线路切换脚本 — 大文件传输加速
# 用法(在Mac上执行): bash switch-proxy-route.sh [ecs|direct|status]
#   ecs     = Proxy分流走 水虾ECS中继(AliyunHK快线) ← 提速默认
#   direct  = 回退直连东京VPS reality节点
#   status  = 查看当前配置
# 前提: 水虾ECS已开 socat TCP-LISTEN:40001 → <VPS_IP>:443
# ============================================================
set -e
ROUTER="root@192.168.1.1"
KEY="$HOME/.ssh/aliyun-hk"
ECS_IP="47.243.177.163"
ECS_PORT="40001"

r() { ssh -i "$KEY" -o ConnectTimeout=10 $ROUTER "$@"; }

case "${1:-status}" in
  status)
    echo "=== 当前分流指向:"
    r "uci get passwall2.myshunt.Proxy; uci get passwall2.myshunt.OpenAI"
    echo "=== reality_cf_test节点地址:"
    r "uci get passwall2.reality_cf_test.address; uci get passwall2.reality_cf_test.port"
    ;;

  ecs)
    echo "[1/4] 在reality节点基础上克隆出ECS中继节点..."
    r "
      uci -q get passwall2.ecs_relay.remarks >/dev/null 2>&1 || {
        uci set passwall2.ecs_relay=nodes
        uci set passwall2.ecs_relay.remarks='东京VPS经ECS中继(sansha快线)'
        uci set passwall2.ecs_relay.type='Xray'
        uci set passwall2.ecs_relay.protocol='vless'
        # 复制reality节点的全部加密参数(uuid/reality公钥/sni等)
        for f in uuid encryption flow tls server_name public_key short_id transport tcp_guise \
                 http_path http_host security fingerprint alpn allowInsecure mux; do
          v=\$(uci -q get passwall2.reality_cf_test.\$f) && uci set passwall2.ecs_relay.\$f=\"\$v\"
        done
      }
      # 地址端口指到ECS中继口
      uci set passwall2.ecs_relay.address='$ECS_IP'
      uci set passwall2.ecs_relay.port='$ECS_PORT'
      uci commit passwall2
    "
    echo "[2/4] 分流切换 Proxy/OpenAI/Netflix → ecs_relay ..."
    r "
      uci set passwall2.myshunt.Proxy='ecs_relay'
      uci set passwall2.myshunt.OpenAI='ecs_relay'
      uci set passwall2.myshunt.Netflix='ecs_relay'
      uci set passwall2.myshunt.GooglePlay='ecs_relay'
      uci commit passwall2
    "
    echo "[3/4] 重启passwall2生效..."
    r "/etc/init.d/passwall2 restart >/dev/null 2>&1; sleep 5"
    echo "[4/4] 验证:"
    bash "$0" status
    echo "✅ 已切换ECS中继线。回退: bash $0 direct"
    ;;

  direct)
    r "
      uci set passwall2.myshunt.Proxy='reality_cf_test'
      uci set passwall2.myshunt.OpenAI='reality_cf_test'
      uci set passwall2.myshunt.Netflix='reality_cf_test'
      uci set passwall2.myshunt.GooglePlay='reality_cf_test'
      uci commit passwall2 && /etc/init.d/passwall2 restart >/dev/null 2>&1; sleep 5
    "
    echo "✅ 已回退直连东京线"
    ;;
esac
