param(
    [string]$BinPath = (Join-Path $env:USERPROFILE "llama-cpp\llama-bin-win-cpu-arm64"),
    [string]$GenieXDir = (Join-Path $env:LOCALAPPDATA "GenieX CLI"),
    [switch]$AutoConfirm
)

$ErrorActionPreference = "Stop"
$GenieExe = Join-Path $GenieXDir "geniex.exe"
$GenieLlamaDir = Join-Path $GenieXDir "llama_cpp"

# Assicura che ADSP_LIBRARY_PATH punti a $BinPath per permettere al driver FastRPC (libcdsprpc.dll)
# di caricare libggml-htp-v81.so e libggml-htp.cat sulla NPU Hexagon (HTP0)
$env:ADSP_LIBRARY_PATH = $BinPath
# ADSP_LIBRARY_PATH resta limitata a questo processo e ai figli.

function Expand-RemoteZipSelective($url, [long]$size, $destDir, $skipFileNames) {
    $tailSize = [Math]::Min($size, 65536)
    $start = $size - $tailSize
    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.UserAgent = "llama-cpp-geniex-sync"
    $req.AddRange([long]$start, [long]($size - 1))
    $resp = $req.GetResponse()
    $ms = New-Object System.IO.MemoryStream
    $resp.GetResponseStream().CopyTo($ms)
    $cdBytes = $ms.ToArray()
    $resp.Close()

    $extracted = 0
    $skipped = 0
    for ($i = 0; $i -lt $cdBytes.Length - 46; $i++) {
        if ($cdBytes[$i] -eq 0x50 -and $cdBytes[$i+1] -eq 0x4B -and $cdBytes[$i+2] -eq 0x01 -and $cdBytes[$i+3] -eq 0x02) {
            $method = [BitConverter]::ToUInt16($cdBytes, $i + 10)
            $compSize = [BitConverter]::ToUInt32($cdBytes, $i + 20)
            $uncompSize = [BitConverter]::ToUInt32($cdBytes, $i + 24)
            $nameLen = [BitConverter]::ToUInt16($cdBytes, $i + 28)
            $extraLen = [BitConverter]::ToUInt16($cdBytes, $i + 30)
            $commentLen = [BitConverter]::ToUInt16($cdBytes, $i + 32)
            $locOffset = [BitConverter]::ToUInt32($cdBytes, $i + 42)
            if ($i + 46 + $nameLen -le $cdBytes.Length) {
                $entryName = [System.Text.Encoding]::UTF8.GetString($cdBytes, $i + 46, $nameLen)
                $leafName = Split-Path $entryName -Leaf
                if ($compSize -gt 0 -and $leafName) {
                    if ($skipFileNames -contains $leafName) {
                        $skipped++
                    } else {
                        $rangeEnd = [long]$locOffset + 30 + $nameLen + 256 + $compSize
                        if ($rangeEnd -ge $size) { $rangeEnd = $size - 1 }
                        $r2 = [System.Net.HttpWebRequest]::Create($url)
                        $r2.UserAgent = "llama-cpp-geniex-sync"
                        $r2.AddRange([long]$locOffset, [long]$rangeEnd)
                        $resp2 = $r2.GetResponse()
                        $ms2 = New-Object System.IO.MemoryStream
                        $resp2.GetResponseStream().CopyTo($ms2)
                        $chunk = $ms2.ToArray()
                        $resp2.Close()

                        $locNameLen = [BitConverter]::ToUInt16($chunk, 26)
                        $locExtraLen = [BitConverter]::ToUInt16($chunk, 28)
                        $dataStart = 30 + $locNameLen + $locExtraLen
                        $outFile = Join-Path $destDir $leafName
                        if ($method -eq 0) {
                            $outBytes = New-Object byte[] $uncompSize
                            [Array]::Copy($chunk, $dataStart, $outBytes, 0, $uncompSize)
                            [System.IO.File]::WriteAllBytes($outFile, $outBytes)
                        } elseif ($method -eq 8) {
                            $compStream = New-Object System.IO.MemoryStream($chunk, $dataStart, [int]$compSize)
                            $deflate = New-Object System.IO.Compression.DeflateStream($compStream, [System.IO.Compression.CompressionMode]::Decompress)
                            $fs = [System.IO.File]::Create($outFile)
                            $deflate.CopyTo($fs)
                            $fs.Close()
                            $deflate.Close()
                        }
                        $extracted++
                    }
                }
                $i += 45 + $nameLen + $extraLen + $commentLen
            }
        }
    }
    return @{ Extracted = $extracted; Skipped = $skipped }
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Controllo allineamento stack llama-cpp <-> GenieX CLI" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

if (-not (Test-Path $GenieExe) -or -not (Test-Path $GenieLlamaDir)) {
    throw "GenieX CLI non trovato in '$GenieXDir': impossibile sincronizzare esplicitamente."
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
                     @(Get-Content "$env:TEMP\llama_htp_err.txt" -ErrorAction SilentlyContinue)) -join "\n")
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
        } elseif ($tf.LastWriteTimeUtc -ne $gf.LastWriteTimeUtc) {
            $srcHash = (Get-FileHash -Path $gf.FullName -Algorithm SHA256).Hash
            $dstHash = (Get-FileHash -Path $targetFile -Algorithm SHA256).Hash
            if ($srcHash -ne $dstHash) {
                $missingOrOutdated += $gf.Name
            }
        }
    }
}

$hashAligned = ($currentHash -ne "") -and ($currentHash.StartsWith($genieHash) -or $genieHash.StartsWith($currentHash))
$isFullyAligned = $srvWorks -and $hashAligned -and ($missingOrOutdated.Count -eq 0)

if ($isFullyAligned) {
    Write-Host "[OK] Stack aggiornato e allineato con GenieX $genieVer (commit $genieHash)." -ForegroundColor Green
    Write-Host "[OK] Backend attivi: CPU Oryon + GPU Adreno (GPUOpenCL) + NPU Hexagon (HTP0)." -ForegroundColor Green
    Write-Host ""
    exit 0
}

# 4. Se non è allineato, mostra i dettagli e proponi l'aggiornamento sicuro
Write-Host "[!] Rilevato disallineamento tra lo stack llama-cpp e GenieX ($genieVer):" -ForegroundColor Yellow
Write-Host "    - Commit attuale in llama-cpp : $(if ($currentHash) { $currentHash } else { 'N/D o non funzionante con HTP0' })"
Write-Host "    - Commit richiesto da GenieX  : $genieHash ($genieVer)"
if ($missingOrOutdated.Count -gt 0) {
    Write-Host "    - Librerie GenieX da collegare: $($missingOrOutdated.Count) file ($($missingOrOutdated[0..([Math]::Min(3, $missingOrOutdated.Count-1))] -join ', ')...)"
}
Write-Host ""
Write-Host "L'aggiornamento sicuro eseguira':" -ForegroundColor Cyan
Write-Host "  1. Backup completo della cartella attuale per rollback automatico in caso di problemi."
Write-Host "  2. Collegamento diretto (HardLink, 0 byte scaricati) di tutte le librerie CPU/GPU/NPU di GenieX."
Write-Host "  3. Scaricamento selettivo HTTP Range dei soli eseguibili mancanti in GenieX (senza scaricare DLL duplicate)."
Write-Host ""

if (-not $AutoConfirm) {
    $choice = Read-Host "Vuoi procedere con l'aggiornamento sicuro adesso? [S/N]"
    if ($choice -notmatch "^[sSyY]$") {
        Write-Host "[i] Aggiornamento annullato dall'utente. Avvio con i file attuali..." -ForegroundColor Yellow
        exit 0
    }
}

# 5. Procedura di aggiornamento sicuro con backup e rollback
$backupDir = "${BinPath}.bak"
$tempExtract = Join-Path $env:TEMP "llama-geniex-extract"

try {
    Write-Host "`n[1/4] Creazione backup di sicurezza in '$backupDir'..." -ForegroundColor Cyan
    if (Test-Path $backupDir) { Remove-Item $backupDir -Recurse -Force }
    if (Test-Path $BinPath) {
        Copy-Item -Path $BinPath -Destination $backupDir -Recurse -Force
    } else {
        New-Item -ItemType Directory -Path $BinPath -Force | Out-Null
    }

    if (-not $hashAligned) {
        Write-Host "[2/4] Ricerca build ufficiale llama.cpp compatibile con il commit GenieX ($genieHash)..." -ForegroundColor Cyan
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $headers = @{ "User-Agent" = "llama-cpp-geniex-sync" }

        $latestRels = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=5" -Headers $headers
        $latestBuildRel = $latestRels | Where-Object { $_.tag_name -match "^b(\d+)$" } | Select-Object -First 1
        if (-not $latestBuildRel) { throw "Impossibile trovare l'ultima release b* su GitHub." }

        $latestNum = [int]($latestBuildRel.tag_name.Substring(1))
        $comp = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/compare/${genieHash}...$($latestBuildRel.tag_name)" -Headers $headers
        $estNum = $latestNum - [int]$comp.ahead_by + [int]$comp.behind_by

        $foundAsset = $null
        $foundTag = $null
        $fallbackAsset = $null
        $fallbackTag = $null
        foreach ($offset in @(0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -7, 7, -8, 8, -9, 9, -10, 10)) {
            $candidateTag = "b$($estNum + $offset)"
            try {
                $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/$candidateTag" -Headers $headers -ErrorAction Stop
                $asset = $rel.assets | Where-Object { $_.name -match "bin-win-cpu-arm64\.zip$" } | Select-Object -First 1
                if ($asset) {
                    if (-not $fallbackAsset) {
                        $fallbackAsset = $asset
                        $fallbackTag = $candidateTag
                    }
                    try {
                        $tagRef = Invoke-RestMethod -Uri "https://api.github.com/repos/ggml-org/llama.cpp/git/ref/tags/$candidateTag" -Headers $headers -ErrorAction Stop
                        $tagSha = $tagRef.object.sha
                        if ($tagSha -and ($tagSha.StartsWith($genieHash) -or $genieHash.StartsWith($tagSha))) {
                            $foundAsset = $asset
                            $foundTag = $candidateTag
                            break
                        }
                    } catch {
                        # API failure does not establish commit compatibility.
                        continue
                    }
                }
            } catch {
                # Tag non ha una release pubblicata, prova il successivo
            }
        }

        # No approximate release fallback: require exact commit/tag match.

        if (-not $foundAsset) {
            throw "Nessun pacchetto Windows ARM64 trovato su GitHub intorno al build b$estNum."
        }

        Write-Host "      Trovata release compatibile: $foundTag. Scaricamento selettivo dei soli eseguibili mancanti..." -ForegroundColor Gray
        if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force }
        New-Item -ItemType Directory -Path $tempExtract -Force | Out-Null

        $genieFileNames = @($genieFiles | Select-Object -ExpandProperty Name)
        $stats = Expand-RemoteZipSelective $foundAsset.browser_download_url $foundAsset.size $tempExtract $genieFileNames
        Write-Host "      Scaricati $($stats.Extracted) file frontend; saltati $($stats.Skipped) file gia' presenti in GenieX." -ForegroundColor Gray

        foreach ($required in @("llama-server.exe", "llama-cli.exe", "llama-bench.exe")) {
            if (-not (Test-Path (Join-Path $tempExtract $required))) {
                throw "ZIP incompleto: $required non estratto. Installazione preservata."
            }
        }
        Remove-Item -Path "$BinPath\*" -Recurse -Force -ErrorAction Stop
        Get-ChildItem -Path $tempExtract -File | ForEach-Object {
            Copy-Item -Path $_.FullName -Destination (Join-Path $BinPath $_.Name) -Force
        }
    } else {
        Write-Host "[2/4] Eseguibili frontend gia' allineati al commit $genieHash (nessun download necessario)." -ForegroundColor Cyan
    }

    Write-Host "[3/4] Collegamento diretto (HardLink) delle librerie da GenieX CLI..." -ForegroundColor Cyan
    $linkedCount = 0
    foreach ($gf in $genieFiles) {
        $destPath = Join-Path $BinPath $gf.Name
        if (Test-Path $destPath) { Remove-Item $destPath -Force }
        try {
            New-Item -ItemType HardLink -Path $destPath -Target $gf.FullName -ErrorAction Stop | Out-Null
        } catch {
            Copy-Item -Path $gf.FullName -Destination $destPath -Force
        }
        $linkedCount++
    }
    Write-Host "      Collegati $linkedCount file da GenieX (CPU Oryon + GPU Adreno + NPU Hexagon HTP0)." -ForegroundColor Gray

    Write-Host "[4/4] Verifica integrita' e caricamento backend NPU (HTP0) e GPU (GPUOpenCL)..." -ForegroundColor Cyan
    $pTestHtp = Start-Process -FilePath $llamaSrv -ArgumentList "--list-devices" -WorkingDirectory $BinPath -NoNewWindow -PassThru -Wait -RedirectStandardOutput "$env:TEMP\test_htp.txt" -RedirectStandardError "$env:TEMP\test_htp_err.txt"
    $devicesText = ((@(Get-Content "$env:TEMP\test_htp.txt" -ErrorAction SilentlyContinue) +
                     @(Get-Content "$env:TEMP\test_htp_err.txt" -ErrorAction SilentlyContinue)) -join "\n")
    if ($pTestHtp.ExitCode -ne 0 -or $devicesText -notmatch "HTP0" -or
        $devicesText -notmatch "GPUOpenCL") {
        throw "Discovery NPU/GPU fallita. Verificare il log di --list-devices."
    }
    # --list-devices non prova che l'inferenza sia realmente offloaded.

    # Rimuovi backup e file temporanei
    Remove-Item $backupDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "`n[OK] Aggiornamento completato con successo! Stack allineato a GenieX $genieVer ($genieHash)." -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Host "`n[ERRORE] Aggiornamento fallito: $($_.Exception.Message)" -ForegroundColor Red
    if (Test-Path $backupDir) {
        Write-Host "[Rollback] Ripristino automatico del backup precedente..." -ForegroundColor Yellow
        Remove-Item "$BinPath\*" -Recurse -Force -ErrorAction SilentlyContinue
        Copy-Item "$backupDir\*" -Destination $BinPath -Recurse -Force
        Remove-Item $backupDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "[Rollback] Ripristino completato." -ForegroundColor Green
    }
    throw
} finally {
    Remove-Item $tempExtract, "$env:TEMP\test_htp.txt", "$env:TEMP\test_htp_err.txt", "$env:TEMP\test_gpu.txt", "$env:TEMP\test_gpu_err.txt" -Recurse -Force -ErrorAction SilentlyContinue
}
