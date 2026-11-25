<#
.SYNOPSIS
    Verifica end-to-end di setup-kilo.ps1 e launch-kilo.ps1 su Windows privo di Python nel PATH.

.DESCRIPTION
    Esegue setup-kilo.ps1, launch-kilo.ps1 -CheckOnly, launch-kilo.ps1 -GenerateConfigOnly e i comandi
    nativi di plugins/hexagon-runtime/dist/cli.js in sottoprocessi con PATH completamente ripulito da
    qualsiasi eseguibile Python (python, python3, py), utilizzando fixture isolate (USERPROFILE/LOCALAPPDATA
    e mock HTTP /v1/models + /health).
#>

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') {
    Write-Host 'NO_PYTHON_CLI_TESTS=SKIP (Windows only)'
    exit 0
}

$repo = Split-Path $PSScriptRoot -Parent
$distCli = Join-Path $repo 'plugins\hexagon-runtime\dist\cli.js'
if (-not (Test-Path -LiteralPath $distCli -PathType Leaf)) {
    throw "Plugin CLI non compilato: eseguire 'npm run build' in plugins\hexagon-runtime prima del test."
}

$nodeCmd = Get-Command 'node' -ErrorAction Stop | Select-Object -First 1
$nodeDir = Split-Path -Parent $nodeCmd.Source
$sysDir = Join-Path $env:SystemRoot 'System32'
$psDir = Join-Path $sysDir 'WindowsPowerShell\v1.0'

$root = Join-Path ([IO.Path]::GetTempPath()) ('hexagon-nopy-' + [guid]::NewGuid().ToString('N'))
$ws = Join-Path $root 'workspace'
$binStub = Join-Path $root 'stub-bin'
$profileDir = Join-Path $root 'userprofile'
$appDataDir = Join-Path $root 'localappdata'
$genieDir = Join-Path $appDataDir 'GenieX CLI'
$genieRuntime = Join-Path $genieDir 'llama_cpp'
$llamaBin = Join-Path $profileDir 'llama-cpp\llama-bin-win-cpu-arm64'
$modelsDir = Join-Path $profileDir '.cache\geniex\models'

foreach ($d in @($ws, $binStub, $genieRuntime, $llamaBin, $modelsDir, (Join-Path $ws '.kilo\agents'), (Join-Path $ws 'plugins\hexagon-runtime\dist'), (Join-Path $ws 'plugins\hexagon-runtime\assets\scripts'))) {
    [void][IO.Directory]::CreateDirectory($d)
}

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Invoke-IsolatedPs([string]$ScriptPath, [string[]]$ArgsList, [string]$CleanPath, [string]$ProfilePath, [string]$LocalAppDataPath) {
    $shell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $shell
    $quotedArgs = ($ArgsList | ForEach-Object {
        if ($_ -match '\s') { "`"$_`"" } else { $_ }
    }) -join ' '
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" $quotedArgs"
    $psi.WorkingDirectory = Split-Path -Parent $ScriptPath
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables['PATH'] = $CleanPath
    $psi.EnvironmentVariables['USERPROFILE'] = $ProfilePath
    $psi.EnvironmentVariables['LOCALAPPDATA'] = $LocalAppDataPath
    $proc = [Diagnostics.Process]::Start($psi)
    try {
        $stdout = $proc.StandardOutput.ReadToEndAsync()
        $stderr = $proc.StandardError.ReadToEndAsync()
        if (-not $proc.WaitForExit(60000)) {
            $proc.Kill()
            throw "Timeout su $ScriptPath $quotedArgs"
        }
        $proc.WaitForExit()
        return @{ Code = $proc.ExitCode; Out = $stdout.Result; Err = $stderr.Result }
    } finally {
        $proc.Dispose()
    }
}

$listener = $null
try {
    # 1. Copia script e plugin dist nel workspace isolato
    foreach ($name in @('setup-kilo.ps1', 'launch-kilo.ps1')) {
        Copy-Item -LiteralPath (Join-Path $repo $name) -Destination (Join-Path $ws $name)
    }
    Copy-Item -Path (Join-Path $repo '.kilo\agents\*.md') -Destination (Join-Path $ws '.kilo\agents')
    Copy-Item -Path (Join-Path $repo 'plugins\hexagon-runtime\dist\*') -Destination (Join-Path $ws 'plugins\hexagon-runtime\dist') -Recurse -Force
    Copy-Item -Path (Join-Path $repo 'plugins\hexagon-runtime\assets\scripts\*') -Destination (Join-Path $ws 'plugins\hexagon-runtime\assets\scripts') -Recurse -Force

    # 2. Stub kilo.cmd e fixture eseguibili GenieX / llama-server (compilati con C# come entrypoints.ps1)
    [IO.File]::WriteAllText((Join-Path $binStub 'kilo.cmd'), "@echo off`r\nif `"%1`"==`"--version`" echo 7.8.32`r\nexit /b 0`r\n")

    $fixtureExe = Join-Path $root 'fixture.exe'
    Add-Type -TypeDefinition @'
using System;
public class HexagonCliFixture {
    public static int Main(string[] args) {
        string joined = String.Join(" ", args);
        if (joined.Contains("--list-devices")) {
            Console.WriteLine("HTP0 GPUOpenCL");
        } else if (joined.Contains("--version")) {
            Console.WriteLine("GenieX CLI Version: v0.12.0");
            Console.WriteLine("QAIRT Runtime Version: 2.50");
            Console.WriteLine("LlamaCPP Runtime Hash: 19cce6919");
            Console.WriteLine("version: 11938 (19cce6919)");
        }
        return 0;
    }
}
'@ -OutputAssembly $fixtureExe -OutputType ConsoleApplication
    Copy-Item -LiteralPath $fixtureExe -Destination (Join-Path $genieDir 'geniex.exe')
    foreach ($exeName in @('llama-server.exe', 'llama-cli.exe', 'llama-bench.exe')) {
        Copy-Item -LiteralPath $fixtureExe -Destination (Join-Path $llamaBin $exeName)
    }
    # Patch PE machine a ARM64 (0xAA64) non necessario qui perche' -CheckOnly controlla --version / --list-devices su fixture.
    # Scriviamo comunque byte validi nelle DLL GenieX e le copiamo in llamaBin cosi' Get-FileHash corrisponde.
    foreach ($dll in @('ggml.dll', 'ggml-hexagon.dll', 'ggml-opencl.dll', 'libggml-htp.cat', 'libggml-htp-v81.so')) {
        $srcFile = Join-Path $genieRuntime $dll
        $dstFile = Join-Path $llamaBin $dll
        [IO.File]::WriteAllText($srcFile, "fixture-$dll")
        [IO.File]::WriteAllText($dstFile, "fixture-$dll")
    }
    # Stub solo del check PE 0xAA64 su fixture.exe compilato con csc/Add-Type (identico a entrypoints.ps1; PE ARM64 e' testato in runtime-update.ps1)
    Add-Content -LiteralPath (Join-Path $ws 'plugins\hexagon-runtime\assets\scripts\runtime-update.psm1') -Value "`nfunction Assert-Arm64Executable([string]`$Path) { }`n"
    [IO.File]::WriteAllText((Join-Path $modelsDir 'Ornith-1.5-9B-Q4_0.gguf'), 'GGUF')

    # 3. Costruisci PATH assolutamente PRIVO di Python
    $cleanPath = (@($binStub, $nodeDir, $psDir, $sysDir) | Select-Object -Unique) -join ';'

    # Verifica che python/python3/py non esistano nel PATH isolato
    $oldPath = $env:PATH
    try {
        $env:PATH = $cleanPath
        Assert-True ($null -eq (Get-Command 'python' -ErrorAction SilentlyContinue)) 'python trovato in cleanPath'
        Assert-True ($null -eq (Get-Command 'python3' -ErrorAction SilentlyContinue)) 'python3 trovato in cleanPath'
        Assert-True ($null -eq (Get-Command 'py' -ErrorAction SilentlyContinue)) 'py trovato in cleanPath'
    } finally {
        $env:PATH = $oldPath
    }

    # 4. Avvia mock HTTP router su porta effimera loopback
    $tcp = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $tcp.Start()
    $port = ([System.Net.IPEndPoint]$tcp.LocalEndpoint).Port
    $tcp.Stop()

    $listener = [System.Net.HttpListener]::new()
    $listener.Prefixes.Add("http://127.0.0.1:$port/")
    $listener.Start()
    $serverJob = [PowerShell]::Create().AddScript({
        param($HttpListener)
        while ($HttpListener.IsListening) {
            try {
                $ctx = $HttpListener.GetContext()
                $path = $ctx.Request.Url.AbsolutePath
                $json = if ($path -eq '/health') {
                    '{"status":"ok"}'
                } elseif ($path -eq '/v1/models') {
                    '{"object":"list","data":[{"id":"Ornith-1.5-9B-Q4_0"}]}'
                } else {
                    '{}'
                }
                $bytes = [Text.Encoding]::UTF8.GetBytes($json)
                $ctx.Response.StatusCode = 200
                $ctx.Response.ContentType = 'application/json'
                $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                $ctx.Response.Close()
            } catch {
                break
            }
        }
    }).AddArgument($listener)
    $asyncHandle = $serverJob.BeginInvoke()

    # 5. Test launch-kilo.ps1 -GenerateConfigOnly senza Python
    $genRes = Invoke-IsolatedPs (Join-Path $ws 'launch-kilo.ps1') @('-GenerateConfigOnly', '-Port', "$port", '-BindHost', '127.0.0.1') $cleanPath $profileDir $appDataDir
    Assert-True ($genRes.Code -eq 0) "launch-kilo.ps1 -GenerateConfigOnly fallito (exit $($genRes.Code)): $($genRes.Out) $($genRes.Err)"
    $kiloJson = Get-Content -LiteralPath (Join-Path $ws 'kilo.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($kiloJson.provider.hexagon.options.baseURL -eq "http://127.0.0.1:$port/v1") 'baseURL non aggiornata con --port/--host'
    Write-Host 'PASS launch-kilo.ps1 -GenerateConfigOnly senza Python nel PATH'

    # 6. Test launch-kilo.ps1 -CheckOnly online senza Python
    $chkRes = Invoke-IsolatedPs (Join-Path $ws 'launch-kilo.ps1') @('-CheckOnly', '-Port', "$port", '-BindHost', '127.0.0.1') $cleanPath $profileDir $appDataDir
    Assert-True ($chkRes.Code -eq 0) "launch-kilo.ps1 -CheckOnly fallito (exit $($chkRes.Code)): $($chkRes.Out) $($chkRes.Err)"
    Assert-True ($chkRes.Out -match 'Stato kilo\.json:\s+Valido') 'Output CheckOnly privo di stato kilo.json'
    Assert-True ($chkRes.Out -match 'Router live:') 'Output CheckOnly privo di stato router'
    Write-Host 'PASS launch-kilo.ps1 -CheckOnly online senza Python nel PATH'

    # 7. Test launch-kilo.ps1 -CheckOnly offline senza Python (deve uscire con code 1 ma stampare validazione)
    $offRes = Invoke-IsolatedPs (Join-Path $ws 'launch-kilo.ps1') @('-CheckOnly', '-Port', "$($port + 1)", '-BindHost', '127.0.0.1') $cleanPath $profileDir $appDataDir
    Assert-True ($offRes.Code -eq 1) "launch-kilo.ps1 -CheckOnly offline avrebbe dovuto uscire 1, ottenuto $($offRes.Code)"
    Assert-True ($offRes.Out -match 'Stato kilo\.json:\s+Valido') 'CheckOnly offline non ha eseguito cli.js validate'
    Write-Host 'PASS launch-kilo.ps1 -CheckOnly offline senza Python nel PATH'

    # 8. Test setup-kilo.ps1 senza Python (su host ARM64 tutte le 11 verifiche passano; su x64 CI verifichiamo zero errori python e validazione config/runtime)
    $setupRes = Invoke-IsolatedPs (Join-Path $ws 'setup-kilo.ps1') @('-CheckOnly', '-VerifyOffline', '-Port', "$port", '-BindHost', '127.0.0.1') $cleanPath $profileDir $appDataDir
    Assert-True ($setupRes.Out -match '\[OK\]\s+Node\.js installato') 'setup-kilo.ps1 non ha rilevato Node.js'
    Assert-True ($setupRes.Out -match '\[OK\]\s+Kilo Code CLI') 'setup-kilo.ps1 non ha rilevato Kilo CLI'
    Assert-True ($setupRes.Out -match '\[OK\]\s+GenieX CLI Runtime') 'setup-kilo.ps1 non ha rilevato GenieX via cli.js'
    Assert-True ($setupRes.Out -match '\[OK\]\s+llama-server Hexagon') 'setup-kilo.ps1 non ha rilevato llama-server via cli.js'
    Assert-True ($setupRes.Out -match '\[OK\]\s+Allineamento Commit Runtime') 'setup-kilo.ps1 non ha verificato allineamento commit'
    Assert-True ($setupRes.Out -match '\[OK\]\s+Sicurezza Endpoint Offline') 'setup-kilo.ps1 non ha superato cli.js validate'
    Assert-True ($setupRes.Out -match '\[OK\]\s+Agenti e Subagenti') 'setup-kilo.ps1 non ha verificato .kilo/agents'
    Assert-True ($setupRes.Out -notmatch 'stack_manager\.py|kilo_config\.py') 'setup-kilo.ps1 contiene ancora riferimenti Python'
    if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -eq 'Arm64') {
        Assert-True ($setupRes.Code -eq 0) "setup-kilo.ps1 fallito su ARM64 (exit $($setupRes.Code)): $($setupRes.Out)"
    }
    Write-Host 'PASS setup-kilo.ps1 -CheckOnly -VerifyOffline senza Python nel PATH'

    # 9. Test negativo validate: manomissione baseURL esterna rilevata
    $badJson = Get-Content -LiteralPath (Join-Path $ws 'kilo.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $badJson.provider.hexagon.options.baseURL = 'https://api.openai.com/v1'
    $badJson | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $ws 'kilo.json') -Encoding UTF8
    $badChk = Invoke-IsolatedPs (Join-Path $ws 'launch-kilo.ps1') @('-CheckOnly', '-Port', "$port", '-BindHost', '127.0.0.1') $cleanPath $profileDir $appDataDir
    Assert-True ($badChk.Code -eq 1 -and $badChk.Out -match 'loopback') 'launch-kilo.ps1 -CheckOnly non ha bloccato baseURL esterna'
    Write-Host 'PASS cli.js validate blocca configurazioni non loopback'

    # 10. Auto-discovery cache senza Ornith-1.5 e differenziazione explore/ask in cli.js setup
    $altWs = Join-Path $root 'alt-ws'
    $altCache = Join-Path $root 'alt-cache'
    [void][IO.Directory]::CreateDirectory((Join-Path $altWs 'plugins\hexagon-runtime'))
    [void][IO.Directory]::CreateDirectory($altCache)
    [IO.File]::WriteAllText((Join-Path $altCache 'Qwen3.8-27B-Q4_0.gguf'), 'GGUF')
    [IO.File]::WriteAllText((Join-Path $altCache 'Spark-X2.5-4B-Q4_K_M.gguf'), 'GGUF')
    $savedEnvPath = $env:PATH
    $savedProf = $env:USERPROFILE
    $savedLad = $env:LOCALAPPDATA
    try {
        $env:PATH = $cleanPath
        $env:USERPROFILE = $profileDir
        $env:LOCALAPPDATA = $appDataDir
        $cliSetupOut = & $nodeCmd.Source (Join-Path $ws 'plugins\hexagon-runtime\dist\cli.js') setup --workspace $altWs --models-dir $altCache --ini (Join-Path $altWs 'missing.ini') --port ($port + 2) --host 127.0.0.1 2>&1 | ForEach-Object { "$_" }
        Assert-True ($LASTEXITCODE -eq 0) "cli.js setup auto-discovery fallito: $($cliSetupOut -join '`n')"
    } finally {
        $env:PATH = $savedEnvPath
        $env:USERPROFILE = $savedProf
        $env:LOCALAPPDATA = $savedLad
    }
    $altCfg = Get-Content -LiteralPath (Join-Path $altWs 'kilo.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Assert-True ($altCfg.model -eq 'hexagon/Qwen3.8-27B-Q4_0') "Atteso model auto-scoperto Qwen3.8-27B-Q4_0, ottenuto $($altCfg.model)"
    Assert-True ($altCfg.small_model -eq 'hexagon/Spark-X2.5-4B-Q4_K_M') "Atteso small_model differenziato Spark-X2.5-4B-Q4_K_M, ottenuto $($altCfg.small_model)"
    Assert-True ($altCfg.agent.explore.model -eq 'hexagon/Spark-X2.5-4B-Q4_K_M') "agent.explore.model non differenziato: $($altCfg.agent.explore.model)"
    Assert-True ($altCfg.agent.ask.model -eq 'hexagon/Spark-X2.5-4B-Q4_K_M') "agent.ask.model non differenziato: $($altCfg.agent.ask.model)"
    Write-Host 'PASS auto-discovery cache e differenziazione explore/ask'

    Write-Host 'NO_PYTHON_CLI_TESTS=PASS (setup-kilo.ps1, launch-kilo.ps1, cli.js senza Python nel PATH)'
} finally {
    if ($listener) {
        try { $listener.Stop(); $listener.Close() } catch { }
    }
    if ($serverJob) {
        try { $serverJob.Dispose() } catch { }
    }
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
