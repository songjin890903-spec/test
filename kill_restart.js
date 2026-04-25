// 强制杀死端口3001并重启
const { execSync } = require('child_process');
try {
  execSync('netstat -ano | findstr :3001', { stdio: 'pipe' });
  console.log('Port 3001 still in use, trying kill...');
} catch(e) { console.log('Port is free'); }

// Use PowerShell to kill and restart
const ps = `
$pid = (Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess)
if ($pid) {
  Stop-Process -Id $pid -Force
  Start-Sleep -Seconds 3
  Write-Host "Killed PID: $pid"
} else {
  Write-Host "No process found on port 3001"
}
Set-Location "C:\\Users\\Administrator\\Desktop\\work\\个人\\项目\\修改V4版本\\test"
Start-Process node -ArgumentList "server.js" -WindowStyle Hidden -PassThru | ForEach-Object { Write-Host "New server PID:" $_.Id }
Start-Sleep -Seconds 5
Write-Host "Done"
`;
require('child_process').execSync('powershell -Command "' + ps.replace(/\n/g, '; ') + '"', { stdio: 'inherit' });
