
<#
.SYNOPSIS
    Antigravity 汉化 + 底栏 HUD 一体化修复工具
.DESCRIPTION
    1. 检查 antigravity-chinese 上游是否有待合并更新（后台只 fetch，合并需要你确认）；
    2. 检测 Antigravity 是否在运行，先请求正常关闭，必要时再经确认强制结束；
       在 Antigravity 智能体会话内运行时拒绝关闭宿主；
    3. 调用 fast-patch.cjs：维护纯净备份 app.asar.bak、内存重打包、原子替换、
       写入后终检（失败自动回滚）。
#>

[CmdletBinding()]
param (
    [string]$CustomAsarPath = "",
    [int]$ContextLimit = 0,
    [switch]$RestoreBackend,
    [switch]$SkipBackendPatch,
    [switch]$SkipProcessCheck,
    [switch]$NoPlugins,
    [switch]$Force,
    [switch]$ApplyUpdates,
    [switch]$NoUpdateCheck
)

$ErrorActionPreference = "Stop"
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}
$sw = [System.Diagnostics.Stopwatch]::StartNew()

function Fail([string]$Message, [int]$Code) {
    Write-Host "[ERR] $Message" -ForegroundColor Red
    exit $Code
}

function Test-Interactive {
    try { return [Environment]::UserInteractive -and -not [Console]::IsInputRedirected } catch { return $false }
}

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "   Antigravity 底栏 HUD + 可选汉化 + 1M 后端修复工具" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

# 0. 参数校验与路径解析（不写死盘符；可用环境变量 AGY_CHINESE_ROOT 覆盖）
if ($ContextLimit -ne 0 -and ($ContextLimit -lt 256001 -or $ContextLimit -gt 1048576)) {
    Fail "无效的 -ContextLimit 参数: $ContextLimit (需为 0 或 256001..1048576 之间的整数)" 5
}
if ($ContextLimit -ne 0 -and $RestoreBackend) {
    Fail "-ContextLimit 与 -RestoreBackend 不能同时使用。" 5
}

$scriptDir      = $PSScriptRoot
$fastPatchJs    = Join-Path $scriptDir "fast-patch.cjs"
$backendPatchJs = Join-Path $scriptDir "core\backend-patcher.cjs"
$bgSyncJs       = Join-Path $scriptDir "bg-sync-i18n.cjs"
$syncStatusPath = Join-Path $scriptDir ".last_bg_sync.json"

if ($env:AGY_CHINESE_ROOT) {
    $chineseRoot = [IO.Path]::GetFullPath($env:AGY_CHINESE_ROOT)
} else {
    $chineseCandidates = @(
        [IO.Path]::GetFullPath((Join-Path $scriptDir "..\antigravity-chinese")),
        [IO.Path]::GetFullPath((Join-Path $scriptDir "..\1\antigravity-chinese"))
    )
    $chineseRoot = $chineseCandidates[0]
    foreach ($cand in $chineseCandidates) {
        if (Test-Path -LiteralPath $cand) {
            $chineseRoot = $cand
            break
        }
    }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "未找到 node，请先安装 Node.js (>=18)。" 4 }
if (-not (Test-Path -LiteralPath $fastPatchJs)) { Fail "未找到补丁引擎: $fastPatchJs" 7 }

$hasI18n = (Test-Path -LiteralPath (Join-Path $chineseRoot "dict\zh-CN.json")) -and (Test-Path -LiteralPath (Join-Path $chineseRoot "core\i18n-runtime.js"))

function Get-I18nVersion {
    try { return (Get-Content (Join-Path $chineseRoot "package.json") -Raw -Encoding utf8 | ConvertFrom-Json).version } catch { return "unknown" }
}

# 1. 可选汉化词库与上游更新检查（仅在检测到汉化仓库且确认后合并）
$localVer = ""
if ($hasI18n) {
    $localVer = Get-I18nVersion
    Write-Host "[1/4] 汉化词库版本: v$localVer"
    if (-not $NoUpdateCheck -and (Test-Path -LiteralPath $syncStatusPath)) {
        $status = $null
        try { $status = Get-Content $syncStatusPath -Raw -Encoding utf8 | ConvertFrom-Json } catch {}
        if ($status -and $status.error) {
            Write-Host "   [WARN] 上次后台更新检查出错: $($status.error)" -ForegroundColor Yellow
        }
        if ($status -and $status.pendingUpdate -and $status.pendingUpdate.count -gt 0 -and $status.pendingUpdate.remoteHead) {
            Write-Host "   [INFO] 上游有 $($status.pendingUpdate.count) 个新提交待合并 (目标提交: $($status.pendingUpdate.remoteHead)):" -ForegroundColor Yellow
            foreach ($c in $status.pendingUpdate.commits) { Write-Host "      $c" -ForegroundColor Gray }
            Write-Host "   [WARN] 合并后上游的 JS 代码会被注入客户端，请确认来源可信。" -ForegroundColor Yellow
            $doApply = $ApplyUpdates.IsPresent
            if (-not $doApply -and (Test-Interactive)) {
                $ans = [string](Read-Host "   [?] 是否合并这些更新后再打补丁？[y/N]")
                $doApply = ($ans.Trim().ToLower() -in @('y', 'yes'))
            }
            if ($doApply) {
                & node $bgSyncJs --apply $status.pendingUpdate.remoteHead
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "   [WARN] 合并失败，继续使用当前本地词库 v$localVer" -ForegroundColor Yellow
                } else {
                    $localVer = Get-I18nVersion
                }
            } else {
                Write-Host "   [INFO] 暂不合并，继续使用当前本地词库 v$localVer" -ForegroundColor Gray
            }
        }
    }
} else {
    Write-Host "[1/4] 检查可选汉化词库..."
    Write-Host "[INFO] 未检测到可选汉化仓库 antigravity-chinese，将以纯 HUD + 角色选择器模式注入客户端" -ForegroundColor Cyan
}

# 2. 目标路径（支持传入安装目录自动解析为 <目录>\resources\app.asar，或自动探测常见安装路径）
$isCustomPath = -not [string]::IsNullOrWhiteSpace($CustomAsarPath)
if ($isCustomPath) {
    $resolvedCustom = [IO.Path]::GetFullPath($CustomAsarPath)
    if (Test-Path $resolvedCustom -PathType Container) {
        $asarPath = Join-Path $resolvedCustom "resources\app.asar"
    } else {
        $asarPath = $resolvedCustom
    }
} else {
    $candidateInstallDirs = @()
    if ($env:LOCALAPPDATA) {
        $candidateInstallDirs += (Join-Path $env:LOCALAPPDATA "Programs\antigravity")
    }
    if ($env:ProgramFiles) {
        $candidateInstallDirs += (Join-Path $env:ProgramFiles "antigravity")
        $candidateInstallDirs += (Join-Path $env:ProgramFiles "Google Antigravity")
    }
    if (${env:ProgramFiles(x86)}) {
        $candidateInstallDirs += (Join-Path ${env:ProgramFiles(x86)} "antigravity")
        $candidateInstallDirs += (Join-Path ${env:ProgramFiles(x86)} "Google Antigravity")
    }
    if ($env:APPDATA) {
        $candidateInstallDirs += (Join-Path $env:APPDATA "antigravity")
    }

    $asarPath = $null
    foreach ($candDir in $candidateInstallDirs) {
        $candAsar = Join-Path $candDir "resources\app.asar"
        $candSwap = Join-Path $candDir "resources\app.asar.swap-old"
        if ((Test-Path -LiteralPath $candAsar) -or (Test-Path -LiteralPath $candSwap)) {
            $asarPath = $candAsar
            break
        }
    }
    if (-not $asarPath) {
        foreach ($candDir in $candidateInstallDirs) {
            if (Test-Path -LiteralPath $candDir) {
                $asarPath = Join-Path $candDir "resources\app.asar"
                break
            }
        }
    }
    if (-not $asarPath) {
        $fallbackBase = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Programs\antigravity" } else { "antigravity" }
        $asarPath = Join-Path $fallbackBase "resources\app.asar"
    }
}
$defaultAsarPath = if ($env:LOCALAPPDATA) {
    [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Programs\antigravity\resources\app.asar"))
} else {
    [IO.Path]::GetFullPath($asarPath)
}
$isDefaultInstall = (-not $isCustomPath) -or [string]::Equals([IO.Path]::GetFullPath($asarPath), $defaultAsarPath, [System.StringComparison]::OrdinalIgnoreCase)
$resDir     = Split-Path -Parent $asarPath
$installDirRaw = if ((Split-Path -Leaf $resDir) -ieq "resources") { Split-Path -Parent $resDir } else { $resDir }
$installDir = $installDirRaw.TrimEnd('\', '/')
$swapOld    = Join-Path $resDir "app.asar.swap-old"
$backendExe = Join-Path $resDir "bin\language_server.exe"

function Get-UpdaterProcesses {
    $updaterDir = (Join-Path $env:LOCALAPPDATA "antigravity-updater").TrimEnd('\', '/')
    $skipNames  = @('Antigravity.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe', 'conhost.exe', 'node.exe', 'git.exe', 'rg.exe')
    $found = @()
    try {
        $cimList = @(Get-CimInstance Win32_Process -ErrorAction Stop)
        foreach ($c in $cimList) {
            if ([int]$c.ProcessId -eq $PID) { continue }
            $name = [string]$c.Name
            if (($name -in $skipNames) -or ($name -like 'language_server*')) { continue }
            $exe  = [string]$c.ExecutablePath
            $cmd  = [string]$c.CommandLine
            $isUpdater = $false
            if ($exe -and (($exe -like "$updaterDir\*") -or ($exe -like "$installDir\Uninstall*"))) {
                $isUpdater = $true
            } elseif ($cmd -and (($cmd -like "*antigravity-updater*") -or ($cmd -like "*Uninstall Antigravity*") -or ($cmd -like "*_?=$installDir*"))) {
                $isUpdater = $true
            } elseif ($name -ieq 'installer.exe' -and $cmd -and ($cmd -like '*--updated*')) {
                $isUpdater = $true
            }
            if ($isUpdater) { $found += $c }
        }
    } catch {}
    return $found
}

function Wait-UpdaterComplete([int]$TimeoutMs = 90000, [switch]$AllowMissingGrace) {
    $notified = $false
    $quietTicks = 0
    $missingNoUpdaterTicks = 0
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        $uProcs = @(Get-UpdaterProcesses)
        $asarMissing = $isDefaultInstall -and (-not (Test-Path -LiteralPath $asarPath)) -and (-not (Test-Path -LiteralPath $swapOld)) -and (Test-Path -LiteralPath $installDir)
        if ($uProcs.Count -gt 0) {
            $quietTicks = 0
            $missingNoUpdaterTicks = 0
            if (-not $notified) {
                Write-Host "   [INFO] 检测到 Antigravity 官方自动更新安装程序正在运行，正在等待更新完成..." -ForegroundColor Yellow
                $notified = $true
            }
        } elseif ($asarMissing -and ($notified -or ($AllowMissingGrace -and $missingNoUpdaterTicks -lt 6))) {
            $quietTicks = 0
            $missingNoUpdaterTicks++
        } else {
            $quietTicks++
            if (-not $notified -or $quietTicks -ge 4) {
                if ($notified) {
                    Write-Host "   [OK] 官方自动更新已完成，继续执行补丁。" -ForegroundColor Green
                }
                return $notified
            }
        }
        Start-Sleep -Milliseconds 300
    }
    return $notified
}

if (-not $SkipProcessCheck -and $isDefaultInstall) {
    $null = Wait-UpdaterComplete
}
if (-not (Test-Path -LiteralPath $asarPath) -and -not (Test-Path -LiteralPath $swapOld)) { Fail "未找到目标文件: $asarPath" 1 }
Write-Host "[INFO] 目标资源路径: $asarPath"

function Resolve-BackendTargets {
    $rawCandidates = @()
    if (Test-Path -LiteralPath $backendExe -PathType Leaf) {
        $rawCandidates += $backendExe
    }
    if ($isCustomPath) {
        $customCandidates = @(
            (Join-Path $installDir "bin\language_server.exe"),
            (Join-Path $resDir "app\extensions\antigravity\bin\language_server.exe"),
            (Join-Path $resDir "app\extensions\agy\bin\agy.exe"),
            (Join-Path $installDir "bin\agy.exe")
        )
        foreach ($c in $customCandidates) {
            if (Test-Path -LiteralPath $c -PathType Leaf) { $rawCandidates += $c }
        }
    } elseif (Test-Path -LiteralPath $backendPatchJs) {
        try {
            $discJson = (& node -e "const bp=require(process.argv[1]); console.log(JSON.stringify(bp.discoverDefaultTargets()));" $backendPatchJs 2>$null | Out-String).Trim()
            if ($discJson) {
                foreach ($item in @($discJson | ConvertFrom-Json)) {
                    $p = [string]$item
                    if ($p -and (Test-Path -LiteralPath $p -PathType Leaf)) {
                        $rawCandidates += $p
                    }
                }
            }
        } catch {}
    }
    $seenPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $resolvedList = @()
    foreach ($cand in $rawCandidates) {
        try {
            $full = [IO.Path]::GetFullPath($cand)
            if ($seenPaths.Add($full)) {
                $resolvedList += $full
            }
        } catch {}
    }
    return $resolvedList
}

# 提前探测可用后端二进制并完成阈值交互选择，避免在清理进程与写入补丁中途停顿等待输入
$backendTargets = @(Resolve-BackendTargets)
$hasBackend = ($backendTargets.Count -gt 0)
$doBackend = (-not $SkipBackendPatch) -and (Test-Path -LiteralPath $backendPatchJs) -and $hasBackend
$doRestore = $RestoreBackend.IsPresent
if ($doRestore -and -not $hasBackend) {
    Write-Host "   [WARN] 未检测到可用后端二进制 (language_server.exe / agy.exe)，将跳过后端恢复。" -ForegroundColor Yellow
    $doRestore = $false
}
$selectedLimit = if ($ContextLimit -gt 0) { $ContextLimit } else { 512000 }

if ($doBackend -and $ContextLimit -eq 0 -and -not $doRestore -and -not $Force -and (Test-Interactive)) {
    Write-Host ""
    Write-Host "[INFO] 后端 1M 上下文自动压缩阈值选择 (同时解除 24KB/20K 规则截断):" -ForegroundColor Cyan
    Write-Host "   [1] 512K (512,000 tokens，默认推荐，兼顾长上下文与响应速度)"
    Write-Host "   [2] 734K (734,000 tokens，超大上下文水位)"
    Write-Host "   [3] 自定义阈值 (256001 .. 1048576 tokens)"
    Write-Host "   [R] 恢复原版 256K 后端"
    $frontModeHint = if ($hasI18n) { "前端汉化+HUD" } else { "前端 HUD+角色选择器" }
    Write-Host "   [0] 跳过后端补丁 (仅保留$frontModeHint)"
    $menuResolved = $false
    for ($menuTry = 1; $menuTry -le 3; $menuTry++) {
        $bAns = ([string](Read-Host "   > 请选择 [回车=1]")).Trim().ToUpper()
        if ($bAns -eq '' -or $bAns -eq '1') {
            $selectedLimit = 512000
            $menuResolved = $true
            break
        } elseif ($bAns -eq '0') {
            $doBackend = $false
            $menuResolved = $true
            break
        } elseif ($bAns -eq 'R') {
            $doRestore = $true
            $menuResolved = $true
            break
        } elseif ($bAns -eq '2') {
            $selectedLimit = 734000
            $menuResolved = $true
            break
        } elseif ($bAns -eq '3') {
            $customRaw = ([string](Read-Host "   > 请输入自定义 Token 阈值 (256001..1048576)")).Trim()
            $parsedLim = 0
            if ([int]::TryParse($customRaw, [ref]$parsedLim) -and $parsedLim -ge 256001 -and $parsedLim -le 1048576) {
                $selectedLimit = $parsedLim
                $menuResolved = $true
                break
            } else {
                Fail "无效的上下文阈值: $customRaw (需为 256001..1048576 之间的整数)" 5
            }
        } else {
            if ($menuTry -lt 3) {
                Write-Host "   [WARN] 无效选项 '$bAns'，请输入 1 / 2 / 3 / R / 0（直接回车默认选 1）。" -ForegroundColor Yellow
            }
        }
    }
    if (-not $menuResolved) {
        Fail "无效的后端阈值菜单输入: $bAns" 5
    }
    Write-Host ""
}

function Test-AsarLocked([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $fs.Close()
        return $false
    } catch {
        return $true
    }
}

function Test-ProtectedEnvironment {
    return [bool]($env:ANTIGRAVITY_AGENT -or $env:ANTIGRAVITY_CONVERSATION_ID -or $env:ANTIGRAVITY_AGENTAPI_EXE -or $env:AGY_NO_KILL -eq '1')
}

function Get-TargetProcesses {
    return @(Get-Process -Name "Antigravity" -ErrorAction SilentlyContinue | Where-Object { $_.Path -and (($_.Path -like "$installDir\*") -or $_.Path.StartsWith("$installDir\", [System.StringComparison]::OrdinalIgnoreCase)) })
}

function Get-LanguageServerProcesses {
    return @(Get-Process -Name "language_server*" -ErrorAction SilentlyContinue | Where-Object { $_.Path -and (($_.Path -like "$installDir\*") -or $_.Path.StartsWith("$installDir\", [System.StringComparison]::OrdinalIgnoreCase)) })
}

function Stop-OrphanedSidecars([switch]$Quiet) {
    if (Test-ProtectedEnvironment) { return 0 }
    $procs = @(Get-TargetProcesses)
    if ($procs.Count -eq 0) { return 0 }
    # 若 language_server 仍在运行，说明宿主会话仍处于活动状态（含最小化到系统托盘）
    if (@(Get-LanguageServerProcesses).Count -gt 0) { return 0 }
    # 若任一进程拥有可见主窗口，说明主客户端仍在运行
    foreach ($p in $procs) {
        try { if ($p.MainWindowHandle -ne [IntPtr]::Zero) { return 0 } } catch {}
    }

    $cimMap = @{}
    try {
        $cimList = @(Get-CimInstance Win32_Process -Filter "Name = 'Antigravity.exe' OR Name = 'cmd.exe'" -ErrorAction Stop)
        foreach ($c in $cimList) { $cimMap[[int]$c.ProcessId] = $c }
    } catch {
        return 0
    }

    $sidecarPattern = 'sidecar_sdk[\\/]register_loader\.js|(?:^|[\s"\\\/])sidecars[\\\/]|mcp_entry\.cjs'
    $orphanProcs = @()
    $parentCmdPids = @()

    foreach ($p in $procs) {
        $cim = $cimMap[[int]$p.Id]
        if (-not $cim) { return 0 }
        $cmdLine = [string]$cim.CommandLine
        if ([string]::IsNullOrWhiteSpace($cmdLine)) { return 0 }
        # 任何带 --type= (gpu/renderer/utility) 或不匹配 Sidecar 特征的进程都视为活跃客户端进程（例如最小化到托盘）
        if (($cmdLine -match '--type=') -or ($cmdLine -notmatch $sidecarPattern)) {
            return 0
        }
        $orphanProcs += $p
        $ppid = [int]$cim.ParentProcessId
        if ($ppid -gt 0 -and $cimMap.ContainsKey($ppid)) {
            $parentCim = $cimMap[$ppid]
            if ($parentCim.Name -ieq 'cmd.exe' -and ([string]$parentCim.CommandLine -match 'agy-node\.cmd')) {
                $parentCmdPids += $ppid
            }
        }
    }

    if ($orphanProcs.Count -eq 0) { return 0 }

    foreach ($cmdPid in ($parentCmdPids | Select-Object -Unique)) {
        Stop-Process -Id $cmdPid -Force -ErrorAction SilentlyContinue
    }
    foreach ($op in $orphanProcs) {
        Stop-Process -Id $op.Id -Force -ErrorAction SilentlyContinue
    }
    $deadline = [DateTime]::UtcNow.AddMilliseconds(2000)
    while ([DateTime]::UtcNow -lt $deadline -and @(Get-TargetProcesses).Count -gt 0) {
        Start-Sleep -Milliseconds 100
    }
    if (-not $Quiet) {
        Write-Host "   [INFO] 已自动清理 $($orphanProcs.Count) 个上次退出残留的插件 Sidecar 进程。" -ForegroundColor Gray
    }
    return $orphanProcs.Count
}

function Wait-ProcessesExit([int]$TimeoutMs) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        $null = Stop-OrphanedSidecars -Quiet
        if (@(Get-TargetProcesses).Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 250
    }
    $null = Stop-OrphanedSidecars -Quiet
    return (@(Get-TargetProcesses).Count -eq 0)
}

# 3. 进程与文件锁
Write-Host "[2/4] 检查客户端运行状态与文件锁..."
if (-not $SkipProcessCheck) {
    $cleanedOrphans = Stop-OrphanedSidecars
    $closedClient = $false
    $procs = @(Get-TargetProcesses)
    if ($procs.Count -gt 0) {
        if (Test-ProtectedEnvironment) {
            Fail "检测到当前运行在 Antigravity 智能体会话中，拒绝关闭宿主客户端。请退出 Antigravity 后从桌面快捷方式运行。" 2
        }
        Write-Host "   [WARN] Antigravity 正在运行 ($($procs.Count) 个进程)。" -ForegroundColor Yellow
        $proceed = $Force.IsPresent
        if (-not $proceed) {
            if (-not (Test-Interactive)) { Fail "客户端正在运行且当前为非交互模式，请先退出客户端或使用 -Force。" 2 }
            $choice = [string](Read-Host "   [?] 是否请求 Antigravity 正常退出并继续？(请先保存工作) [Y/n]")
            $proceed = [string]::IsNullOrWhiteSpace($choice) -or ($choice.Trim().ToLower() -in @('y', 'yes'))
        }
        if (-not $proceed) { Write-Host "[INFO] 已取消。" -ForegroundColor Gray; exit 2 }

        Write-Host "   [INFO] 正在请求客户端正常退出..." -ForegroundColor Cyan
        foreach ($p in $procs) {
            try { if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $null = $p.CloseMainWindow() } } catch {}
        }
        if (-not (Wait-ProcessesExit 15000)) {
            Write-Host "   [WARN] 客户端在 15 秒内未退出（可能弹出了退出确认框）。" -ForegroundColor Yellow
            $kill = $Force.IsPresent
            if (-not $kill -and (Test-Interactive)) {
                $k = [string](Read-Host "   [?] 是否强制结束剩余的 Antigravity 进程？未保存的内容会丢失 [y/N]")
                $kill = ($k.Trim().ToLower() -in @('y', 'yes'))
            }
            if (-not $kill) { Fail "客户端仍在运行，已中止。" 2 }
            Get-TargetProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
            if (-not (Wait-ProcessesExit 5000)) { Fail "无法结束 Antigravity 进程。" 3 }
        }
        $closedClient = $true
        Write-Host "   [OK] 客户端已退出。" -ForegroundColor Green
    }

    # 若刚清理了残留的 Antigravity.exe Sidecar 或刚关闭客户端，可能解除/触发了后台等待的官方 NSIS 自动更新器 (autoInstallOnAppQuit)
    if ($isDefaultInstall) {
        if ($cleanedOrphans -gt 0 -or $closedClient) {
            Start-Sleep -Milliseconds 600
        }
        if (Wait-UpdaterComplete -AllowMissingGrace) {
            $null = Stop-OrphanedSidecars -Quiet
            $postUpdateProcs = @(Get-TargetProcesses)
            if ($postUpdateProcs.Count -gt 0 -and -not (Test-ProtectedEnvironment)) {
                foreach ($p in $postUpdateProcs) {
                    try { if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $null = $p.CloseMainWindow() } } catch {}
                }
                if (-not (Wait-ProcessesExit 8000)) {
                    Get-TargetProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
                    $null = Wait-ProcessesExit 3000
                }
            }
        }
    }

    for ($i = 0; $i -lt 20 -and (Test-AsarLocked $asarPath); $i++) { Start-Sleep -Milliseconds 150 }
    if (Test-AsarLocked $asarPath) { Fail "app.asar 仍被其他程序占用（安全软件/编辑器？），无法写入。" 3 }
    $lsProcs = @(Get-LanguageServerProcesses)
    $targetBackendProcs = @()
    if ($backendTargets.Count -gt 0) {
        $targetSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($bt in $backendTargets) { $null = $targetSet.Add($bt) }
        $targetBackendProcs = @(Get-Process -Name "language_server*", "agy*" -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -and (($_.Path -like "$installDir\*") -or $_.Path.StartsWith("$installDir\", [System.StringComparison]::OrdinalIgnoreCase) -or $targetSet.Contains([IO.Path]::GetFullPath($_.Path)))
        })
    } else {
        $targetBackendProcs = @($lsProcs)
    }
    if (-not $SkipBackendPatch -and $doBackend -and $targetBackendProcs.Count -gt 0) {
        if (Test-ProtectedEnvironment) {
            Fail "检测到当前运行在 Antigravity 智能体会话中，拒绝关闭宿主 language_server / agy。" 2
        }
        $targetBackendProcs | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300
    }
    Write-Host "   [OK] 文件锁检测通过。" -ForegroundColor Green
} else {
    Write-Host "   [INFO] 已跳过进程检查 (-SkipProcessCheck)。" -ForegroundColor Gray
}

# 4. 补丁（前端 ASAR + 后端 Go 1M 上下文与规则预算补丁）
if ($hasI18n) {
    Write-Host "[3/4] 正在注入汉化 v$localVer + 底栏 HUD..."
} else {
    Write-Host "[3/4] 正在注入底栏 HUD + 角色选择器 (纯 HUD 模式)..."
}
$nodeArgs = @($fastPatchJs, '--path', $asarPath, '--skip-process-check')
if (-not $hasI18n) { $nodeArgs += '--hud-only' }
if ($NoPlugins) { $nodeArgs += '--no-plugins' }
if (-not $hasI18n -or $NoUpdateCheck) { $nodeArgs += '--no-bg-sync' }
& node @nodeArgs
if ($LASTEXITCODE -ne 0) { Fail "补丁注入失败（退出码 $LASTEXITCODE），请查看上方错误详情与恢复指引。" 7 }

$backendPatched = $false
$backendRestored = $false
if (-not $SkipBackendPatch -and $hasBackend -and (Test-Path -LiteralPath $backendPatchJs)) {
    if ($doBackend) {
        $bpBaseArgs = @($backendPatchJs)
        foreach ($bt in $backendTargets) {
            $bpBaseArgs += @('--target', $bt)
        }
        if (-not $SkipProcessCheck -and -not (Test-ProtectedEnvironment)) {
            $bpBaseArgs += '--kill'
        }
        $targetNames = ($backendTargets | ForEach-Object { Split-Path -Leaf $_ }) -join ', '
        if ($doRestore) {
            Write-Host "[INFO] 正在恢复原版后端 ($targetNames)..." -ForegroundColor Cyan
            $restoreArgs = @($bpBaseArgs + @('--restore'))
            & node @restoreArgs
            if ($LASTEXITCODE -ne 0) { Fail "后端原版恢复失败（退出码 $LASTEXITCODE）。" 8 }
            $backendRestored = $true
        } else {
            Write-Host "[INFO] 正在应用后端 1M 上下文与规则补丁 ($targetNames | 阈值: $selectedLimit tokens)..." -ForegroundColor Cyan
            $applyArgs = @($bpBaseArgs + @('--context-limit', [string]$selectedLimit))
            & node @applyArgs
            if ($LASTEXITCODE -ne 0) { Fail "后端 1M 补丁应用失败（退出码 $LASTEXITCODE）。" 8 }
            $backendPatched = $true
        }
    } else {
        Write-Host "   [INFO] 已跳过后端 1M 补丁。" -ForegroundColor Gray
    }
}

# 5. 结果（防御补丁期间外部更新器异步覆盖/移除 app.asar）
if (-not $SkipProcessCheck -and $isDefaultInstall) {
    if (@(Get-UpdaterProcesses).Count -gt 0 -or -not (Test-Path -LiteralPath $asarPath)) {
        $null = Wait-UpdaterComplete -AllowMissingGrace
        if ((Test-Path -LiteralPath $swapOld) -and -not (Test-Path -LiteralPath $asarPath)) {
            Move-Item -LiteralPath $swapOld -Destination $asarPath -Force
        }
        if (Test-Path -LiteralPath $asarPath) {
            Write-Host "   [INFO] 检测到后台更新刚替换了客户端文件，正在为新版本重新注入补丁..." -ForegroundColor Cyan
            & node @nodeArgs
            if ($LASTEXITCODE -ne 0) { Fail "更新后重新注入前端补丁失败（退出码 $LASTEXITCODE）。" 7 }
            $backendTargets = @(Resolve-BackendTargets)
            if ($doBackend -and -not $doRestore -and $backendTargets.Count -gt 0) {
                $reBpArgs = @($backendPatchJs)
                foreach ($bt in $backendTargets) { $reBpArgs += @('--target', $bt) }
                if (-not (Test-ProtectedEnvironment)) { $reBpArgs += '--kill' }
                $reBpArgs += @('--context-limit', [string]$selectedLimit)
                & node @reBpArgs
                if ($LASTEXITCODE -ne 0) { Fail "更新后重新应用后端补丁失败（退出码 $LASTEXITCODE）。" 8 }
                $backendPatched = $true
            }
        }
    }
}
if ((Test-Path -LiteralPath $swapOld) -and -not (Test-Path -LiteralPath $asarPath)) {
    Move-Item -LiteralPath $swapOld -Destination $asarPath -Force
}
if (-not (Test-Path -LiteralPath $asarPath)) {
    Fail "未找到补丁后的目标文件: $asarPath（可能被外部安装程序或安全软件移除）" 7
}
if ($hasI18n) {
    Write-Host "[4/4] 终检已在补丁引擎内完成 (头部合法 + 双签名 + 指纹一致)。" -ForegroundColor Green
} else {
    Write-Host "[4/4] 终检已在补丁引擎内完成 (头部合法 + HUD 签名 + 指纹一致，已跳过汉化后台同步)。" -ForegroundColor Green
}
$sw.Stop()
$asarSizeMb = [Math]::Round((Get-Item -LiteralPath $asarPath).Length / 1MB, 2)
Write-Host "   [OK] 文件大小: $asarSizeMb MB | 总耗时: $($sw.ElapsedMilliseconds) ms" -ForegroundColor Green
Write-Host ""
$frontSummary = if ($hasI18n) { "汉化 v$localVer + 底栏 HUD" } else { "底栏 HUD + 角色选择器 (纯 HUD 模式)" }
if ($backendPatched) {
    $limitLabel = if (($selectedLimit % 1000) -eq 0) { "$($selectedLimit / 1000)K" } else { "$selectedLimit" }
    $backendSummary = " + 后端 1M 上下文补丁 (阈值 $limitLabel, $($backendTargets.Count) 个目标)"
} elseif ($backendRestored) {
    $backendSummary = " + 后端已恢复原版 256K ($($backendTargets.Count) 个目标)"
} else {
    $backendSummary = " (未修改后端二进制)"
}
Write-Host "[OK] ${frontSummary}${backendSummary} 就绪，请正常启动客户端。" -ForegroundColor Green
exit 0
