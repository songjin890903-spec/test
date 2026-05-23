$proc = Get-Process -Id 36480 -ErrorAction SilentlyContinue
if ($proc) { Write-Host "Running: $($proc.ProcessName)" } else { Write-Host "Not found" }
