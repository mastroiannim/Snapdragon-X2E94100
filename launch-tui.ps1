<#
.SYNOPSIS
    Avvia Hexagon Claw TUI: GenieX e' l'unico prerequisito software manuale.
    Prepara il runtime locale e, se necessari, Python e dipendenze in un ambiente dedicato.
#>
param(
    [string]$Url = 'http://127.0.0.1:18803/v1',
    [string]$Model = '',
    [string]$SystemPrompt = '',
    [string]$Workspace = $PSScriptRoot,
    [ValidateRange(1, 2147483647)][int]$MaxTokens = 2048,
    [switch]$FromBatch,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$TuiArguments
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'

try {
    $scriptPath = Join-Path $PSScriptRoot 'tui.py'
    if (-not (Test-Path -LiteralPath $scriptPath)) { throw "tui.py non trovato in $PSScriptRoot" }
    # La CLI batch conserva la sintassi Python --url/--model/--workspace.
    if ($FromBatch) {
        for ($i = 0; $i -lt $TuiArguments.Count - 1; $i++) {
            if ($TuiArguments[$i] -eq '--url') { $Url = $TuiArguments[$i + 1] }
            if ($TuiArguments[$i] -eq '--workspace') { $Workspace = $TuiArguments[$i + 1] }
        }
    }
    $uri = [uri]$Url
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http', 'https')) { throw 'URL HTTP(S) non valido.' }
    if ($uri.Host -in @('127.0.0.1', 'localhost', '[::1]')) {
        & (Join-Path $Workspace 'sync-geniex.ps1') -Apply
        if ($LASTEXITCODE -ne 0) { throw 'Preparazione automatica runtime fallita.' }
    }
    Import-Module (Join-Path $PSScriptRoot 'tui-bootstrap.psm1') -Force
    $python = Resolve-HexagonTuiPython -Requirements (Join-Path $PSScriptRoot 'requirements.txt')
    $arguments = @($scriptPath, '--url', $Url, '--workspace', $Workspace, '--max-tokens', $MaxTokens)
    if ($Model) { $arguments += @('--model', $Model) }
    if ($SystemPrompt) { $arguments += @('--system', $SystemPrompt) }
    # PowerShell puo' gia' aver associato --url/--model ai parametri omonimi.
    # Gli altri flag Python restano nell'array e mantengono la precedenza.
    $arguments += @($TuiArguments)
    & $python @arguments
    exit $LASTEXITCODE
} catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
}
