# DSH 破甲懒人包 · macOS 安装器（社区 fork）

`install-macos.mjs` 是 `packs/dsh/install.ps1`（v5.7.0，420 行 PowerShell）的等价 Node 实现：
纯 Node 内置模块、零外部依赖、Node ≥ 18、`chmod 755` 可直接执行。
用途：让「苏苏 AI超频」macOS 分支在无 PowerShell 的系统上部署 DSH 破甲包
（插件 / AGENTS.md / shield 协议 / 注入模板 / 150+ 技能包 / dsh-purge 清洗 / profile patch 自愈）。

## 用法

```bash
node install-macos.mjs --pack <包目录> --dsh-home <DSH 根> [选项]
./install-macos.mjs --help          # 全部选项
```

常用：

| 选项 | 说明 |
| --- | --- |
| `--pack <目录>` | 包根目录（含 `install.ps1`/`materials`/`plugins`/`tools`）；默认按脚本位置推导 |
| `--dsh-home <目录>` | DSH 配置根；默认 `$DSH_HOME` → `~/.dsh` |
| `--profile <名>` | DSH profile（默认 `web`） |
| `--uninstall` | 卸载（按备份与标记精准回滚） |
| `--dry-run` | 只打印计划，不写文件、不重启 |
| `--skip-skills` / `--lean` | 跳过技能包 / 精简插件集（不带 super-injector） |
| `--no-restart` / `--no-open-links` | 不自动重启 DSH / 不自动打开推广链接 |
| `--no-cold-coffee` | 不注册「冷咖啡」急救模板 |
| `--shell-env` | 把 `env.sh` 的 source 行写入 `~/.zshrc`/`~/.bash_profile`（幂等） |
| `--dsh-bases <列表>` | 显式指定 [7/7] 的运行时 base（逗号分隔；测试/CI 用，默认自动探测） |

## 阶段对照（install.ps1 → install-macos.mjs）

| ps1 阶段 | mjs 实现 |
| --- | --- |
| `[0/7]` 环境检查 / Resolve-DshBase | 同阶段；`~/.npm/_npx`、`ps -axo` 进程、`DSH_BASE`、npm 全局前缀四路探测，取实跑进程优先、版本择优 |
| `[1]` package.json 备份 | 同名 `*.bak-dsh-lazy-v5`（只建一次） |
| `[2/7]` 装插件（Junction + json-edit.js） | 目录符号链接替代 Junction（只删链接、不碰目标）；仍调用包内 `tools/json-edit.js` |
| `[3/7]` AGENTS.md / `[4/7]` shield-protocol.md / `[5/7]` 注入模板 | 同 |
| `[6/7]` 技能包 | 同（151 个 SKILL.md 目录） |
| `[7/7]` dsh-purge 清洗全部运行时 | 同（`--apply --base` 逐个运行时；`DSH_HOME` 指向本次安装根） |
| 用户环境变量（注册表） | `<dshHome>/env.sh`（`DSH_BASE` + `DSH_PERMISSION_MODE`；`--shell-env` 可写入 shell 启动文件） |
| `[8/8]` cordis.patch.yml 自愈 | 同（仅对「无有效行」文件补 `[]`） |
| Restart-DshRuntime | 杀旧 DSH 进程 → 同 `bin.js` 拉起 → 探活 15s → `open` 浏览器；日志在 `<dshHome>/logs/dsh-boot.log(.err)` |

## 备份与回滚

- **一次性备份**：`*.bak-dsh-lazy-v5`、`*.bak-v5`（与 ps1 完全同名，只建一次，重跑不重复）。
- **写前快照**：`<dshHome>/backups/<yyyyMMdd-HHmmss>/`，覆盖前先存，按内容去重 ——
  重复执行/重装不会新增备份；`--uninstall` 会按 `.bak` 恢复 AGENTS.md 与 prompt-inject.md。
- **补丁回滚**：`node ~/.dsh/plugins/dsh-purge/bin/dsh-purge.js --revert`（本安装器不自动执行）。

## 安全与测试

- 测试一律 `--dsh-home /private/tmp/dsh-test`（macOS 的 `/tmp` 是符号链接，必须写 `/private/tmp`）；
  **不要指向正在使用的 `~/.dsh`**。
- `--dsh-bases <夹具运行时>` 可把 `[7/7]` 的补丁目标限定到测试夹具，避免动到真实 DSH 运行时。
- `bash selftest.sh --pack <包目录>`：一键跑「安装 → 幂等重装 → 卸载 → 重装」全流程断言，
  全程只写 `/private/tmp`、不重启 DSH、不打开链接。

## 已知差异（相对 ps1）

1. `[7/7]` 的 shim 注入层（`dsh.cmd`/`dsh.ps1`）在 macOS 无对应物 → purge 侧报告 `missing`（无副作用）；
   `DSH_PERMISSION_MODE` 由 `env.sh` / 应用侧注入。
2. 重启时不会杀死「安装器自身进程链上的 DSH 进程」（防止从 DSH 会话内执行时自杀式重启）；
   正常由应用拉起安装器时不受影响。
3. 自动探测未覆盖 pnpm/yarn 全局安装等非常规布局，可用 `--dsh-bases` 兜底。
