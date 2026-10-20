@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto missing

for /f %%v in ('node -p "parseInt(process.versions.node)"') do set major=%%v
if %major% LSS 18 goto old

node bin\claude-dashboard.js %*
exit /b %errorlevel%

:missing
echo claude-dashboard needs Node.js 18 or newer. Install it from https://nodejs.org, then run run.cmd again.
pause
exit /b 1

:old
echo claude-dashboard needs Node.js 18 or newer. Update it from https://nodejs.org, then run run.cmd again.
pause
exit /b 1
