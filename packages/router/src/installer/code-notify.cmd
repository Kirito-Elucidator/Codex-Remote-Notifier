@echo off
setlocal enabledelayedexpansion
REM code-notify — Send a notification via Remote Notifier
REM Installed by the Remote Notifier VS Code extension
REM
REM Usage:
REM   code-notify "Title" "Message"
REM   code-notify "Message"
REM   code-notify -l warning "Title" "Message"

set "LEVEL=information"
set "DISPLAY_HINT="
set "ICON_KEY="
set "SOUND_KEY="
set "TITLE="
set "MESSAGE="

:parse_args
if "%~1"=="" goto :done_args
if /i "%~1"=="-l" (
  set "LEVEL=%~2"
  shift
  shift
  goto :parse_args
)
if /i "%~1"=="--level" (
  set "LEVEL=%~2"
  shift
  shift
  goto :parse_args
)
if /i "%~1"=="-d" (
  set "DISPLAY_HINT=%~2"
  shift
  shift
  goto :parse_args
)
if /i "%~1"=="--display" (
  set "DISPLAY_HINT=%~2"
  shift
  shift
  goto :parse_args
)
if /i "%~1"=="-i" (
  set "ICON_KEY=%~2"
  shift
  shift
  goto :parse_args
)
if /i "%~1"=="--icon" (
  set "ICON_KEY=%~2"
  shift
  shift
  goto :parse_args
)
if /i "%~1"=="-s" (
  set "SOUND_KEY=%~2"
  shift
  shift
  goto :parse_args
)
if /i "%~1"=="--sound" (
  set "SOUND_KEY=%~2"
  shift
  shift
  goto :parse_args
)
if /i "%~1"=="-h" goto :show_help
if /i "%~1"=="--help" goto :show_help
if "!TITLE!"=="" (
  set "TITLE=%~1"
) else if "!MESSAGE!"=="" (
  set "MESSAGE=%~1"
)
shift
goto :parse_args

:done_args
REM If only one positional arg, it's the message
if "!MESSAGE!"=="" (
  set "MESSAGE=!TITLE!"
  set "TITLE="
)

REM Un-escape "" to " (standard workaround for Batch arguments)
if not "!MESSAGE!"=="" set "MESSAGE=!MESSAGE:""="!"
if not "!TITLE!"=="" set "TITLE=!TITLE:""="!"

if "!MESSAGE!"=="" (
  echo code-notify: message is required >&2
  echo Usage: code-notify [-l level] [title] ^<message^> >&2
  exit /b 1
)

REM Use PowerShell to handle everything else: session discovery, JSON, and request.
REM Pass variables to PowerShell via environment to avoid quoting hell.
set "RN_MESSAGE=!MESSAGE!"
set "RN_TITLE=!TITLE!"
set "RN_LEVEL=!LEVEL!"
set "RN_DISPLAY_HINT=!DISPLAY_HINT!"
set "RN_ICON_KEY=!ICON_KEY!"
set "RN_SOUND_KEY=!SOUND_KEY!"
set "RN_PORT=%REMOTE_NOTIFIER_PORT%"
set "RN_TOKEN=%REMOTE_NOTIFIER_TOKEN%"
set "RN_URL=%REMOTE_NOTIFIER_URL%"

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ^
  "$port = $env:RN_PORT; $token = $env:RN_TOKEN; $url = $env:RN_URL; " ^
  "if (-not $port -and -not $token) { " ^
  "  $path = Join-Path $env:USERPROFILE '.remote-notifier\session.json'; " ^
  "  if (Test-Path $path) { " ^
  "    try { $s = Get-Content $path -Raw | ConvertFrom-Json; $port = $s.port; $token = $s.token; } catch {} " ^
  "  } " ^
  "} " ^
  "if (-not $port -or -not $token) { " ^
  "  [Console]::Error.WriteLine('code-notify: cannot find Remote Notifier session (is VS Code running?)'); " ^
  "  exit 1; " ^
  "} " ^
  "if (-not $url) { $url = 'http://127.0.0.1:' + $port + '/notify' }; " ^
  "$p = @{ message = $env:RN_MESSAGE; level = $env:RN_LEVEL }; " ^
  "if ($env:RN_TITLE) { $p.title = $env:RN_TITLE }; " ^
  "if ($env:RN_DISPLAY_HINT) { $p.display_hint = $env:RN_DISPLAY_HINT }; " ^
  "if ($env:RN_ICON_KEY) { $p.icon = $env:RN_ICON_KEY }; " ^
  "if ($env:RN_SOUND_KEY) { $p.sound = $env:RN_SOUND_KEY }; " ^
  "$json = $p | ConvertTo-Json -Compress; " ^
  "try { " ^
  "  $headers = @{ Authorization = 'Bearer ' + $token }; " ^
  "  Invoke-RestMethod -Uri $url -Method Post -Body $json -ContentType 'application/json' -Headers $headers | Out-Null; " ^
  "  exit 0; " ^
  "} catch { " ^
  "  if ($_.Exception.Response) { " ^
  "    $code = [int]$_.Exception.Response.StatusCode; " ^
  "    [Console]::Error.WriteLine('code-notify: server returned HTTP ' + $code); " ^
  "  } else { " ^
  "    [Console]::Error.WriteLine('code-notify: could not connect to Remote Notifier server'); " ^
  "  } " ^
  "  exit 1; " ^
  "}"
exit /b %errorlevel%

:show_help
echo Usage: code-notify [-l level] [-d display] [-i icon] [-s sound] [title] ^<message^>
echo        code-notify [-l level] [-d display] [-i icon] [-s sound] ^<message^>
echo.
echo   -l, --level    information^|warning^|error (default: information)
echo   -d, --display  app^|system (hint for notification display mode)
echo   -i, --icon     icon key name (mapped to a file path in main extension settings)
echo   -s, --sound    sound key name (mapped to a file path in main extension settings)
echo.
echo If two positional arguments are given, the first is the title.
exit /b 0
