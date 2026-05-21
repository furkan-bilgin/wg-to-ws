# wg-to-ws — one-line install (Windows)
#   iwr -useb https://raw.githubusercontent.com/furkan-bilgin/wg-to-ws/main/install.ps1 | iex

$repo = "furkan-bilgin/wg-to-ws"
$binary = "wg-to-ws-windows-x64.exe"

# Determine install directory
if ($env:WG_TO_WS_HOME) {
  $installDir = $env:WG_TO_WS_HOME
} elseif ($env:USERPROFILE) {
  $installDir = "$env:USERPROFILE\.wg-to-ws"
} else {
  $installDir = "$env:LOCALAPPDATA\wg-to-ws"
}

# Fetch latest release tag
Write-Host "Fetching latest release..." -ForegroundColor Cyan
$apiUrl = "https://api.github.com/repos/$repo/releases/latest"
try {
  $release = Invoke-RestMethod -Uri $apiUrl -UseBasicParsing
  $tag = $release.tag_name
} catch {
  Write-Error "Failed to fetch latest release tag: $_"
  exit 1
}

$url = "https://github.com/$repo/releases/download/$tag/$binary"
$outFile = "$installDir\wg-to-ws.exe"

# Create install directory
if (!(Test-Path $installDir)) {
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

Write-Host "Downloading $binary ($tag)..." -ForegroundColor Cyan
try {
  Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing
} catch {
  Write-Error "Download failed: $_"
  exit 1
}

# Add to PATH for the current user if not already there
$path = [Environment]::GetEnvironmentVariable("Path", "User")
if ($path -notlike "*$installDir*") {
  $newPath = "$installDir;$path"
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host "Added $installDir to user PATH (restart terminal to take effect)" -ForegroundColor Yellow
}

Write-Host "Installed wg-to-ws to $outFile" -ForegroundColor Green
Write-Host "Run 'wg-to-ws server' or 'wg-to-ws client' to get started." -ForegroundColor Green

# Offer to run in current session
$env:Path = "$installDir;$env:Path"
