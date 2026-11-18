[CmdletBinding()]
param(
    [string]$ConfigPath,
    [string]$NodePath,
    [string]$ModelEndpoint,
    [string]$ModelName,
    [ValidateSet('rules', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions')][string]$PermissionMode = 'auto',
    [string]$ClassifierEndpoint,
    [string]$ClassifierModel,
    [ValidateSet('off', 'docker')][string]$Isolation = 'off'
)
$ErrorActionPreference = 'Stop'
if (-not $NodePath) {
    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeCommand) { throw 'Node.js PATH uzerinde bulunamadi. Node.js 24 yukleyin veya -NodePath ile node.exe yolunu belirtin.' }
    $NodePath = $nodeCommand.Source
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node bulunamadi: $NodePath" }
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$version = & $NodePath --version
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw 'Node.js 24 veya daha yeni bir surum gerekli.' }
$server = Join-Path $PSScriptRoot 'server-code-mode.mjs'
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { throw "Sunucu bulunamadi: $server" }
if ($Isolation -eq 'docker') {
    # -Isolation docker only counts with a running docker engine, and the
    # worker image is built once up front so the first job is not surprised.
    $dockerCommand = Get-Command docker.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $dockerCommand) { throw 'Isolasyon icin Docker gerekli; Docker Desktop kurulup calisir durumda olmali veya -Isolation off kullanin.' }
    & $dockerCommand.Source version --format '{{.Server.Version}}' 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Docker motoru calismiyor; Docker Desktop acilin veya -Isolation off kullanin.' }
    Push-Location -LiteralPath $PSScriptRoot
    try {
        $workerImage = & $NodePath (Join-Path $PSScriptRoot 'worker-image.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Worker imaj hash degeri hesaplanamadi.' }
        & $dockerCommand.Source build -q -t $workerImage -f 'worker-image/Dockerfile' . 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Worker imaji derlenemedi; Docker, ag ve Dockerfile kontrol edin.' }
    } finally { Pop-Location }
    Write-Host "Worker imaji hazir: $workerImage"
}
if (-not $ConfigPath) {
    $candidates = @()
    if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Claude-3p\claude_desktop_config.json' }
    if ($env:APPDATA) { $candidates += Join-Path $env:APPDATA 'Claude\claude_desktop_config.json' }
    $existing = @($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if ($existing.Count -eq 0) { throw 'Claude Desktop yapilandirmasi bulunamadi. -ConfigPath ile mevcut dosyayi belirtin.' }
    if ($existing.Count -gt 1) { throw "Birden fazla Claude yapilandirmasi bulundu; -ConfigPath ile secin: $($existing -join ', ')" }
    $ConfigPath = $existing[0]
}
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Desktop yapilandirmasi bulunamadi: $ConfigPath" }
$ConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
try { $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json }
catch { throw "Desktop yapilandirmasi gecerli JSON degil: $ConfigPath" }
if (-not $config -or $config -is [array] -or $config -isnot [pscustomobject]) { throw 'Yapilandirma bir JSON nesnesi olmali.' }
if (-not $config.PSObject.Properties['mcpServers']) { $config | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) }
if ($config.mcpServers -isnot [pscustomobject]) { throw 'mcpServers bir JSON nesnesi olmali.' }
Push-Location -LiteralPath $PSScriptRoot
try {
    & $NodePath --input-type=module -e "await import('@modelcontextprotocol/sdk/server/mcp.js'); await import('zod')" 2>$null
    if ($LASTEXITCODE -ne 0) {
        $npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $npmCommand) { throw 'Bagimliliklar eksik ve npm.cmd PATH uzerinde bulunamadi. npm ci calistirip tekrar deneyin.' }
        & $npmCommand.Source ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci basarisiz oldu; Desktop yapilandirmasi degistirilmedi.' }
        & $NodePath --input-type=module -e "await import('@modelcontextprotocol/sdk/server/mcp.js'); await import('zod')" 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Bagimliliklar dogrulanamadi; Desktop yapilandirmasi degistirilmedi.' }
    }
} finally { Pop-Location }
$previous = $config.mcpServers.PSObject.Properties['3p-code-mode']
$environment = [pscustomobject]@{}
if ($previous -and $previous.Value.env -is [pscustomobject]) { $environment = $previous.Value.env }
if (-not $ClassifierEndpoint) { $ClassifierEndpoint = $environment.CODE_MODE_CLASSIFIER_ENDPOINT }
if (-not $ClassifierEndpoint) { $ClassifierEndpoint = $ModelEndpoint }
if (-not $ClassifierEndpoint) { $ClassifierEndpoint = $environment.REVIEW_MODEL_ENDPOINT }
if (-not $ClassifierModel) { $ClassifierModel = $environment.CODE_MODE_CLASSIFIER_MODEL }
if (-not $ClassifierModel) { $ClassifierModel = $ModelName }
if (-not $ClassifierModel) { $ClassifierModel = $environment.REVIEW_MODEL_NAME }
if ($PermissionMode -eq 'auto' -and (-not $ClassifierEndpoint -or -not $ClassifierModel)) {
    throw 'Auto varsayilandir: -ModelEndpoint ve -ModelName veya -ClassifierEndpoint ve -ClassifierModel belirtin. Insan onayli mod icin -PermissionMode default kullanin. Yapilandirma degistirilmedi.'
}
$environment | Add-Member -NotePropertyName CODE_MODE_MCP_CONFIG_PATH -NotePropertyValue $ConfigPath -Force
if ($Isolation -eq 'docker') { $environment | Add-Member -NotePropertyName CODE_MODE_ISOLATION -NotePropertyValue 'docker' -Force }
else { $environment.PSObject.Properties.Remove('CODE_MODE_ISOLATION') }
if ($ModelEndpoint) { $environment | Add-Member -NotePropertyName REVIEW_MODEL_ENDPOINT -NotePropertyValue $ModelEndpoint -Force }
if ($ModelName) { $environment | Add-Member -NotePropertyName REVIEW_MODEL_NAME -NotePropertyValue $ModelName -Force }
if ($PermissionMode) { $environment | Add-Member -NotePropertyName CODE_MODE_PERMISSION_MODE -NotePropertyValue $PermissionMode -Force }
if ($ClassifierEndpoint) { $environment | Add-Member -NotePropertyName CODE_MODE_CLASSIFIER_ENDPOINT -NotePropertyValue $ClassifierEndpoint -Force }
if ($ClassifierModel) { $environment | Add-Member -NotePropertyName CODE_MODE_CLASSIFIER_MODEL -NotePropertyValue $ClassifierModel -Force }
$entry = [pscustomobject]@{ command = $NodePath; args = @($server) }
if (@($environment.PSObject.Properties).Count -gt 0) { $entry | Add-Member -NotePropertyName env -NotePropertyValue $environment }
$config.mcpServers.PSObject.Properties.Remove('3p-code-engine-reader')
$config.mcpServers | Add-Member -NotePropertyName '3p-code-mode' -NotePropertyValue $entry -Force
$json = $config | ConvertTo-Json -Depth 100
$backup = "$ConfigPath.backup-code-mode-$([Guid]::NewGuid().ToString('N'))"
Copy-Item -LiteralPath $ConfigPath -Destination $backup -ErrorAction Stop
$temporary = "$ConfigPath.tmp-$([Guid]::NewGuid().ToString('N'))"
try {
    [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $ConfigPath -Force -ErrorAction Stop
} finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
Write-Host "3p-code-mode eklendi: $ConfigPath"
Write-Host "Yedek: $backup"
Write-Host 'Claude Desktop uygulamasini tamamen kapatip yeniden acin.'
Write-Host "Izin modu: $PermissionMode; JavaScript runtime: QuickJS (Node.js erisimi yok)."
Write-Host "Terminal: node code-mode-cli.mjs --config `"$ConfigPath`""
