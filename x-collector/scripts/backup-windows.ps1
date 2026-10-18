# Local Windows PostgreSQL backup. No passwords or URLs on command line.
# Run from the x-collector folder: npm run db:backup:windows
param(
  [string]$BackupDir = "",
  [ValidateRange(1, 365)][int]$Keep = 7
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (-not $BackupDir) { $BackupDir = Join-Path (Split-Path $PSScriptRoot -Parent) "backups" }
if (-not $env:DATABASE_URL) { throw "DATABASE_URL is required (load your local .env into the process environment)." }
if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) { throw "pg_dump not found. Install PostgreSQL client tools and add them to PATH." }
if (-not (Get-Command pg_restore -ErrorAction SilentlyContinue)) { throw "pg_restore not found. Install PostgreSQL client tools and add them to PATH." }
$uri = [Uri]$env:DATABASE_URL
if ($uri.Scheme -ne "postgresql" -and $uri.Scheme -ne "postgres") { throw "DATABASE_URL must be a PostgreSQL URI" }
$previous = @{}
foreach ($name in @("PGHOST","PGPORT","PGUSER","PGDATABASE","PGPASSWORD")) {
  $previous[$name] = [Environment]::GetEnvironmentVariable($name,"Process")
}
$partial = ""
try {
  $auth = $uri.UserInfo.Split(":",2)
  $env:PGHOST = $uri.Host
  $env:PGPORT = [string]$(if ($uri.IsDefaultPort) { 5432 } else { $uri.Port })
  $env:PGUSER = [Uri]::UnescapeDataString($auth[0])
  $env:PGPASSWORD = $(if ($auth.Length -eq 2) { [Uri]::UnescapeDataString($auth[1]) } else { "" })
  $env:PGDATABASE = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart("/"))
  if (-not $env:PGDATABASE -or -not $env:PGUSER) { throw "DATABASE_URL must contain database and username" }
  New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss-fff")
  $final = Join-Path $BackupDir ("x-collector-" + $stamp + ".dump")
  $partial = $final + ".partial"
  & pg_dump --format=custom --no-owner --no-acl --file $partial
  if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }
  & pg_restore --list $partial | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "pg_restore failed to inspect backup" }
  if ((Get-Item $partial).Length -le 0) { throw "The backup is empty" }
  Move-Item -LiteralPath $partial -Destination $final -ErrorAction Stop
  $partial = ""
  Get-ChildItem -Path $BackupDir -Filter "x-collector-*.dump" -File |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip $Keep |
    Remove-Item -Force
  Write-Output "PostgreSQL backup created and archive TOC validated: $final"
  Write-Output "Restore test against a separate local database is still required."
}
finally {
  if ($partial -and (Test-Path -LiteralPath $partial)) { Remove-Item -LiteralPath $partial -Force }
  foreach ($name in $previous.Keys) {
    [Environment]::SetEnvironmentVariable($name,$previous[$name],"Process")
  }
}
