#!/usr/bin/env pwsh
<#
.SYNOPSIS
  One-command build + test verification loop for the Purview GitHub Action.

.DESCRIPTION
  Runs the same loop an agent (or developer) should run before pushing:
  ensure dependencies are installed, compile TypeScript, bundle the action
  with ncc, and run the full jest test suite. Mirrors `npm run all`
  (build + package + test) plus a best-effort lint, and matches what the
  .husky/pre-commit hook and CI (.github/workflows/tests.yml) enforce.

  Exits non-zero on the first failing step so it can gate CI / pre-push.

.EXAMPLE
  pwsh scripts/verify.ps1

.EXAMPLE
  pwsh scripts/verify.ps1 -SkipInstall   # reuse existing node_modules
#>
[CmdletBinding()]
param(
    [switch] $SkipInstall
)

$ErrorActionPreference = 'Stop'

# Run from the repo root regardless of the caller's working directory.
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Invoke-Step {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [scriptblock] $Action,
        [switch] $ContinueOnError
    )
    Write-Host ""
    Write-Host "==> $Name" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        if ($ContinueOnError) {
            Write-Host "WARNING: '$Name' exited with code $LASTEXITCODE (continuing)." -ForegroundColor Yellow
            return
        }
        Write-Error "Step '$Name' failed with exit code $LASTEXITCODE."
        exit $LASTEXITCODE
    }
}

Write-Host "Purview GitHub Action - verify loop" -ForegroundColor Green
Write-Host "Repo root: $repoRoot"

if (-not $SkipInstall) {
    if (Test-Path (Join-Path $repoRoot 'package-lock.json')) {
        Invoke-Step -Name 'Install dependencies (npm ci)' -Action { npm ci }
    }
    else {
        Invoke-Step -Name 'Install dependencies (npm install)' -Action { npm install }
    }
}
elseif (-not (Test-Path (Join-Path $repoRoot 'node_modules'))) {
    Write-Error "node_modules is missing and -SkipInstall was set. Run without -SkipInstall first."
    exit 1
}

Invoke-Step -Name 'Build TypeScript (npm run build)'   -Action { npm run build }
Invoke-Step -Name 'Package action (npm run package)'   -Action { npm run package }
Invoke-Step -Name 'Run tests (npm run test)'           -Action { npm run test }

# Lint is best-effort: eslint is not currently a declared devDependency, so a
# missing toolchain must not fail the core build+test verification loop.
Invoke-Step -Name 'Lint (npm run lint, best-effort)' -ContinueOnError -Action { npm run lint }

Write-Host ""
Write-Host "All required verification steps passed." -ForegroundColor Green
