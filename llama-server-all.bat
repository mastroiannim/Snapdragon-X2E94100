@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "LAUNCH_SCRIPT=%SCRIPT_DIR%launch-hexagon.ps1"

if not exist "%LAUNCH_SCRIPT%" (
    echo [ERRORE] Script launch-hexagon.ps1 non trovato in %SCRIPT_DIR%
    pause
    exit /b 1
)

echo Avvio llama-server in modalita' ROUTER (tutti i modelli disponibili)...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%LAUNCH_SCRIPT%" -Mode Router %*

if %ERRORLEVEL% neq 0 (
    echo.
    echo Server terminato o interrotto.
    pause
)
