@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "LAUNCH_SCRIPT=%SCRIPT_DIR%launch-hexagon.ps1"

if not exist "%LAUNCH_SCRIPT%" (
    echo [ERRORE] Script launch-hexagon.ps1 non trovato in %SCRIPT_DIR%
    pause
    exit /b 1
)

rem Inoltra tutti gli argomenti al configuratore intelligente
powershell -NoProfile -ExecutionPolicy Bypass -File "%LAUNCH_SCRIPT%" %*

if %ERRORLEVEL% neq 0 (
    echo.
    echo Server terminato o interrotto.
    pause
)
