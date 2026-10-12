@echo off
setlocal
set "examKey=%USERPROFILE%\Downloads\_bibiniao-exam-key.pem"
if not "%~1"=="" set "examKey=%~1"
if not exist "%examKey%" (
  echo SSH key not found: %examKey%
  echo Drag the existing PEM key onto this launcher, or pass its path.
  pause
  exit /b 1
)
echo ECS preview: http://localhost:3300/
echo Admin: http://localhost:3300/admin
echo Keep this window open while using the preview. Press Ctrl+C to stop.
ssh -i "%examKey%" -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -N -L 127.0.0.1:3300:127.0.0.1:8080 root@47.114.55.204
if errorlevel 1 pause
