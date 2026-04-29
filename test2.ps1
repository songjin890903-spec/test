$base = "http://127.0.0.1:3006"

Write-Host "1. Login:"
$r = Invoke-WebRequest -Uri "$base/api/auth/login" -Method POST -ContentType "application/json" -Body (@{username="admin";password="admin123"} | ConvertTo-Json) -SessionVariable sv -TimeoutSec 5
Write-Host "Status:" $r.StatusCode "Content-Type:" $r.Headers["Content-Type"]
Write-Host "Body:" $r.Content
Write-Host "Cookies:" $r.Headers["Set-Cookie"]

Write-Host "`n2. Me:"
if ($sv) {
    $r2 = Invoke-WebRequest -Uri "$base/api/auth/me" -WebSession $sv -TimeoutSec 5
    Write-Host "Status:" $r2.StatusCode "Body:" $r2.Content
} else {
    Write-Host "No session"
}

Write-Host "`n3. Users:"
if ($sv) {
    $r3 = Invoke-WebRequest -Uri "$base/api/admin/users" -WebSession $sv -TimeoutSec 5
    Write-Host "Status:" $r3.StatusCode "Body:" $r3.Content
} else {
    Write-Host "No session"
}

Write-Host "`nDone"
