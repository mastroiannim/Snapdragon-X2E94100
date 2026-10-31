<#
.SYNOPSIS
    Launcher PowerShell per Hexagon Claw TUI (in stile OpenClaw).
#>

param(
    [string]$Url = "http://127.0.0.1:18803/v1",
    [string]$Model = "",
    [string]$SystemPrompt = ""
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"

$tuiScript = Join-Path $PSScriptRoot "tui.py"

if (-not (Test-Path $tuiScript)) {
    Write-Error "tui.py non trovato in $PSScriptRoot"
    exit 1
}

$argsList = @($tuiScript, "--url", $Url)
if ($Model) { $argsList += @("--model", $Model) }
if ($SystemPrompt) { $argsList += @("--system", $SystemPrompt) }

& python @argsList
