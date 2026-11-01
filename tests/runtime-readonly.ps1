$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path $PSScriptRoot -Parent) 'sync-geniex.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('hexagon-readonly-' + [guid]::NewGuid().ToString('N'))
$runtime = Join-Path $root 'runtime'
$genie = Join-Path $root 'genie'
[void][IO.Directory]::CreateDirectory($runtime)
[void][IO.Directory]::CreateDirectory((Join-Path $genie 'llama_cpp'))
[IO.File]::WriteAllText((Join-Path $runtime 'sentinel.dll'), 'original')
$before = (Get-FileHash (Join-Path $runtime 'sentinel.dll')).Hash
$userAdsp = [Environment]::GetEnvironmentVariable('ADSP_LIBRARY_PATH', 'User')
$shell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
try {
    $output = Join-Path $root 'output.txt'
    $errorFile = Join-Path $root 'error.txt'
    $arguments = '-NoProfile -File "' + $source + '" -BinPath "' + $runtime + '" -GenieXDir "' + $genie + '" -Json'
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $shell; $start.Arguments = $arguments
    $start.UseShellExecute = $false; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Read-only subprocess timed out' }
    $process.WaitForExit()
    if ($process.ExitCode -eq 0) { throw 'Missing GenieX reported as success' }
    $message = $stdout.Result | ConvertFrom-Json
    if ($message.Error -notmatch 'GenieX') { throw "Unexpected error: $($message.Error) $($stderr.Result)" }
    if ((Get-FileHash (Join-Path $runtime 'sentinel.dll')).Hash -ne $before) { throw 'Read-only check changed runtime' }
    if (@(Get-ChildItem $root | Where-Object { $_.Name.StartsWith('runtime.') }).Count) { throw 'Read-only check created install files' }
    if ([Environment]::GetEnvironmentVariable('ADSP_LIBRARY_PATH', 'User') -cne $userAdsp) { throw 'Persistent environment changed' }
    $process.Dispose()
    'RUNTIME_READONLY_TESTS=PASS (default check, nonzero failure, unchanged files/environment)'
} finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
