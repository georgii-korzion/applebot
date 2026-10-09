#!/bin/bash
# Флот профилей Chrome на macOS (FLEET-SPEC §5). Команды те же, что в fleet.ps1:
#   fleet.sh init --prefix nl1 --hub "wss://hub.example.com/ws?token=XYZ" [--root ~/drop] [--ext ~/drop/ext] [--url <страница товара>]
#   fleet.sh check-template
#   fleet.sh clone --count 10
#   fleet.sh start [--only p03,p07] [--url …] [--cols 3] [--proxy-flag http://host:port]
#   fleet.sh stop  [--only …]
#   fleet.sh status
#   fleet.sh reset --only p03 [--force]
#   fleet.sh template
# Прокси скрипт НЕ ставит — прокси берётся из конфига расширения (§7). --proxy-flag — запасной путь для всего экземпляра.
set -euo pipefail

DEFAULT_ROOT="$HOME/drop"
DEFAULT_URL="https://www.apple.com/ae/shop/buy-iphone/iphone-18-pro"
CMD="${1:-help}"; shift || true
PREFIX=""; HUB=""; ROOT=""; EXT=""; URL=""; COUNT=0; ONLY=""; COLS=3; PROXY_FLAG=""; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2;;
    --hub) HUB="$2"; shift 2;;
    --root) ROOT="$2"; shift 2;;
    --ext) EXT="$2"; shift 2;;
    --url) URL="$2"; shift 2;;
    --count) COUNT="$2"; shift 2;;
    --only) ONLY="$2"; shift 2;;
    --cols) COLS="$2"; shift 2;;
    --proxy-flag) PROXY_FLAG="$2"; shift 2;;
    --force) FORCE=1; shift;;
    *) echo "неизвестный аргумент: $1" >&2; exit 1;;
  esac
done

say() { echo "$*"; }
warn() { echo "ВНИМАНИЕ: $*" >&2; }
fail() { echo "ОШИБКА: $*" >&2; exit 1; }
mask() { sed -E 's/token=[^&]+/token=…/g' <<<"$1"; }

find_chrome() {
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  command -v google-chrome 2>/dev/null || command -v chromium 2>/dev/null || true
}

# fleet.local.json: простые пары ключ=значение читаем через node (он нужен и для хаба/сборки)
local_file() { echo "${1}/fleet.local.json"; }
load_local() {
  local r="${ROOT:-$DEFAULT_ROOT}" f; f="$(local_file "$r")"
  [ -f "$f" ] || fail "нет $f — сначала: fleet.sh init --prefix <srv> --hub <wss://…>"
  eval "$(node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const q = (s) => "\x27" + String(s ?? "").replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
    for (const k of ["prefix","hub","root","ext","url","chrome"]) console.log(`L_${k.toUpperCase()}=${q(c[k])}`);
  ' "$f")"
  [ -n "$ROOT" ] && L_ROOT="$ROOT"; [ -n "$EXT" ] && L_EXT="$EXT"; [ -n "$URL" ] && L_URL="$URL"; [ -n "$HUB" ] && L_HUB="$HUB"
  TPL="$L_ROOT/tpl"
}
save_local() {
  node -e '
    const [f, prefix, hub, root, ext, url, chrome] = process.argv.slice(1);
    require("fs").writeFileSync(f, JSON.stringify({ prefix, hub, root, ext, url, chrome, createdAt: new Date().toISOString() }, null, 2));
  ' "$(local_file "$1")" "$2" "$3" "$1" "$4" "$5" "$6"
  say "записан $(local_file "$1")"
}

profile_name() { echo "${L_PREFIX}-$1"; }
profile_dirs() { ls -d "$L_ROOT"/p[0-9][0-9]* 2>/dev/null | xargs -n1 basename 2>/dev/null | sort || true; }
select_profiles() {
  local all; all="$(profile_dirs)"
  if [ -z "$ONLY" ]; then echo "$all"; return; fi
  local out=""
  for x in ${ONLY//,/ }; do
    [[ "$x" =~ ^[0-9]+$ ]] && x="$(printf 'p%02d' "$x")"
    grep -qx "$x" <<<"$all" || fail "профиля $x нет в $L_ROOT"
    out="$out $x"
  done
  echo $out
}
# PID процессов Chrome этого профиля (по --user-data-dir); чужой Chrome не трогаем
chrome_pids() { pgrep -f -- "--user-data-dir=$1( |$)" 2>/dev/null || true; }
stop_profile() {
  local pids; pids="$(chrome_pids "$1")"
  [ -z "$pids" ] && { echo 0; return; }
  kill $pids 2>/dev/null || true
  sleep 1
  pids2="$(chrome_pids "$1")"; [ -n "$pids2" ] && kill -9 $pids2 2>/dev/null || true
  wc -w <<<"$pids" | tr -d ' '
}
dir_size_mb() { du -sm "$1" 2>/dev/null | cut -f1; }
copy_template() {
  rm -rf "$1"
  cp -R "$TPL" "$1"
  rm -f "$1"/SingletonLock "$1"/SingletonCookie "$1"/SingletonSocket "$1"/lockfile
}
launch_url() {
  local hub; hub="$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$L_HUB")"
  echo "${L_URL}#drop=$(profile_name "$1")&hub=${hub}"
}
# Сетка окон на основном дисплее (system_profiler не даёт положения второго монитора)
screen_size() {
  local res; res="$(system_profiler SPDisplaysDataType 2>/dev/null | grep -m1 'Resolution' | grep -oE '[0-9]+ x [0-9]+' || true)"
  local w h; w="${res%% x *}"; h="${res##* x }"
  # Retina: system_profiler даёт физические пиксели — делим на 2, если явно больше рабочего стола
  [ -z "$w" ] && { w=1920; h=1080; }
  if [ "$w" -gt 3000 ]; then w=$((w / 2)); h=$((h / 2)); fi
  echo "$w $((h - 60))"
}

case "$CMD" in
  help|-h|--help) sed -n '2,12p' "$0"; exit 0;;

  init)
    [ -n "$PREFIX" ] || fail "нужен --prefix (имя сервера, например nl1 — профили будут nl1-p01…)"
    [[ "$PREFIX" =~ ^[A-Za-z0-9]{1,16}$ ]] || fail "--prefix: только буквы и цифры, без дефиса"
    [ -n "$HUB" ] || fail "нужен --hub (адрес хаба wss://host/ws?token=…)"
    [[ "$HUB" =~ ^wss?:// ]] || fail "--hub должен начинаться с wss:// (или ws:// для локального теста)"
    r="${ROOT:-$DEFAULT_ROOT}"; e="${EXT:-$r/ext}"; u="${URL:-$DEFAULT_URL}"
    chrome="$(find_chrome)"; [ -n "$chrome" ] || fail "Google Chrome не найден — установи обычный Chrome"
    command -v node >/dev/null || fail "нужен Node.js (для fleet.local.json)"
    mkdir -p "$r/tpl"
    [ -f "$e/manifest.json" ] || warn "в $e нет manifest.json — распакуй туда расширение (dist.zip) до загрузки в шаблон"
    tz="$(readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||')"; [[ "$tz" == "Asia/Dubai" ]] || warn "часовой пояс системы «${tz:-?}» — для дропа нужен Asia/Dubai (sudo systemsetup -settimezone Asia/Dubai)"
    save_local "$r" "$PREFIX" "$HUB" "$e" "$u" "$chrome"
    say ""
    say "Chrome: $chrome"
    say "Открываю Chrome с шаблоном $r/tpl. Дальше руками:"
    say "  1. chrome://extensions → Developer mode → Load unpacked → выбрать $e"
    say "  2. Убедиться, что расширение включено. На apple.com НЕ заходить, настройки расширения НЕ трогать."
    say "  3. Закрыть Chrome полностью (⌘Q). Затем: fleet.sh check-template"
    "$chrome" --user-data-dir="$r/tpl" --no-first-run --no-default-browser-check --lang=en-US chrome://extensions >/dev/null 2>&1 &
    ;;

  template)
    load_local
    say "Открываю шаблон $TPL (после правок закрыть Chrome и снова check-template; клоны при необходимости пересоздать: reset)"
    "$L_CHROME" --user-data-dir="$TPL" --no-first-run --no-default-browser-check --lang=en-US chrome://extensions >/dev/null 2>&1 &
    ;;

  check-template)
    load_local; ok=1
    [ -d "$TPL" ] || fail "нет шаблона $TPL — сначала fleet.sh init"
    [ -z "$(chrome_pids "$TPL")" ] || fail "Chrome с шаблоном ещё открыт — закрой его полностью (⌘Q) и повтори"
    for lf in SingletonLock lockfile; do [ -e "$TPL/$lf" ] && { warn "в шаблоне остался $lf — удаляю"; rm -f "$TPL/$lf"; }; done
    found=0
    for f in "$TPL/Default/Preferences" "$TPL/Default/Secure Preferences"; do
      [ -f "$f" ] && grep -qF "$L_EXT" "$f" && found=1
    done
    [ -f "$TPL/Default/Preferences" ] || fail "в $TPL/Default нет Preferences — Chrome с шаблоном ни разу не открывался?"
    if [ $found = 1 ]; then say "✓ расширение из $L_EXT есть в настройках шаблона"; else ok=0; warn "в Preferences шаблона нет пути $L_EXT — расширение не загружено (chrome://extensions → Load unpacked)"; fi
    for ck in "$TPL/Default/Network/Cookies" "$TPL/Default/Cookies"; do
      [ -f "$ck" ] || continue
      if LC_ALL=C grep -aq 'apple.com' "$ck"; then ok=0; warn "в $ck есть cookies apple.com — все клоны унаследовали бы ОДНУ сессию Apple. Удали tpl и сделай заново, не заходя на apple.com"; else say "✓ cookies без apple.com ($ck)"; fi
    done
    say "размер шаблона: $(dir_size_mb "$TPL") МБ"
    [ $ok = 1 ] && say "Шаблон готов. Дальше: fleet.sh clone --count N" || fail "шаблон не готов (см. выше)"
    ;;

  clone)
    load_local
    [ "$COUNT" -ge 1 ] 2>/dev/null || fail "нужен --count N (сколько клонов всего)"
    [ "$COUNT" -gt 12 ] && warn "больше 12 профилей на машину без замера ресурсов не ставить (~0,5 ГБ на экземпляр)"
    [ -f "$TPL/Default/Preferences" ] || fail "шаблон не готов — fleet.sh init / check-template"
    made=0
    for i in $(seq 1 "$COUNT"); do
      p="$(printf 'p%02d' "$i")"; dst="$L_ROOT/$p"
      if [ -d "$dst" ]; then say "  $p есть"; continue; fi
      cp -R "$TPL" "$dst"; rm -f "$dst"/SingletonLock "$dst"/SingletonCookie "$dst"/SingletonSocket "$dst"/lockfile
      say "  $p создан → $(profile_name "$p")"; made=$((made + 1))
    done
    say "готово: создано $made, всего $(profile_dirs | wc -l | tr -d ' '). Проверка первого клона (F1): fleet.sh start --only p01 → chrome://extensions — расширение включено."
    ;;

  start)
    load_local
    list="$(select_profiles)"; [ -n "$list" ] || fail "клонов нет — fleet.sh clone --count N"
    n="$(wc -w <<<"$list" | tr -d ' ')"
    read -r sw sh <<<"$(screen_size)"
    cols=$(( COLS < n ? COLS : n )); [ "$cols" -lt 1 ] && cols=1
    rows=$(( (n + cols - 1) / cols ))
    w=$(( sw / cols )); h=$(( sh / rows )); [ "$w" -lt 800 ] && w=800; [ "$h" -lt 600 ] && h=600
    say "запускаю $n: $list · хаб $(mask "$L_HUB") · страница $L_URL"
    [ -n "$PROXY_FLAG" ] && warn "весь экземпляр через --proxy-server=$PROXY_FLAG (запасной путь; обычно прокси ставит расширение)"
    i=0
    for p in $list; do
      dir="$L_ROOT/$p"
      if [ -n "$(chrome_pids "$dir")" ]; then say "  $p уже запущен — пропускаю"; i=$((i + 1)); continue; fi
      x=$(( (i % cols) * w )); y=$(( (i / cols) * h + 30 ))
      args=(--user-data-dir="$dir" --no-first-run --no-default-browser-check --lang=en-US
        --window-size="$w,$h" --window-position="$x,$y"
        --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
        --silent-debugger-extension-api)
      [ -n "$PROXY_FLAG" ] && args+=(--proxy-server="$PROXY_FLAG")
      "$L_CHROME" "${args[@]}" "$(launch_url "$p")" >/dev/null 2>&1 &
      say "  $p → $(profile_name "$p") · окно ${w}x${h} @ $x,$y"
      i=$((i + 1)); [ "$i" -lt "$n" ] && sleep 1.5
    done
    say "Готово. Имя и конфиг каждый клон берёт из адреса (#drop=…&hub=…); при autoStart гонка взводится сама."
    ;;

  stop)
    load_local; total=0
    for p in $(select_profiles); do
      k="$(stop_profile "$L_ROOT/$p")"; [ "$k" != 0 ] && say "  $p: завершено процессов $k"; total=$((total + k))
    done
    say "остановлено процессов: $total (чужой Chrome не тронут)"
    ;;

  status)
    load_local
    printf '%-6s %-12s %-8s %-8s %s\n' профиль имя запущен PID МБ
    for p in $(profile_dirs); do
      pids="$(chrome_pids "$L_ROOT/$p")"
      printf '%-6s %-12s %-8s %-8s %s\n' "$p" "$(profile_name "$p")" "$([ -n "$pids" ] && echo да || echo нет)" "$(awk '{print $1}' <<<"$pids")" "$(dir_size_mb "$L_ROOT/$p")"
    done
    say "шаблон: $TPL · расширение: $L_EXT · хаб: $(mask "$L_HUB")"
    ;;

  reset)
    load_local
    [ -n "$ONLY" ] || fail "reset только для указанных профилей: fleet.sh reset --only p03"
    list="$(select_profiles)"; n="$(wc -w <<<"$list" | tr -d ' ')"
    [ "$n" -gt 1 ] && [ $FORCE = 0 ] && fail "reset сразу $n профилей — добавь --force, если точно надо"
    for p in $list; do
      stop_profile "$L_ROOT/$p" >/dev/null
      copy_template "$L_ROOT/$p"
      say "  $p заменён свежей копией шаблона (сессия Apple, лог и записи заказов этого профиля удалены)"
    done
    ;;

  *) fail "неизвестная команда: $CMD (fleet.sh help)";;
esac
