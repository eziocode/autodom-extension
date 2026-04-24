# ══════════════════════════════════════════════════════════════
#  AutoDOM — Windows One-Click Setup (PowerShell)
#  Mirrors setup.sh: installs server deps, kills stale listeners,
#  configures every IDE it can detect, and prints next steps for
#  loading the browser extension.
#
#  Run from an elevated *or* normal PowerShell:
#      powershell -ExecutionPolicy Bypass -File .\setup.ps1
#      .\setup.ps1 -Name autodom-firefox -Port 9877
# ══════════════════════════════════════════════════════════════

[CmdletBinding()]
param(
    [string]$Name = "autodom",
    [int]$Port = 9876,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

function Write-Step($msg)    { Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)      { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)    { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Fail($msg)    { Write-Host "  [X]  $msg" -ForegroundColor Red }

if ($Help) {
    @"
Usage: setup.ps1 [-Name <server-name>] [-Port <port>]

Examples:
  .\setup.ps1
  .\setup.ps1 -Name autodom-firefox -Port 9877
  .\setup.ps1 -Name autodom-edge     -Port 9878

Options:
  -Name   MCP server name registered with each IDE (default: autodom)
  -Port   WebSocket port for this browser target  (default: 9876)
  -Help   Show this help
"@
    exit 0
}

if ($Port -lt 1024 -or $Port -gt 65535) {
    Write-Fail "Port must be between 1024 and 65535 (got $Port)"
    exit 1
}
if ($Name -notmatch '^[A-Za-z0-9._-]+$') {
    Write-Fail "Name may only contain letters, numbers, dot, underscore, dash"
    exit 1
}

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ServerDir   = Join-Path $ScriptDir "server"
$ExtDir      = Join-Path $ScriptDir "extension"
$ServerPath  = Join-Path $ServerDir "index.js"
$DefaultPort = 9876

if (-not (Test-Path $ServerPath)) {
    Write-Fail "server/index.js not found at $ServerPath"
    exit 1
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  AutoDOM Setup (Windows)" -ForegroundColor White
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Server name : $Name"   -ForegroundColor White
Write-Host "  WS port     : $Port"   -ForegroundColor White
Write-Host ""

# ── 1. Node.js check ─────────────────────────────────────────
Write-Step "Checking Node.js..."
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Fail "Node.js not found. Install v18+ from https://nodejs.org"
    exit 1
}
$nodeVer = (& node -v).TrimStart('v')
$majorVer = [int]($nodeVer.Split('.')[0])
if ($majorVer -lt 18) {
    Write-Fail "Node.js v18+ required (found v$nodeVer)"
    exit 1
}
Write-Ok "node v$nodeVer"

# ── 2. Kill stale listeners on the target port ───────────────
Write-Step "Cleaning up stale listeners on port $Port..."
$killed = 0
try {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        try {
            Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop
            $killed++
        } catch { }
    }
} catch { }
$lockFile = Join-Path $env:TEMP "autodom-bridge-$Port.json"
Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
if ($killed -gt 0) { Write-Ok "Killed $killed stale process(es)" }
else                { Write-Ok "No stale listeners found" }

# ── 3. npm install ───────────────────────────────────────────
Write-Step "Installing server dependencies..."
Push-Location $ServerDir
try {
    & npm install --silent 2>&1 | Out-Null
    Write-Ok "Dependencies installed"
} catch {
    Write-Fail "npm install failed: $_"
    Pop-Location
    exit 1
}

# ── 4. Verify critical deps ──────────────────────────────────
Write-Step "Verifying critical dependencies..."
$missing = @()
foreach ($dep in @("fastmcp","ws","zod")) {
    $depDir = Join-Path $ServerDir "node_modules\$dep"
    if (-not (Test-Path $depDir)) {
        $missing += $dep
        Write-Fail "$dep not found in node_modules"
    } else {
        $verJson = Get-Content (Join-Path $depDir "package.json") -Raw | ConvertFrom-Json
        Write-Ok "$dep@$($verJson.version)"
    }
}
if ($missing.Count -gt 0) {
    Write-Warn "Retrying with clean install..."
    Remove-Item -Recurse -Force (Join-Path $ServerDir "node_modules") -ErrorAction SilentlyContinue
    & npm install --silent 2>&1 | Out-Null
    foreach ($dep in $missing) {
        if (-not (Test-Path (Join-Path $ServerDir "node_modules\$dep"))) {
            Write-Fail "$dep still missing — check network and retry"
            Pop-Location
            exit 1
        }
    }
    Write-Ok "All dependencies resolved"
}
Pop-Location

# ── 5. Verify server starts ──────────────────────────────────
Write-Step "Verifying server..."
$serverArgs = @($ServerPath)
if ($Port -ne $DefaultPort) { $serverArgs += @("--port","$Port") }
$verifyOut = ""
try {
    $verifyOut = "{}" | & node @serverArgs 2>&1
} catch {
    $verifyOut = "$_"
}
if ($verifyOut -notmatch "Bridge Server Started|Proxy client connected|MCP server running on stdio transport") {
    Write-Fail "Server failed to start"
    Write-Host $verifyOut
    exit 1
}
Write-Ok "Server verified on port $Port"

# ── 6. Configure IDEs ────────────────────────────────────────
Write-Step "Configuring IDEs..."
$Configured = 0

function Build-McpEntry($schema) {
    $args = @($ServerPath)
    if ($Port -ne $DefaultPort) { $args += @("--port","$Port") }
    if ($schema -eq "copilot") {
        return @{ type = "stdio"; command = "node"; args = $args }
    } else {
        return @{ command = "node"; args = $args }
    }
}

function Upsert-JsonServer($file, $rootKey, $schema) {
    try {
        $cfg = @{}
        if (Test-Path $file) {
            $raw = Get-Content $file -Raw
            if ($raw.Trim()) {
                $cfg = $raw | ConvertFrom-Json -AsHashtable
                if (-not $cfg) { $cfg = @{} }
            }
        }
        if (-not $cfg.ContainsKey($rootKey) -or -not ($cfg[$rootKey] -is [hashtable])) {
            $cfg[$rootKey] = @{}
        }
        $cfg[$rootKey][$Name] = Build-McpEntry $schema
        $dir = Split-Path -Parent $file
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
        $cfg | ConvertTo-Json -Depth 10 | Set-Content -Path $file -Encoding UTF8
        return $true
    } catch {
        Write-Warn "Could not update $file — $_"
        return $false
    }
}

# VS Code (user-level mcp.json)
$vscodeFile = Join-Path $env:USERPROFILE ".vscode\mcp.json"
if (Test-Path (Split-Path -Parent $vscodeFile)) {
    if (Upsert-JsonServer $vscodeFile "mcpServers" "standard") {
        Write-Ok "VS Code ($Name)"
        $Configured++
    }
}

# Cursor
$cursorFile = Join-Path $env:USERPROFILE ".cursor\mcp.json"
if (Test-Path (Split-Path -Parent $cursorFile)) {
    if (Upsert-JsonServer $cursorFile "mcpServers" "standard") {
        Write-Ok "Cursor ($Name)"
        $Configured++
    }
}

# Copilot for IntelliJ
$copilotFile = Join-Path $env:USERPROFILE ".config\github-copilot\intellij\mcp.json"
if (Test-Path (Split-Path -Parent (Split-Path -Parent $copilotFile))) {
    $copilotDir = Split-Path -Parent $copilotFile
    if (-not (Test-Path $copilotDir)) { New-Item -ItemType Directory -Path $copilotDir -Force | Out-Null }
    if (Upsert-JsonServer $copilotFile "servers" "copilot") {
        Write-Ok "Copilot for IntelliJ ($Name)"
        $Configured++
    }
}

# Claude Desktop
$claudeFile = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
if (Test-Path (Split-Path -Parent $claudeFile)) {
    if (Upsert-JsonServer $claudeFile "mcpServers" "standard") {
        Write-Ok "Claude Desktop ($Name)"
        $Configured++
    }
}

# Gemini CLI
$geminiFile = Join-Path $env:USERPROFILE ".gemini\settings.json"
if (Test-Path (Split-Path -Parent $geminiFile)) {
    if (Upsert-JsonServer $geminiFile "mcpServers" "standard") {
        Write-Ok "Gemini CLI ($Name)"
        $Configured++
    }
}

if ($Configured -eq 0) {
    Write-Warn "No supported IDE detected. Configure manually — see INSTALL.md."
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  AutoDOM Setup Complete!" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Load the browser extension:" -ForegroundColor White
Write-Host "    1. Open chrome://extensions"
Write-Host "    2. Enable 'Developer mode' (top-right)"
Write-Host "    3. Click 'Load unpacked'"
Write-Host "    4. Select: $ExtDir"
Write-Host "    5. Open the AutoDOM popup and ensure port = $Port"
Write-Host ""
Write-Host "  Manual MCP config snippet:" -ForegroundColor White
$snippet = @{ mcpServers = @{ "$Name" = (Build-McpEntry "standard") } } | ConvertTo-Json -Depth 10
Write-Host $snippet
Write-Host ""
Write-Host "  Then restart your IDE so it picks up the new MCP config." -ForegroundColor White
Write-Host "  Troubleshooting: see INSTALL.md or README.md"
Write-Host ""
