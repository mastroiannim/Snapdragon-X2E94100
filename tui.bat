@echo off
setlocal

rem Forza Code Page UTF-8 per simboli ed emoji terminale
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1

set "SCRIPT_DIR=%~dp0"
set "TUI_SCRIPT=%SCRIPT_DIR%tui.py"

if not exist "%TUI_SCRIPT%" (
    echo [ERRORE] Script tui.py non trovato in %SCRIPT_DIR%
    pause
    exit /b 1
)

python "%TUI_SCRIPT%" %*

if %ERRORLEVEL% neq 0 (
    echo.
    echo TUI terminata.
)
