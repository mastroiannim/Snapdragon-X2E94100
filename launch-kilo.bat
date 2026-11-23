@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "LAUNCH_SCRIPT=%SCRIPT_DIR%launch-kilo.ps1"

if not exist "%LAUNCH_SCRIPT%" (
    echo [ERRORE] Script launch-kilo.ps1 non trovato in %SCRIPT_DIR%
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%LAUNCH_SCRIPT%" %*

if %ERRORLEVEL% neq 0 (
    echo.
    echo Kilo Code terminato con codice di uscita %ERRORLEVEL%.
    pause
)
