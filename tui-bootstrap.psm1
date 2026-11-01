# Provisioning della sola TUI: il runtime llama.cpp resta gestito da runtime-update.psm1.
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'runtime-update.psm1')

function Test-TuiPython([string]$Python) {
    if (-not $Python -or -not (Test-Path -LiteralPath $Python -PathType Leaf)) { return $false }
    try {
        [void](Invoke-RuntimeNative $Python '-I -c "import sys; assert sys.version_info >= (3,10)"' (Split-Path -Parent $Python) 10000)
        return $true
    } catch { return $false }
}

function Find-TuiPython([string]$ManagedRoot) {
    $candidates = @((Join-Path $ManagedRoot 'python.exe'))
    $command = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($command -and $command.Source -notlike '*\WindowsApps\*') { $candidates += $command.Source }
    foreach ($hive in @('HKCU:\Software\Python\PythonCore', 'HKLM:\Software\Python\PythonCore')) {
        foreach ($key in @(Get-ChildItem $hive -ErrorAction SilentlyContinue)) {
            $install = Get-Item -LiteralPath ($key.PSPath + '\InstallPath') -ErrorAction SilentlyContinue
            if ($install -and $install.GetValue('')) { $candidates += Join-Path $install.GetValue('') 'python.exe' }
        }
    }
    foreach ($candidate in $candidates) { if (Test-TuiPython $candidate) { return $candidate } }
    return $null
}

function Install-TuiPython([string]$Destination, [string]$Architecture) {
    # Release e SHA-256 da python.org, file *.exe.sigstore (messageSignature.messageDigest).
    $version = '3.13.17'
    $hashes = @{
        arm64 = '3089a1977c32b26f5078e5a7d0285b7a861b8c96250c5dac3b6af59fbe9e9a75'
        amd64 = '5da012101ba2e17113a9a1cd901e9ce1441086f2b7ecb5de06ec94163899a190'
    }
    if (-not $hashes.ContainsKey($Architecture)) { throw "Architettura Python non supportata: $Architecture" }
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Destination))
    $installer = $Destination + '.installer-' + [guid]::NewGuid().ToString('N') + '.exe'
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri "https://www.python.org/ftp/python/$version/python-$version-$Architecture.exe" -OutFile $installer -TimeoutSec 120
        if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $hashes[$Architecture]) { throw 'SHA-256 installer Python differente.' }
        $arguments = '/quiet InstallAllUsers=0 Include_launcher=0 Include_test=0 Include_doc=0 Include_tcltk=0 Include_pip=1 PrependPath=0 Shortcuts=0 AssociateFiles=0 TargetDir="' + $Destination + '"'
        [void](Invoke-RuntimeNative $installer $arguments (Split-Path -Parent $Destination) 600000)
        $python = Join-Path $Destination 'python.exe'
        if (-not (Test-TuiPython $python)) { throw 'Installazione automatica Python non completata.' }
        return $python
    } finally { Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }
}

function Resolve-HexagonTuiPython {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Requirements,
        [string]$CacheDirectory = (Join-Path $env:LOCALAPPDATA 'HexagonClaw'))
    [void][IO.Directory]::CreateDirectory($CacheDirectory)
    $lockPath = Join-Path $CacheDirectory 'setup.lock'
    try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw 'Preparazione TUI gia'' in corso in un altro processo.' }
    try {
        $managedRoot = Join-Path $CacheDirectory 'python313'
        $python = Find-TuiPython $managedRoot
        if (-not $python) {
            $architecture = $env:PROCESSOR_ARCHITEW6432
            if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
            if ($architecture -eq 'ARM64') { $architecture = 'arm64' } else { $architecture = 'amd64' }
            Write-Host "Preparazione Python $architecture per la TUI..."
            $python = Install-TuiPython $managedRoot $architecture
        }
        $environment = Join-Path $CacheDirectory 'tui-env'
        $environmentPython = Join-Path $environment 'Scripts\python.exe'
        if (-not (Test-TuiPython $environmentPython)) {
            Write-Host 'Creazione ambiente Python della TUI...'
            [void](Invoke-RuntimeNative $python ('-I -m venv "' + $environment + '"') (Split-Path -Parent $python) 120000)
        }
        $fingerprint = (Get-FileHash -LiteralPath $Requirements -Algorithm SHA256).Hash
        $marker = Join-Path $environment 'requirements.sha256'
        $ready = (Test-Path -LiteralPath $marker) -and ([IO.File]::ReadAllText($marker) -eq $fingerprint)
        if ($ready) {
            try { [void](Invoke-RuntimeNative $environmentPython '-I -c "import rich,httpx,prompt_toolkit"' $environment 10000) }
            catch { $ready = $false }
        }
        if (-not $ready) {
            Write-Host 'Installazione dipendenze TUI nell''ambiente dedicato...'
            [void](Invoke-RuntimeNative $environmentPython ('-I -m pip install --disable-pip-version-check --only-binary=:all: -r "' + $Requirements + '"') $environment 600000)
            [void](Invoke-RuntimeNative $environmentPython '-I -c "import rich,httpx,prompt_toolkit"' $environment 10000)
            [IO.File]::WriteAllText($marker, $fingerprint)
        }
        return $environmentPython
    } finally {
        $lock.Dispose()
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    }
}
Export-ModuleMember -Function Resolve-HexagonTuiPython
