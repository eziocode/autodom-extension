# enterprise\install.ps1 — installs (or removes) the AutoDOM force-install
# policy on every Chromium-family browser detected on this Windows machine.
#
# Run from an elevated PowerShell:
#   $env:AUTODOM_EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop"
#   powershell -ExecutionPolicy Bypass -File .\enterprise\install.ps1
#
# To remove:
#   powershell -ExecutionPolicy Bypass -File .\enterprise\install.ps1 -Remove
#
# Touches HKLM only — the policy applies to every user on the machine.

[CmdletBinding()]
param(
  [string]$ExtensionId = $env:AUTODOM_EXTENSION_ID,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
  $current = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $current.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run from an elevated (Administrator) PowerShell."
    exit 2
  }
}

Assert-Admin

if (-not $Remove -and [string]::IsNullOrWhiteSpace($ExtensionId)) {
  Write-Error @"
AUTODOM_EXTENSION_ID is not set.

Set the 32-char extension ID from docs/RELEASE-SIGNING.md, then re-run:

  `$env:AUTODOM_EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop"
  powershell -ExecutionPolicy Bypass -File .\enterprise\install.ps1
"@
  exit 2
}

# Strict format check before $ExtensionId is interpolated into any registry
# path. A Chromium extension id is exactly 32 lowercase a–p characters; any
# other input is refused so attacker-controlled values cannot construct
# unexpected registry keys.
if (-not $Remove -and ($ExtensionId -notmatch '^[a-p]{32}$')) {
  Write-Error "AUTODOM_EXTENSION_ID must be exactly 32 lowercase a-p characters. Got: '$ExtensionId'"
  exit 2
}

$UpdateUrl = 'https://eziocode.github.io/autodom-extension/updates.xml'

# (display name, registry root for ExtensionSettings)
$Browsers = @(
  @{ Name = 'Google Chrome'  ; Root = 'HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionSettings' },
  @{ Name = 'Microsoft Edge' ; Root = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionSettings' },
  @{ Name = 'Brave'          ; Root = 'HKLM:\SOFTWARE\Policies\BraveSoftware\Brave\ExtensionSettings' }
)

foreach ($b in $Browsers) {
  Write-Host "→ $($b.Name)"
  if ($Remove) {
    # Try the legacy id env first, then any subkeys we may have created.
    if ($ExtensionId) {
      $sub = Join-Path $b.Root $ExtensionId
      if (Test-Path $sub) {
        Remove-Item -Path $sub -Recurse -Force
        Write-Host "  ✓ removed $sub"
      }
    } else {
      if (Test-Path $b.Root) {
        Get-ChildItem $b.Root | ForEach-Object {
          Remove-Item -Path $_.PSPath -Recurse -Force
          Write-Host "  ✓ removed $($_.PSPath)"
        }
      }
    }
  } else {
    if (-not (Test-Path $b.Root)) {
      New-Item -Path $b.Root -Force | Out-Null
    }
    $sub = Join-Path $b.Root $ExtensionId
    if (-not (Test-Path $sub)) {
      New-Item -Path $sub -Force | Out-Null
    }
    Set-ItemProperty -Path $sub -Name 'installation_mode' -Value 'force_installed' -Type String
    Set-ItemProperty -Path $sub -Name 'update_url'        -Value $UpdateUrl         -Type String
    Write-Host "  ✓ wrote $sub"
  }
}

Write-Host ''
if ($Remove) {
  Write-Host '✔ AutoDOM force-install policy removed.'
  Write-Host '  Re-launch each browser; AutoDOM will be uninstalled on next launch.'
} else {
  Write-Host '✔ AutoDOM force-install policy is now in place.'
  Write-Host ''
  Write-Host 'Next steps:'
  Write-Host '  1. Quit any open Chrome / Edge / Brave windows.'
  Write-Host '  2. Re-launch the browser. AutoDOM installs silently within a few seconds.'
  Write-Host "  3. Verify at chrome://policy → ExtensionSettings → $ExtensionId"
  Write-Host '     should show installation_mode=force_installed.'
  Write-Host '  4. From now on the browser auto-updates AutoDOM in the background.'
  Write-Host ''
  Write-Host '  To remove later: powershell -ExecutionPolicy Bypass -File .\enterprise\install.ps1 -Remove'
}
