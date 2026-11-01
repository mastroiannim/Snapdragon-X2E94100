$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('hexagon-tui-setup-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$source = Split-Path $PSScriptRoot -Parent
$passed = 0
function Assert-True($Condition, $Message) { if (-not $Condition) { throw $Message } }
function New-Fixture([string]$Name, [switch]$NoPython) {
    $dir = Join-Path $root $Name
    [void][IO.Directory]::CreateDirectory($dir)
    $requirements = Join-Path $dir 'requirements.txt'
    [IO.File]::WriteAllText($requirements, 'rich>=13')
    $python = Join-Path $dir 'existing-python.exe'
    if (-not $NoPython) { [IO.File]::WriteAllText($python, 'fixture') }
    $m = Import-Module (Join-Path $source 'tui-bootstrap.psm1') -Force -PassThru
    & $m {
        param($Python, $NoPython)
        $script:Python = $Python; $script:NoPython = $NoPython
        $script:Installations = 0; $script:PipCalls = 0; $script:FailPip = $false
        function script:Find-TuiPython($ManagedRoot) { if (-not $script:NoPython) { return $script:Python }; return $null }
        function script:Install-TuiPython($Destination, $Architecture) {
            $script:Installations++
            [void][IO.Directory]::CreateDirectory($Destination)
            $result = Join-Path $Destination 'python.exe'
            [IO.File]::WriteAllText($result, 'installed Python fixture')
            return $result
        }
        function script:Invoke-RuntimeNative([string]$File, [string]$Arguments, [string]$Directory, [int]$Timeout) {
            if ($Arguments -match '-m venv "(.+)"') {
                $scripts = Join-Path $Matches[1] 'Scripts'
                [void][IO.Directory]::CreateDirectory($scripts)
                [IO.File]::WriteAllText((Join-Path $scripts 'python.exe'), 'virtual environment fixture')
            }
            if ($Arguments -match '-m pip install') {
                $script:PipCalls++
                if ($script:FailPip) { throw 'injected pip failure' }
            }
            return ''
        }
    } $python ([bool]$NoPython)
    return [pscustomobject]@{ Module = $m; Requirements = $requirements; Cache = (Join-Path $dir 'cache') }
}
try {
    $f = New-Fixture 'GenieX only' -NoPython
    $python = Resolve-HexagonTuiPython -Requirements $f.Requirements -CacheDirectory $f.Cache
    Assert-True (Test-Path -LiteralPath $python) 'No virtual environment created'
    Assert-True ((& $f.Module { $script:Installations }) -eq 1) 'Missing Python was not installed'
    Assert-True ((& $f.Module { $script:PipCalls }) -eq 1) 'Dependencies were not installed'
    $passed++; Write-Host 'PASS missing Python provisions interpreter, venv and dependencies'

    $f = New-Fixture 'reuse'
    [void](Resolve-HexagonTuiPython -Requirements $f.Requirements -CacheDirectory $f.Cache)
    [void](Resolve-HexagonTuiPython -Requirements $f.Requirements -CacheDirectory $f.Cache)
    Assert-True ((& $f.Module { $script:Installations }) -eq 0) 'Existing Python was replaced'
    Assert-True ((& $f.Module { $script:PipCalls }) -eq 1) 'Second launch reinstalled dependencies'
    $passed++; Write-Host 'PASS existing interpreter reused; second launch avoids pip'
    [IO.File]::WriteAllText($f.Requirements, 'rich>=14')
    [void](Resolve-HexagonTuiPython -Requirements $f.Requirements -CacheDirectory $f.Cache)
    Assert-True ((& $f.Module { $script:PipCalls }) -eq 2) 'Changed requirements ignored'
    $passed++; Write-Host 'PASS changed requirements reinstall automatically'

    $f = New-Fixture 'pip failure'
    & $f.Module { $script:FailPip = $true }
    $failed = $false
    try { [void](Resolve-HexagonTuiPython -Requirements $f.Requirements -CacheDirectory $f.Cache) } catch { $failed = $true }
    Assert-True $failed 'pip failure reported as success'
    Assert-True (-not (Test-Path (Join-Path $f.Cache 'tui-env/requirements.sha256'))) 'Failed install wrote success marker'
    & $f.Module { $script:FailPip = $false }
    [void](Resolve-HexagonTuiPython -Requirements $f.Requirements -CacheDirectory $f.Cache)
    Assert-True ((& $f.Module { $script:PipCalls }) -eq 2) 'Failed bootstrap did not retry'
    $passed++; Write-Host 'PASS failed pip install remains retryable without false success marker'
    Write-Host "TUI_BOOTSTRAP_TESTS=PASS ($passed scenarios)"
} finally {
    Remove-Module tui-bootstrap -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
