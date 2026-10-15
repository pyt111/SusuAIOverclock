# Codex 破甲包（eni-solo 4.0.0 replica）· macOS 安装器

`install-macos.mjs` 是 `packs/codex/install-replica.ps1`（1893 行）与 `packs/codex/Uninstall.ps1`（212 行）
的等价 Node 实现：**纯 Node 内置模块、零外部依赖、Node ≥ 18**，`chmod 755` 后可直接执行，
输出为中文并按 `[n/9]` 阶段推进，支持 `--dry-run` 零写入预览。

用途：让「苏苏 AI超频」macOS 分支在无 PowerShell 的系统上部署 Codex 破甲包
（AGENTS.md 标记块合并 / hooks.json 注入 / ishii_auto_route 路由钩子 / 107 个技能包 /
prompts / eni-solo manifest / slo-runtime / hook 信任同步 / 安装清单），并按备份精准回滚。

## 用法

```bash
node install-macos.mjs --pack <包目录> --codex-home <Codex 配置根> [选项]
./install-macos.mjs --help          # 全部选项
```

Electron 侧调用口径（与 Windows 分支一致）：

```bash
node install-macos.mjs --pack . --no-open-links --skip-astra6     # 安装（cwd = 包目录）
node install-macos.mjs --pack . --uninstall                       # 卸载
```

| 选项 | 说明 |
| --- | --- |
| `--pack <目录>` | 破甲包根目录（含 `materials/`、`codex-namespace-fix/`、`Sync-HookTrust.py`）。默认按脚本位置自动推导（见下） |
| `--codex-home <目录>` | Codex 配置根。默认 `$CODEX_HOME`，未设置时 `~/.codex` |
| `--python <路径>` | python3 解释器（默认在 PATH 上找 `python3`，再退 `python`） |
| `--force` | 检测到交互式 codex 进程时仍继续（**任何情况下都不 kill 进程**） |
| `--no-open-links` | 不自动打开官网 / 加群链接（仅打印） |
| `--skip-astra6` | 跳过 Astra6 号池中间件（v1 未移植；保留参数以对齐 Windows 侧默认） |
| `--uninstall` | 卸载（按备份 + 标记双路精准回滚） |
| `--purge` | 卸载时额外清理 `backups/eni-solo-*`、安装清单、过期状态文件（= `Uninstall.ps1 -PurgeAll`） |
| `--dry-run` | 只打印将执行的操作，**零写入**（含不生成 backup / manifest / trust 记录） |
| `--help` | 帮助 |

`--pack` 默认推导顺序：显式参数 → 脚本所在目录 → 逐级向上找 `<root>/packs/codex` →
同级 `02-源码/<版本>/packs/codex`、`source/<版本>/packs/codex`、`src/<版本>/packs/codex`。
两条常见布局都能零参数命中：打包后（脚本被拷进 `Resources/packs/codex/`）与开发期（fork 仓库与源码包同级）。

## 阶段对照（install-replica.ps1 → install-macos.mjs）

| ps1 阶段 | mjs 实现 |
| --- | --- |
| 环境预检（materials / python / 进程） | `[preflight]`；进程检测改写为 `ps -axo pid=,ppid=,command=`，并把常驻 `app-server` 当「无需退出」忽略 |
| `[1]` 备份目录 | `backups/eni-solo-4.0.0-replica-<stamp>/`（**只新增自己的子目录**，不动 `backups/` 其它内容） |
| `[1.5]` codex_app namespace fix（app.asar） | 同；mac 候选为 `/Applications/*Codex*.app`、`~/Applications/*Codex*.app`；未探测到即跳过；改前自动 `.bak-codexapp-<stamp>` |
| `[2]` config.toml（只备份、不改） | 同：只记 sha256 + 备份，`config_toml_modified_by_this_install=false` |
| `[3]` AGENTS.md 标记块合并 | `mergeMarkedBlock` 逐行移植（见下） |
| `[4]` hooks.json 合并 | `mergeHooksJson`（见下） |
| `[5]` hooks 脚本 / prompts / eni-solo / models.json | 同 |
| `[5.5]` tools | 同（`materials/tools` 不存在即跳过） |
| `[6]` skills 分段安装 | 同：先 stage 到 `.eni-solo-stage-*` 再原子换位；**符号链接按链接本身移动**（不解引用） |
| `[7]` slo-runtime / ColdBrew | 同；`ColdBrew` 不存在即跳过 |
| `[7.x]` astra6 号池中间件 | **未移植**（Windows 专属），`--skip-astra6` 为默认，打印 skip 说明 |
| `[8]` hook trust sync（app-server oracle） | 同；见「helper 差异」 |
| `[9]` 部署完整性自检 + manifest | 同；manifest 字段逐字对齐（见下） |

卸载（Uninstall.ps1 → `--uninstall`）：`[1/5]` 定位最近备份 → `[2/5]` 逐项回滚 →
`[3/5]` config.toml 管理块剥离（兜底）→ `[4/5]` hooks.json 注入条目移除 →
`[5/5]` `--purge` 深度清理。回滚前一律先生成 `backups/pre-uninstall-<stamp>` 安全备份。

## 安装清单（manifest）字段

落盘于 `<codexHome>/eni-solo-replica-install-manifest-<stamp>.json`，字段与原版逐字一致：

```json
{
  "name": "eni-solo",
  "version": "4.0.0",
  "replica_of": "sha256-r2-mixed-pinned-2b50f93a8d7716b5",
  "installed_at": "2026-10-14T09:05:54.470Z",
  "codex_home": "/Users/<you>/.codex",
  "installed_skills": 107,
  "hooks_installed": true,
  "astra6_pool_patch": false,
  "config_toml_sha256": "<目标 config.toml 的 sha256>",
  "config_toml_modified_by_this_install": false,
  "l1_pointer_scan": "shallow-scan (top-level only, for report; writes go through v13 engine)",
  "backup": "<codexHome>/backups/eni-solo-4.0.0-replica-<stamp>",
  "notes": [
    "AGENTS.md/hooks/skills/runtime deployed; user config.toml and models.json preserved",
    "non-invasive mode: user model/provider/login/config are never modified",
    "restart Codex to activate"
  ]
}
```

结束时打印 `DONE. Restart Codex to activate.` 与 `Install manifest: <path>`，退出码 0。

## 与 Windows 原版的差异清单

| # | 项 | Windows 原版 | macOS 版 | 原因 |
| --- | --- | --- | --- | --- |
| 1 | **换行符** | 新块一律 CRLF（`WriteAllText` 显式 `\r\n`） | **LF**；目标文件已有 CRLF 则沿用其 CRLF | macOS 惯例；对已存在的文件不改变其风格，避免整文件 diff |
| 2 | **Astra6 号池中间件** | 安装（`pool_proxy.py` / `patch_pool.py` / 多盘符扫描） | **未移植**，默认 `--skip-astra6` | Windows 专属实现（盘符枚举 + Windows 侧代理注册），macOS 无对应面 |
| 3 | **slo-runtime 钩子注册** | 注册 `slo-runtime-hook.ps1` / `.exe` | 只铺开运行时目录与 `hook-activation.json`，**不注册钩子** | `slo-runtime-hook.exe` 是 Windows PE，macOS 无法执行 |
| 5 | **ns 补丁调用** | 脚本内部自动探测（`_proc_asars` / 盘符扫描） | 安装器以 `--asar <探测到的路径> --auto` 显式调用；未探测到即跳过 | 原脚本的自动探测是 Windows 逻辑，显式入口跨平台可用，故不改脚本本体 |
| 6 | **hook 信任同步** | `Sync-HookTrust.py`（要求 `codex.exe`） | 优先用 `helpers/Sync-HookTrust-macos.py`，缺失则回退包内原脚本 | 原脚本 `_exe_ok` 要求 `.exe`，在 mac 上必然退出 3（详见下） |
| 7 | **进程检测** | `Get-Process` / `.Path` | `ps -axo pid=,ppid=,command=` + 常驻子进程识别 | 无 PowerShell；`app-server` 常驻不能误判为「交互式 Codex 在跑」 |
| 8 | **robocopy 语义** | `/E` 目录复制 | `fs.cpSync(..., {recursive:true, dereference:false})` | 保持**符号链接为链接**（真实 `~/.codex/skills/` 有指向 `~/.agents/skills/*` 的链接） |
| 9 | **原子写** | `WriteAllText` | 同目录临时文件 + `rename`（POSIX 原子） | 避免半写文件；对符号链接目标拒绝直写 |
| 10 | **skills 回滚路径** | Uninstall 从 `backup/skills/<name>` 取 | 从**实际落盘布局** `backup/<name>` 取 | ps1 的 install 写扁平 `backup/<name>`，Uninstall 却查 `backup/skills/<name>` —— 该路径从不存在，Windows 版实际不会恢复技能。mac 版按真实布局修正 |
| 11 | **时间戳** | `yyyyMMdd-HHmmss-fff`（本地时区） | 同格式、同语义（本地时区 + 毫秒） | 目录名与 Windows 版一致，便于跨端对照 |
| 12 | **`--force`** | 提示「先退出 Codex」并可强推 | 同，但**永不 kill / 重启**任何 codex 进程 | 主动作恶面更大，交给用户自行重启 |
| 13 | **dry-run** | 无 | **新增** `--dry-run`，零写入 | 便于 CI / 打包前自检；也是本仓库要求 |
| 14 | **`SKILL.md` 的 UTF-8 BOM** | 不处理（`install-replica.ps1` 从不调用包自带的 `Fix-SkillFrontmatter.ps1`） | 技能部署前就地剥离（只删前 3 字节，原子替换，不跟随符号链接） | 包自带 3 个带 BOM 的 `SKILL.md`；codex 严格要求首字符是 `---`，否则报 `missing YAML frontmatter` 并**静默丢弃该技能** |

> 说明：第 1 条与第 14 条是**唯二**会改变落盘字节的差异（第 14 条是修 bug，改完的技能才能被 codex 加载）；
> 其余为平台面替换或路径修正，合并算法、标记块清单、
> 钩子条目过滤规则、manifest 字段、备份目录命名均与原版逐条对齐。

## 标记块合并（`[3/9] AGENTS.md`）逐条对齐

- **Legacy 旧块清单（9 个，逐字照抄 ps1）**：`<!-- BEGIN WORKSPACE IDENTITY -->`、
  `WORKSPACE-CONTRACT`、`SLO-RUNTIME:eni-solo`、`WORKSPACE-AMPLIFIER`、`ASTRA-GRANULARITY-V8`、
  `SHIYI-WB-L1-HANDOFF`、`SHIYI-WB-EVIDENCE-CORE`、`SHIYI-WB-OUTPUT-ORDER`、`SHIYI-WB-MEMORY-IMMUNITY`
  （后 8 个为 `<!-- X:BEGIN -->` … `<!-- X:END -->` 形式）。
- **外部保留块（3 个）**：`SHIYI-V11`、`CHA-CODEX-POJIA`、`coldbrew`。夹在其中的内容**原样保留**，
  BEGIN/END 计数做守恒校验；新块插入时锚定在首个外部块之前。
- 三种状态：① 已有外层块 → 块内替换；② 只有 Legacy → 剥除 Legacy 后插入；③ 全新文件 → 直接写入。
- `Expand-Paths` 的 `\u0001` 哨兵机制逐行移植（避免嵌套替换互相污染）。
- **幂等**：内容未变则**零写入**（二次安装 AGENTS.md 逐字节不变，已由自测断言）。

## hooks.json 合并（`[4/9]`）

- 坏 JSON → 告警 + 备份 + 重建（不抛错中断）。
- 本 Kit 条目的 `command` / `commandWindows` 重写为 `python3 "<codexHome>/hooks/ishii_auto_route.py"`。
- 从**所有**事件里剔除 `ishii_auto_route|slo-runtime-hook` 旧条目，再追加材料条目。
- 转义反斜杠路径替换：`C:\\Users\\Administrator\\.codex` → 真实 `codexHome`，`C:\\Users\\Administrator` → `$HOME`。
- **反夹层自检**：`PreToolUse` / `PostToolUse` / `SubagentStart` 三个工具事件下**禁止**出现本 Kit 条目
  （否则撕开 `tool_calls`/`tool-output` 相邻性 → `No tool output found for tool call (400)`），
  hook 脚本内同规则正则校验。
- UTF-8 输出。

## helper 差异：`helpers/Sync-HookTrust-macos.py`

原版 `Sync-HookTrust.py`（736 行）在 macOS 上**必然失败**：

```
[trust][FAIL] 找不到 codex 可执行文件，无法同步 hook 信任。
             可显式指定：python Sync-HookTrust.py --codex <codex.exe>
```

根因有两处：(a) `_exe_ok()` 要求文件名以 `.exe` 结尾，`/usr/local/bin/codex`（本就无扩展名）永远不过检；
(b) 子进程探测只匹配 `codex.exe`。本仓库的做法是**保留原脚本不动**，另存一份最小改动的 mac 副本：

| 改动 | 内容 |
| --- | --- |
| 新增 `IS_MAC` / `NL` | `NL = "\r\n" if sys.platform == "win32" else "\n"`；全文 5 处硬编码 `"\r\n"` 改为 `NL` |
| `_exe_ok` | 放宽为「存在且可执行」（`os.access(p, os.X_OK)`），不再强制 `.exe` |
| `_shim_children` | 额外匹配**无扩展名**的 `codex`（npm shim 与 Homebrew 均为无扩展名） |
| `resolve_codex_candidates` | 固定候选增加 `/usr/local/bin/codex`、`/opt/homebrew/bin/codex`、`~/.codex/bin/codex`、`~/.npm-global/bin/codex`、ChatGPT.app 内 `CodexCLI.app/Contents/MacOS/codex` |
| 文档字符串 | 顶部注明上述差异与原因 |

其余逻辑（`codex app-server --listen stdio://` → `initialize` → `hooks/list {cwds}` 取运行时
`currentHash` 原样写入）**逐行不变**。退出码语义保持：`0` 成功 / `3` 未找到 codex / `4` app-server 过旧 /
`5` 仍不可信 / `6` 声明了钩子但一个都没加载。

hook 信任记录写法（写入目标 `config.toml`，由 `SLO-RUNTIME:eni-solo:HOOK-TRUST` 标记块包裹，卸载时可精准剥离）：

```toml
# SLO-RUNTIME:eni-solo:HOOK-TRUST:BEGIN
[hooks.state.'/path/to/hooks.json:pre_compact:0:0']
trusted_hash = "sha256:…"
# SLO-RUNTIME:eni-solo:HOOK-TRUST:END
```

## macOS 环境注意事项

1. **真实 `~/.codex/skills/` 含符号链接**（如 `computer-use`、`dev-progress-log`、`frontend-skill`、
   `gsap-plugins` → `~/.agents/skills/*`）。安装会把这些链接**整体移进备份**（保持仍是链接），
   卸载再**按链接原样还原**——绝不 `cp -r` 解引用成实体目录副本（自测有专门断言）。
2. **真实 `~/.codex/backups/` 已有无关内容**（`logs_2.sqlite-*`、`manual/` 等）。安装 / 卸载 / `--purge`
   都**只允许动本 Kit 自己的子目录**（`backups/eni-solo-*`、`backups/pre-uninstall-*`）。
3. **常驻 `codex app-server` 进程无需退出**：Codex 桌面端 / VS Code 扩展常驻 `app-server` 子进程，
   安装器识别后按「无需退出」忽略（不会误报「交互式 Codex 正在运行」，也不会去 kill 它）。
4. **`/tmp` 是符号链接**：测试请用 `/private/tmp/...`，否则路径比对会不一致。
5. **本机未安装 Codex 桌面版时**：`[1.5/9]` asar 补丁会跳过（非致命），其余步骤照常。
6. **`slo-runtime-hook.exe` 是 Windows PE**：macOS 无法执行，该运行时只铺文件、不注册钩子。

## 自测

```bash
bash selftest.sh --pack "/path/to/packs/codex"
```

- **用例 A（增量场景）**：安装 → 校验 → 二次安装（幂等）→ 卸载 → 重装
- **用例 B（干净场景）**：安装 → 卸载，逐字节回滚到夹具原文（含符号链接技能还原）
- **用例 C**：`--dry-run` 零写入
- **用例 D**：`--purge` 只清本 Kit 内容，`backups/` 无关内容零改动
- 夹具覆盖：用户内容 + Legacy 旧块 + `SHIYI-V11` 外部块 + 旧 ishii 钩子 + 第三方钩子 +
  冲突技能目录 + **符号链接技能** + **`backups/` 无关内容**
- 全程只写 `/private/tmp/codex-selftest`，不 kill 进程、不打开链接、不碰真实 `~/.codex`

## 已知限制 / 未验证项

- **Astra6 号池中间件未移植**（`astra6_pool_patch: false`），Windows 上的号池能力在 macOS 版缺失。
- **slo-runtime 钩子在 macOS 不注册**（缺可执行的 mac 版运行时），`hook-activation.json` 只作留档。
- `install-replica.ps1` 中 `[7.x]` 之后的少量 Windows 专属辅助（如盘符扫描、PowerShell 计划任务）
  未逐条移植，原因是 macOS 无对应载体。
- 本安装器**不修改** `config.toml` 的账号 / 模型 / 供应商配置（非侵入模式），因此需要在 Codex 里
  重启后由用户自行确认模型可用性。
- 开发期未在「装了 Codex 桌面版」的机器上实跑 `[1.5/9]` 的 asar 补丁分支（本机无 Codex.app）；
  该分支已用合成 asar 夹具验证（补丁成功、integrity 复核 MATCH、自动备份 .bak）。

## 实测记录（v4.0.0-mac.1，macOS 15.5 Intel）

- 端到端安装：`skills installed: 107`、`skill_bom_fixed: 3`、hooks 三事件注册、`[8/9]` 写入
  3 条 `trusted_hash`、`[9/9]` manifest 落盘，`~/.codex/AGENTS.md` 从 312 行合并到 747 行
  且用户原有 312 行**零丢失**（逐行核对），`config.toml` 剥除信任块后与安装前**逐字节一致**。
- 破甲 hook 真实生效：`codex exec` 实跑输出 `hook: SessionStart Completed` /
  `hook: UserPromptSubmit Completed`；手工喂事件给 `hooks/ishii_auto_route.py` 返回
  `{"continue": true, …}` 与路由回执。
- BOM 修复：装后 `~/.codex/skills` 下 198 个 `SKILL.md` 带 BOM 数量为 **0**，`codex exec` 实跑
  **零** `failed to load skill` ERROR（修复前每次会话必报 3 条）。
- 沙箱验证：源包目录**不被污染**（安装后源 `SKILL.md` 仍带 BOM），BOM 只在 stage 副本上剥离。
