# Windows で最小ゲスト（x86_64）を QEMU で起動し、ゴールデンテストを流す（Issue #18）。
#
# PowerShell 5.1 は BOM の無い UTF-8 を Shift_JIS として読むので、このファイルは BOM 付き UTF-8 で保存する。
# 使い方: powershell -ExecutionPolicy Bypass -File windows\run-golden.ps1 [-Accel auto|whpx|tcg]
#   QEMU は環境変数 QEMU（qemu-system-x86_64.exe のパス）、PATH、guest\.cache\qemu-win、既定のインストール先の順に探す。
#   guest\out\x86_64\Image が無ければ、GitHub Actions の最新の成功した Guest ワークフローから取ってくる（gh が要る）。
#
# -Accel auto は WHPX（Windows ハイパーバイザー プラットフォーム）を先に試し、使えなければ TCG（エミュレーション）で動かす。
# QEMU は -accel を複数並べると前から順に試す。
#
# -Demo を付けると、ゴールデンテストの代わりに scripts/guest/demo.mjs（保存・削除・過去に戻る・枝分かれを 1 段ずつ見せる）を流す。
# -Step を足すと、デモの各段で Enter を待つ。
param(
    [ValidateSet('auto', 'whpx', 'tcg')]
    [string]$Accel = 'auto',
    [switch]$Demo,
    [switch]$Step
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Out = Join-Path $Root 'guest\out\x86_64'
$Image = Join-Path $Out 'Image'

$Qemu = $env:QEMU
if (-not $Qemu) {
    $cmd = Get-Command qemu-system-x86_64.exe -ErrorAction SilentlyContinue
    if ($cmd) { $Qemu = $cmd.Source }
}
if (-not $Qemu) {
    # 開発用に配布版から必要なファイルだけを抜き出して置いた場所（Git の管理外）
    $local = Join-Path $Root 'guest\.cache\qemu-win\qemu-system-x86_64.exe'
    if (Test-Path $local) { $Qemu = $local }
}
if (-not $Qemu) { $Qemu = 'C:\Program Files\qemu\qemu-system-x86_64.exe' }
if (-not (Test-Path $Qemu)) {
    throw "QEMU が見つからない。環境変数 QEMU に qemu-system-x86_64.exe のパスを入れる"
}

if (-not (Test-Path $Image)) {
    $branch = (git -C $Root rev-parse --abbrev-ref HEAD).Trim()
    $runId = (gh run list -R usudonsdev/microgit -w guest.yml -b $branch -s success -L 1 --json databaseId -q '.[0].databaseId')
    if (-not $runId) { throw "成功した Guest ワークフローが $branch にない" }
    Write-Host "downloading Image from run $runId"
    New-Item -ItemType Directory -Force $Out | Out-Null
    gh run download $runId -R usudonsdev/microgit -n microgit-guest-x86_64 -D $Out
    if ($LASTEXITCODE -ne 0) { throw "gh run download failed" }
}

# kernel-irqchip=off: QEMU の WHPX では割り込みコントローラを QEMU 側で持つ（外した場合は未確認）
$accelArgs = switch ($Accel) {
    'whpx' { @('-accel', 'whpx,kernel-irqchip=off') }
    'tcg' { @('-accel', 'tcg') }
    default { @('-accel', 'whpx,kernel-irqchip=off', '-accel', 'tcg') }
}
$consoleLog = Join-Path $Out "console-windows-$Accel.log"
$qemuArgs = @('-M', 'q35') + $accelArgs + @(
    '-cpu', 'max', '-smp', '1', '-m', '256',
    '-nodefaults', '-display', 'none', '-no-reboot',
    '-kernel', $Image, '-append', 'console=hvc0',
    '-device', 'virtio-serial-pci',
    '-chardev', "file,id=con,path=$consoleLog",
    '-device', 'virtconsole,chardev=con',
    '-chardev', 'stdio,id=proto,signal=off',
    '-device', 'virtserialport,chardev=proto,name=microgit'
)

if ($Demo) {
    $demoOpts = @('--console', $consoleLog)
    if ($Step) { $demoOpts += '--step' }
    node (Join-Path $Root 'scripts\guest\demo.mjs') @demoOpts -- $Qemu @qemuArgs
} else {
    node (Join-Path $Root 'scripts\golden\check-guest.mjs') --json (Join-Path $Out "guest-result-windows-$Accel.json") -- $Qemu @qemuArgs
}
exit $LASTEXITCODE
