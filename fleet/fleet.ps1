<#
.SYNOPSIS
  Флот профилей Chrome на Windows-сервере (FLEET-SPEC §5). PowerShell 5+, без зависимостей.

.DESCRIPTION
  Команды (одинаковые с fleet.sh; bootstrap — только Windows):
    bootstrap      [-Zip C:\drop\dist.zip] [-Root C:\drop]   один раз на сервере, PowerShell от администратора:
                   часовой пояс Dubai, время, не спать/не блокировать экран, Chrome (ставит, если нет), автообновление
                   Chrome выкл., исключение Defender для C:\drop, расширение из -Zip в C:\drop\ext
    init           -Prefix nl1 -Hub "wss://hub.example.com/ws?token=XYZ" [-Root C:\drop] [-Ext C:\drop\ext] [-Url <страница товара>]
                   проверяет Chrome, создаёт папки, пишет fleet.local.json, открывает шаблон tpl для Load unpacked
    check-template проверяет шаблон: Chrome закрыт, расширение загружено, cookies без apple.com, нет lockfile
    clone          -Count 10            создаёт недостающие клоны p01…p10 (копия tpl)
    start          [-Only p03,p07] [-Url …] [-Cols 3] [-ProxyFlag http://host:port]   запускает окна плиткой по мониторам
    stop           [-Only …]            завершает Chrome только этих профилей
    status                              таблица: профиль, PID, запущен, размер папки
    reset          -Only p03            закрыть и заменить папку свежей копией шаблона
    template       открыть Chrome с шаблоном tpl ещё раз
    update-ext     -Zip C:\drop\dist.zip [-NoStart]   новая версия расширения в тот же C:\drop\ext: останавливает окна,
                   подменяет файлы, запускает снова; клоны пересоздавать (reset) не надо — путь не меняется

  Прокси скрипт НЕ ставит — прокси берётся из конфига расширения (§7). -ProxyFlag — запасной путь для всего экземпляра.

.EXAMPLE
  .\fleet.ps1 bootstrap -Zip C:\drop\dist.zip
  .\fleet.ps1 init -Prefix nl1 -Hub "wss://hub.example.com/ws?token=XYZ"
  .\fleet.ps1 check-template
  .\fleet.ps1 clone -Count 10
  .\fleet.ps1 start
  .\fleet.ps1 start -Only p03,p07
  .\fleet.ps1 stop
  .\fleet.ps1 update-ext -Zip C:\drop\dist-new.zip
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('bootstrap', 'init', 'check-template', 'clone', 'start', 'stop', 'status', 'reset', 'template', 'update-ext', 'help')]
  [string]$Command = 'help',
  [string]$Prefix,
  [string]$Hub,
  [string]$Root,
  [string]$Ext,
  [string]$Url,
  [int]$Count = 0,
  [string[]]$Only,
  [int]$Cols = 3,
  [string]$ProxyFlag,
  [string]$Zip,
  [switch]$NoStart,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
# Без этого Invoke-WebRequest и Expand-Archive в Windows PowerShell 5.1 рисуют прогресс и работают в десятки раз медленнее
$ProgressPreference = 'SilentlyContinue'
$DefaultRoot = 'C:\drop'
$DefaultUrl = 'https://www.apple.com/ae/shop/buy-iphone/iphone-18-pro'

function Say($msg) { Write-Host $msg }
function Warn($msg) { Write-Host "ВНИМАНИЕ: $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "ОШИБКА: $msg" -ForegroundColor Red; exit 1 }

function Find-Chrome {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  try {
    $k = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction Stop
    if ($k.'(default)' -and (Test-Path $k.'(default)')) { return $k.'(default)' }
  } catch { }
  return $null
}

function Local-Path($r) { Join-Path $r 'fleet.local.json' }

function Load-Local {
  $r = if ($Root) { $Root } else { $DefaultRoot }
  $f = Local-Path $r
  if (-not (Test-Path $f)) { Fail "нет $f — сначала: fleet.ps1 init -Prefix <srv> -Hub <wss://…>" }
  $cfg = Get-Content -Raw -Encoding UTF8 $f | ConvertFrom-Json
  if ($Root) { $cfg.root = $Root }
  if ($Ext) { $cfg.ext = $Ext }
  if ($Url) { $cfg.url = $Url }
  if ($Hub) { $cfg.hub = $Hub }
  return $cfg
}

function Save-Local($cfg) {
  $f = Local-Path $cfg.root
  $cfg | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $f
  Say "записан $f"
}

function Profile-Name($cfg, $p) { "$($cfg.prefix)-$p" }

function Profile-Dirs($cfg) {
  # -Filter файловой системы понимает только * и ?, классов [0-9] там нет — отбираем по имени регуляркой
  Get-ChildItem -Path $cfg.root -Directory -Filter 'p*' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^p\d{2,}$' } | Sort-Object Name
}

function Select-Profiles($cfg) {
  $all = @(Profile-Dirs $cfg | ForEach-Object { $_.Name })
  if (-not $Only) { return $all }
  $want = @()
  foreach ($o in $Only) {
    foreach ($x in ($o -split ',')) {
      $x = $x.Trim()
      if (-not $x) { continue }
      if ($x -match '^\d+$') { $x = 'p{0:D2}' -f [int]$x }
      if ($all -notcontains $x) { Fail "профиля $x нет в $($cfg.root)" }
      $want += $x
    }
  }
  return $want
}

# Процессы Chrome данного профиля (по --user-data-dir в командной строке); чужой Chrome не трогаем.
function Chrome-Procs($dir) {
  $esc = [regex]::Escape($dir)
  Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match "--user-data-dir=`"?$esc`"?(\s|$)" }
}

function Stop-Profile($dir) {
  $procs = @(Chrome-Procs $dir)
  if (-not $procs.Count) { return 0 }
  foreach ($p in $procs) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }
  Start-Sleep -Milliseconds 800
  return $procs.Count
}

function Dir-SizeMB($dir) {
  try {
    $sum = (Get-ChildItem -Path $dir -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    return [math]::Round(($sum / 1MB), 0)
  } catch { return 0 }
}

function Copy-Template($cfg, $dst) {
  $tpl = Join-Path $cfg.root 'tpl'
  $null = robocopy $tpl $dst /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 /XF lockfile /XD 'Crashpad' 'ShaderCache' 'GrShaderCache' 'GraphiteDawnCache' 'BrowserMetrics'
  if ($LASTEXITCODE -ge 8) { Fail "robocopy $tpl → $dst завершился с кодом $LASTEXITCODE" }
  # лок-файлы шаблона в копии не нужны
  foreach ($lf in @('lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket')) { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $dst $lf) }
}

function Launch-Url($cfg, $p) {
  $hub = [Uri]::EscapeDataString($cfg.hub)
  return "$($cfg.url)#drop=$(Profile-Name $cfg $p)&hub=$hub"
}

# Сетка окон по всем мониторам: N окон → по ceil(N/мониторов) на монитор, по $Cols в ряд.
function Window-Slots($n) {
  Add-Type -AssemblyName System.Windows.Forms
  $screens = [System.Windows.Forms.Screen]::AllScreens | Sort-Object { $_.Bounds.X }
  if (-not $screens) { return @(1..$n | ForEach-Object { @{ x = 0; y = 0; w = 1280; h = 900 } }) }
  $perScreen = [math]::Ceiling($n / $screens.Count)
  $cols = [math]::Max(1, [math]::Min($Cols, $perScreen))
  $rows = [math]::Max(1, [math]::Ceiling($perScreen / $cols))
  $slots = @()
  foreach ($s in $screens) {
    $wa = $s.WorkingArea
    $w = [math]::Floor($wa.Width / $cols); $h = [math]::Floor($wa.Height / $rows)
    for ($r = 0; $r -lt $rows; $r++) {
      for ($c = 0; $c -lt $cols; $c++) {
        if ($slots.Count -ge $n) { break }
        $slots += @{ x = $wa.X + $c * $w; y = $wa.Y + $r * $h; w = [math]::Max(800, $w); h = [math]::Max(600, $h) }
      }
    }
  }
  return $slots
}

function Start-Profile($cfg, $p, $slot) {
  $dir = Join-Path $cfg.root $p
  if ((Chrome-Procs $dir).Count) { Say "  $p уже запущен — пропускаю"; return }
  $args = @(
    "--user-data-dir=$dir",
    '--no-first-run', '--no-default-browser-check', '--lang=en-US',
    "--window-size=$($slot.w),$($slot.h)", "--window-position=$($slot.x),$($slot.y)",
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    '--silent-debugger-extension-api'
  )
  if ($ProxyFlag) { $args += "--proxy-server=$ProxyFlag" }
  $args += ('"' + (Launch-Url $cfg $p) + '"')
  Start-Process -FilePath $cfg.chrome -ArgumentList $args | Out-Null
  Say "  $p → $(Profile-Name $cfg $p) · окно $($slot.w)x$($slot.h) @ $($slot.x),$($slot.y)"
}

# Распаковать архив расширения (dist.zip из `npm run pack` или ext.zip из архива установки) в $ext. Старая папка → $ext.bak-<дата>.
# Путь $ext не меняется, поэтому шаблон и клоны (Load unpacked по этому пути) подхватят новые файлы при следующем запуске.
function Install-Ext($zip, $ext) {
  if (-not (Test-Path -LiteralPath $zip)) { Fail "нет архива $zip" }
  $tmp = Join-Path $env:TEMP ('drop-ext-' + [guid]::NewGuid().ToString('N'))
  Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
  $src = $tmp
  if (-not (Test-Path (Join-Path $src 'manifest.json'))) {
    $m = Get-ChildItem -Path $tmp -Filter manifest.json -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $m) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue; Fail "в $zip нет manifest.json" }
    $src = $m.DirectoryName
  }
  $ver = (Get-Content -Raw -Encoding UTF8 (Join-Path $src 'manifest.json') | ConvertFrom-Json).version
  if (Test-Path -LiteralPath $ext) {
    $old = '?'
    if (Test-Path (Join-Path $ext 'manifest.json')) { $old = (Get-Content -Raw -Encoding UTF8 (Join-Path $ext 'manifest.json') | ConvertFrom-Json).version }
    $bak = "$ext.bak-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Move-Item -LiteralPath $ext -Destination $bak
    Say "  старое расширение ($old) → $bak"
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ext) | Out-Null
  Copy-Item -LiteralPath $src -Destination $ext -Recurse
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Say "✓ расширение $ver в $ext"
  return $ver
}

switch ($Command) {
  'help' { Get-Help $MyInvocation.MyCommand.Path -Detailed; exit 0 }

  # Один раз на новом Windows-сервере, PowerShell от администратора. Повторный запуск безвреден.
  'bootstrap' {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) { Fail 'bootstrap запускать в PowerShell от администратора (правой кнопкой → Run as administrator)' }
    $r = if ($Root) { $Root } else { $DefaultRoot }
    New-Item -ItemType Directory -Force -Path $r | Out-Null
    # 1. часовой пояс и время
    try {
      if ((Get-TimeZone).Id -ne 'Arabian Standard Time') { Set-TimeZone -Id 'Arabian Standard Time'; Say '✓ часовой пояс → Arabian Standard Time (Asia/Dubai)' }
      else { Say '✓ часовой пояс уже Arabian Standard Time' }
    } catch { Warn "часовой пояс не выставлен: $_ — Set-TimeZone 'Arabian Standard Time' руками" }
    try { Start-Service W32Time -ErrorAction SilentlyContinue; & w32tm /resync /nowait | Out-Null; Say '✓ время: w32tm /resync' } catch { Warn "w32tm /resync не удался: $_" }
    # 2. не спать, не гасить экран, не блокировать (Chrome за заблокированным/спящим экраном душит таймеры)
    foreach ($a in @(@('monitor-timeout-ac', '0'), @('standby-timeout-ac', '0'), @('hibernate-timeout-ac', '0'), @('disk-timeout-ac', '0'))) { & powercfg /change $a[0] $a[1] | Out-Null }
    Say '✓ powercfg: сон, гибернация, отключение экрана и диска выключены'
    try {
      New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' -Force | Out-Null
      Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' -Name 'NoLockScreen' -Value 1 -Type DWord
      Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name 'ScreenSaveActive' -Value '0'
      Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name 'ScreenSaverIsSecure' -Value '0'
      New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Control Panel\Desktop' -Force | Out-Null
      Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Control Panel\Desktop' -Name 'ScreenSaveActive' -Value '0'
      Say '✓ экран блокировки и заставка выключены'
    } catch { Warn "реестр (экран блокировки): $_" }
    # 3. Chrome: обычный Google Chrome; если нет — тихая установка enterprise-MSI
    $chrome = Find-Chrome
    if (-not $chrome) {
      Say 'Chrome не найден — скачиваю googlechromestandaloneenterprise64.msi и ставлю тихо…'
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $msi = Join-Path $env:TEMP 'googlechromestandaloneenterprise64.msi'
      Invoke-WebRequest -Uri 'https://dl.google.com/dl/chrome/install/googlechromestandaloneenterprise64.msi' -OutFile $msi -UseBasicParsing
      $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart') -Wait -PassThru
      if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { Fail "msiexec завершился с кодом $($p.ExitCode) — поставь Chrome руками (https://www.google.com/chrome/) и повтори" }
      $chrome = Find-Chrome
      if (-not $chrome) { Fail 'Chrome не найден после установки — поставь руками и повтори' }
    }
    Say "✓ Chrome: $chrome ($((Get-Item $chrome).VersionInfo.ProductVersion))"
    # 4. автообновление Chrome выключить: обновление посреди 15–16.10 перезапустит окна
    foreach ($svcName in @('gupdate', 'gupdatem')) {
      $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
      if ($svc) { Stop-Service -Name $svcName -Force -ErrorAction SilentlyContinue; Set-Service -Name $svcName -StartupType Disabled -ErrorAction SilentlyContinue }
    }
    try {
      New-Item -Path 'HKLM:\SOFTWARE\Policies\Google\Update' -Force | Out-Null
      Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Google\Update' -Name 'UpdateDefault' -Value 0 -Type DWord
      Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Google\Update' -Name 'AutoUpdateCheckPeriodMinutes' -Value 0 -Type DWord
    } catch { Warn "политика Google Update: $_" }
    Get-ScheduledTask -TaskName 'GoogleUpdateTask*' -ErrorAction SilentlyContinue | Disable-ScheduledTask -ErrorAction SilentlyContinue | Out-Null
    Say '✓ автообновление Chrome выключено (службы gupdate/gupdatem, политика UpdateDefault=0, задачи планировщика)'
    # 5. Defender: исключение для папки флота — клонирование и запуск 8 Chrome заметно быстрее
    try { Add-MpPreference -ExclusionPath $r -ErrorAction Stop; Say "✓ Defender: исключение для $r" } catch { Warn "исключение Defender не добавлено ($_) — не критично" }
    # 6. расширение
    $e = Join-Path $r 'ext'
    if ($Zip) { $null = Install-Ext $Zip $e }
    elseif (-not (Test-Path (Join-Path $e 'manifest.json'))) { Warn "расширения в $e ещё нет: распакуй dist.zip туда или повтори с -Zip C:\drop\dist.zip" }
    else { Say "✓ расширение уже в $e" }
    Say ''
    Say 'Готово. RDP-сессию во время дропа не отключать (сворачивать окно, не разрывать). Дальше:'
    Say "  .\fleet.ps1 init -Prefix s1 -Hub `"wss://hub.example.com/ws?token=…`""
  }

  'init' {
    if (-not $Prefix) { Fail 'нужен -Prefix (имя сервера, например nl1 — профили будут nl1-p01…)' }
    if ($Prefix -notmatch '^[A-Za-z0-9]{1,16}$') { Fail '-Prefix: только буквы и цифры, без дефиса (дефис отделяет номер профиля)' }
    if (-not $Hub) { Fail 'нужен -Hub (адрес хаба wss://host/ws?token=…)' }
    if ($Hub -notmatch '^wss?://') { Fail '-Hub должен начинаться с wss:// (или ws:// для локального теста)' }
    $r = if ($Root) { $Root } else { $DefaultRoot }
    $e = if ($Ext) { $Ext } else { Join-Path $r 'ext' }
    $u = if ($Url) { $Url } else { $DefaultUrl }
    $chrome = Find-Chrome
    if (-not $chrome) { Fail 'Google Chrome не найден — установи обычный Chrome (https://www.google.com/chrome/)' }
    New-Item -ItemType Directory -Force -Path $r, (Join-Path $r 'tpl') | Out-Null
    if (-not (Test-Path (Join-Path $e 'manifest.json'))) { Warn "в $e нет manifest.json — распакуй туда расширение (dist.zip) до загрузки в шаблон" }
    $tz = (Get-TimeZone).Id
    if ($tz -notmatch 'Arabian|Dubai|Abu') { Warn "часовой пояс системы «$tz» — для дропа нужен Asia/Dubai (Arabian Standard Time): Set-TimeZone 'Arabian Standard Time'" }
    $cfg = [pscustomobject]@{ prefix = $Prefix; hub = $Hub; root = $r; ext = $e; url = $u; chrome = $chrome; createdAt = (Get-Date).ToString('s') }
    Save-Local $cfg
    Say ''
    Say "Chrome: $chrome"
    Say "Открываю Chrome с шаблоном $(Join-Path $r 'tpl'). Дальше руками:"
    Say "  1. chrome://extensions → включить Developer mode → Load unpacked → выбрать $e"
    Say '  2. Убедиться, что расширение включено. Больше ничего: на apple.com НЕ заходить, настройки расширения НЕ трогать.'
    Say '  3. Закрыть Chrome полностью. Затем: fleet.ps1 check-template'
    Start-Process -FilePath $chrome -ArgumentList @("--user-data-dir=$(Join-Path $r 'tpl')", '--no-first-run', '--no-default-browser-check', '--lang=en-US', 'chrome://extensions') | Out-Null
  }

  'template' {
    $cfg = Load-Local
    $tpl = Join-Path $cfg.root 'tpl'
    Say "Открываю шаблон $tpl (после правок закрыть Chrome и снова fleet.ps1 check-template; клоны при необходимости пересоздать: reset)"
    Start-Process -FilePath $cfg.chrome -ArgumentList @("--user-data-dir=$tpl", '--no-first-run', '--no-default-browser-check', '--lang=en-US', 'chrome://extensions') | Out-Null
  }

  'check-template' {
    $cfg = Load-Local
    $tpl = Join-Path $cfg.root 'tpl'
    $ok = $true
    if (-not (Test-Path $tpl)) { Fail "нет шаблона $tpl — сначала fleet.ps1 init" }
    if ((Chrome-Procs $tpl).Count) { Fail 'Chrome с шаблоном ещё открыт — закрой его полностью и повтори' }
    foreach ($lf in @('lockfile', 'SingletonLock')) { if (Test-Path (Join-Path $tpl $lf)) { Warn "в шаблоне остался $lf — Chrome закрыт некорректно; удаляю"; Remove-Item -Force (Join-Path $tpl $lf) } }
    $prefs = @((Join-Path $tpl 'Default\Preferences'), (Join-Path $tpl 'Default\Secure Preferences')) | Where-Object { Test-Path $_ }
    if (-not $prefs) { Fail "в $tpl\Default нет Preferences — Chrome с шаблоном ни разу не открывался?" }
    # В Preferences путь лежит как в JSON: C:\\drop\\ext. Строка замены .NET буквальная, поэтому '\\' (два символа), а не четыре.
    $extEsc = ($cfg.ext -replace '\\', '\\')
    $found = $false
    foreach ($f in $prefs) { if ((Get-Content -Raw -Encoding UTF8 $f) -match [regex]::Escape($extEsc)) { $found = $true } }
    if ($found) { Say "✓ расширение из $($cfg.ext) есть в настройках шаблона" } else { $ok = $false; Warn "в Preferences шаблона нет пути $($cfg.ext) — расширение не загружено (chrome://extensions → Load unpacked)" }
    foreach ($ck in @((Join-Path $tpl 'Default\Network\Cookies'), (Join-Path $tpl 'Default\Cookies'))) {
      if (Test-Path $ck) {
        $bytes = [IO.File]::ReadAllBytes($ck)
        $text = [Text.Encoding]::ASCII.GetString($bytes)
        if ($text.Contains('apple.com')) { $ok = $false; Warn "в $ck есть cookies apple.com — все клоны унаследовали бы ОДНУ сессию Apple. Удали шаблон (tpl) и сделай заново, не заходя на apple.com" }
        else { Say "✓ cookies без apple.com ($ck)" }
      }
    }
    $sz = Dir-SizeMB $tpl
    Say "размер шаблона: $sz МБ"
    if ($ok) { Say 'Шаблон готов. Дальше: fleet.ps1 clone -Count N' } else { Fail 'шаблон не готов (см. выше)' }
  }

  'clone' {
    $cfg = Load-Local
    if ($Count -lt 1) { Fail 'нужен -Count N (сколько клонов всего, например 10)' }
    if ($Count -gt 12) { Warn 'больше 12 профилей на сервер без замера ресурсов не ставить (FLEET-SPEC §13.8: ~0,5 ГБ на экземпляр)' }
    if (-not (Test-Path (Join-Path $cfg.root 'tpl\Default\Preferences'))) { Fail 'шаблон не готов — fleet.ps1 init / check-template' }
    $made = 0
    for ($i = 1; $i -le $Count; $i++) {
      $p = 'p{0:D2}' -f $i
      $dst = Join-Path $cfg.root $p
      if (Test-Path $dst) { Say "  $p есть"; continue }
      Copy-Template $cfg $dst
      Say "  $p создан → $(Profile-Name $cfg $p)"
      $made++
    }
    Say "готово: создано $made, всего $(@(Profile-Dirs $cfg).Count). Проверка первого клона (F1): fleet.ps1 start -Only p01 → в окне открыть chrome://extensions — расширение включено, без «повреждено»."
  }

  'start' {
    $cfg = Load-Local
    $list = @(Select-Profiles $cfg)
    if (-not $list.Count) { Fail 'клонов нет — fleet.ps1 clone -Count N' }
    if (-not (Test-Path $cfg.chrome)) { Fail "Chrome не найден: $($cfg.chrome)" }
    Say "запускаю $($list.Count): $($list -join ', ') · хаб $($cfg.hub -replace 'token=[^&]+', 'token=…') · страница $($cfg.url)"
    if ($ProxyFlag) { Warn "весь экземпляр через --proxy-server=$ProxyFlag (запасной путь; обычно прокси ставит расширение)" }
    $slots = Window-Slots $list.Count
    for ($i = 0; $i -lt $list.Count; $i++) {
      Start-Profile $cfg $list[$i] $slots[$i]
      if ($i -lt $list.Count - 1) { Start-Sleep -Milliseconds 1500 }
    }
    Say 'Готово. Имя и конфиг каждый клон берёт из адреса (#drop=…&hub=…); при autoStart гонка взводится сама. Проверка: popup расширения → профиль, конфиг v…, хаб ●.'
  }

  'stop' {
    $cfg = Load-Local
    $list = @(Select-Profiles $cfg)
    $total = 0
    foreach ($p in $list) {
      $n = Stop-Profile (Join-Path $cfg.root $p)
      if ($n) { Say "  ${p}: завершено процессов $n" }
      $total += $n
    }
    Say "остановлено процессов: $total (чужой Chrome не тронут)"
  }

  'status' {
    $cfg = Load-Local
    $rows = @()
    foreach ($d in (Profile-Dirs $cfg)) {
      $procs = @(Chrome-Procs $d.FullName)
      $rows += [pscustomobject]@{
        'профиль' = $d.Name; 'имя' = (Profile-Name $cfg $d.Name)
        'запущен' = if ($procs.Count) { 'да' } else { 'нет' }
        'PID' = if ($procs.Count) { ($procs | Sort-Object CreationDate | Select-Object -First 1).ProcessId } else { '' }
        'процессов' = $procs.Count
        'МБ' = Dir-SizeMB $d.FullName
      }
    }
    if (-not $rows.Count) { Say 'клонов нет' } else { $rows | Format-Table -AutoSize }
    Say "шаблон: $(Join-Path $cfg.root 'tpl') · расширение: $($cfg.ext) · хаб: $($cfg.hub -replace 'token=[^&]+', 'token=…')"
  }

  'reset' {
    $cfg = Load-Local
    if (-not $Only) { Fail 'reset только для указанных профилей: fleet.ps1 reset -Only p03 (все сразу — с -Force и -Only p01,p02,…)' }
    $list = @(Select-Profiles $cfg)
    if ($list.Count -gt 1 -and -not $Force) { Fail "reset сразу $($list.Count) профилей — добавь -Force, если точно надо" }
    foreach ($p in $list) {
      $dir = Join-Path $cfg.root $p
      $null = Stop-Profile $dir
      Remove-Item -Recurse -Force $dir
      Copy-Template $cfg $dir
      Say "  $p заменён свежей копией шаблона (сессия Apple, лог и записи заказов этого профиля удалены)"
    }
  }

  'update-ext' {
    $cfg = Load-Local
    if (-not $Zip) { Fail 'нужен -Zip C:\drop\dist.zip (npm run pack) или ext.zip из архива установки' }
    $running = @(Profile-Dirs $cfg | Where-Object { (Chrome-Procs $_.FullName).Count } | ForEach-Object { $_.Name })
    foreach ($p in $running) { $null = Stop-Profile (Join-Path $cfg.root $p) }
    $null = Stop-Profile (Join-Path $cfg.root 'tpl')
    if ($running.Count) { Say "остановлены: $($running -join ', ')" }
    $null = Install-Ext $Zip $cfg.ext
    Say "Путь $($cfg.ext) прежний — шаблон и клоны подхватят новую версию при запуске, reset не нужен."
    if ($running.Count -and -not $NoStart) {
      Say "запускаю снова: $($running -join ', ')"
      $slots = Window-Slots $running.Count
      for ($i = 0; $i -lt $running.Count; $i++) {
        Start-Profile $cfg $running[$i] $slots[$i]
        if ($i -lt $running.Count - 1) { Start-Sleep -Milliseconds 1500 }
      }
    }
  }
}
