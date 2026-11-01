$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('hexagon-update-tests-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$modulePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'runtime-update.psm1'
$script:passed = 0
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Assert-True($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-Rejected([scriptblock]$Action, [string]$Pattern) {
    $errorText = ''
    try { & $Action | Out-Null } catch { $errorText = $_.Exception.Message }
    Assert-True ($errorText -match $Pattern) "Expected error '$Pattern', got '$errorText'"
}
function Get-Snapshot([string]$Directory) {
    if (-not (Test-Path -LiteralPath $Directory)) { return '<absent>' }
    return ((Get-ChildItem -LiteralPath $Directory -Recurse -File | Sort-Object FullName | ForEach-Object {
        $_.FullName.Substring($Directory.Length) + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }) -join "`n")
}
function New-PE([string]$Commit, [int]$Machine = 0xAA64) {
    $bytes = New-Object byte[] 256
    $bytes[0] = 0x4D; $bytes[1] = 0x5A; $bytes[0x3C] = 64
    $bytes[64] = 0x50; $bytes[65] = 0x45
    [BitConverter]::GetBytes([uint16]$Machine).CopyTo($bytes, 68)
    [Text.Encoding]::ASCII.GetBytes('SNAPCOMMIT=' + $Commit).CopyTo($bytes, 128)
    return ,$bytes
}
function New-Archive([string]$Path, [string]$Commit, [int]$Machine = 0xAA64, [switch]$Missing, [switch]$Duplicate) {
    $zip = [IO.Compression.ZipFile]::Open($Path, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $names = @('llama-server.exe', 'llama-cli.exe', 'llama-bench.exe', 'llama-common.dll')
        if ($Missing) { $names = @('llama-server.exe') }
        if ($Duplicate) { $names += 'nested/llama-server.exe' }
        foreach ($name in $names) {
            $entry = $zip.CreateEntry('package/' + $name)
            $stream = $entry.Open()
            try { $bytes = New-PE $Commit $Machine; $stream.Write($bytes, 0, $bytes.Length) }
            finally { $stream.Dispose() }
        }
    } finally { $zip.Dispose() }
}
function New-Fixture([string]$Name, [switch]$Existing, [int]$Machine = 0xAA64, [switch]$Missing, [switch]$Duplicate) {
    $dir = Join-Path $root $Name
    $genie = Join-Path $dir 'genie'
    $source = Join-Path $genie 'llama_cpp'
    $target = Join-Path $dir 'bin'
    [void][IO.Directory]::CreateDirectory($source)
    [IO.File]::WriteAllText((Join-Path $genie 'geniex.exe'), 'genie fixture')
    foreach ($file in @('ggml.dll', 'ggml-hexagon.dll', 'ggml-opencl.dll', 'libggml-htp.cat', 'libggml-htp-v81.so')) {
        [IO.File]::WriteAllText((Join-Path $source $file), 'GenieX-' + $file)
    }
    if ($Existing) {
        [void][IO.Directory]::CreateDirectory($target)
        foreach ($file in @('llama-server.exe', 'llama-cli.exe', 'llama-bench.exe')) {
            [IO.File]::WriteAllBytes((Join-Path $target $file), (New-PE 'aaaaaaaaaa'))
        }
        [IO.File]::WriteAllText((Join-Path $target 'user.ini'), 'preserve me')
    }
    $archive = Join-Path $dir 'fixture.zip'
    New-Archive $archive '19cce6919' $Machine -Missing:$Missing -Duplicate:$Duplicate
    $module = Import-Module $modulePath -Force -PassThru
    & $module {
        param($FixtureArchive, $Target)
        $script:FixtureArchive = $FixtureArchive
        $script:Target = $Target
        $script:Downloads = 0
        $script:FailAfterPromotion = $false
        $script:Processes = @()
        $script:Restarts = 0
        function script:Invoke-RuntimeNative([string]$File, [string]$Arguments, [string]$Directory) {
            if ((Split-Path -Leaf $File) -eq 'geniex.exe') { return 'GenieX CLI Version: 0.10.0' + "`n" + 'LlamaCPP Runtime Hash: 19cce6919' }
            $data = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($File))
            $hash = [regex]::Match($data, 'SNAPCOMMIT=([a-f0-9]+)').Groups[1].Value
            if ($script:FailAfterPromotion -and $Directory -eq $script:Target -and $hash -eq '19cce6919') { throw 'injected post-promotion failure' }
            if ($Arguments -eq '--version') { return "version: 11938 ($hash)" }
            return 'HTP0 GPUOpenCL'
        }
        function script:Get-LlamaReleaseAsset([string]$Commit) { return [pscustomobject]@{ Tag = 'b11938'; Commit = $Commit; Url = 'fixture'; Size = 1; Sha256 = 'fixture' } }
        function script:Get-RuntimeArchive($Asset, [string]$Destination) { $script:Downloads++; Copy-Item -LiteralPath $script:FixtureArchive -Destination $Destination }
        function script:Get-RuntimeProcesses([string]$Directory) { return $script:Processes }
        function script:Stop-RuntimeProcesses($Processes) { }
        function script:Start-RuntimeProcesses($Processes, [string]$Directory) { $script:Restarts++ }
    } $archive $target
    return [pscustomobject]@{ Module = $module; Genie = $genie; Source = $source; Target = $target; Directory = $dir }
}
function Pass([string]$Name) { $script:passed++; Write-Host "PASS $Name" }

try {
    $f = New-Fixture 'first launch'
    $sourceBefore = Get-Snapshot $f.Genie
    $result = Sync-HexagonRuntime -BinPath $f.Target -GenieXDir $f.Genie -Apply
    Assert-True $result.Updated 'First launch did not install'
    Assert-True (Test-Path (Join-Path $f.Target 'llama-server.exe')) 'Missing frontend'
    Assert-True (Test-Path (Join-Path $f.Target 'hexagon-runtime.json')) 'Missing manifest'
    Assert-True ((Get-Snapshot $f.Genie) -eq $sourceBefore) 'Source changed'
    Assert-True (-not $result.Backup) 'First launch should not invent an old backup'
    $again = Sync-HexagonRuntime -BinPath $f.Target -GenieXDir $f.Genie -Apply
    Assert-True (-not $again.Updated) 'Aligned runtime changed'
    Assert-True ((& $f.Module { $script:Downloads }) -eq 1) 'Aligned runtime downloaded again'
    Pass 'first install with only GenieX; second run offline/idempotent; paths with spaces'

    Remove-Item -LiteralPath (Join-Path $f.Target 'llama-cli.exe')
    $repair = Sync-HexagonRuntime -BinPath $f.Target -GenieXDir $f.Genie -Apply
    Assert-True $repair.Updated 'Missing companion frontend was ignored'
    Assert-True (Test-Path (Join-Path $f.Target 'llama-cli.exe')) 'Missing frontend was not repaired'
    Pass 'partial installation with missing frontend is repaired automatically'

    $f = New-Fixture 'readonly'
    $before = Get-Snapshot $f.Directory
    Assert-Rejected { Sync-HexagonRuntime -BinPath $f.Target -GenieXDir $f.Genie } 'Usare -Apply'
    Assert-True ((Get-Snapshot $f.Directory) -eq $before) 'Read-only check changed files'
    Pass 'read-only missing runtime does not create installation'

    $f = New-Fixture 'missing genie'
    Remove-Item -LiteralPath (Join-Path $f.Genie 'geniex.exe')
    Assert-Rejected { Sync-HexagonRuntime -BinPath $f.Target -GenieXDir $f.Genie -Apply } 'Installare GenieX'
    Assert-True (-not (Test-Path $f.Target)) 'Missing dependency created installation'
    Pass 'missing GenieX fails before install'

    foreach ($fault in @('stage', 'promotion', 'after-promotion')) {
        $f = New-Fixture $fault -Existing
        $before = Get-Snapshot $f.Target
        $sourceBefore = Get-Snapshot $f.Genie
        if ($fault -eq 'stage') {
            & $f.Module { function script:Get-RuntimeArchive($Asset, $Destination) { throw 'injected download failure' } }
        } elseif ($fault -eq 'promotion') {
            & $f.Module { function script:Move-RuntimeDirectory($Source, $Destination) {
                if ($Source -like '*.stage-*') { throw 'injected promotion failure' }
                [IO.Directory]::Move($Source, $Destination)
            } }
        } else { & $f.Module { $script:FailAfterPromotion = $true } }
        Assert-Rejected { Sync-HexagonRuntime -BinPath $f.Target -GenieXDir $f.Genie -Apply -UseHardLinks } 'Aggiornamento fallito'
        Assert-True ((Get-Snapshot $f.Target) -eq $before) "$fault did not restore original"
        Assert-True ((Get-Snapshot $f.Genie) -eq $sourceBefore) "$fault changed GenieX via links"
        Assert-True (@(Get-ChildItem $f.Directory -Filter 'bin.stage-*').Count -eq 0) 'Staging left behind'
        Pass "rollback $fault preserves installed and source bytes"
    }

    $f = New-Fixture 'failed backup rename' -Existing
    $before = Get-Snapshot $f.Target
    & $f.Module { function script:Move-RuntimeDirectory($Source, $Destination) { throw 'injected rename failure' } }
    Assert-Rejected { Sync-HexagonRuntime -BinPath $f.Target -GenieXDir $f.Genie -Apply } 'Aggiornamento fallito'
    Assert-True ((Get-Snapshot $f.Target) -eq $before) 'Backup rename failure damaged original'
    Pass 'backup rename failure never deletes live installation'

    $f = New-Fixture 'first launch failed promotion'
    & $f.Module { function script:Move-RuntimeDirectory($Source, $Destination) { throw 'injected rename failure' } }
    Assert-Rejected { Sync-HexagonRuntime -BinPath $f.Target -GenieXDir $f.Genie -Apply } 'Aggiornamento fallito'
    Assert-True (-not (Test-Path $f.Target)) 'Failed first install left partial destination'
    Pass 'failed first install leaves destination absent'

    foreach ($case in @('missing frontend', 'duplicate frontend', 'wrong architecture')) {
        $options = @{ Name = $case; Existing = $true }
        if ($case -eq 'missing frontend') { $options.Missing = $true }
        if ($case -eq 'duplicate frontend') { $options.Duplicate = $true }
        if ($case -eq 'wrong architecture') { $options.Machine = 0x8664 }
        $f = New-Fixture @options
        $before = Get-Snapshot $f.Target
        Assert-Rejected { Sync-HexagonRuntime -BinPath $f.Target -GenieXDir $f.Genie -Apply } 'Aggiornamento fallito'
        Assert-True ((Get-Snapshot $f.Target) -eq $before) "$case damaged original"
        Pass "$case rejected before replacement"
    }

    $f = New-Fixture 'existing config and copies' -Existing
    $result = Sync-HexagonRuntime -BinPath $f.Target -GenieXDir $f.Genie -Apply
    Assert-True ((Get-Content (Join-Path $f.Target 'user.ini') -Raw) -eq 'preserve me') 'User config lost'
    Assert-True (Test-Path -LiteralPath $result.Backup) 'Previous backup not retained'
    [IO.File]::WriteAllText((Join-Path $f.Source 'ggml.dll'), 'vendor changed in place')
    Assert-True ((Get-Content (Join-Path $f.Target 'ggml.dll') -Raw) -ne 'vendor changed in place') 'Default copies still share source'
    Pass 'successful upgrade preserves config and backup; copies isolate vendor writes'

    $f = New-Fixture 'no stop' -Existing
    $before = Get-Snapshot $f.Target
    & $f.Module { $script:Processes = @([pscustomobject]@{ ProcessId = 999; ParentProcessId = 0; CommandLine = 'fixture'; ExecutablePath = 'fixture' }) }
    Assert-Rejected { Sync-HexagonRuntime -BinPath $f.Target -GenieXDir $f.Genie -Apply -NoStopServer } 'attivo'
    Assert-True ((Get-Snapshot $f.Target) -eq $before) 'NoStopServer changed runtime'
    Pass 'running server refusal preserves installation'

    $f = New-Fixture 'running restart' -Existing
    & $f.Module { $script:Processes = @([pscustomobject]@{ ProcessId = 999; ParentProcessId = 0; CommandLine = 'fixture'; ExecutablePath = 'fixture' }) }
    [void](Sync-HexagonRuntime -BinPath $f.Target -GenieXDir $f.Genie -Apply)
    Assert-True ((& $f.Module { $script:Restarts }) -eq 1) 'Server was not restarted'
    Pass 'restart after successful replacement'

    $f = New-Fixture 'lock'
    $lock = [IO.File]::Open(($f.Target + '.update.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { Assert-Rejected { Sync-HexagonRuntime -BinPath $f.Target -GenieXDir $f.Genie -Apply } 'altro aggiornamento' }
    finally { $lock.Dispose() }
    Pass 'exclusive update lock'

    $m = Import-Module $modulePath -Force -PassThru
    $count = & $m {
        function script:Invoke-RestMethod($Uri, $Headers, $TimeoutSec) {
            Write-Output -NoEnumerate @([pscustomobject]@{ tag_name = 'b12032' }, [pscustomobject]@{ tag_name = 'b12031' })
        }
        @(Get-RuntimeJson 'fixture').Count
    }
    Assert-True ($count -eq 2) 'REST array was treated as one release'
    Pass 'REST JSON arrays are enumerated before release selection'

    $m = Import-Module $modulePath -Force -PassThru
    & $m {
        function script:Get-RuntimeJson([string]$Url) {
            if ($Url -like '*/commits/*') { return @{ sha = '19cce6919992fdffd92e0ac152caaf1e2b8f254e' } }
            if ($Url -like '*/releases?per_page=5') { return @(@{ tag_name = 'b12032' }) }
            if ($Url -like '*/compare/*') { return @{ ahead_by = 94; behind_by = 0 } }
            if ($Url -like '*/git/ref/tags/*') { return @{ object = @{ type = 'tag'; sha = 'annotated' } } }
            if ($Url -like '*/git/tags/*') { return @{ object = @{ type = 'commit'; sha = '19cce6919992fdffd92e0ac152caaf1e2b8f254e' } } }
            if ($Url -like '*/releases/tags/*') { return @{ assets = @([pscustomobject]@{ name = 'llama-b11938-bin-win-cpu-arm64.zip'; size = 13; digest = ('sha256:' + ('f' * 64)); browser_download_url = 'https://github.com/ggml-org/llama.cpp/releases/download/b11938/fixture.zip' }) } }
            throw "Unexpected URL: $Url"
        }
    }
    $asset = & $m { Get-LlamaReleaseAsset '19cce6919' }
    Assert-True ($asset.Tag -eq 'b11938') 'Estimated search failed'
    Pass 'release search verifies full commit and dereferences annotated tag'

    & $m { function script:Get-TagCommit([string]$Tag) { return ('a' * 40) }
        $original = ${function:Get-RuntimeJson}
        $script:OriginalGetJson = $original
        function script:Get-RuntimeJson([string]$Url) {
            if ($Url -like '*/tags?per_page=*') { return @(@{ name = 'b11938'; commit = @{ sha = '19cce6919992fdffd92e0ac152caaf1e2b8f254e' } }) }
            & $script:OriginalGetJson $Url
        }
    }
    $asset = & $m { Get-LlamaReleaseAsset '19cce6919' }
    Assert-True ($asset.Tag -eq 'b11938') 'Exact tag pagination fallback failed'
    Pass 'no approximate release accepted; exact tag-list fallback'

    & $m { function script:Get-RuntimeJson([string]$Url) {
        if ($Url -like '*/tags?per_page=*') { return @(@{ name = 'wrong'; commit = @{ sha = ('a' * 40) } }) }
        & $script:OriginalGetJson $Url
    } }
    Assert-Rejected { & $m { Get-LlamaReleaseAsset '19cce6919' } } 'Nessuna release'
    Pass 'missing exact commit never accepts nearby build'

    $m = Import-Module $modulePath -Force -PassThru
    $archivePath = Join-Path $root 'integrity.zip'
    New-Archive $archivePath '19cce6919'
    $asset = [pscustomobject]@{ Size = (Get-Item $archivePath).Length; Sha256 = (Get-FileHash $archivePath -Algorithm SHA256).Hash }
    & $m { param($Asset, $Path) Assert-RuntimeArchive $Asset $Path } $asset $archivePath
    $bytes = [IO.File]::ReadAllBytes($archivePath); $bytes[100] = $bytes[100] -bxor 1
    [IO.File]::WriteAllBytes($archivePath, $bytes)
    Assert-Rejected { & $m { param($Asset, $Path) Assert-RuntimeArchive $Asset $Path } $asset $archivePath } 'SHA-256'
    [IO.File]::WriteAllBytes($archivePath, [byte[]]@(1,2,3))
    Assert-Rejected { & $m { param($Asset, $Path) Assert-RuntimeArchive $Asset $Path } $asset $archivePath } 'incompleto'
    Pass 'full archive digest and byte count reject corruption and truncation'

    $f = New-Fixture 'rollback itself fails' -Existing
    $before = Get-Snapshot $f.Target
    & $f.Module { function script:Move-RuntimeDirectory($Source, $Destination) {
        if ($Source -like '*.stage-*' -or $Source -like '*.backup-*') { throw 'injected rename failure' }
        [IO.Directory]::Move($Source, $Destination)
    } }
    Assert-Rejected { Sync-HexagonRuntime -BinPath $f.Target -GenieXDir $f.Genie -Apply } 'Ripristino non completato'
    $backups = @(Get-ChildItem $f.Directory -Directory -Filter 'bin.backup-*')
    Assert-True ($backups.Count -eq 1) 'Failed rollback lost backup'
    Assert-True ((Get-Snapshot $backups[0].FullName) -eq $before) 'Failed rollback damaged backup'
    Pass 'rollback failure reports failure and retains original backup bytes'

    $f = New-Fixture 'missing catalog'
    Remove-Item -LiteralPath (Join-Path $f.Source 'libggml-htp.cat')
    Assert-Rejected { Sync-HexagonRuntime -BinPath $f.Target -GenieXDir $f.Genie -Apply } 'incompleto'
    Assert-True (-not (Test-Path $f.Target)) 'Missing source artifact created destination'
    Pass 'incomplete GenieX fails before staging'

    Write-Host "RUNTIME_UPDATE_TESTS=PASS ($script:passed scenarios)"
} finally {
    Remove-Module runtime-update -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
