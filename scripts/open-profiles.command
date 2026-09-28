#!/bin/bash
# macOS: открыть профили Chrome «Drop 1 … Drop N» (§7.1, §12). Двойной клик в Finder или из Терминала.
#   ./scripts/open-profiles.command            → "Profile 1" … "Profile 3"
#   ./scripts/open-profiles.command 6          → "Profile 1" … "Profile 6"
#   PROFILES="Profile 2,Profile 5" ./scripts/open-profiles.command
#   URL=https://www.apple.com/ae/ ./scripts/open-profiles.command 3
# Имя папки профиля — chrome://version → «Путь к профилю» (последняя часть пути).
N="${1:-3}"
if [ -n "$PROFILES" ]; then
  IFS=',' read -ra DIRS <<< "$PROFILES"
else
  DIRS=()
  for i in $(seq 1 "$N"); do DIRS+=("Profile $i"); done
fi
for d in "${DIRS[@]}"; do
  d="$(echo "$d" | sed 's/^ *//;s/ *$//')"
  echo "→ $d"
  if [ -n "$URL" ]; then
    open -na "Google Chrome" --args --profile-directory="$d" "$URL"
  else
    open -na "Google Chrome" --args --profile-directory="$d"
  fi
  sleep 1
done
echo "Готово: ${#DIRS[@]} профил(ей). Дальше в каждом: иконка расширения → Start."
