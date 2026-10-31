param(
    [string]$BinPath = (Join-Path $env:USERPROFILE "llama-cpp\llama-bin-win-cpu-arm64"),
    [string]$ModelsDir = (Join-Path $env:USERPROFILE ".cache\geniex\models"),
    [string[]]$Models = @(
        "Qwen3.5-0.8B-Q4_0.gguf",
        "Spark-X2.5-4B-Q4_K_M.gguf",
        "Ornith-1.5-9B-Q4_0.gguf",
        "LFM2.5-24B-A2B-QAD-Q4_0.gguf",
        "Qwen3.8-27B-Q4_0.gguf",
        "Qwen_Qwen3.6-35B-A3B-Q4_0.gguf"
    ),
    [int]$Repetitions = 5,
    [int]$Threads = 12,
    [string]$ReportPath = (Join-Path $PSScriptRoot "BENCHMARK_AUTO.md"),
    [switch]$SkipReportWrite
)

$ErrorActionPreference = "Stop"
$env:ADSP_LIBRARY_PATH = $BinPath
$benchExe = Join-Path $BinPath "llama-bench.exe"

if (-not (Test-Path $benchExe)) {
    throw "Impossibile trovare '$benchExe'. Esegui prima sync-geniex.ps1."
}

function Get-RailSnapshot {
    $raw = Get-CimInstance Win32_PerfRawData_PowerMeterCounter_EnergyMeter -ErrorAction SilentlyContinue
    $map = @{}
    if ($raw) {
        foreach ($r in $raw) {
            $map[$r.Name] = @{ Energy = [double]$r.Energy; Time = [double]$r.Time }
        }
    }
    return $map
}

function Get-RailDeltaWatts($s0, $s1, $dtSec) {
    $res = @{}
    foreach ($k in $s0.Keys) {
        if ($s1.ContainsKey($k)) {
            $dE_pWh = $s1[$k].Energy - $s0[$k].Energy
            $joules = $dE_pWh * 3.6e-9
            $watts = if ($dtSec -gt 0) { $joules / $dtSec } else { 0 }
            $res[$k] = [math]::Round($watts, 2)
        }
    }
    return $res
}

function Invoke-BenchWithPower {
    param(
        [string]$ModelFile,
        [string]$ProfileName,
        [string]$DevArgs,
        [int]$PromptTokens,
        [int]$GenTokens,
        [int]$Depth = 0
    )

    $fullModelPath = Join-Path $ModelsDir $ModelFile
    if (-not (Test-Path $fullModelPath)) {
        Write-Host "[!] Modello non trovato: $fullModelPath (salto)" -ForegroundColor Yellow
        return $null
    }

    $testType = if ($PromptTokens -gt 0 -and $GenTokens -eq 0) { "pp$PromptTokens" }
                elseif ($GenTokens -gt 0 -and $PromptTokens -eq 0) { "tg$GenTokens" }
                else { "pp${PromptTokens}+tg${GenTokens}" }
    if ($Depth -gt 0) { $testType += "@d$Depth" }

    $logDir = Join-Path $PSScriptRoot "benchmark-logs"
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    $runId = [guid]::NewGuid().ToString("N")
    $outFile = Join-Path $logDir ($runId + "_stdout.json")
    $errFile = Join-Path $logDir ($runId + "_stderr.txt")

    $argStr = "-m `"$fullModelPath`" -ngl 999 -fa on -b 4096 -ub 512 -t $Threads -p $PromptTokens -n $GenTokens -d $Depth -r $Repetitions $DevArgs -o json"

    $samples = @()
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $prevSnap = Get-RailSnapshot
    $prevTime = $sw.Elapsed.TotalSeconds

    $proc = Start-Process -FilePath $benchExe -ArgumentList $argStr -WorkingDirectory $BinPath -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile

    while (-not $proc.HasExited) {
        Start-Sleep -Milliseconds 300
        $nowTime = $sw.Elapsed.TotalSeconds
        $nowSnap = Get-RailSnapshot
        $dt = $nowTime - $prevTime
        if ($dt -ge 0.2 -and $nowSnap.Count -gt 0) {
            $w = Get-RailDeltaWatts $prevSnap $nowSnap $dt
            $npuG = ($w["NPU"] + $w["GPU"])
            $cpuW = [math]::Round(($w["CPU_CLUSTER_0"] + $w["CPU_CLUSTER_1"] + $w["CPU_CLUSTER_2"]), 2)
            $samples += [PSCustomObject]@{
                T        = [math]::Round($nowTime, 2)
                NPU      = $w["NPU"]
                GPU      = $w["GPU"]
                CPU      = $cpuW
                MEM      = $w["MEMORY"]
                INFRA    = $w["INFRA"]
                SOC      = $w["SOC"]
                SYS      = $w["SYSTEM"]
                AccelSum = $npuG
            }
            $prevSnap = $nowSnap
            $prevTime = $nowTime
        }
    }
    $proc.WaitForExit()
    Start-Sleep -Milliseconds 100

    $tokPerSec = 0
    $stdDev = 0
    if (Test-Path $outFile) {
        $jsonText = Get-Content $outFile -Raw -ErrorAction SilentlyContinue
        if ($jsonText) {
            try {
                $parsed = $jsonText | ConvertFrom-Json
                if ($parsed -and $parsed[0].avg_ts) {
                    $tokPerSec = [math]::Round([double]$parsed[0].avg_ts, 2)
                    $stdDev    = [math]::Round([double]$parsed[0].stddev_ts, 2)
                }
            } catch {}
        }
    }
    if ($proc.ExitCode -ne 0) {
        Write-Warning "llama-bench exit code $($proc.ExitCode); stderr: $errFile"
        return $null
    }

    if ($tokPerSec -le 0) {
        Write-Host "    [!] Fallito o incompatibile: $ModelFile | $ProfileName ($testType)" -ForegroundColor Yellow
        return $null
    }

    # La telemetria PMIC puo' essere assente: la misura di throughput resta valida.
    # I campioni coprono caricamento e benchmark: non isolano prefill/decode.
    $active = @($samples)
    $hasPower = ($active.Count -gt 0)
    if (-not $hasPower) {
        Write-Warning "PMIC non disponibile per $ModelFile ($testType): throughput conservato, potenza N/D."
    }

    $avgNPU   = if ($hasPower) { [math]::Round(($active | Measure-Object -Property NPU -Average).Average, 2) } else { $null }
    $avgGPU   = if ($hasPower) { [math]::Round(($active | Measure-Object -Property GPU -Average).Average, 2) } else { $null }
    $avgCPU   = if ($hasPower) { [math]::Round(($active | Measure-Object -Property CPU -Average).Average, 2) } else { $null }
    $avgMEM   = if ($hasPower) { [math]::Round(($active | Measure-Object -Property MEM -Average).Average, 2) } else { $null }
    $avgINFRA = if ($hasPower) { [math]::Round(($active | Measure-Object -Property INFRA -Average).Average, 2) } else { $null }
    $avgSOC   = if ($hasPower) { [math]::Round(($active | Measure-Object -Property SOC -Average).Average, 2) } else { $null }
    $avgSYS   = if ($hasPower) { [math]::Round(($active | Measure-Object -Property SYS -Average).Average, 2) } else { $null }

    # NON calcolare E/token da potenza media dell'intero processo e velocita' di sola inferenza.
    # Intervalli differenti rendono il rapporto fisicamente non interpretabile.
    $jPerTok = $null
    $tokPerJ = $null

    return [PSCustomObject]@{
        Model     = $ModelFile
        Profile   = $ProfileName
        Test      = $testType
        TokPerSec = $tokPerSec
        StdDev    = $stdDev
        NPU_W     = $avgNPU
        GPU_W     = $avgGPU
        CPU_W     = $avgCPU
        MEM_W     = $avgMEM
        INFRA_W   = $avgINFRA
        SOC_W     = $avgSOC
        SYS_W     = $avgSYS
        J_per_Tok = $jPerTok
        Tok_per_J = $tokPerJ
    }
}

$profiles = @(
    @{ Name = "HTP0 (100% NPU)";        Args = "-dev HTP0" },
    @{ Name = "HTP0/GPUOpenCL (75/25)"; Args = "-dev HTP0,GPUOpenCL -ts 75,25" },
    @{ Name = "HTP0/GPUOpenCL (50/50)"; Args = "-dev HTP0,GPUOpenCL -ts 50,50" },
    @{ Name = "HTP0/GPUOpenCL (25/75)"; Args = "-dev HTP0,GPUOpenCL -ts 25,75" },
    @{ Name = "GPUOpenCL (100% GPU)";   Args = "-dev GPUOpenCL" }
)

Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host "  Benchmark Prestazioni & Telemetria PMIC (Hexagon HTP0 vs GPUOpenCL)" -ForegroundColor Cyan
Write-Host "=====================================================================" -ForegroundColor Cyan

$allResults = @()

foreach ($m in $Models) {
    Write-Host "`n>>> Modello: $m" -ForegroundColor Green
    foreach ($p in $profiles) {
        Write-Host "  -> [$($p.Name)] Prompt Processing (pp512)..." -ForegroundColor Gray
        $rPP = Invoke-BenchWithPower -ModelFile $m -ProfileName $p.Name -DevArgs $p.Args -PromptTokens 512 -GenTokens 0
        if ($rPP) { $allResults += $rPP }

        Write-Host "  -> [$($p.Name)] Token Generation (tg128)..." -ForegroundColor Gray
        $rTG = Invoke-BenchWithPower -ModelFile $m -ProfileName $p.Name -DevArgs $p.Args -PromptTokens 0 -GenTokens 128
        if ($rTG) { $allResults += $rTG }
    }
}

Write-Host "`n=== RISULTATI RIEPILOGATIVI ===" -ForegroundColor Cyan
$allResults | Format-Table -AutoSize

if (-not $SkipReportWrite -and $allResults.Count -gt 0) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine("# Benchmark & PMIC Energy Report (Auto-Generated)")
    [void]$sb.AppendLine("**Nota:** potenze PMIC medie indicative dell'intero processo (caricamento incluso); nessuna misura di J/token e' disponibile senza sincronizzazione temporale delle fasi. N/D significa telemetria non disponibile.")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("Generato il: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("| Modello | Profilo | Test | Velocita' (t/s) | NPU (W) | GPU (W) | CPU (W) | RAM (W) | INFRA (W) | SoC Tot (W) | Sistema (W) |")
    [void]$sb.AppendLine("| :--- | :--- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    foreach ($row in $allResults) {
        [void]$sb.AppendLine("| `$($row.Model)` | **$($row.Profile)** | `$($row.Test)` | **$($row.TokPerSec)** ± $($row.StdDev) | $($row.NPU_W) | $($row.GPU_W) | $($row.CPU_W) | $($row.MEM_W) | $($row.INFRA_W) | **$($row.SOC_W)** | $($row.SYS_W) |")
    }
    [System.IO.File]::WriteAllText($ReportPath, $sb.ToString(), [System.Text.Encoding]::UTF8)
    Write-Host "[OK] Report salvato in: $ReportPath" -ForegroundColor Green
}
