<#
.SYNOPSIS
  Builds the Python backend into a standalone Windows executable via PyInstaller.

.DESCRIPTION
  Packages the FastAPI backend in `backend/` into a single distributable folder
  used by the Electron app.

  Steps:
    1. Verifies `uv` is on PATH (used to manage the Python environment from
       `backend/pyproject.toml`).
    2. Wipes any previous artifacts:
         backend/build/pyinstaller
         backend/dist/atfi-memnu-backend
    3. Runs `uv run --with pyinstaller pyinstaller` against
       `backend/atfi-memnu-backend.spec`.
    4. Confirms `backend/dist/atfi-memnu-backend/atfi-memnu-backend.exe` exists.

  This script takes no parameters. Run from the repo root or via:
    npm run build:backend

  For full help:
    Get-Help .\scripts\build-backend.ps1 -Full
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backendDir = Join-Path $projectRoot 'backend'
$specPath = Join-Path $projectRoot 'backend\atfi-memnu-backend.spec'

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw 'uv is required for backend packaging. Install uv and retry.'
}

Write-Host '[build-backend] Using uv project environment from backend/pyproject.toml'

$buildDir = Join-Path $backendDir 'build\pyinstaller'
$distDir = Join-Path $backendDir 'dist\atfi-memnu-backend'

if (Test-Path $buildDir) {
    Remove-Item -Recurse -Force $buildDir
}
if (Test-Path $distDir) {
    Remove-Item -Recurse -Force $distDir
}

Write-Host '[build-backend] Building backend executable with PyInstaller...'
& uv run --project $backendDir --with pyinstaller pyinstaller --noconfirm --clean $specPath --distpath (Join-Path $backendDir 'dist') --workpath $buildDir

if ($LASTEXITCODE -ne 0) {
    throw 'PyInstaller build failed.'
}

$backendExe = Join-Path $distDir 'atfi-memnu-backend.exe'
if (-not (Test-Path $backendExe)) {
    throw "Backend executable not found at $backendExe"
}

Write-Host "[build-backend] OK: $backendExe"
