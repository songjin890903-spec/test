$conn = Get-NetTCPConnection -LocalPort 3006 -ErrorAction SilentlyContinue
if ($conn) { Stop-Process -Id $conn.OwningProcess -Force; Write-Host ("Killed " + $conn.OwningProcess) } else { Write-Host "Free" }
