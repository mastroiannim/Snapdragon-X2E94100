<#
.SYNOPSIS
    Verifica in sola lettura l'allineamento del runtime llama.cpp con GenieX.
.DESCRIPTION
    Confronta versioni, SHA-256 e discovery dei dispositivi senza scaricare,
    sostituire o collegare binari. Non costituisce un test di inferenza.
.PARAMETER Apply
    Opzione mantenuta per compatibilita': viene rifiutata prima di ogni controllo.
    L'aggiornamento automatico e' temporaneamente disabilitato.
.PARAMETER AutoConfirm
    Opzione legacy ignorata: non abilita aggiornamenti e non aggira il blocco Apply.
#>
param(
    [string]$BinPath = (Join-Path $env:USERPROFILE "llama-cpp\llama-bin-win-cpu-arm64"),
    [string]$GenieXDir = (Join-Path $env:LOCALAPPDATA "GenieX CLI"),
    [switch]$AutoConfirm,
    [switch]$Apply
)

$ErrorActionPreference = "Stop"

# Fail before discovery, subprocesses, environment changes or file operations.
if ($Apply) {
    throw "-Apply e' disabilitato: questo script verifica soltanto il runtime. L'aggiornamento richiede un intervento separato e verificato."
}

$GenieExe = Join-Path $GenieXDir "geniex.exe"
$GenieLlamaDir = Join-Path $GenieXDir "llama_cpp"
# Solo il processo corrente e i suoi figli; nessuna variabile utente persistente.
$env:ADSP_LIBRARY_PATH = $BinPath

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Controllo allineamento stack llama-cpp <-> GenieX CLI" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

if (-not (Test-Path $GenieExe) -or -not (Test-Path $GenieLlamaDir)) {
    throw "GenieX CLI non trovato in '$GenieXDir': impossibile verificare il runtime."
}

# 1. Leggi versione e commit di GenieX CLI
$genieOut = & $GenieExe --version --skip-update 2>$null
$genieVer = ""
$genieHash = ""
foreach ($line in $genieOut) {
    if ($line -match "GenieX CLI Version:\s*(\S+)") { $genieVer = $Matches[1] }
    if ($line -match "LlamaCPP Runtime Hash:\s*(\S+)") { $genieHash = $Matches[1] }
}

if (-not $genieHash) {
    throw "Impossibile determinare LlamaCPP Runtime Hash da GenieX CLI."
}

# 2. Controlla stato attuale di llama-cpp in $BinPath
$llamaSrv = Join-Path $BinPath "llama-server.exe"
$currentHash = ""
$srvWorks = $false

if (Test-Path $llamaSrv) {
    try {
        $pVer = Start-Process -FilePath $llamaSrv -ArgumentList "--version" -WorkingDirectory $BinPath -NoNewWindow -PassThru -Wait -RedirectStandardOutput "$env:TEMP\llama_ver_out.txt" -RedirectStandardError "$env:TEMP\llama_ver_err.txt"
        $verText = (Get-Content "$env:TEMP\llama_ver_out.txt" -ErrorAction SilentlyContinue) -join "`n"
        $errText = (Get-Content "$env:TEMP\llama_ver_err.txt" -ErrorAction SilentlyContinue) -join "`n"
        $allText = "$verText`n$errText"
        if ($allText -match "commit\s+([0-9a-fA-F]+)") {
            $currentHash = $Matches[1]
        }
        $pHtp = Start-Process -FilePath $llamaSrv -ArgumentList "--list-devices" -WorkingDirectory $BinPath -NoNewWindow -PassThru -Wait -RedirectStandardOutput "$env:TEMP\llama_htp_out.txt" -RedirectStandardError "$env:TEMP\llama_htp_err.txt"
        $devText = ((@(Get-Content "$env:TEMP\llama_htp_out.txt" -ErrorAction SilentlyContinue) +
                     @(Get-Content "$env:TEMP\llama_htp_err.txt" -ErrorAction SilentlyContinue)) -join "`n")
        if ($pVer.ExitCode -eq 0 -and $pHtp.ExitCode -eq 0 -and
            $devText -match "HTP0" -and $devText -match "GPUOpenCL") {
            $srvWorks = $true
        }
    } catch {
        $srvWorks = $false
    } finally {
        Remove-Item "$env:TEMP\llama_ver_out.txt", "$env:TEMP\llama_ver_err.txt", "$env:TEMP\llama_htp_out.txt", "$env:TEMP\llama_htp_err.txt" -ErrorAction SilentlyContinue
    }
}

# 3. Verifica che tutti i file di GenieX\llama_cpp siano presenti e aggiornati in $BinPath
$genieFiles = Get-ChildItem -Path $GenieLlamaDir -File
$missingOrOutdated = @()
foreach ($gf in $genieFiles) {
    $targetFile = Join-Path $BinPath $gf.Name
    if (-not (Test-Path $targetFile)) {
        $missingOrOutdated += $gf.Name
    } else {
        $tf = Get-Item $targetFile
        if ($tf.Length -ne $gf.Length) {
            $missingOrOutdated += $gf.Name
        } else {
            # Timestamp uguali non provano che due file siano identici.
            $srcHash = (Get-FileHash -Path $gf.FullName -Algorithm SHA256).Hash
            $dstHash = (Get-FileHash -Path $targetFile -Algorithm SHA256).Hash
            if ($srcHash -ne $dstHash) {
                $missingOrOutdated += $gf.Name
            }
        }
    }
}

$hashAligned = ($genieHash -match "^[0-9a-fA-F]{7,40}$") -and ($currentHash -match "^[0-9a-fA-F]{7,40}$") -and
               ($currentHash.StartsWith($genieHash, [System.StringComparison]::OrdinalIgnoreCase) -or
                $genieHash.StartsWith($currentHash, [System.StringComparison]::OrdinalIgnoreCase))
$isFullyAligned = $srvWorks -and $hashAligned -and ($missingOrOutdated.Count -eq 0)

if ($isFullyAligned) {
    Write-Host "[OK] Allineamento verificato con GenieX $genieVer (commit $genieHash)." -ForegroundColor Green
    Write-Host "[OK] Device enumerati: CPU Oryon + GPU Adreno (GPUOpenCL) + NPU Hexagon (HTP0)." -ForegroundColor Green
    Write-Host ""
    exit 0
}


Write-Host "[!] Runtime non allineato o device non disponibili." -ForegroundColor Yellow
Write-Host "    Commit frontend: $currentHash; commit GenieX: $genieHash"
if ($missingOrOutdated.Count -gt 0) {
    Write-Host "    File mancanti o differenti: $($missingOrOutdated -join ', ')"
}
throw "Verifica runtime fallita. Nessun binario modificato; l'aggiornamento automatico e' disabilitato."

