@echo off
setlocal
set "PREV_CP="
for /f "tokens=2 delims=:." %%a in ('chcp') do set "PREV_CP=%%a"
if defined PREV_CP set "PREV_CP=%PREV_CP: =%"
chcp 65001 >nul 2>&1
cd /d "%~dp0"

where pwsh >nul 2>&1
if %errorlevel% equ 0 (
    pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0patch.ps1" %*
) else if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
    "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0patch.ps1" %*
) else (
    powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0patch.ps1" %*
)
set "EXIT_CODE=%errorlevel%"

if "%~1"=="" (
    echo.
    pause
)

if defined PREV_CP chcp %PREV_CP% >nul 2>&1
exit /b %EXIT_CODE%
