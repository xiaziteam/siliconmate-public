#!/bin/bash
# 硅侣安卓一条龙构建：前端 → 同步到 assets → gradle APK
# 背景：v4.1.0 验证时发现 assets/dist 若不同步会把旧前端打进新 APK（静默发版事故隐患）
set -euo pipefail
cd "$(dirname "$0")/.."

VARIANT="${1:-debug}"

echo "[1/3] 构建前端 (tsc && vite build)..."
cd client
npm run build
cd ..

echo "[2/3] 同步前端产物到 android assets (rsync --delete)..."
rsync -a --delete client/dist/ android/app/src/main/assets/dist/

echo "[3/3] gradle assemble$(echo "${VARIANT:0:1}" | tr 'a-z' 'A-Z')${VARIANT:1}..."
cd android
./gradlew "assemble$(echo "${VARIANT:0:1}" | tr 'a-z' 'A-Z')${VARIANT:1}"

echo ""
echo "✅ 构建完成："
ls -lh app/build/outputs/apk/"${VARIANT}"/
