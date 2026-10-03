#!/bin/bash
# Apple Drop Bot — двойной клик в Finder: ставит зависимости (первый раз), собирает расширение и открывает пульт в браузере.
# Окно Терминала не закрывай, пока работаешь с пультом. Запущенный бот продолжит работать и без пульта.
cd "$(dirname "$0")" || exit 1

# Node.js из Homebrew / установщика / nvm — Finder запускает с коротким PATH
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

pause() { read -r -p "Нажми Enter, чтобы закрыть окно… " _; }

if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Поставь LTS-версию с https://nodejs.org (или brew install node) и запусти этот файл снова."
  pause; exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "Нужен Node.js 20 или новее, сейчас $(node -v). Обнови с https://nodejs.org"
  pause; exit 1
fi

# зависимости: первый раз и после обновления кода (package.json новее установленных)
if [ ! -d node_modules ] || [ package.json -nt node_modules/.package-lock.json ]; then
  echo "Ставлю зависимости (npm install)…"
  npm install || { echo "npm install не прошёл."; pause; exit 1; }
fi
# расширение собирается каждый раз (меньше секунды) — после git pull в браузерах всегда свежая версия
echo "Собираю расширение…"
npm run build --silent >/dev/null || { echo "Сборка не прошла: npm run build"; pause; exit 1; }

npm run bot -- ui
pause
