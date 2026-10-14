# macOS 构建与可用性说明

> 本目录是社区 fork 补丁的一部分：让「苏苏 AI超频」在 macOS 上可运行、可部署跨平台包，
> 并对 Windows 专属包给出明确阻断原因，而不是 `spawn powershell.exe ENOENT`。

## 包可用性（macOS）

| 包 | macOS | 说明 |
| --- | --- | --- |
| `cursor` | ✅ 原生可用 | 安装器是 `setup.py`，装 `~/.cursor/rules` 18 条规则 + `~/.cursor-shiyi-lazy/` |
| `claude` | ✅ 原生可用 | `install-claude.py inject`，CLAUDE.md 标记块 + rules + 86 个 SKILL.md，`verify` 全量校验 |
| `dsh` | ⚠️ 仅手动 | 官方安装器是 PowerShell / CMD；可用包内 `materials/` 与 `plugins/` 按 README 手动部署 |
| `opencode` / `workbuddy` / `workbuddy-ai` | ❌ 仅 Windows | 安装器为 `ps1` / `cmd`，且载荷内含 Windows 专属组件 |
| `codex` / `codex-panghu` / `anti-gravity`（已隔离） | ❌ 仅 Windows | 同上；隔离策略与知情同意逻辑在 macOS 上照常生效 |

在非 Windows 平台上，这些包会在包卡片上显示「仅支持 Windows」并禁用安装 / 卸载按钮；
即使绕过 UI 直接调用 IPC，`buildSpawn()` 也会抛出同样的可读原因。

## 构建

前置：macOS（Intel x64 已实测；Apple Silicon 请换 `darwin-arm64` 运行时）、`node`、`ditto`、`codesign`（Xcode CLT）。

### 1. 准备官方 Electron 运行时

版本必须与应用构建时一致（v1.5.7 为 **44.4.3**）：

```bash
curl -LO https://github.com/electron/electron/releases/download/v44.4.3/electron-v44.4.3-darwin-x64.zip
```

### 2. 从官方便携版提取 resources

```bash
# 便携版 EXE 是 NSIS 自解压：先取出 app-64.7z，再解出 resources/
7z x SusuAIOverclock-1.5.7-portable.exe '$PLUGINSDIR/app-64.7z'
7z x app-64.7z resources -o./resources
# 需要：resources/app.asar、resources/packs、resources/library
```

### 3. 组装

```bash
npm run build:mac -- --resources ./resources --electron-zip ./electron-v44.4.3-darwin-x64.zip
# 或
bash macos/build-macos.sh --resources ./resources --electron-zip ./electron-v44.4.3-darwin-x64.zip --out ./release/mac
```

脚本会：解压运行时 → 改名 → 注入 `app.asar` / `packs` / `library` → 写 `CFBundleDisplayName` / 版本 / Bundle ID
→ 写 `LSEnvironment`（`DANGO_PYTHON`、`PATH`）→ `xattr -cr` → ad-hoc `codesign` → 输出 `.app`。

### 4. 安装

```bash
ditto "release/mac/苏苏 AI超频.app" "/Applications/苏苏 AI超频.app"
open "/Applications/苏苏 AI超频.app"
```

## 运行注意

- **`DANGO_PYTHON`**：`cursor` / `claude` 包的安装器是 Python。脚本默认写 `~/.pyenv/shims/python3`（存在时），
  否则用 `command -v python3` 的结果；也可以自己指定：`DANGO_PYTHON=/path/to/python3 npm run build:mac -- ...`。
  应用内解析顺序：`DANGO_PYTHON` → `PATH` 上的 `python3` → `python`。
- **签名**：ad-hoc 签名（`codesign --force --deep --sign -`）足以在本机运行；
  首次打开若被 Gatekeeper 拦下，右键 →「打开」，或 `xattr -cr` 后再开。
- **升级**：应用内「检查更新」走的是官方 Windows 渠道，macOS 上请手动重新组装。

## 本目录带来的源码改动

| 文件 | 改动 |
| --- | --- |
| `electron/core.cjs` | `buildSpawn()` 平台守卫（`ps1`/`cmd` 仅 Windows，抛可读原因）；`resolvePythonBin()` 非 Windows 探测 `python3`；新增 `findOnPath()`；新增 `WINDOWS_ONLY_PACKS` / `MAC_APP_BUNDLES` / `packPlatformBlockReason()`；`detectPlatform()` 增加 `/Applications/*.app` 证据（只写入 `macApp`，不写 `exePath`） |
| `electron/main.cjs` | 包卡片 / 导入分析在非 Windows 上显示平台阻断原因；spawn `ENOENT` 兜底为可读错误 |
| `tests/core.test.cjs` | 平台阻断与 `resolvePythonBin` 的回归测试（按平台自动跳过） |
| `package.json` | `npm run build:mac` 入口 |

## 已知限制

- 深度验证的 L4「会话层」在 macOS 上对 GUI 类客户端仍可能跳过或走客户端通道（与 Windows 行为一致）；
  `cursor` / `claude` 的文件层（L1）与配置层（L2）校验完整可用。
- 应用图标沿用 Electron 默认图标（打包 `build/` 里的 `.icns` 需另行生成）。
- `darwin-arm64` 运行时未实测（脚本层面无差异，替换 zip 即可）。

## 实测记录（v1.5.7，2026-10-14）

- 组装产物：760 MB `.app`，`codesign -v` 通过，正常启动（主进程 + GPU + 网络 + 渲染进程齐全）。
- `cursor` 包：18 条规则写入沙箱根，`check` 通过。
- `claude` 包：`inject` 写入 88 个文件，`verify` 88/88 通过。
- 修复前：安装隔离的 Codex 旧载荷报 `Error invoking remote method 'dango:deploy': Error: spawn powershell.exe ENOENT`；
  修复后：包卡片直接显示「仅支持 Windows」并禁用按钮。
