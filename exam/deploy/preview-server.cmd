@echo off
setlocal
if "%~1"=="" goto usage
if "%~2"=="" goto usage
set "examKey=%~1"
if not exist "%examKey%" (
  echo SSH key not found: %examKey%
  exit /b 1
)
echo Preview: http://localhost:3300/
echo Keep this window open. Press Ctrl+C to stop.
ssh -i "%examKey%" -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -N -L 127.0.0.1:3300:127.0.0.1:8080 "%~2"
exit /b %errorlevel%
:usage
echo Usage: preview-server.cmd SSH_KEY_PATH USER@SERVER
exit /b 1
