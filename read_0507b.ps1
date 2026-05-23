$content = [System.IO.File]::ReadAllText([System.IO.Path]::GetTempPath() + 'segmentPlanner_0507.js', [System.Text.Encoding]::GetEncoding('GBK'))
$i = $content.IndexOf('function chooseEventBoundaries')
$j = $content.IndexOf('function groupDialoguesByCuts')
if ($i -ge 0 -and $j -ge 0) {
    $content.Substring($i, [Math]::Min($j-$i, 8000))
} else {
    "NOT FOUND i=$i j=$j"
}
