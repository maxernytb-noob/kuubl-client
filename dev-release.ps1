<#
  Publishes a TEST build of Kuubl Client to https://ertenix.net/kuubl/dev/ (not the public release).
  Only the owner's launcher shows the "Dev" button that installs it; normal launchers never look there.

  The version is the next patch with a -dev suffix (0.9.1 -> 0.9.2-dev.2611151030), so:
    - normal launchers don't see it (it's a different feed),
    - the real 0.9.2 release later counts as newer and replaces it automatically.
  Nothing in the repo is bumped: the version is only passed to this build.

  Usage (from bash, like release.ps1):
    powershell -NoProfile -ExecutionPolicy Bypass -File D:\claudemaker\justice-client\dev-release.ps1 -Notes "- what changed"
    ... -DryRun   # build + prepare files, don't upload

  Needs the update signing key (D:\dev\justice-signing\justice.key, never commit or share it) and SSH to the VPS.
#>
param(
  [string]$Notes = "",
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$key = "D:\dev\justice-signing\justice.key"
$sshKey = "$env:USERPROFILE\.ssh\claude_bythorn"
$remote = "claude@178.95.164.26"
$baseUrl = "https://ertenix.net/kuubl/dev"
$utf8 = New-Object Text.UTF8Encoding $false

$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';D:\dev\cargo\bin'
$env:CARGO_HOME = 'D:\dev\cargo'
$env:RUSTUP_HOME = 'D:\dev\rustup'

# ---- 1. Version: next patch + -dev.<yyMMddHHmm> ----
$base = (Get-Content "$root\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version -replace '-.*$', ''
$p = $base.Split('.')
$Version = "$($p[0]).$($p[1]).$([int]$p[2] + 1)-dev.$((Get-Date).ToString('yyMMddHHmm'))"
Write-Host "== Kuubl Client DEV $Version" -ForegroundColor Cyan

# ---- 2. Signed build with the version overridden ----
if (-not (Test-Path $key)) { throw "Missing signing key $key" }
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content "D:\dev\justice-signing\password.txt" -Raw).Trim()
$conf = "$env:TEMP\kuubl-dev-conf.json"
[IO.File]::WriteAllText($conf, "{`"version`":`"$Version`"}", $utf8)
Push-Location $root
npx tauri build --config $conf
$code = $LASTEXITCODE
Pop-Location
Remove-Item $conf -ErrorAction SilentlyContinue
if ($code -ne 0) { throw "Build failed" }

$nsis = "$root\src-tauri\target\release\bundle\nsis"
$setup = Get-ChildItem $nsis -Filter "*_${Version}_x64-setup.exe" | Select-Object -First 1
if (-not $setup) { throw "Installer for $Version not found in $nsis" }
$sig = "$($setup.FullName).sig"
if (-not (Test-Path $sig)) { throw "Signature $sig not found" }

# ---- 3. Files: installer + latest.json ----
$out = "$root\packaging\dev-release\$Version"
Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $out | Out-Null
$file = "KuublClient_${Version}_x64-setup.exe"
Copy-Item $setup.FullName "$out\$file"
$latest = [ordered]@{
  version   = $Version
  notes     = $Notes
  pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = (Get-Content $sig -Raw).Trim()
      url       = "$baseUrl/$file"
    }
  }
}
[IO.File]::WriteAllText("$out\latest.json", ($latest | ConvertTo-Json -Depth 5), $utf8)
Get-ChildItem $out | Format-Table Name, Length
if ($DryRun) { Write-Host "Dry run: nothing uploaded. Files are in $out"; return }

# ---- 4. Upload: installer first, latest.json last; keep the 3 newest dev installers ----
$stage = "/home/claude/kuubl-dev-stage"
ssh -i $sshKey $remote "rm -rf $stage && mkdir -p $stage"
scp -q -i $sshKey "$out\$file" "$out\latest.json" "${remote}:$stage/"
ssh -i $sshKey $remote "sudo install -d -o www-data -g www-data /var/www/kuubl/dev && sudo install -o www-data -g www-data -m 644 $stage/$file /var/www/kuubl/dev/$file && sudo install -o www-data -g www-data -m 644 $stage/latest.json /var/www/kuubl/dev/latest.json && cd /var/www/kuubl/dev && ls -t KuublClient_*-setup.exe | tail -n +4 | xargs -r sudo rm -f && ls -la && rm -rf $stage"
if ($LASTEXITCODE -ne 0) { throw "Upload failed" }
Write-Host "Published DEV $Version -> $baseUrl/latest.json" -ForegroundColor Green
