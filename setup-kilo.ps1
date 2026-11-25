<#
.SYNOPSIS
    Script di setup, verifica prerequisiti e validazione offline per Hexagon Local Coding Agent.

.DESCRIPTION
    Verifica l'ambiente Windows 11 ARM64, la presenza di Node.js e Kilo Code CLI,
    l'allineamento del runtime Hexagon (GenieX / llama.cpp), la disponibilita' dei modelli GGUF
    e la conformita' delle impostazioni di sicurezza offline tramite @hexagon/kilo-plugin (cli.js),
    senza alcuna dipendenza da Python.

.PARAMETER VerifyOffline
    Esegue controlli rigorosi sull'assenza di endpoint esterni, chiavi cloud o instradamenti remoti.

.PARAMETER CheckOnly
    Solo verifica in sola lettura senza apportare modifiche.

.PARAMETER Port
    Porta HTTP del router llama-server (default: 18803).

.PARAMETER BindHost
    Indirizzo bind del router (default: 127.0.0.1).
#>

param(
    [switch]$VerifyOffline,
    [switch]$CheckOnly,
    [int]$Port = 18803,
    [string]$BindHost = "127.0.0.1"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginCli = Join-Path $ScriptDir "plugins\hexagon-runtime\dist\cli.js"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host " SETUP E VERIFICA PREREQUISITI: HEXAGON LOCAL CODING AGENT" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

$Passed = 0
$Failed = 0
$Warnings = 0

function Report-Check([string]$Name, [bool]$Ok, [string]$Details = "") {
    if ($Ok) {
        Write-Host " [OK]      $Name $(if ($Details) { "($Details)" })" -ForegroundColor Green
        $script:Passed++
    } else {
        Write-Host " [ERRORE]  $Name $(if ($Details) { "($Details)" })" -ForegroundColor Red
        $script:Failed++
    }
}

function Report-Warn([string]$Name, [string]$Details = "") {
    Write-Host " [ATTENZ]  $Name $(if ($Details) { "($Details)" })" -ForegroundColor Yellow
    $script:Warnings++
}

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

# 1. Piattaforma e Architettura
$IsWin = [System.Environment]::OSVersion.Platform -eq "Win32NT"
$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$IsArm64 = ($Arch -eq "Arm64")
Report-Check "Piattaforma Windows 11 ARM64" ($IsWin -and $IsArm64) "OS: Windows, Arch: $Arch"

# 2. Node.js e NPM
$NodeCmd = Get-Command "node" -ErrorAction SilentlyContinue | Select-Object -First 1
$NodeVer = if ($NodeCmd) { (& $NodeCmd.Source -v 2>$null).Trim() } else { "" }
Report-Check "Node.js installato" ($null -ne $NodeCmd) "Versione: $NodeVer"

# 3. Kilo Code CLI upstream
$KiloCmd = Get-Command "kilo.cmd", "kilo" -ErrorAction SilentlyContinue | Select-Object -First 1
$KiloVer = if ($KiloCmd) { (& $KiloCmd.Source --version 2>$null).Trim() } else { "" }
Report-Check "Kilo Code CLI" ($null -ne $KiloCmd) "Versione: $KiloVer"

# 4. Runtime Hexagon / GenieX via cli.js status --check-runtime (zero Python)
$HasPluginCli = ($null -ne $NodeCmd) -and (Test-Path -LiteralPath $PluginCli -PathType Leaf)
if ($HasPluginCli) {
    $statusRes = Invoke-CliCaptured $NodeCmd.Source @("status", "--check-runtime", "--workspace", $ScriptDir, "--port", "$Port", "--host", $BindHost)
    $statusObj = $null
    if ($statusRes.Code -eq 0 -and $statusRes.Text.Trim()) {
        try {
            $statusObj = $statusRes.Text | ConvertFrom-Json
        } catch {
            $statusObj = $null
        }
    }

    if ($statusObj -and $statusObj.runtime) {
        $rt = $statusObj.runtime
        $geniexOk = [bool]$rt.geniexInstalled
        $llamaOk = [bool]$rt.llamaServerInstalled
        $commitAligned = [bool]$rt.commitAligned
        $filesAligned = [bool]$rt.allFilesAligned
        $geniexVer = if ($rt.geniexVersion) { [string]$rt.geniexVersion } else { "Non rilevato" }
        $llamaVer = if ($rt.llamaServerVersion) { [string]$rt.llamaServerVersion } else { "Non rilevato" }
        $sigStatus = if ($rt.catalogSignature) { [string]$rt.catalogSignature } else { "N/D" }

        Report-Check "GenieX CLI Runtime" $geniexOk "Versione: $geniexVer"
        Report-Check "llama-server Hexagon" $llamaOk "Versione: $llamaVer"
        $commitDetail = if ($commitAligned) {
            "Commit corrispondente"
        } else {
            "GenieX=$($rt.geniexHash), llama=$($rt.llamaCommit)"
        }
        Report-Check "Allineamento Commit Runtime" $commitAligned $commitDetail
        $filesDetail = if ($filesAligned) {
            "File e firma Authenticode ($sigStatus) verificati"
        } else {
            $parts = @()
            if ($rt.missingFiles -and @($rt.missingFiles).Count -gt 0) {
                $parts += "Mancanti: $((@($rt.missingFiles)) -join ', ')"
            }
            if ($rt.staleFiles -and @($rt.staleFiles).Count -gt 0) {
                $parts += "Non allineati: $((@($rt.staleFiles)) -join ', ')"
            }
            if ($parts.Count -eq 0 -and $rt.error) { $parts += [string]$rt.error }
            $parts -join "; "
        }
        Report-Check "Integrita' Binari Runtime" $filesAligned $filesDetail
    } else {
        Report-Check "Verifica Stack Runtime" $false "cli.js status --check-runtime ha fallito l'ispezione"
    }
} else {
    Report-Check "Verifica Stack Runtime" $false "Node.js o $PluginCli non disponibile (eseguire npm run build in plugins/hexagon-runtime)"
}

# 5. Modelli GGUF in cache
$ModelsDir = Join-Path $env:USERPROFILE ".cache\geniex\models"
$ModelsExist = Test-Path $ModelsDir
$GgufCount = 0
if ($ModelsExist) {
    $GgufCount = @(Get-ChildItem -Path $ModelsDir -Filter "*.gguf" -File).Count
    if ($GgufCount -eq 0) {
        $GgufCount = @(Get-ChildItem -Path $ModelsDir -Filter "*.gguf" -File -Recurse | Where-Object { $_.Name -notlike "mmproj*" }).Count
    }
}
Report-Check "Cache Modelli GGUF" ($GgufCount -gt 0) "Trovati $GgufCount file in $ModelsDir"

# 6. Configurazione Kilo Code locale
$KiloJsonPath = Join-Path $ScriptDir "kilo.json"
if (-not (Test-Path $KiloJsonPath) -and -not $CheckOnly) {
    if ($HasPluginCli) {
        $setupRes = Invoke-CliCaptured $NodeCmd.Source @("setup", "--workspace", $ScriptDir, "--port", "$Port", "--host", $BindHost)
        if ($setupRes.Code -ne 0) {
            Report-Warn "Generazione kilo.json" $setupRes.Text
        }
    }
}
$KiloJsonExists = Test-Path $KiloJsonPath
Report-Check "File configurazione kilo.json" $KiloJsonExists "Percorso: $KiloJsonPath"

# 7. Validazione Regole Offline e Sicurezza via cli.js validate (zero Python)
$OfflineValid = $false
$OfflineIssues = @()
if ($KiloJsonExists -and $HasPluginCli) {
    $valRes = Invoke-CliCaptured $NodeCmd.Source @("validate", "--workspace", $ScriptDir)
    if ($valRes.Code -eq 0) {
        $OfflineValid = $true
    } else {
        $OfflineIssues += $valRes.Lines
    }
} elseif (-not $KiloJsonExists) {
    $OfflineIssues += "kilo.json mancante"
} else {
    $OfflineIssues += "cli.js non disponibile"
}
$OfflineDetail = if ($OfflineValid -and $VerifyOffline) {
    "Verifica rigorosa offline/loopback superata"
} elseif (-not $OfflineValid) {
    $OfflineIssues -join "; "
} else {
    ""
}
Report-Check "Sicurezza Endpoint Offline (Loopback $BindHost)" $OfflineValid $OfflineDetail

# 8. Agenti e Subagenti personalizzati
$AgentsDir = Join-Path $ScriptDir ".kilo\agents"
$AgentsExist = Test-Path $AgentsDir
$AgentCount = if ($AgentsExist) { @(Get-ChildItem -Path $AgentsDir -Filter "*.md").Count } else { 0 }
Report-Check "Agenti e Subagenti personalizzati (.kilo/agents)" ($AgentCount -ge 4) "Trovati $AgentCount ruoli (code, plan, debug, explore, reviewer)"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host " RIEPILOGO: $Passed superati, $Failed falliti, $Warnings avvisi." -ForegroundColor $(if ($Failed -eq 0) { "Green" } else { "Red" })
Write-Host "========================================================" -ForegroundColor Cyan

if ($Failed -gt 0) {
    Write-Host "`nRisolvi gli errori sopra elencati prima di avviare l'agente." -ForegroundColor Yellow
    exit 1
} else {
    Write-Host "`nSistema pronto! Avvia l'agente con: .\launch-kilo.ps1" -ForegroundColor Green
    exit 0
}
