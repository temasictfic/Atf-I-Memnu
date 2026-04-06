[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Version = "patch",
  [switch]$SkipPush
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Git {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
  )

  $output = & git @Args 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Args -join ' ') failed.`n$output"
  }
  return @($output)
}

function Invoke-NpmVersion {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RequestedVersion
  )

  $output = & npm version $RequestedVersion --no-git-tag-version 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "npm version $RequestedVersion failed.`n$output"
  }
  return @($output)
}

function Get-NonEmptyLines {
  param([object]$Value)

  $lines = @()
  foreach ($item in @($Value)) {
    $text = [string]$item
    if (-not [string]::IsNullOrWhiteSpace($text)) {
      $lines += $text
    }
  }
  return $lines
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Push-Location $repoRoot

try {
  # Ensure required tools are available before doing any work.
  $null = Get-Command git -ErrorAction Stop
  $null = Get-Command npm -ErrorAction Stop

  $insideWorkTree = (Invoke-Git rev-parse --is-inside-work-tree | Select-Object -First 1).Trim()
  if ($insideWorkTree -ne "true") {
    throw "Current directory is not inside a git repository."
  }

  $branch = (Invoke-Git rev-parse --abbrev-ref HEAD | Select-Object -First 1).Trim()
  if ([string]::IsNullOrWhiteSpace($branch) -or $branch -eq "HEAD") {
    throw "Detached HEAD is not supported. Checkout a branch first."
  }

  $dirty = Get-NonEmptyLines (Invoke-Git status --porcelain)
  if (@($dirty).Count -gt 0) {
    throw "Working tree is not clean. Commit/stash changes first.`n$($dirty -join "`n")"
  }

  $latestTagLines = Get-NonEmptyLines (& git tag --list "v*" --sort=-v:refname)
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to list tags."
  }
  $latestTag = if (@($latestTagLines).Count -gt 0) { $latestTagLines[0].Trim() } else { "" }

  if (-not [string]::IsNullOrWhiteSpace($latestTag)) {
    $commitsSinceTag = [int]((Invoke-Git rev-list --count "$latestTag..HEAD" | Select-Object -First 1).Trim())
    if ($commitsSinceTag -eq 0) {
      throw "No committed changes since last tag '$latestTag'. Nothing to release."
    }
  }

  $null = Invoke-NpmVersion -RequestedVersion $Version

  $packageJsonPath = Join-Path $repoRoot "package.json"
  $package = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
  $newVersion = [string]$package.version
  if ([string]::IsNullOrWhiteSpace($newVersion)) {
    throw "Failed to read bumped version from package.json"
  }

  $tagName = "v$newVersion"

  $existingTagLines = Get-NonEmptyLines (& git tag --list $tagName)
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to check for existing tag '$tagName'."
  }
  if (@($existingTagLines).Count -gt 0) {
    throw "Tag '$tagName' already exists."
  }

  Invoke-Git add package.json | Out-Null

  $packageLockPath = Join-Path $repoRoot "package-lock.json"
  if (Test-Path $packageLockPath) {
    Invoke-Git add package-lock.json | Out-Null
  }

  $shrinkwrapPath = Join-Path $repoRoot "npm-shrinkwrap.json"
  if (Test-Path $shrinkwrapPath) {
    Invoke-Git add npm-shrinkwrap.json | Out-Null
  }

  $stagedFiles = Get-NonEmptyLines (Invoke-Git diff --cached --name-only)
  if (@($stagedFiles).Count -eq 0) {
    throw "Version bump produced no staged files."
  }

  $commitMessage = "chore(release): v$newVersion"
  Invoke-Git commit -m $commitMessage | Out-Null
  Invoke-Git tag $tagName | Out-Null

  if (-not $SkipPush) {
    Invoke-Git push origin $branch | Out-Null
    Invoke-Git push origin $tagName | Out-Null
  }

  Write-Host "Release prepared successfully." -ForegroundColor Green
  Write-Host "Version: $newVersion"
  Write-Host "Tag: $tagName"
  if ($SkipPush) {
    Write-Host "Push skipped (--SkipPush)."
  } else {
    Write-Host "Pushed branch '$branch' and tag '$tagName' to origin."
    Write-Host "GitHub Actions release workflow should start from the new tag."
  }
}
finally {
  Pop-Location
}
