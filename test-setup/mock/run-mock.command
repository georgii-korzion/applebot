#!/bin/bash
# Мок apple.com/ae для сухого прогона. Ctrl+C — остановить.
#   ./run-mock.command                 продажи «откроются» через 60 с
#   OPEN_AFTER=120 ./run-mock.command  через 120 с
cd "$(dirname "$0")"
SERVER=./mock-server.mjs
[ -f "$SERVER" ] || SERVER=../../test/mock-server.mjs
export OPEN_AFTER="${OPEN_AFTER:-60}"
echo "Мок apple.com/ae: http://127.0.0.1:4777 — продажи «откроются» через ${OPEN_AFTER} с. Ctrl+C — стоп."
exec node "$SERVER"
