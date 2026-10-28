@echo off
setlocal

set "BIN_PATH=%USERPROFILE%\llama-cpp\llama-bin-win-cpu-arm64"
set "BASE_MODELS=%USERPROFILE%\.cache\geniex\models"
set "SYNC_SCRIPT=%~dp0sync-geniex.ps1"
if not exist "%SYNC_SCRIPT%" (
    set "SYNC_SCRIPT=%USERPROFILE%\llama-cpp\sync-geniex.ps1"
)

rem FastRPC: fa trovare a libcdsprpc.dll libggml-htp-v81.so + libggml-htp.cat per HTP0
set "ADSP_LIBRARY_PATH=%BIN_PATH%"
rem Stabilita' NPU Hexagon su contesti lunghi (>8K) mantenendo HMX Flash Attention (FA_SELECT=2) attiva
set "GGML_HEXAGON_OPBATCH=512"
set "GGML_HEXAGON_VTCM_SIZE=8M"
cd /d "%BIN_PATH%"

if exist "%SYNC_SCRIPT%" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%SYNC_SCRIPT%" -BinPath "%BIN_PATH%" -AutoConfirm
)

rem Hard-link espone i .gguf dei sotto-repo nella root di --models-dir (0 byte duplicati)
for /r "%BASE_MODELS%" %%F in (*.gguf) do (
    if /i not "%%~dpF"=="%BASE_MODELS%\" (
        if not exist "%BASE_MODELS%\%%~nxF" (
            echo Creo link per: %%~nxF
            mklink /H "%BASE_MODELS%\%%~nxF" "%%F"
        )
    )
)

rem Opzionale: sanity-check dispositivi (commentalo per avvio rapido)
rem "%BIN_PATH%\llama-server.exe" --list-devices

"%BIN_PATH%\llama-server.exe" ^
  --host 0.0.0.0 ^
  --port 18803 ^
  --jinja ^
  --models-dir "%BASE_MODELS%" ^
  --agent ^
  -lm mlock ^
  -lv 3 ^
  -ngl 999 ^
  -c 65536 ^
  -b 4096 ^
  -ub 512 ^
  -tb 8 ^
  -t 12 ^
  -fit off ^
  -dev HTP0,GPUOpenCL ^
  -ts 75,25 ^
  -fa on

echo.
pause
