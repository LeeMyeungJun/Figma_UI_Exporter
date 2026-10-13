param([string]$InputPath)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

function ConvertFrom-GodotString([string]$Value) {
    try { return $Value | ConvertFrom-Json } catch { return $Value.Trim('"') }
}

function ConvertFrom-GodotColor([string]$Value, [Drawing.Color]$Fallback) {
    if ($Value -notmatch '^Color\(([^)]+)\)') { return $Fallback }
    $numbers = $matches[1].Split(',') | ForEach-Object { [double]$_.Trim() }
    if ($numbers.Count -lt 3) { return $Fallback }
    return [Drawing.Color]::FromArgb(
        255,
        [Math]::Max(0, [Math]::Min(255, [Math]::Round($numbers[0] * 255))),
        [Math]::Max(0, [Math]::Min(255, [Math]::Round($numbers[1] * 255))),
        [Math]::Max(0, [Math]::Min(255, [Math]::Round($numbers[2] * 255)))
    )
}

function Get-PropertyMap([string]$Block) {
    $map = @{}
    foreach ($line in ($Block -split "`r?`n")) {
        if ($line -match '^([^=]+?)\s*=\s*(.+)$') { $map[$matches[1].Trim()] = $matches[2].Trim() }
    }
    return $map
}

function Resolve-ViewerInput([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) {
        $dialog = [Windows.Forms.OpenFileDialog]::new()
        $dialog.Title = 'Godot UI 내보내기 파일 열기'
        $dialog.Filter = 'Godot UI 파일 (*.zip;*.tscn)|*.zip;*.tscn|ZIP 파일 (*.zip)|*.zip|Godot 씬 (*.tscn)|*.tscn'
        $dialog.Multiselect = $false
        if ($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { return $null }
        $Path = $dialog.FileName
    }

    $Path = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $Path)) { throw "파일을 찾을 수 없습니다: $Path" }
    $item = Get-Item -LiteralPath $Path
    if ($item.PSIsContainer) {
        $root = $item.FullName
        $scene = Get-ChildItem -LiteralPath $root -Filter 'generated.tscn' -File -Recurse | Select-Object -First 1
    } elseif ($item.Extension -ieq '.zip') {
        $root = Join-Path (Join-Path $env:TEMP 'GodotUIViewer') ([guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $root -Force | Out-Null
        Expand-Archive -LiteralPath $item.FullName -DestinationPath $root -Force
        $scene = Get-ChildItem -LiteralPath $root -Filter 'generated.tscn' -File -Recurse | Select-Object -First 1
    } elseif ($item.Extension -ieq '.tscn') {
        $scene = $item
        $cursor = $scene.Directory
        while ($cursor.Parent -and $cursor.Name -ne 'figma_ui') { $cursor = $cursor.Parent }
        $root = if ($cursor.Name -eq 'figma_ui' -and $cursor.Parent) { $cursor.Parent.FullName } else { $scene.Directory.FullName }
    } else {
        throw 'ZIP, 폴더 또는 generated.tscn 파일만 열 수 있습니다.'
    }
    if (-not $scene) { throw 'generated.tscn을 찾지 못했습니다.' }
    return @{ Root = $root; Scene = $scene.FullName; Display = $item.Name }
}

function Show-Scene([Windows.Forms.Panel]$Canvas, [Windows.Forms.Label]$Status, [Windows.Forms.ToolTip]$Tips, $Source) {
    $Canvas.SuspendLayout()
    try {
        $Canvas.Controls.Clear()
        $text = [IO.File]::ReadAllText($Source.Scene, [Text.Encoding]::UTF8)
        $resources = @{}
        foreach ($match in [regex]::Matches($text, '(?m)^\[ext_resource[^\]]*path="([^"]+)"[^\]]*id="([^"]+)"\]')) {
            $relative = $match.Groups[1].Value -replace '^res://', '' -replace '/', '\'
            $resources[$match.Groups[2].Value] = Join-Path $Source.Root $relative
        }

        $styles = @{}
        $styleMatches = [regex]::Matches($text, '(?ms)^\[sub_resource[^\]]*id="([^"]+)"\]\s*(.*?)(?=^\[|\z)')
        foreach ($match in $styleMatches) { $styles[$match.Groups[1].Value] = Get-PropertyMap $match.Groups[2].Value }

        $nodeMatches = [regex]::Matches($text, '(?ms)^\[node\s+name="((?:\\.|[^"])*)"\s+type="([^"]+)"[^\]]*\]\s*(.*?)(?=^\[|\z)')
        $count = 0
        $maxRight = 640
        $maxBottom = 480
        foreach ($match in $nodeMatches) {
            $name = ConvertFrom-GodotString ('"' + $match.Groups[1].Value + '"')
            $type = $match.Groups[2].Value
            if ($type -eq 'Control' -and $name -eq 'FigmaUI') { continue }
            $properties = Get-PropertyMap $match.Groups[3].Value
            $left = if ($properties.ContainsKey('offset_left')) { [double]$properties['offset_left'] } else { 0 }
            $top = if ($properties.ContainsKey('offset_top')) { [double]$properties['offset_top'] } else { 0 }
            $right = if ($properties.ContainsKey('offset_right')) { [double]$properties['offset_right'] } else { $left + 1 }
            $bottom = if ($properties.ContainsKey('offset_bottom')) { [double]$properties['offset_bottom'] } else { $top + 1 }
            $x = [Math]::Round($left); $y = [Math]::Round($top)
            $width = [Math]::Max(1, [Math]::Round($right - $left)); $height = [Math]::Max(1, [Math]::Round($bottom - $top))
            $control = $null

            if ($type -eq 'TextureRect') {
                $control = [Windows.Forms.PictureBox]::new()
                $control.SizeMode = [Windows.Forms.PictureBoxSizeMode]::StretchImage
                if ($properties['texture'] -match 'ExtResource\("([^"]+)"\)') {
                    $asset = $resources[$matches[1]]
                    if ($asset -and (Test-Path -LiteralPath $asset) -and [IO.Path]::GetExtension($asset) -ine '.svg') {
                        $stream = [IO.File]::OpenRead($asset)
                        try { $control.Image = [Drawing.Image]::FromStream($stream).Clone() } finally { $stream.Dispose() }
                    } else {
                        $control.BackColor = [Drawing.Color]::FromArgb(65, 75, 90)
                    }
                }
            } elseif ($type -eq 'Panel') {
                $control = [Windows.Forms.Panel]::new()
                $control.BackColor = [Drawing.Color]::FromArgb(45, 52, 63)
                if ($properties['theme_override_styles/panel'] -match 'SubResource\("([^"]+)"\)' -and $styles.ContainsKey($matches[1])) {
                    $control.BackColor = ConvertFrom-GodotColor $styles[$matches[1]]['bg_color'] $control.BackColor
                }
            } elseif ($type -eq 'Label') {
                $control = [Windows.Forms.Label]::new()
                $control.BackColor = [Drawing.Color]::Transparent
                $control.ForeColor = ConvertFrom-GodotColor $properties['theme_override_colors/font_color'] ([Drawing.Color]::White)
                $control.TextAlign = [Drawing.ContentAlignment]::MiddleLeft
                if ($properties.ContainsKey('text')) { $control.Text = ConvertFrom-GodotString $properties['text'] }
                $fontSize = if ($properties.ContainsKey('theme_override_font_sizes/font_size')) { [single]$properties['theme_override_font_sizes/font_size'] } else { 16 }
                $control.Font = [Drawing.Font]::new('Malgun Gothic', [Math]::Max(1, $fontSize), [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
            } else { continue }

            $control.Location = [Drawing.Point]::new($x, $y)
            $control.Size = [Drawing.Size]::new($width, $height)
            $control.Name = $name
            $Tips.SetToolTip($control, "$name ($type)  ${width}x${height}")
            $Canvas.Controls.Add($control)
            $control.BringToFront()
            $maxRight = [Math]::Max($maxRight, $x + $width)
            $maxBottom = [Math]::Max($maxBottom, $y + $height)
            $count++
        }
        $Canvas.AutoScrollMinSize = [Drawing.Size]::new($maxRight + 30, $maxBottom + 30)
        $Status.Text = "$($Source.Display)  |  $count개 노드  |  $([IO.Path]::GetFileName($Source.Scene))"
    } finally {
        $Canvas.ResumeLayout($true)
    }
}

$form = [Windows.Forms.Form]::new()
$form.Text = 'Godot UI Viewer'
$form.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
$form.ClientSize = [Drawing.Size]::new(1280, 800)
$form.MinimumSize = [Drawing.Size]::new(720, 480)
$form.BackColor = [Drawing.Color]::FromArgb(20, 25, 34)

$toolbar = [Windows.Forms.Panel]::new()
$toolbar.Dock = [Windows.Forms.DockStyle]::Top
$toolbar.Height = 46
$toolbar.BackColor = [Drawing.Color]::FromArgb(29, 37, 49)
$form.Controls.Add($toolbar)

$openButton = [Windows.Forms.Button]::new()
$openButton.Text = 'ZIP / TSCN 열기'
$openButton.Location = [Drawing.Point]::new(12, 9)
$openButton.Size = [Drawing.Size]::new(130, 28)
$toolbar.Controls.Add($openButton)

$status = [Windows.Forms.Label]::new()
$status.Text = '파일을 여세요.'
$status.ForeColor = [Drawing.Color]::FromArgb(205, 216, 230)
$status.Location = [Drawing.Point]::new(155, 14)
$status.AutoSize = $true
$toolbar.Controls.Add($status)

$viewport = [Windows.Forms.Panel]::new()
$viewport.Dock = [Windows.Forms.DockStyle]::Fill
$viewport.AutoScroll = $true
$viewport.BackColor = [Drawing.Color]::FromArgb(15, 18, 24)
$form.Controls.Add($viewport)
$viewport.BringToFront()
$toolbar.BringToFront()
$tips = [Windows.Forms.ToolTip]::new()

$load = {
    param([string]$Path)
    try {
        $source = Resolve-ViewerInput $Path
        if ($source) { Show-Scene $viewport $status $tips $source; $form.Text = 'Godot UI Viewer - ' + $source.Display }
    } catch {
        [Windows.Forms.MessageBox]::Show($_.Exception.Message, '열기 실패', 'OK', 'Error') | Out-Null
    }
}
$openButton.Add_Click({ & $load '' })
$form.Add_Shown({ if (-not [string]::IsNullOrWhiteSpace($InputPath)) { & $load $InputPath } else { & $load '' } })

[Windows.Forms.Application]::Run($form)
