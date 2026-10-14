# OpenCode 破甲包 · macOS 安装器（install-macos.mjs）

> Windows 侧 `install.ps1` / `install.cmd` + `patch-opencoe.js` + `merge-config.mjs` 的 macOS 移植（社区 fork · mac 分支工作）。
> **纯 Node ≥18 实现，零外部依赖**：不依赖 `@electron/asar`、不需要 npm、不需要联网。

## 功能

1. **合并 `opencode.jsonc`** 到用户配置目录（幂等；覆盖前备份 `.bak-install`，已存在的备份不覆盖）
2. **部署插件层**：`plugins/shiyi-lock.ts` / `shiyi-lock.mjs`、`AGENTS.md`、`shield-protocol.md`（+ 兜底 `package.json`）
3. **对 `app.asar` 打补丁（P1-P7，权限默认放行）**，原生 asar 手术：
   - 解 header → 内存替换目标文件 → **重算每文件 integrity（hash=SHA256 整文件、blocks=按 blockSize 分块）** → 原子写回 → **逐文件校验（字节一致 + integrity 一致）**
   - P1 更新器禁用（`prod`→`dev`）；P2 PermissionV1 默认 ask→allow；P3 工具永不隐藏；P4 内置默认 system prompt 清空
   - P5-P7 PermissionV2 全破（默认放行 / deny 恒 false / 默认 agent 门禁清空）
   - 特征不匹配 → **失败关闭**（绝不生成部分补丁，原 asar 不动）

## 用法

```bash
# 安装（默认探测 /Applications/OpenCode.app）
node install-macos.mjs --pack <破甲包目录>

# 演练：不写任何文件
node install-macos.mjs --pack <破甲包目录> --dry-run

# 只打 P1-P4（跳过 PermissionV2 攻破）
node install-macos.mjs --pack <破甲包目录> --no-v2

# 回滚
node install-macos.mjs --uninstall --pack <破甲包目录>

# 测试/演练：指向 /private/tmp 副本 + 临时配置目录（勿直接改真实应用/配置）
node install-macos.mjs --pack <破甲包目录> \
  --asar /private/tmp/oc-test/app.asar \
  --config-dir /private/tmp/oc-test-config
```

| 参数 | 说明 |
| --- | --- |
| `--pack <目录>` | 破甲包目录（`opencode.jsonc` / `plugins/` / `AGENTS.md` / `shield-protocol.md`）。默认：脚本所在目录 |
| `--app <路径>` | OpenCode.app。默认探测 `/Applications/OpenCode.app`、`~/Applications/OpenCode.app` |
| `--asar <路径>` | app.asar。默认由 `--app` 推导 `<app>/Contents/Resources/app.asar` |
| `--config-dir <目录>` | 配置目录。默认 `$XDG_CONFIG_HOME/opencode`，否则 `~/.config/opencode`（与 ps1 及 shiyi-lock 插件一致） |
| `--uninstall` | 回滚：恢复 asar 备份、恢复/清理配置层（无备份且与包内容一致的安装文件会被删除） |
| `--dry-run` / `--verify-only` | 只分析不写盘 |
| `--backup <路径>` | 自定义 asar 备份路径（默认 `<asar>.orig-backup.bak`） |
| `--no-v2` | 跳过 P5-P7 |
| `--no-sign` | 跳过 ad-hoc 重签名 |
| `--relaunch` | 完成后自动启动 OpenCode.app |
| `--with-plugin-deps` | 额外执行 `npm install @opencode-ai/plugin@<版本>`（默认跳过，离线友好） |
| `--open-links` | 打开推广链接（默认仅打印） |

## 安全与签名（重要）

- **修改 asar 会破坏 macOS 代码签名**。当 asar 位于 `.app` 内时，脚本在写回后自动执行
  `codesign --force --deep --sign - <OpenCode.app>`（`--no-sign` 可关）；不重签则应用无法启动。
- 备份位置：asar → `<asar>.orig-backup.bak`；配置 → `<文件>.bak-install`；**已存在的备份不会被覆盖**。
- 演练一律使用 `/private/tmp` 副本（macOS `/tmp` 是符号链接，用 `/private/tmp`）与临时 `--config-dir`，
  不要对真实 `/Applications/OpenCode.app` 和 `~/.config/opencode` 直接试跑。
- 回滚：`--uninstall`。注意：无 `.bak-install` 时仅剥离合并加入的 `permission['*']` / `tools['*']` / plugin 条目（`$schema` 保留）。

## 兼容性（实测）

| 目标 | 结果 |
| --- | --- |
| macOS OpenCode Desktop **1.16.2**（app.asar 97,311,522B，3598 文件 / 17 unpacked） | ✅ 全量 P1-P7 通过，重打包后逐文件校验 3598/3598 |
| Windows 1.18.x 代码形态 | ✅ 以变体形式兼容（P2/P3 双形态；P4 为版本无关的 provider9 组操作） |

- 修复后 asar：97,311,026B（-496B），sha256=`45168295e7dd51877ef1331af20573225181c229a06ae6661d3bb59d8fe926d6`（对同一输入逐字节确定）。
- `app.asar.unpacked/` **不参与重打包**（补丁只改 asar 内两个 JS 文件，unpacked 节点原样保留），无需备份。

## 分发

把破甲包内容与 `install-macos.mjs` 放同目录即可零参数运行；或运行时用 `--pack` 指定。完整参数见 `--help`。
