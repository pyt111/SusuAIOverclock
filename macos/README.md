# macOS 构建与可用性说明

> 本目录是 **macos 分支** 的核心：让「苏苏 AI超频」在 macOS 上可运行、可部署跨平台包与 mac 移植包，
> 并对仍然只能跑在 Windows 的包给出明确阻断原因，而不是 `spawn powershell.exe ENOENT`。

## 架构：mac 移植安装器（install-macos.mjs）

官方安装器是 PowerShell / CMD，macOS 上无法运行（系统没有 `powershell`）。mac 分支的做法：

1. **`macos/installers/<包>/install-macos.mjs`** —— Node 实现的等价安装器（零依赖，仅用内置模块，含 `--uninstall` / `--dry-run`）；
2. **组装脚本**（`macos/build-macos.sh`）把它复制进 `Resources/packs/<包>/`；
3. **应用侧接线**（`electron/core.cjs` 的 `MAC_DEPLOY_PLANS` + `macInstallerPresent()`）：
   非 Windows 平台上，只要包目录里存在 `install-macos.mjs`，`deployPlanFor(id, packPath)` 就返回 mac 计划，
   `buildSpawn()` 生成 `node install-macos.mjs --pack . …` 命令（解释器：系统 `node` → 兜底 Electron 自带 Node + `ELECTRON_RUN_AS_NODE=1`）；
4. **Windows 上始终走官方 ps1 / cmd**，不受影响。

没有 mac 安装器的包，仍然按原策略在卡片上显示原因并禁用按钮；即使绕过 UI 直接调用 IPC，`buildSpawn()` 也会抛出同样的可读原因。

## 包可用性（macOS）

| 包 | macOS | 说明 |
| --- | --- | --- |
| `cursor` | ✅ 原生可用 | 安装器是 `setup.py`，装 `~/.cursor/rules` 18 条规则 + `~/.cursor-shiyi-lazy/` |
| `claude` | ✅ 原生可用 | `install-claude.py inject`，CLAUDE.md 标记块 + rules + 86 个 SKILL.md，`verify` 全量校验 |
| `dsh` | ✅ 移植安装器 | `macos/installers/dsh/install-macos.mjs`（PowerShell 安装器的 Node 等价实现） |
| `opencode` | ✅ 移植安装器 | `macos/installers/opencode/install-macos.mjs`（配置合并 + 对 mac 版 asar 打补丁） |
| `workbuddy` / `workbuddy-ai` | ❌ 仅 Windows | 安装器为 `ps1` / `cmd`，且载荷内含 Windows 专属组件 |
| `codex`（已隔离） | ✅ 移植安装器 | `macos/installers/codex/install-macos.mjs`（`install-replica.ps1` 的 Node 等价实现）；**仍需勾选知情同意**才解锁 |
| `codex-panghu` / `anti-gravity`（已隔离） | ❌ 仅 Windows | 安装器与载荷均为 Windows 专属；隔离策略与知情同意逻辑在 macOS 上照常生效 |

在非 Windows 平台上，仍属 Windows 专属的包会在包卡片上显示「仅支持 Windows」并禁用安装 / 卸载按钮。

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

脚本会：解压运行时 → 改名 → 注入 `app.asar` / `packs` / `library` → **注入 mac 移植安装器（`macos/installers/<包>/` → `packs/<包>/`）**
→ 写 `CFBundleDisplayName` / 版本 / Bundle ID → 写 `LSEnvironment`（`DANGO_PYTHON`、`PATH`）→ `xattr -cr` → ad-hoc `codesign` → 输出 `.app`。

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
| `electron/core.cjs` | `buildSpawn()` 平台守卫（`ps1`/`cmd` 仅 Windows，抛可读原因）；`resolvePythonBin()` 非 Windows 探测 `python3`；`resolveNodeBin()`（系统 `node` → Electron 自带 Node）；`findOnPath()`；`WINDOWS_ONLY_PACKS` / `MAC_APP_BUNDLES` / `MAC_DEPLOY_PLANS` / `macInstallerPresent()` / `packPlatformBlockReason(id, packPath)`；`deployPlanFor(id, packPath)` 优先 mac 计划；`detectPlatform()` 增加 `/Applications/*.app` 证据（只写入 `macApp`，不写 `exePath`） |
| `electron/main.cjs` | 包卡片 / 导入分析在非 Windows 上显示平台阻断原因（传入 packPath 判定）；spawn `ENOENT` 兜底为可读错误；子进程环境合并 `sp.env`（mac 安装器解释器需要） |
| `macos/installers/<包>/install-macos.mjs` | mac 移植安装器（dsh / opencode / codex），含 `--uninstall` / `--dry-run` / `--pack` / 独立测试目录支持 |
| `macos/build-macos.sh` | 组装 + 注入 mac 安装器 + LSEnvironment + ad-hoc 签名；退出清理临时目录 |
| `tests/core.test.cjs` | 平台阻断 / mac 计划选择 / `buildSpawn` 守卫 / `resolvePythonBin` 回归测试（按平台自动跳过） |
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
- mac 安装器（dsh）：`selftest.sh` 全流程 ALL PASS（安装 / 幂等重装 / 卸载回滚 / 重装）；应用内 `dango:detect` 返回 `installFile=install-macos.mjs`，卡片三按钮可用；应用资源内 `--dry-run` 演练识别真实运行时 0.2.1-alpha.1、零写入。
- mac 安装器（opencode）：对 OpenCode.app 副本打补丁 **3598/3598 逐文件校验通过**、幂等、`--uninstall` 还原到与原版逐字节一致；真实 `/Applications/OpenCode.app` 的 sha256 与代码签名未被改动。
