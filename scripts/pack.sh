#!/bin/bash
# Собрать архив для установки: out/apple-drop-test-setup.zip.
# Корень папки apple-drop-test-setup — само расширение (боевая сборка, рядом manifest.json),
# в extension-dev/ — dev-сборка для мока, в live/ и mock/ — конфиги и мок-сервер, в hub/ — хаб одним файлом (hub.mjs + dashboard.html + fleet.example.json).
#   npm run pack            (или ./scripts/pack.sh)
#   OUT=/путь npm run pack  — другая папка для результата
set -euo pipefail
cd "$(dirname "$0")/.."
node build.mjs >/dev/null
node build.mjs --dev >/dev/null
OUT="${OUT:-out}"
T="$OUT/apple-drop-test-setup"
rm -rf "$T" "$OUT/apple-drop-test-setup.zip"
mkdir -p "$T/extension-dev" "$T/live" "$T/mock"
cp -R dist/. "$T/"
cp -R dist-dev/. "$T/extension-dev/"
cp test-setup/README.md "$T/README.md"
cp test-setup/КАК-УСТАНОВИТЬ.txt "$T/"
cp docs/INSTALL.md docs/FEATURES.md docs/GUIDE.md docs/RESEARCH-iphone18-preorder.md "$T/"
cp test-setup/live/*.json "$T/live/"
cp test-setup/mock/* "$T/mock/"
cp test/mock-server.mjs "$T/mock/"
# хаб одним файлом (ws внутри): на сервере нужен только Node.js, без исходников и npm install
mkdir -p "$T/hub"
# ESM, не CJS: хаб v2 берёт dashboard.html рядом с собой через import.meta.url
npx esbuild hub/server.mjs --bundle --platform=node --format=esm --target=node20 \
  --external:bufferutil --external:utf-8-validate --log-level=warning --outfile="$T/hub/hub.mjs"
cp hub/dashboard.html hub/README.md "$T/hub/"
cp fleet.example.json "$T/hub/fleet.example.json"
cat > "$T/hub/run-hub.command" <<'SH'
#!/bin/bash
# Хаб v2: fleet.json рядом (см. fleet.example.json), HUB_TOKEN/HUB_DASH_TOKEN в окружении. Окно Терминала не закрывать. Ctrl+C — стоп.
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Нужен Node.js 20+: https://nodejs.org"; read -r; exit 1; }
exec node hub.mjs
SH
chmod +x "$T/hub/run-hub.command"
printf '@echo off\r\nrem Hub for several Chrome profiles on THIS computer. Keep this window open.\r\nwhere node >nul 2>nul || (echo Node.js 20+ is required: https://nodejs.org & pause & exit /b 1)\r\nnode "%%~dp0hub.mjs"\r\npause\r\n' > "$T/hub/run-hub.bat"
printf '@echo off\r\nrem Mock apple.com/ae for a dry run. Ctrl+C to stop.\r\nif "%%OPEN_AFTER%%"=="" set OPEN_AFTER=60\r\nnode "%%~dp0mock-server.mjs"\r\npause\r\n' > "$T/mock/run-mock.bat"
(cd "$OUT" && zip -qr apple-drop-test-setup.zip apple-drop-test-setup -x '*.DS_Store')
echo "готово: $OUT/apple-drop-test-setup.zip"
