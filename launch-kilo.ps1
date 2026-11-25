<#
.SYNOPSIS
    Launcher integrato per Hexagon Local Coding Agent con Kilo Code e runtime Hexagon GGUF.

.DESCRIPTION
    Verifica l'endpoint locale del router Hexagon (default: 127.0.0.1:18803), avvia il router
    se non e' gia' in esecuzione, allinea la configurazione kilo.json tramite @hexagon/kilo-plugin
    (cli.js, zero dipendenze Python) e avvia la CLI Kilo Code con provider 100% locale.

.PARAMETER Port
    Porta HTTP del router llama-server (default: 18803).

.PARAMETER BindHost
    Indirizzo bind del router (default: 127.0.0.1, strettamente loopback).

.PARAMETER Model
    Modello principale per Kilo (default: "hexagon/Ornith-1.5-9B-Q4_0").

.PARAMETER SmallModel
    Modello compatto ausiliario (default: "hexagon/MiniCPM5-2B-Q4_K_M").

.PARAMETER Agent
    Ruolo agent iniziale da avviare (es. code, plan, debug, explore, reviewer).

.PARAMETER Message
    Esegue un messaggio singolo non interattivo (kilo run) ed esce.

.PARAMETER CheckOnly
    Verifica router, modelli, runtime e configurazione senza avviare Kilo.

.PARAMETER GenerateConfigOnly
    Rigenera kilo.json ed esce.

.PARAMETER NoAutoStart
    Non avviare automaticamente il router se offline.

.PARAMETER Pure
    Esegue Kilo in modalita' pure (senza plugin esterni).
#>

param(
    [int]$Port = 18803,
    [string]$BindHost = "127.0.0.1",
    [string]$Model = "hexagon/Ornith-1.5-9B-Q4_0",
    [string]$SmallModel = "hexagon/MiniCPM5-2B-Q4_K_M",
    [string]$Agent = "",
    [string]$Message = "",
    [switch]$CheckOnly,
    [switch]$GenerateConfigOnly,
    [switch]$NoAutoStart,
    [switch]$Pure
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginCli = Join-Path $ScriptDir "plugins\hexagon-runtime\dist\cli.js"

function Invoke-CliCaptured([string]$NodePath, [string[]]$CliArgs) {
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & $NodePath $PluginCli @CliArgs 2>&1 | ForEach-Object { "$_" }
        return @{
            Code = $LASTEXITCODE
            Lines = @($output)
            Text = ($output -join "`n")
        }
    } finally {
        $ErrorActionPreference = $prevEAP
    }
}

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host " HEXAGON LOCAL CODING AGENT (Kilo Code + Hexagon GGUF)" -ForegroundColor Cyan
Write-Host " Target: Windows 11 ARM64 (Qualcomm Snapdragon)" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

# 1. Verifica eseguibile Kilo e Node.js / cli.js
$KiloCmd = Get-Command "kilo.cmd", "kilo" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $KiloCmd) {
    Write-Error "Kilo Code CLI ('kilo' o 'kilo.cmd') non trovato nel PATH. Esegui .\setup-kilo.ps1 per i controlli dei prerequisiti."
    exit 1
}
Write-Host " * Frontend:          Kilo Code CLI ($($KiloCmd.Source))" -ForegroundColor Green

$NodeCmd = Get-Command "node" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $NodeCmd) {
    Write-Error "Node.js ('node') non trovato nel PATH. Esegui .\setup-kilo.ps1 per i controlli dei prerequisiti."
    exit 1
}
if (-not (Test-Path -LiteralPath $PluginCli -PathType Leaf)) {
    Write-Error "Plugin CLI non trovato in $PluginCli. Esegui 'npm run build' in plugins\hexagon-runtime."
    exit 1
}

$BaseUrl = "http://${BindHost}:${Port}/v1"

# Generazione config isolata senza richiedere l'avvio automatico del router
if ($GenerateConfigOnly) {
    Write-Host " * Endpoint Router:   $BaseUrl" -ForegroundColor Green
    Write-Host " * Sincronizzazione:  Aggiornamento kilo.json via plugin TS..." -ForegroundColor Gray
    $setupRes = Invoke-CliCaptured $NodeCmd.Source @("setup", "--workspace", $ScriptDir, "--port", "$Port", "--host", $BindHost)
    if ($setupRes.Code -ne 0) {
        Write-Error "cli.js setup fallito (exit $($setupRes.Code)): $($setupRes.Text)"
        exit 1
    }
    Write-Host "Configurazione kilo.json generata con successo." -ForegroundColor Green
    exit 0
}

# 2. Verifica Router Hexagon
Write-Host " * Endpoint Router:   $BaseUrl" -ForegroundColor Green

$IsOnline = $false
try {
    $resp = Invoke-RestMethod -Uri "$BaseUrl/models" -Method Get -TimeoutSec 2 -ErrorAction SilentlyContinue
    if ($resp -and $resp.data) {
        $IsOnline = $true
        $ModelCount = $resp.data.Count
        Write-Host " * Stato Router:      Online ($ModelCount modelli registrati)" -ForegroundColor Green
    }
} catch {
    $IsOnline = $false
}

if (-not $IsOnline) {
    if ($CheckOnly) {
        Write-Host " * Stato Router:      Offline" -ForegroundColor Yellow
        $valRes = Invoke-CliCaptured $NodeCmd.Source @("validate", "--workspace", $ScriptDir)
        if ($valRes.Code -eq 0) {
            Write-Host " * Stato kilo.json:   Valido (offline/loopback)" -ForegroundColor Green
        } else {
            Write-Host " * Stato kilo.json:   Non valido" -ForegroundColor Red
            $valRes.Lines | ForEach-Object { Write-Host "   $_" -ForegroundColor Red }
        }
        $statusRes = Invoke-CliCaptured $NodeCmd.Source @("status", "--check-runtime", "--workspace", $ScriptDir, "--port", "$Port", "--host", $BindHost)
        if ($statusRes.Code -eq 0 -and $statusRes.Text.Trim()) {
            try {
                $statusObj = $statusRes.Text | ConvertFrom-Json
                if ($statusObj.runtime) {
                    $rt = $statusObj.runtime
                    Write-Host " * Runtime GenieX:    $(if ($rt.commitAligned) { "Allineato" } else { "Disallineato" }) (GenieX=$($rt.geniexHash), llama=$($rt.llamaCommit))" -ForegroundColor $(if ($rt.commitAligned) { "Green" } else { "Yellow" })
                }
            } catch { }
        }
        Write-Host "Verifica completata: Router Hexagon non in esecuzione su $BaseUrl."
        exit 1
    }

    if ($NoAutoStart) {
        Write-Error "Router Hexagon non attivo su $BaseUrl e -NoAutoStart specificato."
        exit 1
    }

    Write-Host " * Stato Router:      Offline. Avvio automatico router locale in corso..." -ForegroundColor Yellow
    $LaunchHexagon = Join-Path $ScriptDir "launch-hexagon.ps1"
    if (-not (Test-Path $LaunchHexagon)) {
        Write-Error "Script launch-hexagon.ps1 non trovato in $ScriptDir"
        exit 1
    }

    # Avvio router in background console separata (con -NoExit per ispezione log)
    Start-Process powershell -ArgumentList "-NoExit -NoProfile -ExecutionPolicy Bypass -File `"$LaunchHexagon`" -Mode Router -Port $Port -BindHost $BindHost" -WorkingDirectory $ScriptDir

    Write-Host " In attesa del router su $BaseUrl (warm-up NPU Hexagon)..." -ForegroundColor Cyan
    $Retries = 45
    while ($Retries -gt 0 -and -not $IsOnline) {
        Start-Sleep -Seconds 1
        try {
            $resp = Invoke-RestMethod -Uri "$BaseUrl/models" -Method Get -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($resp -and $resp.data) {
                $IsOnline = $true
                $ModelCount = $resp.data.Count
                Write-Host " Router attivo con successo! ($ModelCount modelli)" -ForegroundColor Green
                break
            }
        } catch { }
        $Retries--
    }

    if (-not $IsOnline) {
        Write-Error "Impossibile contattare il router Hexagon su $BaseUrl entro il timeout di 45s. Verifica che la porta $Port non sia bloccata."
        exit 1
    }
}

# 3. Sincronizzazione o verifica sola lettura kilo.json + runtime (100% TypeScript via cli.js)
if (-not $CheckOnly) {
    Write-Host " * Sincronizzazione:  Aggiornamento kilo.json via plugin TS..." -ForegroundColor Gray
    $setupRes = Invoke-CliCaptured $NodeCmd.Source @("setup", "--workspace", $ScriptDir, "--port", "$Port", "--host", $BindHost)
    if ($setupRes.Code -ne 0) {
        Write-Warning "cli.js setup ha restituito codice $($setupRes.Code). Verifica kilo.json: $($setupRes.Text)"
    }
}

if ($CheckOnly) {
    $valRes = Invoke-CliCaptured $NodeCmd.Source @("validate", "--workspace", $ScriptDir)
    if ($valRes.Code -ne 0) {
        Write-Host "`nErrori di validazione rilevati in kilo.json:" -ForegroundColor Red
        $valRes.Lines | ForEach-Object { Write-Host " $_" -ForegroundColor Red }
        exit 1
    }

    $statusRes = Invoke-CliCaptured $NodeCmd.Source @("status", "--check-runtime", "--workspace", $ScriptDir, "--port", "$Port", "--host", $BindHost)
    if ($statusRes.Code -ne 0) {
        Write-Error "cli.js status --check-runtime ha restituito codice $($statusRes.Code): $($statusRes.Text)"
        exit 1
    }

    $statusObj = $statusRes.Text | ConvertFrom-Json
    Write-Host "`nControllo stato completato con successo:" -ForegroundColor Green
    Write-Host " * Stato kilo.json:   Valido (offline/loopback)" -ForegroundColor Green
    $routerState = if ($statusObj.router.ready) { "Pronto" } elseif ($statusObj.router.active) { "Warm-up" } else { "Offline" }
    Write-Host " * Router live:       $routerState ($($statusObj.loadedModels.Count) modelli, latenza $($statusObj.latencyMs) ms)" -ForegroundColor Green
    if ($statusObj.runtime) {
        $rt = $statusObj.runtime
        $rtOk = [bool]$rt.commitAligned -and [bool]$rt.allFilesAligned
        Write-Host " * Runtime GenieX:    $(if ($rtOk) { "Allineato" } else { "Disallineato" }) (GenieX=$($rt.geniexHash), llama=$($rt.llamaCommit), firma=$($rt.catalogSignature))" -ForegroundColor $(if ($rtOk) { "Green" } else { "Yellow" })
    }
    $KiloJsonPath = Join-Path $ScriptDir "kilo.json"
    if (Test-Path -LiteralPath $KiloJsonPath -PathType Leaf) {
        $cfgObj = Get-Content -LiteralPath $KiloJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
        Write-Host " * Modello principale: $($cfgObj.model)" -ForegroundColor White
        Write-Host " * Small model:       $($cfgObj.small_model)" -ForegroundColor White
    }
    exit 0
}

# 4. Avvio di Kilo Code
Write-Host "--------------------------------------------------------" -ForegroundColor DarkGray
Write-Host " Modello Principale:  $Model" -ForegroundColor White
Write-Host " Modello Ausiliario:  $SmallModel" -ForegroundColor White
if ($Agent) {
    Write-Host " Ruolo Agente:        $Agent" -ForegroundColor White
}
Write-Host "========================================================`n" -ForegroundColor Cyan

$kiloArgs = @()
if ($Pure) {
    $kiloArgs += "--pure"
}

if ($Message -ne "") {
    Write-Host "Esecuzione prompt singolo non interattivo..." -ForegroundColor Cyan
    $runArgs = @("run", $Message, "-m", $Model)
    if ($Agent) {
        $runArgs += @("--agent", $Agent)
    }
    if ($Pure) {
        $runArgs += "--pure"
    }
    & $KiloCmd.Source @runArgs
    exit $LASTEXITCODE
} else {
    $startArgs = @("-m", $Model)
    if ($Agent) {
        $startArgs += @("--agent", $Agent)
    }
    if ($Pure) {
        $startArgs += "--pure"
    }
    $prevTitle = $null
    try {
        $prevTitle = $Host.UI.RawUI.WindowTitle
        $Host.UI.RawUI.WindowTitle = "Hexagon / Kilo Code - Caricamento in corso..."
    } catch { }
    Write-Host "Avvio TUI Kilo Code (caricamento plugin e indice progetto, attendere qualche secondo)..." -ForegroundColor Cyan

    # kilo.cmd esegue `title %COMSPEC%` prima di lanciare node, azzerando il titolo finestra.
    # Se disponibile, invochiamo direttamente l'entrypoint Node di @kilocode/cli.
    $kiloEntry = Join-Path (Split-Path -Parent $KiloCmd.Source) "node_modules\@kilocode\cli\bin\kilo"
    try {
        if ($NodeCmd -and (Test-Path -LiteralPath $kiloEntry -PathType Leaf)) {
            & $NodeCmd.Source $kiloEntry @startArgs
        } else {
            & $KiloCmd.Source @startArgs
        }
        $kiloExit = $LASTEXITCODE
    } finally {
        if ($null -ne $prevTitle) {
            try { $Host.UI.RawUI.WindowTitle = $prevTitle } catch { }
        }
    }
    exit $kiloExit
}
