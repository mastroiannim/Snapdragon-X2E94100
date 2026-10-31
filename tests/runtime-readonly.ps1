$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path $PSScriptRoot -Parent) 'sync-geniex.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('hexagon-readonly-tests-' + [guid]::NewGuid().ToString('N'))
$shellExe = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$runtime = Join-Path $testRoot 'runtime'
$genie = Join-Path $testRoot 'genie'
$missing = Join-Path $testRoot 'missing'
New-Item -ItemType Directory -Path $runtime, (Join-Path $genie 'llama_cpp') -Force | Out-Null

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Get-FixtureSnapshot {
    $lines = foreach ($dir in @($runtime, $genie)) {
        Get-ChildItem -LiteralPath $dir -Recurse -File | Sort-Object FullName | ForEach-Object {
            $_.FullName + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        }
    }
    return ($lines -join "`n")
}

function Invoke-Check([string]$Name, [string[]]$Options, [string]$BinDir, [string]$GenieDir) {
    $stdout = Join-Path $testRoot ($Name + '-out.txt')
    $stderr = Join-Path $testRoot ($Name + '-err.txt')
    $arguments = @('-NoProfile', '-File', ('"' + $source + '"'),
        '-BinPath', ('"' + $BinDir + '"'), '-GenieXDir', ('"' + $GenieDir + '"')) + $Options
    $process = Start-Process -FilePath $shellExe -ArgumentList $arguments -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $text = (Get-Content -LiteralPath $stdout -Raw) + (Get-Content -LiteralPath $stderr -Raw)
    Assert-True ($process.ExitCode -ne 0) ('Unexpected success: ' + $Name)
    return $text
}

try {
    Set-Content -LiteralPath (Join-Path $runtime 'llama-server.exe') -Value 'must never execute'
    Set-Content -LiteralPath (Join-Path $runtime 'ggml.dll') -Value 'installed runtime sentinel'
    Set-Content -LiteralPath (Join-Path $genie 'geniex.exe') -Value 'must never execute'
    Set-Content -LiteralPath (Join-Path $genie 'llama_cpp\ggml.dll') -Value 'different source sentinel'
    $before = Get-FixtureSnapshot
    $userAdsp = [Environment]::GetEnvironmentVariable('ADSP_LIBRARY_PATH', 'User')

    foreach ($case in @(
        @{ Name = 'apply'; Options = @('-Apply'); Bin = $runtime; Genie = $genie },
        @{ Name = 'apply-auto'; Options = @('-Apply', '-AutoConfirm'); Bin = $runtime; Genie = $genie },
        @{ Name = 'apply-missing'; Options = @('-Apply', '-AutoConfirm'); Bin = $missing; Genie = $missing }
    )) {
        $message = Invoke-Check $case.Name $case.Options $case.Bin $case.Genie
        Assert-True ($message -match "-Apply e' disabilitato") ('Apply was not rejected before discovery: ' + $case.Name)
        Assert-True ((Get-FixtureSnapshot) -ceq $before) ('Runtime/source changed: ' + $case.Name)
        Assert-True (-not (Test-Path -LiteralPath ($case.Bin + '.bak'))) 'Backup created by disabled updater'
    }
    Assert-True (-not (Test-Path -LiteralPath $missing)) 'Disabled Apply created an installation directory'

    foreach ($options in @(@{ Name = 'check'; Args = @() }, @{ Name = 'check-auto'; Args = @('-AutoConfirm') })) {
        $message = Invoke-Check $options.Name $options.Args $runtime $missing
        Assert-True ($message -match 'GenieX CLI non trovato') 'Missing GenieX was not reported'
        Assert-True ((Get-FixtureSnapshot) -ceq $before) 'Read-only failure changed fixture files'
    }
    Assert-True ($userAdsp -ceq [Environment]::GetEnvironmentVariable('ADSP_LIBRARY_PATH', 'User')) 'Persistent ADSP_LIBRARY_PATH changed'
    'RUNTIME_READONLY_TESTS=PASS (Apply, Apply+AutoConfirm, missing paths, read-only failures, unchanged fixtures)'
} finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolved) -like 'hexagon-readonly-tests-*') {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
