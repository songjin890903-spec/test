$content = [System.IO.File]::ReadAllText([System.IO.Path]::GetTempPath() + 'av7_0507.js', [System.Text.Encoding]::GetEncoding('GBK'))
$lines = $content -split "`n"
$lineCount = $lines.Count
Write-Host "Total lines: $lineCount"
# Check function list
$funcs = $lines | Where-Object { $_ -match '^function ' } | ForEach-Object { $_.Trim() }
Write-Host "Functions in 0507:"
$funcs | ForEach-Object { Write-Host "  $_" }

# Count lines
$current = 0
$version = ''
foreach ($line in $lines) {
  if ($line -match 'TOOL_VERSION') {
    $version = $line.Trim()
    break
  }
  $current++
}
Write-Host "First TOOL_VERSION mention at line: $current"
Write-Host "Version: $version"
