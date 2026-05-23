$content = [System.IO.File]::ReadAllText([System.IO.Path]::GetTempPath() + 'segmentPlanner_0507.js', [System.Text.Encoding]::GetEncoding('GBK'))
$i = $content.IndexOf('function planSceneSegments')
$j = $content.IndexOf('function planManifestSegments')
if ($i -ge 0) {
    $len = $j - $i
    if ($len -gt 0) {
        $content.Substring($i, [Math]::Min($len, 10000))
    } else {
        "NOT FOUND"
    }
} else {
    "NOT FOUND"
}
