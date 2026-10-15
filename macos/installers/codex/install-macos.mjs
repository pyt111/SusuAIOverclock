#!/usr/bin/env node
// ============================================================
//  Codex 破甲包（eni-solo 4.0.0 replica）— macOS 安装器 / 卸载器（Node 版）
//  社区 fork（mac 分支）：install-replica.ps1 + Uninstall.ps1 的等价移植，
//  供「苏苏 AI超频」在 macOS 上以 `node install-macos.mjs --pack . …` 调用。
//
//  用法:
//    node install-macos.mjs --pack . --no-open-links --skip-astra6      # 安装
//    node install-macos.mjs --pack . --uninstall                        # 卸载
//    node install-macos.mjs --pack . --dry-run                          # 零写入预览
//    node install-macos.mjs --help
//
//  与 install-replica.ps1 的 Windows→macOS 语义映射:
//    robocopy /E                         -> fs.cpSync(src, dst, {recursive:true})
//    Move-Item（跨目录搬备份）            -> fs.renameSync + 跨卷时 cp+rm 兜底
//    Write-FileUtf8（原子写）             -> 同目录临时文件 + rename（POSIX 原子）
//    Get-Date 'yyyyMMdd-HHmmss-fff'      -> 同格式本地时间戳（STAMP，含毫秒）
//    Get-FileHash -Algorithm SHA256      -> crypto.createHash('sha256')
//    Get-Process / .Path                 -> ps -axo pid=,ppid=,command=
//    Start-Process <url>                 -> open <url>
//    python（Windows 命令名）             -> python3（--python 可覆盖）
//    robocopy 退出码 1..7 归一为 0        -> Node 无此问题
//
//  安全: 绝不 sudo；绝不写 codexHome 之外（唯一例外：namespace-fix 对 Codex.app
//        app.asar 的补丁——本机没有 Codex.app 时会跳过，且脚本自身先做备份）。
//        dry-run 零写入。测试一律用 --codex-home /private/tmp/…。
// ============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const TOOL_VERSION = '4.0.0-mac.1';
const KIT_VERSION = '4.0.0';
const REPLICA_OF = 'sha256-r2-mixed-pinned-2b50f93a8d7716b5';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const PROMO_LINKS = [
  ['苏苏官网', 'https://susu.wiki/'],
  ['加群', 'https://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=&jump_from=webapi&group_code=1041209479'],
];

// 必需材料（preflight：缺一即失败）
const REQUIRED_MATERIALS = ['AGENTS.md', 'models.json', 'hooks', 'prompts', 'skills'];

// v10.3：AGENTS.md 块标记台账（逐字取自 install-replica.ps1 946-967 行）
const LEGACY_BEGIN_BLOCKS = [
  '<!-- BEGIN WORKSPACE IDENTITY -->',
  '<!-- WORKSPACE-CONTRACT:BEGIN -->',
  '<!-- SLO-RUNTIME:eni-solo:BEGIN -->',
  '<!-- WORKSPACE-AMPLIFIER:BEGIN -->',
  '<!-- ASTRA-GRANULARITY-V8:BEGIN -->',
  '<!-- SHIYI-WB-L1-HANDOFF:BEGIN -->',
  '<!-- SHIYI-WB-EVIDENCE-CORE:BEGIN -->',
  '<!-- SHIYI-WB-OUTPUT-ORDER:BEGIN -->',
  '<!-- SHIYI-WB-MEMORY-IMMUNITY:BEGIN -->',
];
const FOREIGN_KEEP_BLOCKS = [
  '<!-- SHIYI-V11:BEGIN -->',
  '<!-- CHA-CODEX-POJIA:BEGIN -->',
  '<!-- coldbrew:begin -->',
];
const AGENTS_TAG = '<!-- ENI-SOLO-AGENTS';

// 本 Kit 历史版本 hooks 脚本哈希（逐字拷贝 ps1 1274-1283 行；小写比较）
const KNOWN_KIT_HOOK_HASHES = [
  '7A3FF879F30E196621220DC06DE84E3EEB1779FF73A1E81B2207E8F2566ADF4F',
  '83C0F53E721E31F2D1A20AB51C99AB1AE06116A7DF53B2682AA580B01C87D7FF',
  'C3DCBFDAE222B870E3544CC62637B4D1F3C7E2E5099507DBF4AC90E0C9CE59BE',
  'F26CE9FC04F2191BF8642204B89CCAEDB3586F8FABC4165F7880342DCA1BE639',
  'E7BB41DDD452EC54FE15D50B9E05855269EA821F098F1F66BBD1265518E2F3EB',
  '9EBB426FC578F6F4397431C6B8328100E3753C583CE4588E9262ACFA7096D5A3',
  'C18FE139D9B594E40BFFE26B9CA0CF53BE5C3EA996CD8B5D1D9D5F1D6947B7D6',
  'B301B25FDECBF2D4A1F7E5B9E309DADF0E450B0A44222B254810C24A11A8E6E1',
].map((h) => h.toLowerCase());

// 反夹层正则（逐字取自 ps1 1821 行）
const FORBIDDEN_HOOK_RE = /_ctx\(\s*.?PreToolUse|_ctx\(\s*.?PostToolUse|_ctx\(\s*.?SubagentStart/;
const KIT_ENTRY_RE = /ishii_auto_route|slo-runtime-hook/;
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'SubagentStart'];

// ═══════════════════════════════════════════════════════════════════
//  CLI
// ═══════════════════════════════════════════════════════════════════

function die(msg) { throw new Error(msg); }

function parseArgs(raw) {
  const opts = {
    pack: null, codexHome: null, python: null,
    force: false, noOpenLinks: false, skipAstra6: true,
    uninstall: false, purge: false, dryRun: false, help: false,
  };
  for (let i = 0; i < raw.length; i++) {
    let tok = raw[i];
    let inline = null;
    const eq = tok.indexOf('=');
    if (tok.startsWith('--') && eq !== -1) { inline = tok.slice(eq + 1); tok = tok.slice(0, eq); }
    const val = (name) => {
      if (inline !== null) { if (inline === '') die(`参数 ${name} 缺少数值`); return inline; }
      const v = raw[i + 1];
      if (v === undefined || (v.startsWith('--') && v.length > 2)) die(`参数 ${name} 缺少数值`);
      i += 1;
      return v;
    };
    switch (tok) {
      case '--pack': opts.pack = val('--pack'); break;
      case '--codex-home': opts.codexHome = val('--codex-home'); break;
      case '--python': opts.python = val('--python'); break;
      case '--force': opts.force = true; break;
      case '--no-open-links': opts.noOpenLinks = true; break;
      case '--skip-astra6': opts.skipAstra6 = true; break;
      case '--uninstall': opts.uninstall = true; break;
      case '--purge': opts.purge = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (tok.startsWith('-')) die(`未知参数: ${tok}（--help 查看用法）`);
        die(`多余的位置参数: ${tok}（--help 查看用法）`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Codex 破甲包（eni-solo ${KIT_VERSION} replica）macOS 安装器 v${TOOL_VERSION}
纯 Node（>=18，零依赖）— install-replica.ps1 / Uninstall.ps1 的等价实现。

用法:
  node install-macos.mjs [选项]
  ./install-macos.mjs [选项]                # chmod 755 后可直接运行

选项:
  --pack <目录>        破甲包根目录（含 materials/、codex-namespace-fix/、Sync-HookTrust.py）。
                       默认 = 本脚本所在目录
  --codex-home <目录>  Codex 配置根。默认 $CODEX_HOME，未设置时 ~/.codex
  --python <路径>      python3 解释器路径（默认在 PATH 上找 python3）
  --force              即使检测到交互式 codex 进程也继续（绝不 kill 任何进程）
  --no-open-links      不自动打开官网 / 加群链接（仅打印）
  --skip-astra6        v1 默认跳过 Astra6 号池中间件（未移植；保留参数以对齐 Windows 侧）
  --uninstall          卸载（按备份与标记精准回滚）
  --purge              卸载时额外清理 backups/eni-solo-*、manifest、状态文件（= Uninstall.ps1 -PurgeAll）
  --dry-run            只打印将执行的操作，不写任何文件
  --help               显示本帮助

示例:
  node install-macos.mjs --pack . --no-open-links --skip-astra6
  node install-macos.mjs --pack . --codex-home /private/tmp/codex-test --dry-run
  node install-macos.mjs --pack . --uninstall --purge

安全提示: 测试请使用 --codex-home /private/tmp/codex-test；不要指向正在使用的 ~/.codex。`);
}

// ═══════════════════════════════════════════════════════════════════
//  日志（沿用 ps1 的 [OK] / [WARN] / ==> 样式与阶段编号）
// ═══════════════════════════════════════════════════════════════════

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const C = {
  cyan: (s) => paint(36, s), green: (s) => paint(32, s),
  yellow: (s) => paint(33, s), red: (s) => paint(31, s),
};
function step(msg) { console.log(C.cyan(`==> ${msg}`)); }
function ok(msg) { console.log(C.green(`  [OK] ${msg}`)); }
function warn(msg) { console.log(C.yellow(`  [WARN] ${msg}`)); }
function info(msg) { console.log(msg); }
function dryLog(msg) { console.log(`  [DRY] ${msg}`); }

// ═══════════════════════════════════════════════════════════════════
//  通用小工具
// ═══════════════════════════════════════════════════════════════════

let DRY = false;

function expandHome(p) {
  if (!p) return p;
  let s = String(p);
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/')) s = path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
}

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

function stripBom(s) { return String(s).replace(/^\uFEFF/, ''); }
function safeLstat(p) { try { return fs.lstatSync(p); } catch { return null; } }
function exists(p) { try { fs.lstatSync(p); return true; } catch { return false; } }
function readText(p) { return stripBom(fs.readFileSync(p, 'utf8')); }
function readJson(p) { return JSON.parse(stripBom(readText(p))); }
function sha256hex(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
function rmrfF(p) { if (DRY) { dryLog(`删除: ${p}`); return; } rmrf(p); }
function listDirs(d) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(d).sort(); } catch { return out; }
  for (const n of names) {
    const st = safeLstat(path.join(d, n));
    if (st && st.isDirectory() && !st.isSymbolicLink()) out.push(n);
  }
  return out;
}
function fileIsLink(p) {
  const st = safeLstat(p);
  return Boolean(st && st.isSymbolicLink());
}
function mkdirp(d) { if (!DRY) fs.mkdirSync(d, { recursive: true }); }

// 复制文件/目录/符号链接：符号链接按链接本身复制（不跟随、不解引用）
function copyPathF(src, dst) {
  if (DRY) { dryLog(`复制: ${src} -> ${dst}`); return; }
  const st = safeLstat(src);
  if (!st) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(src);
    rmrf(dst);
    fs.symlinkSync(target, dst);
  } else if (st.isDirectory()) {
    fs.cpSync(src, dst, { recursive: true, dereference: false });
  } else {
    fs.copyFileSync(src, dst);
  }
}
function copyFileF(src, dst) { copyPathF(src, dst); }
function copyDirF(src, dst) { copyPathF(src, dst); }

/**
 * 剥离 SKILL.md 开头的 UTF-8 BOM。
 *
 * 为什么必须做：codex 的 session_init 用严格解析器读 skills，要求文件首字符就是
 * frontmatter 定界符 `---`。文件若以 EF BB BF 开头，codex 会报
 *   failed to load skill <path>/SKILL.md: missing YAML frontmatter delimited by ---
 * 并**静默丢弃该技能**（技能不生效，且每次会话刷 ERROR）。
 *
 * 本仓库的 codex 破甲包自带若干带 BOM 的 SKILL.md（Windows 侧同样中招：
 * install-replica.ps1 并不调用包内自带的 Fix-SkillFrontmatter.ps1，所以那个
 * 修复器从未在真实安装里跑过）。这里在部署阶段就地修好，属无损改写：
 * 只删前 3 字节，正文逐字节不变，写回用原子替换且保留原文件权限。
 */
function stripBomFromSkillMd(rootDir) {
  const fixed = [];
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue; // 不跟随链接，链接技能由卸载逻辑按链接本身回滚
      if (ent.isDirectory()) { walk(p); continue; }
      if (ent.name !== 'SKILL.md') continue;
      let buf;
      try { buf = fs.readFileSync(p); } catch { continue; }
      if (buf.length < 3 || buf[0] !== 0xef || buf[1] !== 0xbb || buf[2] !== 0xbf) continue;
      if (DRY) { dryLog(`剥离 BOM: ${p}`); fixed.push(p); continue; }
      const mode = (safeLstat(p) || {}).mode;
      const tmp = path.join(path.dirname(p), `.eni-solo-bomfix-${crypto.randomBytes(8).toString('hex')}.tmp`);
      try {
        fs.writeFileSync(tmp, buf.subarray(3), mode ? { mode } : undefined);
        fs.renameSync(tmp, p);
        fixed.push(p);
      } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        warn(`  剥离 BOM 失败（忽略，不中断安装）：${p} — ${e.message}`);
      }
    }
  };
  walk(rootDir);
  return fixed;
}

// 原子写（等价 ps1 的 Write-FileUtf8：同目录临时文件 + rename，POSIX 上 rename 原子）
function writeFileUtf8(p, content) {
  if (DRY) { dryLog(`写入文件: ${p}`); return; }
  if (fileIsLink(p)) die(`拒绝写入符号链接/目录联接: ${p}`);
  const dir = path.dirname(p);
  if (fileIsLink(dir)) die(`拒绝写入链接目录: ${dir}`);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.eni-solo-atomic-${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, content, 'utf8'); // 无 BOM
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

// 移动（备份）：优先 rename（同一文件系统上原子、且天然保留符号链接本身）；
// 跨卷/失败时退回 copyPathF（按链接复制）+ 删源，绝不跟随链接目标。
function moveTo(src, dst) {
  if (DRY) { dryLog(`移动: ${src} -> ${dst}`); return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.renameSync(src, dst); return; } catch { /* fallthrough */ }
  copyPathF(src, dst);
  rmrf(src);
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function countOcc(text, sub) { return text.split(sub).length - 1; }
function whichSync(cmd) {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
//  ps1 移植：Expand-Paths / Get-BlockEndMarker / Merge-MarkedBlock
// ═══════════════════════════════════════════════════════════════════

// 两段式 + 哨兵：先转哨兵、后回填，避免嵌套污染（ps1 472-498 行）
function expandPaths(text, codexHome, home) {
  const S = '\u0001';
  let out = String(text);
  out = out.split('C:\\Users\\Administrator\\.codex').join(`${S}CODEXHOME${S}`);
  out = out.split('C:\\Users\\Administrator').join(home);
  out = out.split(`${S}CODEXHOME${S}`).join(codexHome);
  return out;
}

// 「xxxBEGIN yyy」->「xxxEND yyy」，大小写原样保留（ps1 607-627 行）
function getBlockEndMarker(marker) {
  if (!marker) return '';
  const k = marker.toLowerCase().indexOf('begin');
  if (k < 0) return '';
  const w = marker.substr(k, 5);
  if (w === 'BEGIN') return marker.slice(0, k) + 'END' + marker.slice(k + 5);
  return marker.slice(0, k) + 'end' + marker.slice(k + 5);
}

function countMatches(text, needle) {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

// 标记块外科手术（ps1 629-839 行）。三态：块内替换 / 剥旧块+插入 / 全新文件。
function mergeMarkedBlock(text, payload, legacyBegin, foreignKeep, tag) {
  if (!tag) die('Merge-MarkedBlock: Tag 为空');
  const bTag = `${tag}:BEGIN -->`;
  const eTag = `${tag}:END -->`;

  // 换行口径跟着现有文件走；空文件在 macOS 上用 LF（ps1 用 CRLF —— 见 README 差异清单）
  let nl = '\r\n';
  if (text && !text.includes('\r\n')) nl = '\n';
  if (!text) nl = '\n';

  const newBody = String(payload).replace(/\r?\n/g, nl).replace(/\s+$/, '');
  if (!newBody) die('Merge-MarkedBlock: payload 为空，拒绝写盘');

  // ── 路径 1：已有外层块
  if (text && text.includes(bTag)) {
    const i = text.indexOf(bTag);
    const j = text.indexOf(eTag, i + bTag.length);
    if (j < 0) die('AGENTS.md 外层标记块不配对（只有 BEGIN 没有 END），拒绝写盘');
    const head = text.slice(0, i);
    const tail = text.slice(j + eTag.length);
    const hOut = head.trim() ? head.replace(/\s+$/, '') + nl : '';
    const tOut = tail.trim() ? nl + nl + tail.replace(/^\s+/, '') : nl;
    return { text: hOut + newBody + tOut, mode: 'replace' };
  }

  // ── 路径 2：剥旧块 + 插入
  let out = text;
  const removed = [];
  for (const b of legacyBegin) {
    if (!b) continue;
    const e = getBlockEndMarker(b);
    if (e === b) continue;
    if (!out.includes(b)) continue;

    const protect = [];
    for (const f of foreignKeep) {
      if (!f) continue;
      const fe = getBlockEndMarker(f);
      const fm = new RegExp(escapeRe(f) + '[\\s\\S]*?' + escapeRe(fe)).exec(out);
      if (fm) protect.push([fm.index, fm.index + fm[0].length]);
    }

    const rx = new RegExp(escapeRe(b) + '[\\s\\S]*?' + escapeRe(e) + '[ \\t]*(?:\\r?\\n)?', 'g');
    let hit = null;
    for (const m of out.matchAll(rx)) {
      const inside = protect.some((pr) => m.index >= pr[0] && (m.index + m[0].length) <= pr[1]);
      if (!inside) { hit = m; break; }
    }
    if (!hit) continue;
    out = out.slice(0, hit.index) + out.slice(hit.index + hit[0].length);
    removed.push(b);
  }

  // ---- 裸头（v10.x 早期把无标记正文直接写在文件开头）
  {
    const lines = out.split(/\r?\n/);
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i < lines.length && lines[i].includes('所有的方案实现都要遵循以下几点')) {
      let j = i;
      while (j < lines.length) {
        const ln = lines[j].trim();
        if (ln === '' || /^[1-4]/.test(ln) || ln.includes('所有的方案实现都要遵循以下几点')) { j++; continue; }
        break;
      }
      let headTxt = '';
      if (i > 0) headTxt = lines.slice(0, i).join(nl);
      if (!headTxt.includes('<!--')) {
        const rest = j < lines.length ? lines.slice(j).join(nl) : '';
        out = headTxt ? headTxt + nl + rest : rest;
        removed.push('bare-head');
      }
    }
  }

  // ---- 安全阀：外部块 BEGIN / END 计数双向守恒
  for (const f of foreignKeep) {
    if (!f) continue;
    const fe = getBlockEndMarker(f);
    const b1 = countMatches(text, f); const b2 = countMatches(out, f);
    if (b1 !== b2) die(`拒绝写盘：剥旧块的操作伤到了外部块 ${f}（BEGIN 计数 ${b1} -> ${b2}）`);
    const e1 = countMatches(text, fe); const e2 = countMatches(out, fe);
    if (e1 !== e2) die(`拒绝写盘：剥旧块的操作伤到了外部块 ${f}（END 计数 ${e1} -> ${e2}）`);
  }

  // ---- 拼装：新块插到第一个外部块之前；没有外部块就插到最前
  let anchor = -1;
  for (const f of foreignKeep) {
    if (!f) continue;
    const pos = out.indexOf(f);
    if (pos >= 0 && (anchor < 0 || pos < anchor)) anchor = pos;
  }
  if (anchor < 0) anchor = 0;
  const head = out.slice(0, anchor);
  const tail = out.slice(anchor);
  const hOut = head.trim() ? head.replace(/\s+$/, '') + nl : '';
  const tOut = tail.trim() ? nl + nl + tail.replace(/^\s+/, '') : nl;
  return { text: hOut + newBody + tOut, mode: removed.length ? `insert (removed=${removed.join(',')})` : 'insert' };
}

// ═══════════════════════════════════════════════════════════════════
//  进程探测（mac：排除 app-server 常驻子进程）
// ═══════════════════════════════════════════════════════════════════

function psList() {
  try {
    const out = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || '';
    const rows = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
    }
    return rows;
  } catch { return []; }
}

// 常驻进程标记：app-server（含 daemon/proxy 子命令）、插件宿主、code-mode-host。
// 证据（本机实测）：`.../codex ... app-server ...`（VSCode 扩展 / ChatGPT.app 内的
// CodexCLI）都是桌面端拉起的常驻 daemon，不随窗口退出，必须排除，否则永远误报。
const RESIDENT_CMD_RE = /app-server|\.plugin-appserver|\/plugins\/|code-mode-host/;

function classifyCodexProc(cmd) {
  const argv0 = String(cmd).trim().split(/\s+/)[0] || '';
  const base = path.basename(argv0);
  const looksCodex = base === 'codex' || base === 'codex.js' || /\/@openai\/codex\//.test(argv0);
  if (!looksCodex) return { isCodex: false, resident: false };
  return { isCodex: true, resident: RESIDENT_CMD_RE.test(cmd) };
}

// 返回 { running:[...], resident:[...] }；resident 为无需退出的常驻子进程。
function detectCodexProcs() {
  const running = [];
  const resident = [];
  for (const pr of psList()) {
    const r = classifyCodexProc(pr.cmd);
    if (!r.isCodex) continue;
    const item = { pid: pr.pid, cmd: pr.cmd };
    if (r.resident) resident.push(item); else running.push(item);
  }
  return { running, resident };
}

// ═══════════════════════════════════════════════════════════════════
//  hooks.json 合并（ps1 1038-1250 行）
// ═══════════════════════════════════════════════════════════════════

function arrOf(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }

function mergeHooksJson(existingText, matHooks, codexHome, home) {
  let target = null;
  let rebuilt = false;
  if (existingText !== null) {
    try {
      const parsed = JSON.parse(stripBom(existingText));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) target = parsed;
      else { warn('现有 hooks.json 顶层不是对象，已备份原文件，按新结构重建'); rebuilt = true; }
    } catch (e) {
      warn(`现有 hooks.json 解析失败，已备份原文件，按新结构重建: ${e.message}`);
      rebuilt = true;
    }
  }
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    target = { description: 'Codex lifecycle hooks (eni-solo managed hooks)', hooks: {} };
    if (existingText !== null) rebuilt = true;
  }
  if (!target.hooks || typeof target.hooks !== 'object' || Array.isArray(target.hooks)) target.hooks = {};
  if (!Object.prototype.hasOwnProperty.call(target.hooks, 'UserPromptSubmit')) target.hooks.UserPromptSubmit = [];

  // v10.1：把材料里含 ishii_auto_route 的条目命令改写为 mac 命令
  const hookPyPath = path.join(codexHome, 'hooks', 'ishii_auto_route.py');
  const newCmd = `python3 "${hookPyPath}"`;
  for (const evt of Object.keys(matHooks.hooks || {})) {
    for (const entry of arrOf(matHooks.hooks[evt])) {
      for (const h of arrOf(entry && entry.hooks)) {
        if (!h || typeof h !== 'object') continue;
        if (KIT_ENTRY_RE.test(JSON.stringify(h))) {
          h.command = newCmd;
          h.commandWindows = newCmd;
        }
      }
    }
  }

  // 先从所有现有事件里剪掉本 Kit 条目（保留同事件里的用户钩子）
  for (const evt of Object.keys(target.hooks)) {
    const kept = arrOf(target.hooks[evt]).filter((e) => e != null && !KIT_ENTRY_RE.test(JSON.stringify(e)));
    if (kept.length > 0) target.hooks[evt] = kept;
    else delete target.hooks[evt];
  }

  // 追加材料条目（UserPromptSubmit + PreCompact + SessionStart；工具事件不注册）
  const events = [];
  for (const evt of Object.keys(matHooks.hooks || {})) {
    events.push(evt);
    const eniEntries = arrOf(matHooks.hooks[evt]);
    const kept = arrOf(target.hooks[evt]).filter((e) => e != null && !KIT_ENTRY_RE.test(JSON.stringify(e)));
    target.hooks[evt] = kept.concat(eniEntries);
  }

  let json = JSON.stringify(target, null, 2);
  // JSON 会转义反斜杠，路径适配必须作用在转义形态上
  const escAdminCodex = 'C:\\\\Users\\\\Administrator\\\\.codex';
  const escCodexHome = codexHome.replace(/\\/g, '\\\\');
  const escAdminUser = 'C:\\\\Users\\\\Administrator';
  const escHome = home.replace(/\\/g, '\\\\');
  json = json.split(escAdminCodex).join(escCodexHome).split(escAdminUser).join(escHome);
  return { json: json + '\n', events, rebuilt };
}

// ═══════════════════════════════════════════════════════════════════
//  namespace fix 探测（mac 候选）
// ═══════════════════════════════════════════════════════════════════

function probeCodexAsar() {
  const cands = [];
  const add = (p) => { try { if (fs.statSync(p).isFile()) cands.push(path.resolve(p)); } catch { /* skip */ } };
  for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (/codex/i.test(n) && n.endsWith('.app')) add(path.join(dir, n, 'Contents', 'Resources', 'app.asar'));
    }
  }
  add('/Applications/Codex.app/Contents/Resources/app.asar');
  add(path.join(os.homedir(), 'Applications', 'Codex.app', 'Contents', 'Resources', 'app.asar'));
  return [...new Set(cands)];
}

// ═══════════════════════════════════════════════════════════════════
//  上下文
// ═══════════════════════════════════════════════════════════════════

let ctx = null; // { opts, pack, codexHome, home, mat, stamp, backup, python, log }

function setStep(name) { ctx.step = name; }

// ═══════════════════════════════════════════════════════════════════
//  安装主流程（阶段编号沿用 [1/9] … [9/9]）
// ═══════════════════════════════════════════════════════════════════

function preflight() {
  const { mat, opts, codexHome, home } = ctx;
  info('[preflight] 环境预检');
  if (!exists(mat)) die(`materials 目录不存在: ${mat}`);
  for (const req of REQUIRED_MATERIALS) {
    if (!exists(path.join(mat, req))) die(`缺少必要材料: ${req}`);
  }
  ok(`materials 必需项齐全: ${REQUIRED_MATERIALS.join(', ')}`);

  if (!ctx.python) {
    if (DRY) warn('未找到 python3（dry-run 继续预览；实际安装会中止）');
    else die('未找到 Python 3，请先安装 Python 并配置到环境变量（或加 --python <路径>）');
  } else {
    ok(`python3: ${ctx.python}`);
  }

  if (codexHome === home) {
    warn('CODEX_HOME 指向的是用户主目录本身，而不是 .../.codex');
    warn(`         当前值 : ${codexHome}`);
    warn(`         建议值 : ${path.join(home, '.codex')}`);
    warn('         继续安装会把破甲包内容铺到用户主目录下（不推荐）。');
  }

  const { running, resident } = detectCodexProcs();
  for (const r of resident) info(`  [i] 常驻子进程（无需退出，已忽略）: codex PID ${r.pid} @ ${r.cmd.split(' ')[0]}`);
  if (running.length > 0 && !opts.force) {
    const detail = running.map((r) => `  - codex PID ${r.pid} @ ${r.cmd.split(' ')[0]}`).join('\n');
    die(`检测到 Codex 主程序正在运行，请完全退出后重试（或加 --force 强制继续）：\n${detail}`);
  }
  if (running.length > 0 && opts.force) warn(`检测到 ${running.length} 个交互式 codex 进程，已按 --force 继续（不会 kill 任何进程）`);
  ok('预检通过');
}

function runInstall() {
  const { opts, mat, codexHome, home, stamp } = ctx;
  const backup = path.join(codexHome, 'backups', `eni-solo-${KIT_VERSION}-replica-${stamp}`);
  const force = opts.force;

  // ── 推广链接（--no-open-links 仅打印）
  for (const [name, url] of PROMO_LINKS) info(`  [官方社区] ${name}: ${url}`);
  if (!opts.noOpenLinks && !DRY) {
    for (const [, url] of PROMO_LINKS) { try { spawnSync('open', [url], { stdio: 'ignore' }); } catch { /* ignore */ } }
  }

  mkdirp(codexHome);
  ctx.backup = backup;
  mkdirp(backup);
  info(`backup dir: ${backup}`);

  // ── [1.5/9] namespace fix
  setStep('[1.5/9] codex_app namespace fix (app.asar)');
  step('[1.5/9] codex_app namespace fix (app.asar)');
  const nxScript = path.join(ctx.pack, 'codex-namespace-fix', 'patch_codex_asar_namespace.py');
  if (!exists(nxScript)) {
    info('  [i] codex-namespace-fix 未随包提供 —— 已跳过');
  } else if (!ctx.python) {
    warn('namespace fix 跳过（无 python3）—— 非致命，安装继续');
  } else {
    const cands = probeCodexAsar();
    if (cands.length === 0) {
      info('  [i] 未在本机探测到 Codex 桌面版 app.asar（/Applications/*Codex*.app、~/Applications/*Codex*.app）—— 已跳过（非致命）');
    } else if (DRY) {
      dryLog(`python ${nxScript} --asar ${cands[0]} --auto`);
    } else {
      // 包内脚本支持显式 --asar；mac 上只复用其探测的显式入口，不改脚本本体
      const r = spawnSync(ctx.python, [nxScript, '--asar', cands[0], '--auto'], { encoding: 'utf8' });
      const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
      if (out) for (const l of out.split('\n').slice(-6)) info(`        | ${l}`);
      if (r.status === 0) ok('namespace fix applied (or already patched, idempotent skip)');
      else {
        warn(`namespace fix NOT applied (rc=${r.status}) - install continues.`);
        warn('         manual: codex-namespace-fix/FIX-NAMESPACE.cmd（Windows）或 python patch_codex_asar_namespace.py --asar <path> --auto');
      }
    }
  }

  // ── [2/9] config.toml（只备份 + 记 sha256，绝不修改）
  setStep('[2/9] config.toml (untouched)');
  step('[2/9] config.toml (untouched)');
  const cfgPath = path.join(codexHome, 'config.toml');
  let cfgSha = '';
  let l1ScanNote = 'not-scanned';
  if (exists(cfgPath)) {
    cfgSha = sha256hex(cfgPath);
    l1ScanNote = 'shallow-scan (top-level only, for report; writes go through v13 engine)';
    copyFileF(cfgPath, path.join(backup, 'config.toml'));
    info('  [preserve] config.toml 原文件已备份，原有账号/模型/供应商配置保持原样（不修改）');
  } else {
    info('  [i] config.toml 不存在（首次安装），跳过备份');
  }
  ctx.cfgSha = cfgSha;

  // ── [3/9] AGENTS.md 标记块合并
  setStep('[3/9] AGENTS.md');
  step('[3/9] AGENTS.md');
  const agentsPath = path.join(codexHome, 'AGENTS.md');
  if (exists(agentsPath)) copyFileF(agentsPath, path.join(backup, 'AGENTS.md'));
  const agentsSrc = exists(agentsPath) ? readText(agentsPath) : '';
  const agentsPayload = expandPaths(readText(path.join(mat, 'AGENTS.md')), codexHome, home);
  const agentsRes = mergeMarkedBlock(agentsSrc, agentsPayload, LEGACY_BEGIN_BLOCKS, FOREIGN_KEEP_BLOCKS, AGENTS_TAG);
  const agentsBody = agentsRes.text;
  if (!agentsBody.trim()) die('AGENTS.md 合并结果为空，拒绝写盘');
  if (agentsSrc === agentsBody) {
    info('  [i] AGENTS.md 内容未变化，零写入');
  } else {
    writeFileUtf8(agentsPath, agentsBody);
    ok(`AGENTS.md 已合并（${agentsRes.mode}，${agentsSrc.length} -> ${agentsBody.length} 字符）`);
  }
  for (const fk of FOREIGN_KEEP_BLOCKS) {
    if (agentsSrc.includes(fk) && !agentsBody.includes(fk)) die(`AGENTS.md 写入后丢失外部块 ${fk}`);
  }

  // ── [4/9] hooks.json 合并
  setStep('[4/9] hooks.json');
  step('[4/9] hooks.json');
  const hooksPath = path.join(codexHome, 'hooks.json');
  let existingHooksText = null;
  if (exists(hooksPath)) {
    copyFileF(hooksPath, path.join(backup, 'hooks.json'));
    existingHooksText = readText(hooksPath);
  }
  const matHooks = readJson(path.join(mat, 'hooks.json'));
  const hooksRes = mergeHooksJson(existingHooksText, matHooks, codexHome, home);
  writeFileUtf8(hooksPath, hooksRes.json);
  info(`hook script path -> ${path.join(codexHome, 'hooks', 'ishii_auto_route.py')}`);
  info(`hook events installed: ${hooksRes.events.join(', ')}`);
  ctx.targetHooks = JSON.parse(hooksRes.json);

  // ── [5/9] hook 脚本 + prompts + eni-solo + models.json
  setStep('[5/9] hooks script, prompts, eni-solo manifest, models.json');
  step('[5/9] hooks script, prompts, eni-solo manifest, models.json');
  const hookDir = path.join(codexHome, 'hooks');
  mkdirp(hookDir);
  const hookPyTarget = path.join(hookDir, 'ishii_auto_route.py');
  const hookPySrc = path.join(mat, 'hooks', 'ishii_auto_route.py');
  const hookSrcHash = sha256hex(hookPySrc);
  const hookDstHash = exists(hookPyTarget) ? sha256hex(hookPyTarget) : '';
  let hookOverwrite = false;
  let hookIsKnownOld = false;
  if (!hookDstHash) hookOverwrite = true;
  else if (hookDstHash === hookSrcHash) hookOverwrite = true;
  else if (KNOWN_KIT_HOOK_HASHES.includes(hookDstHash.toLowerCase())) { hookOverwrite = true; hookIsKnownOld = true; }
  else if (force) hookOverwrite = true;

  if (hookOverwrite) {
    if (hookDstHash && hookDstHash !== hookSrcHash) {
      mkdirp(path.join(backup, 'hooks'));
      copyFileF(hookPyTarget, path.join(backup, 'hooks', 'ishii_auto_route.py'));
      if (hookIsKnownOld) info('  [upgrade] 检测到本 Kit 旧版 hooks 脚本（带 PreToolUse 夹层 bug），已升级为修复版');
      else if (force) info('  [force] hooks 脚本已被 --force 覆盖（旧文件已备份到 backup/hooks/）');
      else info('  [deploy] hooks 脚本已被覆盖（旧文件已备份到 backup/hooks/）');
    } else if (!hookDstHash) {
      info('  [deploy] hooks 脚本不存在，安装修复版');
    } else {
      info('  [keep] hooks 脚本与包内版本一致，无需改动');
    }
    copyFileF(hookPySrc, hookPyTarget);
  } else {
    mkdirp(path.join(backup, 'hooks'));
    copyFileF(hookPyTarget, path.join(backup, 'hooks', 'ishii_auto_route.py.preexisting'));
    info('  [skip] 目标 hooks/ishii_auto_route.py 是本机自定义版本（非本 Kit 已知旧版），保留不动');
    info('         原文件已备份到 backup/hooks/ishii_auto_route.py.preexisting');
    info('         如需强制换成本 Kit 修复版，请加 --force 重跑安装');
  }

  const promptsDir = path.join(codexHome, 'prompts');
  mkdirp(promptsDir);
  if (exists(path.join(promptsDir, 'eni-solo-v4.0.0.md'))) {
    copyFileF(path.join(promptsDir, 'eni-solo-v4.0.0.md'), path.join(backup, 'eni-solo-v4.0.0.md'));
  }
  copyFileF(path.join(mat, 'prompts', 'eni-solo-v4.0.0.md'), path.join(promptsDir, 'eni-solo-v4.0.0.md'));

  const soloDir = path.join(codexHome, 'eni-solo');
  if (exists(soloDir)) moveTo(soloDir, path.join(backup, 'eni-solo'));
  copyDirF(path.join(mat, 'eni-solo'), soloDir);

  const modelsTarget = path.join(codexHome, 'models.json');
  if (exists(modelsTarget)) {
    copyFileF(modelsTarget, path.join(backup, 'models.json'));
    info('  [preserve] models.json 已存在，保留用户原有模型清单（不覆盖）');
  } else {
    copyFileF(path.join(mat, 'models.json'), modelsTarget);
    info('  [deploy] models.json 不存在，部署默认模型清单');
  }

  // ── [5.5/9] tools
  setStep('[5.5/9] tools');
  const toolsMat = path.join(mat, 'tools');
  if (exists(toolsMat)) {
    const toolsDir = path.join(codexHome, 'tools');
    mkdirp(toolsDir);
    copyDirF(toolsMat, toolsDir);
    info('  [deploy] tools/ (含 shiyi_assembler.py) 部署完成');
  }

  // ── [6/9] skills（分阶段安装）
  setStep('[6/9] skills staged install');
  step('[6/9] skills staged install');
  const skillsRoot = path.join(codexHome, 'skills');
  mkdirp(skillsRoot);
  const installed = [];
  const bomFixed = [];
  for (const name of listDirs(path.join(mat, 'skills'))) {
    const srcDir = path.join(mat, 'skills', name);
    const target = path.join(skillsRoot, name);
    const stage = path.join(skillsRoot, `.eni-solo-stage-${name}-${stamp}`);
    copyDirF(srcDir, stage);
    // 就地修掉包自带 SKILL.md 的 UTF-8 BOM（否则 codex 静默丢弃该技能，见函数注释）
    bomFixed.push(...stripBomFromSkillMd(stage));
    if (exists(target)) moveTo(target, path.join(backup, name));
    if (DRY) { dryLog(`移入: ${stage} -> ${target}`); }
    else {
      try { fs.renameSync(stage, target); }
      catch {
        copyDirF(stage, target);
        rmrf(stage);
      }
    }
    installed.push(name);
  }
  info(`skills installed: ${installed.length}`);
  if (bomFixed.length) {
    info(`  [fix] 剥离 SKILL.md 的 UTF-8 BOM：${bomFixed.length} 个（不修则 codex 会静默丢弃这些技能）`);
    for (const p of bomFixed) info(`        ${p.replace(codexHome, '~/.codex')}`);
  }
  ctx.installed = installed;
  ctx.bomFixed = bomFixed;

  // ── [7/9] slo-runtime + ColdBrew
  setStep('[7/9] slo-runtime, ColdBrew');
  step('[7/9] slo-runtime, ColdBrew');
  const rtDir = path.join(codexHome, 'slo-runtime');
  if (exists(path.join(rtDir, 'eni-solo'))) moveTo(path.join(rtDir, 'eni-solo'), path.join(backup, 'slo-runtime-eni-solo'));
  mkdirp(rtDir);
  copyDirF(path.join(mat, 'slo-runtime'), rtDir);

  // 适配运行时文本文件里的绝对用户路径
  const TEXT_EXT = new Set(['.md', '.json', '.ps1', '.py', '.toml', '.txt', '.csv', '.slo']);
  const rtSolo = path.join(rtDir, 'eni-solo');
  const adaptTextFiles = (dir) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of names) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { adaptTextFiles(p); continue; }
      if (!ent.isFile() || !TEXT_EXT.has(path.extname(ent.name).toLowerCase())) continue;
      let raw;
      try { raw = readText(p); } catch { continue; }
      if (raw.includes('C:\\Users\\Administrator')) writeFileUtf8(p, expandPaths(raw, codexHome, home));
    }
  };
  if (exists(rtSolo)) adaptTextFiles(rtSolo);
  info('  [i] slo-runtime 已部署（mac 上不注册 hook：slo-runtime-hook.exe 为 Windows 二进制，见 README）');

  // ColdBrew：材料里没有就跳过（ps1 有守卫）
  const coldBrewMat = path.join(mat, 'ColdBrew');
  if (exists(coldBrewMat)) {
    warn('materials/ColdBrew 存在但 v1 未移植其目标探测（Windows 的 %LOCALAPPDATA%\\ColdBrew）—— 已跳过');
  } else {
    info('  [i] materials/ColdBrew 不存在 —— 跳过（与 ps1 守卫同语义）');
  }

  // ── Astra6（v1 未移植，默认跳过）
  step('[+step] astra6 pool middleware');
  info('  [skip] astra6 号池中间件在 macOS 上未移植（Windows 专属：pool_proxy.py / patch_pool.py / 多盘符扫描）—— 已跳过');
  const astraOk = false;

  // ── [8/9] hook trust sync
  setStep('[8/9] hook trust sync (app-server oracle)');
  step('[8/9] hook trust sync (app-server oracle)');
  const trustScript = path.join(scriptDir, 'helpers', 'Sync-HookTrust-macos.py');
  const trustScriptFallback = path.join(ctx.pack, 'Sync-HookTrust.py');
  let trustRc = -1;
  if (DRY) {
    dryLog(`python ${trustScript} --home ${codexHome}`);
    trustRc = 0;
  } else if (!ctx.python) {
    warn('信任同步跳过（无 python3）—— 不影响文件部署');
  } else {
    const script = exists(trustScript) ? trustScript : (exists(trustScriptFallback) ? trustScriptFallback : null);
    if (!script) {
      warn('包内缺少 Sync-HookTrust.py —— 钩子可能因未受信任而被 Codex 静默跳过');
    } else {
      const codexBin = whichSync('codex');
      const args = [script, '--home', codexHome];
      if (codexBin) args.push('--codex', codexBin);
      const r = spawnSync(ctx.python, args, { encoding: 'utf8' });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      for (const l of out.split('\n')) if (/\[trust\]|\[FAIL\]|\[WARN\]|OK |FAIL /.test(l)) info(`        | ${l}`);
      trustRc = r.status === null ? -1 : r.status;
      switch (trustRc) {
        case 0: ok('全部钩子已可信（trusted_hash 与 Codex 实际声明逐一匹配）'); break;
        case 3: warn('没找到 codex 可执行文件 —— 已跳过信任同步'); break;
        case 4: warn('本机 Codex 版本过旧，不支持 hooks/list（该版本 hooks 一般不受信任门控约束）'); break;
        case 5: warn('写入后复查仍有钩子不可信'); break;
        case 6: warn('hooks.json 声明了钩子，但 Codex 一个都没装载（config.toml 失效或 hooks 被关闭）'); break;
        default: warn(`信任同步退出码 ${trustRc}`); break;
      }
      if (trustRc !== 0) {
        info('  +-- 钩子未受信任时的兜底方案 ---------------------------------');
        info('  | 1) 重启 Codex 并新建会话；若弹窗询问是否信任钩子，选「信任 / Trust」');
        info(`  | 2) 手动补信任：${ctx.python} "${script}" --home "${codexHome}"`);
        info('  | 3) 仍不行，把上面 [trust] 开头的整段输出反馈给包作者');
        info('  +--------------------------------------------------------------');
      }
    }
  }

  // ── [9/9] 自检 + manifest
  setStep('[9/9] 部署完整性自检');
  step('[9/9] 部署完整性自检');

  // v1.3.6 反夹层自检（不依赖磁盘，dry-run 也跑）
  for (const toolEvt of TOOL_EVENTS) {
    if (ctx.targetHooks.hooks && Object.prototype.hasOwnProperty.call(ctx.targetHooks.hooks, toolEvt)) {
      for (const entry of arrOf(ctx.targetHooks.hooks[toolEvt])) {
        if (KIT_ENTRY_RE.test(JSON.stringify(entry))) {
          die(`hooks.json 的工具事件 ${toolEvt} 仍挂着本 Kit 条目 -> 会撕开 tool_calls/tool-output 相邻性`);
        }
      }
    }
  }

  if (DRY) {
    info('  [DRY] 跳过磁盘自检（dry-run 不写盘）：AGENTS.md / hooks / prompts / eni-solo / slo-runtime');
    info('  [OK] 反夹层校验通过（内存态 hooks.json 未注册工具事件）');
  } else {
    const checks = {
      agents: exists(path.join(codexHome, 'AGENTS.md')),
      hooks: exists(path.join(codexHome, 'hooks', 'ishii_auto_route.py')),
      prompts: exists(path.join(codexHome, 'prompts', 'eni-solo-v4.0.0.md')),
      eni_solo: exists(path.join(codexHome, 'eni-solo')),
      slo_runtime: exists(path.join(codexHome, 'slo-runtime', 'eni-solo')),
    };
    const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    if (failed.length > 0) die(`缺少核心破甲组件: ${failed.join(', ')}`);
    ok('破甲核心组件部署完整');

    const hookText = readText(path.join(codexHome, 'hooks', 'ishii_auto_route.py'));
    if (FORBIDDEN_HOOK_RE.test(hookText)) {
      die('hooks 脚本仍含工具事件注入 -> 会触发 No tool output found for tool call (400)');
    }
    ok('反夹层校验通过（hooks 零工具事件注入 / hooks.json 未注册工具事件）');
    ok('目标用户 config.toml 与 models.json 账号/模型配置已完整保留');
  }

  // ── manifest
  setStep('[9/9] install manifest');
  step('[9/9] install manifest');
  const result = {
    name: 'eni-solo',
    version: KIT_VERSION,
    replica_of: REPLICA_OF,
    installed_at: new Date().toISOString(),
    codex_home: codexHome,
    installed_skills: installed.length,
    skill_bom_fixed: (ctx.bomFixed || []).length,
    hooks_installed: true,
    astra6_pool_patch: astraOk,
    config_toml_sha256: cfgSha,
    config_toml_modified_by_this_install: false,
    l1_pointer_scan: l1ScanNote,
    backup,
    notes: [
      'AGENTS.md/hooks/skills/runtime deployed; user config.toml and models.json preserved',
      'non-invasive mode: user model/provider/login/config are never modified',
      'restart Codex to activate',
      `skill_bom_fixed=${(ctx.bomFixed || []).length}：安装时就地剥掉包自带 SKILL.md 的 UTF-8 BOM，否则 codex 会报 missing YAML frontmatter 并静默丢弃这些技能`,
    ],
  };
  const manifestPath = path.join(codexHome, `eni-solo-replica-install-manifest-${stamp}.json`);
  writeFileUtf8(manifestPath, JSON.stringify(result, null, 2) + '\n');
  info(JSON.stringify(result, null, 2));

  console.log('');
  console.log('DONE. Restart Codex to activate.');
  console.log(`Install manifest: ${manifestPath}`);
  return 0;
}

// ═══════════════════════════════════════════════════════════════════
//  卸载（等价 Uninstall.ps1）
// ═══════════════════════════════════════════════════════════════════

function findLatestBackup(codexHome) {
  const root = path.join(codexHome, 'backups');
  let names = [];
  try { names = fs.readdirSync(root); } catch { return null; }
  const cands = names.filter((n) => /^eni-solo-.*-replica-/.test(n))
    .filter((n) => { const st = safeLstat(path.join(root, n)); return st && st.isDirectory(); })
    .sort();
  return cands.length ? path.join(root, cands[cands.length - 1]) : null;
}

function runUninstall() {
  const { opts, codexHome } = ctx;
  const stamp = ts();
  step(`Uninstall eni-solo ${KIT_VERSION}  ->  ${codexHome}`);

  // 运行中 Codex 检测（同样排除常驻 app-server）
  const { running } = detectCodexProcs();
  if (running.length > 0 && !opts.force) {
    die(`检测到 Codex 主程序正在运行，请完全退出后重试（或加 --force 强制继续）`);
  }

  const safety = path.join(codexHome, 'backups', `pre-uninstall-${stamp}`);
  mkdirp(safety);

  // [1/5] 定位最近一次安装备份
  info('[1/5] 定位安装备份');
  const backupDir = findLatestBackup(codexHome);
  if (backupDir) info(`  安装备份: ${backupDir}`);
  else warn('没有 eni-solo-*-replica-* 备份，只做管理块剥离兜底');

  const restoreItem = (name, srcName) => {
    if (!backupDir) return;
    const src = path.join(backupDir, srcName === undefined ? name : srcName);
    const dst = path.join(codexHome, name);
    if (!exists(src)) return;
    if (exists(dst)) {
      const safeDst = path.join(safety, name);
      mkdirp(path.dirname(safeDst));
      if (DRY) dryLog(`备份当前: ${dst} -> ${safeDst}`); else copyDirF(dst, safeDst);
      rmrfF(dst);
    }
    mkdirp(path.dirname(dst));
    if (DRY) dryLog(`回滚: ${src} -> ${dst}`); else copyDirF(src, dst);
    ok(`已回滚: ${name}`);
  };

  // [2/5] 按备份回滚
  info('[2/5] 按备份回滚');
  restoreItem('AGENTS.md');
  restoreItem('hooks.json');
  restoreItem('hooks');
  restoreItem(path.join('prompts', 'eni-solo-v4.0.0.md'));
  restoreItem('eni-solo');
  // 备份目录里 slo-runtime-eni-solo -> slo-runtime/eni-solo
  if (backupDir && exists(path.join(backupDir, 'slo-runtime-eni-solo'))) {
    const dst = path.join(codexHome, 'slo-runtime', 'eni-solo');
    if (exists(dst)) { mkdirp(path.join(safety, 'slo-runtime')); if (!DRY) copyDirF(dst, path.join(safety, 'slo-runtime', 'eni-solo')); rmrfF(dst); }
    mkdirp(path.dirname(dst));
    if (DRY) dryLog(`回滚: slo-runtime-eni-solo -> ${dst}`); else copyDirF(path.join(backupDir, 'slo-runtime-eni-solo'), dst);
    ok('已回滚: slo-runtime/eni-solo');
  }
  restoreItem('models.json');
  restoreItem('ColdBrew');
  restoreItem('tools');

  // skills 逐目录回滚：备份目录里除已知项外的条目（目录或符号链接）都视为技能目录。
  // 注意（相对 ps1 的修正）：install 把技能备份到 backup/<name>（扁平），而 Uninstall.ps1
  // 从 backup/skills/<name> 取 —— 那个路径从不存在，Windows 版实际不会恢复技能。
  // mac 版按真实落盘布局从 backup/<name> 还原到 <codexHome>/skills/<name>。
  if (backupDir) {
    const FIXED = new Set(['hooks', 'eni-solo', 'slo-runtime-eni-solo', 'ColdBrew', 'tools']);
    let names = [];
    try { names = fs.readdirSync(backupDir).sort(); } catch { /* ignore */ }
    for (const d of names) {
      if (FIXED.has(d)) continue;
      const st = safeLstat(path.join(backupDir, d));
      if (!st) continue;
      if (!st.isDirectory() && !st.isSymbolicLink()) continue; // 跳过 config.toml/hooks.json/models.json 等文件
      restoreItem(path.join('skills', d), d);
    }
  }

  // 兜底删除注入 prompt（备份里没有、但属于注入面）
  const promptsDir = path.join(codexHome, 'prompts');
  if (exists(promptsDir)) {
    let names = [];
    try { names = fs.readdirSync(promptsDir); } catch { /* ignore */ }
    for (const n of names) {
      if (!/^eni-solo-.*\.md$/.test(n)) continue;
      const p = path.join(promptsDir, n);
      if (DRY) { dryLog(`删除注入 prompt: ${n}`); continue; }
      copyFileF(p, path.join(safety, `prompts-${n}`));
      fs.rmSync(p, { force: true });
      ok(`已删除注入 prompt: ${n}`);
    }
  }

  // [3/5] config.toml 管理块剥离
  info('[3/5] config.toml 管理块剥离');
  const cfgPath = path.join(codexHome, 'config.toml');
  if (exists(cfgPath)) {
    if (DRY) dryLog(`备份 + 剥离管理块: ${cfgPath}`);
    else {
      copyFileF(cfgPath, path.join(safety, 'config.toml'));
      let cfg = readText(cfgPath);
      cfg = cfg.replace(/\r?\n?# SLO-RUNTIME:eni-solo:BEGIN[\s\S]*?# SLO-RUNTIME:eni-solo:END\r?\n?/g, '\n');
      cfg = cfg.replace(/\r?\n?# SLO-RUNTIME:eni-solo:HOOK-TRUST:BEGIN[\s\S]*?# SLO-RUNTIME:eni-solo:HOOK-TRUST:END\r?\n?/g, '\n');
      cfg = cfg.replace(/^model_instructions_file\s*=.*\r?\n/gm, '');
      cfg = cfg.replace(/^# \[eni-replaced\] (.*)\r?\n/gm, '$1\r\n');
      writeFileUtf8(cfgPath, cfg);
      ok('config.toml 管理块已剥离');
    }
  } else {
    info('  [i] config.toml 不存在，跳过');
  }

  // [4/5] hooks.json 注入条目移除
  info('[4/5] hooks.json 注入条目移除');
  const hooksPath = path.join(codexHome, 'hooks.json');
  if (exists(hooksPath)) {
    try {
      const hj = JSON.parse(stripBom(readText(hooksPath)));
      let removed = 0;
      if (hj && hj.hooks && typeof hj.hooks === 'object') {
        for (const evt of Object.keys(hj.hooks)) {
          const kept = arrOf(hj.hooks[evt]).filter((e) => {
            if (KIT_ENTRY_RE.test(JSON.stringify(e))) { removed++; return false; }
            return true;
          });
          hj.hooks[evt] = kept;
        }
      }
      if (DRY) dryLog(`写回 ${hooksPath}（移除 ${removed} 条）`);
      else writeFileUtf8(hooksPath, JSON.stringify(hj, null, 2) + '\n');
      ok(`移除注入条目: ${removed}`);
    } catch (e) {
      warn(`hooks.json 清理失败（跳过）: ${e.message}`);
    }
  } else {
    info('  [i] hooks.json 不存在，跳过');
  }

  // [5/5] PurgeAll 深度清理
  info('[5/5] PurgeAll 深度清理');
  if (opts.purge) {
    const bkRoot = path.join(codexHome, 'backups');
    let bnames = [];
    try { bnames = fs.readdirSync(bkRoot); } catch { /* ignore */ }
    for (const n of bnames) {
      if (!/^eni-solo-.*-replica-/.test(n)) continue;
      rmrfF(path.join(bkRoot, n));
      ok(`删备份: ${n}`);
    }
    let cnames = [];
    try { cnames = fs.readdirSync(codexHome); } catch { /* ignore */ }
    for (const n of cnames) {
      if (!/^eni-solo-replica-install-manifest-.*\.json$/.test(n)) continue;
      rmrfF(path.join(codexHome, n));
      ok(`删 manifest: ${n}`);
    }
    const stateDir = path.join(codexHome, 'shiyi-route-state');
    if (exists(stateDir)) {
      let snames = [];
      try { snames = fs.readdirSync(stateDir); } catch { /* ignore */ }
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
      for (const n of snames) {
        const p = path.join(stateDir, n);
        try { if (fs.statSync(p).isFile() && fs.statSync(p).mtimeMs < cutoff) rmrfF(p); } catch { /* ignore */ }
      }
      ok('shiyi-route-state 7 天前状态已清');
    }
    const sbDir = path.join(codexHome, 'sandbox');
    if (exists(sbDir)) {
      let snames = [];
      try { snames = fs.readdirSync(sbDir); } catch { /* ignore */ }
      for (const n of snames) if (n.includes('acl_state')) rmrfF(path.join(sbDir, n));
      ok('sandbox/*acl_state* 残留已清');
    }
    const soloDir = path.join(codexHome, 'eni-solo');
    if (exists(soloDir)) { rmrfF(soloDir); ok('eni-solo 目录已清'); }
    const asmPath = path.join(codexHome, 'tools', 'shiyi_assembler.py');
    if (exists(asmPath)) { rmrfF(asmPath); ok('tools/shiyi_assembler.py 已清'); }
  } else {
    info('  [i] 未指定 --purge，备份/manifest/状态文件保留');
  }

  console.log('');
  console.log('DONE. Restart Codex to activate.');
  console.log(`卸载前保险副本: ${safety}`);
  return 0;
}

// ═══════════════════════════════════════════════════════════════════
//  main
// ═══════════════════════════════════════════════════════════════════

function resolvePack(explicit) {
  const valid = (d) => {
    try { return exists(path.join(d, 'materials', 'AGENTS.md')) && exists(path.join(d, 'materials', 'hooks.json')); }
    catch { return false; }
  };
  const cands = [];
  if (explicit) cands.push(expandHome(explicit));
  cands.push(scriptDir);
  let up = scriptDir;
  for (let i = 0; i < 6; i++) {
    const next = path.dirname(up);
    if (next === up) break;
    up = next;
    // <root>/macos/installers/codex → <root>/packs/codex（打包后的 Resources/packs 布局）
    cands.push(path.join(up, 'packs', 'codex'));
    // 开发期常见布局：与 fork 仓库同级/上层的源码包（02-源码/<ver>/packs/codex）
    for (const rel of ['02-源码', 'source', 'src']) {
      const srcRoot = path.join(up, rel);
      let vers = [];
      try { vers = fs.readdirSync(srcRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse(); }
      catch { continue; }
      for (const v of vers.slice(0, 3)) cands.push(path.join(srcRoot, v, 'packs', 'codex'));
    }
  }
  // 打包后运行时：脚本被拷进 Resources/packs/codex/，包目录就是脚本所在目录本身
  for (const c of cands) { if (c && valid(c)) return path.resolve(c); }
  if (explicit) die(`--pack 指向的目录不是有效的 codex 破甲包（缺 materials/AGENTS.md 或 materials/hooks.json）: ${explicit}`);
  die('未能自动定位 codex 包目录，请用 --pack <包目录> 指定');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); process.exit(0); }
  DRY = opts.dryRun;

  const pack = resolvePack(opts.pack);
  const home = os.homedir();
  const codexHome = opts.codexHome
    ? expandHome(opts.codexHome)
    : expandHome(process.env.CODEX_HOME || path.join(home, '.codex'));
  const python = opts.python ? expandHome(opts.python) : (whichSync('python3') || whichSync('python'));
  const stamp = ts();

  ctx = { opts, pack, codexHome, home, mat: path.join(pack, 'materials'), stamp, python, step: '' };

  if (DRY) info(`[DRY] dry-run 模式：不写任何文件（stamp=${stamp}）`);
  info(`codex home   : ${codexHome}`);
  info(`pack         : ${pack}`);

  preflight();

  if (opts.uninstall) return runUninstall();
  return runInstall();
}

try {
  const code = main();
  process.exit(code === undefined ? 0 : code);
} catch (e) {
  console.error('');
  console.error(C.red('============================================================'));
  console.error(C.red('  [安装失败] codex 破甲包安装器中止'));
  console.error(C.red('============================================================'));
  console.error(`  失败步骤 : ${ctx ? ctx.step : '(尚未进入任何步骤)'}`);
  console.error(`  错误信息 : ${e && e.message ? e.message : e}`);
  if (ctx && ctx.backup) console.error(`  备份目录 : ${ctx.backup}`);
  if (ctx) console.error(`  Codex 目录: ${ctx.codexHome}`);
  console.error('');
  console.error('  说明：这不是 Codex 本身坏了，是安装器没跑完。处理办法：');
  console.error('   1) 截图上面这一段（含 失败步骤 / 错误信息）发给包作者');
  console.error('   2) 若已生成备份目录，装前的 hooks.json / config.toml / AGENTS.md 都在里面');
  console.error('   3) 本脚本只改规则层；config.toml 的账号、模型、供应商配置始终原样保留');
  console.error(C.red('============================================================'));
  process.exit(1);
}
