$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path $PSScriptRoot -Parent) 'benchmark-hexagon.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('hexagon-profile-tests-' + [guid]::NewGuid().ToString('N'))
$savedAdsp = $env:ADSP_LIBRARY_PATH
New-Item -ItemType Directory -Path $testRoot | Out-Null

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Assert-Rejected([scriptblock]$Action, [string]$Message) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Assert-True $rejected $Message
}

function New-Result([string]$DevArgs, [int]$Prompt = 512, [int]$Gen = 0) {
    $device = [regex]::Match($DevArgs, '(?:^|\s)-dev\s+(\S+)').Groups[1].Value
    $splitMatch = [regex]::Match($DevArgs, '(?:^|\s)-ts\s+(\S+)')
    $split = ''
    if ($splitMatch.Success) {
        $weights = @($splitMatch.Groups[1].Value.Split('/') | ForEach-Object {
            ([double]::Parse($_, [Globalization.CultureInfo]::InvariantCulture)).ToString('F2', [Globalization.CultureInfo]::InvariantCulture)
        })
        $split = $weights -join '/'
    }
    return [pscustomobject]@{
        devices = $device; tensor_split = $split; split_mode = 'layer'
        n_prompt = $Prompt; n_gen = $Gen; n_depth = 0
        avg_ts = 123.45; stddev_ts = 2.0
    }
}

try {
    $testSource = Join-Path $testRoot 'benchmark-hexagon.ps1'
    Copy-Item -LiteralPath $source -Destination $testSource
    $source = $testSource
    # Load the real entry point with no models; never execute the placeholder binary.
    Set-Content -LiteralPath (Join-Path $testRoot 'llama-bench.exe') -Value ''
    Set-Content -LiteralPath (Join-Path $testRoot 'fixture.gguf') -Value ''
    . $source -BinPath $testRoot -ModelsDir $testRoot -Models @() -SkipReportWrite

    $expectedArgs = @(
        '-dev HTP0',
        '-dev HTP0/GPUOpenCL -ts 75/25',
        '-dev HTP0/GPUOpenCL -ts 50/50',
        '-dev HTP0/GPUOpenCL -ts 25/75',
        '-dev GPUOpenCL'
    )
    Assert-True ($profiles.Count -eq $expectedArgs.Count) 'Unexpected number of profiles'
    for ($i = 0; $i -lt $expectedArgs.Count; $i++) {
        Assert-True ($profiles[$i].Args -ceq $expectedArgs[$i]) 'Profile arguments changed or use comma-separated test variants'
        foreach ($counts in @(@{ P = 512; G = 0 }, @{ P = 0; G = 128 })) {
            $json = ConvertTo-Json -InputObject @(New-Result $profiles[$i].Args $counts.P $counts.G)
            $accepted = Get-ValidatedBenchResult $json $profiles[$i].Args $counts.P $counts.G
            Assert-True ($accepted.avg_ts -eq 123.45) 'Matching result rejected or modified'
        }
    }

    $devArgs = $expectedArgs[2]
    $valid = New-Result $devArgs
    $multiple = ConvertTo-Json -InputObject @($valid, $valid, $valid, $valid)
    Assert-Rejected { Get-ValidatedBenchResult $multiple $devArgs 512 0 } 'Four benchmark variants silently reduced to the first result'
    Assert-Rejected { Get-ValidatedBenchResult '[]' $devArgs 512 0 } 'Empty result accepted'
    Assert-Rejected { Get-ValidatedBenchResult '{broken' $devArgs 512 0 } 'Malformed JSON accepted'
    foreach ($case in @(
        @{ Field = 'devices'; Value = 'HTP0' },
        @{ Field = 'devices'; Value = 'GPUOpenCL/HTP0' },
        @{ Field = 'tensor_split'; Value = '75.00/25.00' },
        @{ Field = 'tensor_split'; Value = '50.00' },
        @{ Field = 'tensor_split'; Value = 'NaN/50.00' },
        @{ Field = 'split_mode'; Value = 'none' },
        @{ Field = 'n_prompt'; Value = 128 },
        @{ Field = 'n_gen'; Value = 128 },
        @{ Field = 'n_depth'; Value = 4096 },
        @{ Field = 'avg_ts'; Value = 0 },
        @{ Field = 'avg_ts'; Value = 'NaN' },
        @{ Field = 'stddev_ts'; Value = -1 }
    )) {
        $bad = New-Result $devArgs
        $bad.PSObject.Properties[$case.Field].Value = $case.Value
        $json = ConvertTo-Json -InputObject @($bad)
        Assert-Rejected { Get-ValidatedBenchResult $json $devArgs 512 0 } ('Mismatched field accepted: ' + $case.Field)
    }
    $bad = New-Result $devArgs
    $bad.PSObject.Properties.Remove('stddev_ts')
    $json = ConvertTo-Json -InputObject @($bad)
    Assert-Rejected { Get-ValidatedBenchResult $json $devArgs 512 0 } 'Missing statistics accepted'

    # Exercise the complete report path without PMIC, drivers, models, or a native executable.
    function Get-CimInstance { param($ClassName, $ErrorAction) return $null }
    function Start-Sleep { param($Milliseconds) }
    $script:benchCalls = @()
    $script:multipleResults = $false
    function Start-Process {
        param($FilePath, $ArgumentList, $WorkingDirectory, [switch]$NoNewWindow,
              [switch]$PassThru, $RedirectStandardOutput, $RedirectStandardError)
        $script:benchCalls += $ArgumentList
        $p = [int][regex]::Match($ArgumentList, '(?:^|\s)-p\s+(\d+)').Groups[1].Value
        $g = [int][regex]::Match($ArgumentList, '(?:^|\s)-n\s+(\d+)').Groups[1].Value
        $result = New-Result $ArgumentList $p $g
        $rows = @($result)
        if ($script:multipleResults) { $rows = @($result, $result, $result, $result) }
        ConvertTo-Json -InputObject $rows | Set-Content -LiteralPath $RedirectStandardOutput
        $mockStderr = @(
            'ggml-hex: Hexagon Arch version v81, DMA64 enabled',
            'load_tensors: layer 0 assigned to device HTP0',
            'load_tensors: offloaded 24/24 layers to GPU',
            'load_tensors: HTP0 model buffer size = 1200.00 MiB',
            'llama_kv_cache: HTP0 KV buffer size = 128.00 MiB',
            'llama_perf_context_print: load time = 842.50 ms'
        ) -join "`r`n"
        Set-Content -LiteralPath $RedirectStandardError -Value $mockStderr
        $process = [pscustomobject]@{ HasExited = $true; ExitCode = 0 }
        $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {}
        return $process
    }

    $report = Join-Path $testRoot 'report.md'
    $logDir = Join-Path $testRoot 'logs'
    . $source -BinPath $testRoot -ModelsDir $testRoot -Models 'fixture.gguf' -Repetitions 1 -ReportPath $report -LogDir $logDir
    Assert-True ($script:benchCalls.Count -eq 10) 'Expected prefill and decode for each of five profiles'
    Assert-True ($script:benchCalls[0] -match '(?:^|\s)-v(?:\s|$)') 'llama-bench call missing verbose flag -v for offload telemetry'
    $table = @(Get-Content -LiteralPath $report | Where-Object { $_.StartsWith('|') })
    Assert-True ($table.Count -eq 12) 'Report lost results'
    foreach ($line in $table) {
        Assert-True ($line.Trim('|').Split('|').Count -eq 11) 'Markdown table column counts differ'
    }
    $reportText = Get-Content -LiteralPath $report -Raw
    Assert-True ($reportText.Contains('`fixture.gguf`') -and $reportText.Contains('`pp512`') -and $reportText.Contains('`tg128`')) 'Report prints PowerShell expressions instead of values'
    Assert-True ($reportText.Contains('N/D') -and -not $reportText.Contains('| J/tok')) 'Missing PMIC misrepresented'
    $telemetryPath = "$report.telemetry.json"
    Assert-True (Test-Path -LiteralPath $telemetryPath) 'Missing sidecar telemetry JSON report'
    $telemetryJson = Get-Content -LiteralPath $telemetryPath -Raw | ConvertFrom-Json
    Assert-True (@($telemetryJson.results).Count -eq 10) 'Sidecar telemetry results count mismatch'
    Assert-True ($telemetryJson.results[0].loadTimeMs -eq 842.5 -and $telemetryJson.results[0].warmUpMs -eq 842.5) 'Warm-up time missing from sidecar telemetry'
    Assert-True ($telemetryJson.results[0].offload.layersOffloaded -eq 24 -and $telemetryJson.results[0].offload.offloadPercent -eq 100) 'Offload layer telemetry missing from sidecar'

    # A successful process returning several variants must not publish a misleading report.
    $script:multipleResults = $true
    $rejectedReport = Join-Path $testRoot 'rejected.md'
    $global:LASTEXITCODE = 0
    . $source -BinPath $testRoot -ModelsDir $testRoot -Models 'fixture.gguf' -Repetitions 1 -ReportPath $rejectedReport -LogDir $logDir
    Assert-True ($LASTEXITCODE -eq 1) 'Expected exit code 1 when all benchmark results are rejected'
    $global:LASTEXITCODE = 0
    Assert-True (-not (Test-Path -LiteralPath $rejectedReport)) 'Rejected JSON was published'
    Assert-True (-not (Test-Path -LiteralPath "$rejectedReport.telemetry.json")) 'Rejected telemetry JSON was published'

    # Specific -Device and -TensorSplit must execute ONLY that single profile.
    $script:multipleResults = $false
    $script:benchCalls = @()
    $scopedReport = Join-Path $testRoot 'scoped-hybrid.md'
    . $source -BinPath $testRoot -ModelsDir $testRoot -Models 'fixture.gguf' -Device 'HTP0,GPUOpenCL' -TensorSplit '85,15' -Repetitions 1 -ReportPath $scopedReport -LogDir $logDir
    Assert-True ($profiles.Count -eq 1) 'Expected single scoped profile'
    Assert-True ($profiles[0].Args -ceq '-dev HTP0/GPUOpenCL -ts 85/15') 'Scoped hybrid profile arguments mismatch'
    Assert-True ($script:benchCalls.Count -eq 2) 'Expected only pp512 and tg128 for scoped profile'
    $scopedText = Get-Content -LiteralPath $scopedReport -Raw
    Assert-True ($scopedText.Contains('**HTP0/GPUOpenCL (85/15)**')) 'Scoped report missing expected hybrid profile label'

    $script:benchCalls = @()
    $npuReport = Join-Path $testRoot 'scoped-npu.md'
    . $source -BinPath $testRoot -ModelsDir $testRoot -Models 'fixture.gguf' -Device 'HTP0' -Repetitions 1 -ReportPath $npuReport -LogDir $logDir
    Assert-True ($profiles.Count -eq 1 -and $profiles[0].Args -ceq '-dev HTP0') 'Scoped HTP0 profile mismatch'
    Assert-True ($script:benchCalls.Count -eq 2) 'Expected only pp512 and tg128 for scoped HTP0 profile'

    Assert-Rejected { . $source -BinPath $testRoot -ModelsDir $testRoot -Models @() -TensorSplit '80,20' -SkipReportWrite } 'TensorSplit without Device was accepted'
    Assert-Rejected { . $source -BinPath $testRoot -ModelsDir $testRoot -Models @() -Device 'HTP0' -TensorSplit '80,20' -SkipReportWrite } 'Mismatched TensorSplit weight count was accepted'
    Assert-Rejected { . $source -BinPath $testRoot -ModelsDir $testRoot -Models @() -Device 'HTP0;rm -rf' -SkipReportWrite } 'Invalid Device characters were accepted'

    'BENCHMARK_PROFILE_TESTS=PASS (5 profiles, scoped Device/TensorSplit, pp/tg, invalid JSON, report and rejection path)'
} finally {
    $env:ADSP_LIBRARY_PATH = $savedAdsp
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolved) -like 'hexagon-profile-tests-*') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
