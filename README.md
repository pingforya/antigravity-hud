# Antigravity HUD & Thinking Inspector

Antigravity 客户端全链路遥测 HUD（顶部 Token 统计胶囊 + 输入框底栏上下文水位胶囊）、思考链监控侧边栏、新聊天角色切换器、Go 后端 1M 上下文补丁引擎与可选 [antigravity-chinese](https://github.com/yiheng8023/antigravity-chinese) 汉化协同工具链。

## 核心特性

### 1. 窗口顶部 Token 统计胶囊 (Topbar Telemetry Capsule)
- **实时多维度汇总**：在客户端顶部居中胶囊实时展示 **今日 / 近 7 天 / 近 28 天 / 历史累计** 的 Token 消耗排行（按模型拆分、含缓存命中率、主会话与子代理拆分）。
- **低开销按需刷新**：通过主进程 IPC 按需读取本地会话日志与 SQLite 元数据，不占用渲染进程轮询带宽。

### 2. 输入框底栏 HUD 胶囊与新聊天角色选择器 (Composer Footer HUD & Persona Switcher)
- **Position A 内嵌胶囊** (`.agy-composer-footer`)：内嵌显示当前会话上下文水位（`currentContext / contextLimit` 与百分比）、缓存命中率、最新生成速率 (`tok/s`)、模型推理 vs 工具执行耗时拆分以及压缩次数提示。
- **按会话独立的角色切换** (`core/new-chat-persona.js` + `persona-mode.cjs`)：
  - 在新聊天输入框提供原生风格胶囊选择器（支持 `哈基米` / `正常助手`），通过 `StartCascade` 请求/响应双向绑定与 Turn-0 队列票据机制，确保多窗口并发创建新聊天时互不串台，且严格隔离 Worker 子代理会话。

### 3. 辅助侧边栏遥测与思考链面板 (Auxiliary Pane Sidecar)
- **独立插件即可运行**：`plugins/agy-hud` 部署后，无需修改客户端 `app.asar` 即可通过 `hooks.json` (`PreInvocation` / `PostInvocation` / `Stop`) 记录毫秒级步骤耗时，并在 Sidecar Web UI (`ui.html`) 中查看上下文水位、Top 消耗步骤排行与完整思考链（Thinking Chain）。
- **轻量化短连接轮询**：采用 `/api/hud/live` + `ETag` (`304 Not Modified`) + 页面隐藏自动暂停机制，避免 `EventSource` 长连接耗尽浏览器同源连接池。

### 4. Go 后端 1M 上下文与规则预算补丁 (`core/backend-patcher.cjs`)
- **纯 Node.js Go `pclntab` 动态定位**：支持 Windows PE (`x86_64` / `arm64`)、Linux ELF (`x86_64` / `arm64`)、macOS Mach-O (`arm64`) 的 `language_server` / `agy` 二进制。
- **动态跳板注入**：将默认 `256,000` tokens 自动压缩阈值提升至自定义水位（默认 `512,000`，可选 `734,000` 或 `256,001..1,048,576`），同时将单条规则文件字节上限由 `24 KB` 提升至 `1 MiB` (`1,048,576` bytes)，规则与自定义配置总预算由 `20,000` 提升至 `131,072` tokens。
- **可逆备份**：首次打补丁前自动在 `~/.gemini/agy-patches` 生成原版校验备份与清单，支持一键无损恢复 (`restore-backend`)。

### 5. 极速内存 ASAR 补丁引擎 (`fast-patch.cjs`)
- **毫秒级零解包重打包**：直接解析 Chromium Pickle 头部并在内存中重写目标文件与 SHA-256 块完整性校验，完整保留 `app.asar.unpacked` 布局。
- **原子替换与自动回滚**：维护纯净基准 `app.asar.bak`、检查 Electron `EnableEmbeddedAsarIntegrityValidation` Fuse 位、双签名后置终检，失败自动回滚 `app.asar.swap-old`。
- **上游安全信任门控**：可选配合 `antigravity-chinese` 仓库注入汉化词库，且仅在本地 `HEAD` 与用户显式确认 (`--apply <sha>`) 的 `approvedHead` 一致时才加载上游脚本，否则自动回退到内置本地替换规则。

### 6. Swarm 协作面板离线简体中文补丁 (`core/swarm-zh-patch.cjs` + `plugins/swarm-zh/`)
- **100% 离线零密钥消耗**：直接汉化 Antigravity 内置 `swarm_board` Sidecar 面板（概览、看板、成员、关系图、原始数据页签及状态提示/筛选/回放/工具栏），内置 Tier-1 确定性协议标签与活动描述汉化（`[done]` → `[已完成]`、`[stall]` → `[停滞告警]` 等），默认不发起任何外网或 API Key 调用。
- **单模式清爽顶栏与双语搜索**：去除冗余的顶栏语言切换栏，直接以简体中文呈现界面与原生中文看板消息，同时保留看板/成员页的中英文双语检索与无损 `原始数据` 查看。
- **可校验、可同步、可无损还原**：使用 `plugins/swarm-zh/manifest.json` 校验全部 7 个受管文件 SHA-256，支持客户端更新覆盖后的自动检测与重打补丁（`patch-swarm` / `verify-swarm` / `sync-swarm` / `restore-swarm`），外部备份存放在 `~/.gemini/agy-patches/swarm-zh`。

---

## 架构概览

```text
+-------------------------------------------------------------------+
| Antigravity Client (Electron)                                     |
|  +---------------------------+  +------------------------------+  |
|  | Renderer (dist/preload.js)|  | Auxiliary Pane (Sidecar UI)  |  |
|  | - Topbar Token Capsule    |  | - ui.html (Token-protected)  |  |
|  | - Composer Footer HUD     |  | - Thinking Chain & Step Cost |  |
|  | - New Chat Persona Pill   |  +--------------+---------------+  |
|  +-------------+-------------+                 | HTTP (127.0.0.1) |
|                | Electron IPC                  v                  |
|                | (agy-hud:*)    +------------------------------+  |
|  +-------------v-------------+  | Sidecar Server (server.mjs)  |  |
|  | Main (dist/ipcHandlers.js)|  | - Host validation, no CORS   |  |
|  | - Hot-reloads plugin scripts | - /healthz LS liveness probe |  |
|  +-------------+-------------+  +--------------+---------------+  |
+----------------|-------------------------------|------------------+
                 | reads                         | reads/writes
                 v                               v
+-------------------------------------------------------------------+
| Local Data & Telemetry (~/.gemini/)                               |
| - brain/<convId>/.system_generated/logs/transcript_full.jsonl     |
| - conversations/<convId>.db (SQLite gen/executor metadata)        |
| - antigravity/sidecar_data/agy-hud/telemetry/data/                |
|   (timing_*.jsonl, persona_<id>.json, pending_new_chats.json)     |
+-------------------------------------------------------------------+
                 ^
                 | writes (PreInvocation / PostInvocation / Stop)
+----------------+--------------------------------------------------+
| Go Backend (language_server / agy) + hud-hook.cjs                 |
| - Patched via core/backend-patcher.cjs (1M context & 1MiB rules)  |
+-------------------------------------------------------------------+
```

### 目录结构

```text
antigravity/
├── cli.js                        # 主 CLI 管理工具 (inspect/daily/install/patch-backend)
├── fast-patch.cjs                # 内存级 ASAR 补丁引擎与完整性终检
├── unified-patch.cjs             # 前端/IPC + 插件快捷补丁入口
├── apply-new-chat-persona.cjs    # 新聊天角色选择器与 HUD 注入脚本
├── bg-sync-i18n.cjs              # 上游 antigravity-chinese 只读 fetch 检查与 SHA 快进
├── paths.cjs                     # 共享路径解析 (支持 AGY_CHINESE_ROOT 覆盖)
├── patch.ps1 / patch.bat         # Windows 一键交互式修复脚本 (进程检测/更新等待/前后端补丁)
├── core/
│   ├── telemetry-parser.cjs      # 会话日志、SQLite protobuf 元数据与每日统计解析器
│   ├── backend-patcher.cjs       # 跨平台 Go pclntab 解析与 1M 上下文二进制补丁引擎
│   ├── swarm-zh-patch.cjs        # 内置 Swarm 面板中文补丁、SHA-256 校验与外部备份恢复引擎
│   ├── hud-runtime.js            # 注入渲染进程的 Topbar + Composer Footer HUD 运行时
│   └── new-chat-persona.js       # 注入渲染进程的新聊天角色选择器与 StartCascade 钩子
├── plugins/agy-hud/
│   ├── plugin.json               # 插件清单 (可独立安装使用 Hooks + Sidecar 面板)
│   ├── hooks.json                # 声明式 Hook 配置 (仅 PreInvocation/PostInvocation/Stop)
│   ├── assets/                   # 角色提示词模板 (hakimi.md / hakimi-memory.md)
│   ├── scripts/                  # hud-hook.cjs, persona-mode.cjs, telemetry-parser.cjs
│   └── sidecars/telemetry/       # Sidecar HTTP 服务 (server.mjs) 与前端面板 (ui.html)
├── plugins/swarm-zh/             # 内置 Swarm 面板简体中文补丁资源包 (manifest.json + 7 个受管文件)
├── reference/                    # Python 参考实现 (fix_antigravity_context.py, verify_session.py)
└── test/                         # 单元测试 + Swarm 翻译/UI/补丁测试 + Chromium E2E 套件 (e2e-swarm/)
```

---

## 环境要求

- **Node.js**：推荐 **Node.js >= 22.5**（内置 `node:sqlite`，用于无锁读取会话 `.db` 元数据与运行完整测试）；基础插件与 ASAR 补丁最低支持 **Node.js >= 18.0.0**。
- **可选上游汉化仓库**（`antigravity-chinese`）：
  - **独立开箱即用**：若本地未克隆 `antigravity-chinese`（或显式传入 `--hud-only`），`cli.js install`、`fast-patch.cjs` 与 `patch.ps1` 会自动以 **纯 HUD + 角色选择器模式** 注入客户端，无需任何外部词库。
  - **一体化汉化协同**：若同级目录存在 `../antigravity-chinese`（兼容 `../1/antigravity-chinese`，或通过 `AGY_CHINESE_ROOT` 指定路径），则自动合并注入中文词库与运行时性能优化补丁。
  - 上游仓库地址：`https://github.com/yiheng8023/antigravity-chinese.git`

---

## 快速开始与 CLI 参考

### Windows 一键修复 (推荐)
双击运行 `patch.bat`，或在 PowerShell 中执行：
```powershell
.\patch.ps1
```
常用参数：
- `-CustomAsarPath <path>`：指定自定义安装目录或 `app.asar` 路径
- `-ContextLimit <tokens>`：直接指定后端自动压缩阈值（如 `512000` / `734000`，范围 `256001..1048576`）
- `-SkipBackendPatch` / `-RestoreBackend`：跳过后端补丁或恢复原版 256K 后端
- `-Force` / `-SkipProcessCheck`：非交互强制关闭客户端或跳过进程检测
- `-ApplyUpdates` / `-NoUpdateCheck`：自动应用待确认上游更新或跳过更新检查

### 跨平台 CLI (`cli.js`)

```bash
# 查看插件、客户端 ASAR、Go 后端状态与最新会话实时遥测
node cli.js inspect
node cli.js inspect <conversation-uuid> --path /path/to/Antigravity

# 查看每日各模型 Token 消耗统计
node cli.js daily
node cli.js daily --days 14 --date 2026-11-05

# 仅部署/更新独立插件 (Hooks + Sidecar 面板，不修改客户端 app.asar)
node cli.js install-plugin

# 部署插件并注入客户端 app.asar (需先关闭 Antigravity 客户端)
node cli.js install
node cli.js install --hud-only
node cli.js install --path /path/to/Antigravity

# 修补 / 校验 / 同步 / 恢复 Swarm 协作面板中文补丁
node cli.js verify-swarm --json
node cli.js patch-swarm
node cli.js sync-swarm
node cli.js restore-swarm
node fast-patch.cjs --swarm-only

# 修补 / 恢复 Go 后端 1M 上下文与规则预算 (Windows / macOS / Linux)
node cli.js patch-backend --context-limit 512000
node cli.js patch-backend --path /path/to/language_server --context-limit 734000
node cli.js restore-backend

# 查看完整帮助
node cli.js --help
```

也可以通过 `npm scripts` 调用：
```bash
npm run inspect
npm run daily
npm run install-plugin
npm run install-all
npm run patch-swarm
npm run verify-swarm
npm run sync-swarm
npm run restore-swarm
npm run patch-backend
npm run restore-backend
```

---

## 环境变量说明

| 环境变量 | 作用 | 默认值 |
| --- | --- | --- |
| `AGY_CHINESE_ROOT` | 指定可选 `antigravity-chinese` 仓库本地路径 | 自动探测 `../antigravity-chinese` 或 `../1/antigravity-chinese` |
| `AGY_HUD_PLUGIN_DIR` | 指定全局插件部署与主进程热重载读取目录 | `~/.gemini/config/plugins/agy-hud` |
| `AGY_HUD_DATA_DIR` | 指定计时日志 (`timing_*.jsonl`) 与角色状态 (`persona_*.json`) 目录 | `~/.gemini/antigravity/sidecar_data/agy-hud/telemetry/data` |
| `AGY_BRAIN_DIR` | 指定 Antigravity 会话日志 (`brain/`) 根目录 | `~/.gemini/antigravity/brain` |
| `AGY_HUD_MEMORY_FILE` | 覆盖 `hakimi-memory` 提示词读取文件路径 | 插件目录下 `assets/hakimi-memory.local.md` 或 `hakimi-memory.md` |
| `AGY_HUD_DEFAULT_PERSONA` | 覆盖新聊天与未标记历史聊天的默认角色 (`hakimi` 或 `normal`，前后端全链路同步) | `hakimi` |
| `AGY_HUD_SIDECAR_TOKEN` | 自定义独立模式下的 Sidecar API 鉴权令牌（宿主内默认复用 `ANTIGRAVITY_SIDECAR_UI_TOKEN` 保护写操作） | 空（由宿主网关保护） |

---

## 安全与隐私模型

1. **纯本地回环 Sidecar (`127.0.0.1`)**：`server.mjs` 仅绑定系统分配的随机回环端口（不再监听固定端口），严格校验 `Host` 头防 DNS 重绑定攻击，不发送任何 `Access-Control-Allow-Origin` CORS 头。
2. **认证令牌与写保护**：Sidecar API 读取与修改请求需携带启动时生成的随机令牌 (`X-Sidecar-Token`) 与显式请求头 (`X-AGY-Persona: 1`)，并校验 `conversationId` 为合法 UUID（防止路径穿越）。
3. **进程内仅走 Electron IPC**：客户端内嵌 HUD (`hud-runtime.js` / `new-chat-persona.js`) 仅通过 `ipcRenderer.invoke('agy-hud:*')` 与主进程通信，主进程校验发送方 (`isTrustedTopSender`)，拒绝来自 `<webview>` 或非主帧的请求。
4. **不在磁盘冗余落盘思考链**：`hud-hook.cjs` 仅记录轻量毫秒级时间戳事件，不再将完整思考链副本写入 `live_telemetry.json` 或 `conv_*.json`。
5. **本地覆盖文件隔离**：`plugins/agy-hud/assets/hakimi-memory.local.md` 已被 `.gitignore` 忽略，且 `cli.js install-plugin` 在同步插件时会自动保留已存在的 `.local.md` 个人配置。

---

## 测试

安装开发依赖（`jsdom`、`@electron/asar`）并运行完整测试套件（包含 `test/verify.js`、HUD/角色单测及 Swarm 补丁/翻译/UI 单测；在无本地 Antigravity 客户端或 `app.asar.bak` 的 CI 环境中，宿主相关项会自动 `[SKIP]` 并保持零失败）：

```bash
npm install
npm test
```

也可以单独运行 Swarm 实机 Chromium E2E 回归测试（148 项）：

```bash
node test/e2e-swarm/run-all.mjs
```

---

## 许可证

[MIT](LICENSE) © 2026 Antigravity Community
