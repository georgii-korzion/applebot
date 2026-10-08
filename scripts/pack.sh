#!/bin/bash
# Собрать архив для установки: out/apple-drop-test-setup.zip.
# Корень папки apple-drop-test-setup — само расширение (боевая сборка, рядом manifest.json),
# в extension-dev/ — dev-сборка для мока, в live/ и mock/ — конфиги и мок-сервер.
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
cp docs/FEATURES.md docs/GUIDE.md docs/RESEARCH-iphone18-preorder.md "$T/"
cp test-setup/live/*.json "$T/live/"
cp test-setup/mock/* "$T/mock/"
cp test/mock-server.mjs "$T/mock/"
(cd "$OUT" && zip -qr apple-drop-test-setup.zip apple-drop-test-setup -x '*.DS_Store')
echo "готово: $OUT/apple-drop-test-setup.zip"
