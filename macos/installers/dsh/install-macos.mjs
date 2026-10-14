#!/usr/bin/env node
// ============================================================
//  DSH 破甲懒人包 v5.7.0 — macOS 安装器（Node 版）
//  社区 fork（mac 分支）：install.ps1 的等价移植，供「苏苏 AI超频」在 macOS 上调用。
//
//  用法:
//    node install-macos.mjs [--pack <包目录>] [--dsh-home <目录>] [--profile web]
//                           [--uninstall] [--dry-run] [--skip-skills] [--lean]
//                           [--no-restart] [--no-open-links] [--no-cold-coffee]
//                           [--shell-env] [--dsh-bases <列表>] [--port 3080] [--help]
//
//  与 install.ps1 的 Windows→macOS 语义映射:
//    Junction                          -> fs.symlinkSync(target, link, 'dir')
//    Get-Date -Format 'yyyyMMdd-HHmmss'-> 同格式本地时间戳（STAMP）
//    $env:LOCALAPPDATA\npm-cache\_npx  -> ~/.npm/_npx
//    Get-CimInstance Win32_Process      -> ps -axo pid=,ppid=,command=
//    Start-Process <url>               -> open <url>
//    用户环境变量（注册表）             -> <dshHome>/env.sh（--shell-env 追加进 shell 启动文件）
//    备份                              -> *.bak-dsh-lazy-v5 / *.bak-v5（同 ps1）
//                                         + <dshHome>/backups/<时间戳>/（写前快照，按内容去重）
//
//  安全: 测试一律用 --dsh-home /private/tmp/dsh-test（macOS 的 /tmp 是符号链接，
//        必须用 /private/tmp）。不要指向正在使用的 ~/.dsh。
// ============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const TOOL_VERSION = '5.7.0-mac.1';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════════════════════════════════
//  CLI
// ═══════════════════════════════════════════════════════════════════

function die(msg) { throw new Error(msg); }

function parseArgs(raw) {
  const opts = {
    pack: null, dshHome: null, profile: 'web',
    uninstall: false, dryRun: false, skipSkills: false, lean: false,
    noRestart: false, noOpenLinks: false, noColdCoffee: false,
    forcePromptInject: false, shellEnv: false,
    dshBases: null, port: 3080, help: false,
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
      case '--dsh-home': opts.dshHome = val('--dsh-home'); break;
      case '--profile': opts.profile = val('--profile'); break;
      case '--dsh-bases': opts.dshBases = val('--dsh-bases'); break;
      case '--port': {
        const v = Number(val('--port'));
        if (!Number.isInteger(v) || v < 1 || v > 65535) die('--port 必须是 1-65535 的整数');
        opts.port = v;
        break;
      }
      case '--uninstall': opts.uninstall = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--skip-skills': opts.skipSkills = true; break;
      case '--lean': opts.lean = true; break;
      case '--no-restart': opts.noRestart = true; break;
      case '--no-open-links': opts.noOpenLinks = true; break;
      case '--no-cold-coffee': opts.noColdCoffee = true; break;
      case '--force-prompt-inject': opts.forcePromptInject = true; break; // ps1 同款兼容参数（当前无行为）
      case '--shell-env': opts.shellEnv = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (tok.startsWith('-')) die(`未知参数: ${tok}（--help 查看用法）`);
        die(`多余的位置参数: ${tok}（--help 查看用法）`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`DSH 破甲懒人包 v5（石井 · SHIYI-DSH）macOS 安装器 v${TOOL_VERSION}
纯 Node（>=18，零依赖）— install.ps1 的等价实现。

用法:
  node install-macos.mjs [选项]
  ./install-macos.mjs [选项]                # chmod 755 后可直接运行

选项:
  --pack <目录>        包根目录（含 install.ps1 / materials / plugins / tools）。
                       默认按脚本位置推导（脚本旁 pack/、dsh-pack/，或向上找 packs/dsh）
  --dsh-home <目录>    DSH 配置根。默认 $DSH_HOME，未设置时 ~/.dsh
  --profile <名>       DSH profile 名（默认 web）
  --uninstall          卸载（按备份与标记精准回滚）
  --dry-run            只打印将执行的操作，不写任何文件、不重启
  --skip-skills        跳过技能包安装（150+，约省 30 秒）
  --lean               精简插件集：跳过 super-injector（只装 purge/prompt-inject/shield）
  --no-restart         安装/卸载后不自动重启 DSH
  --no-open-links      不自动打开官网/QQ群链接（仅打印）
  --no-cold-coffee     不注册「冷咖啡」急救模板
  --shell-env          额外把 env.sh 的 source 行写入 ~/.zshrc / ~/.bash_profile（幂等）
  --dsh-bases <列表>   显式指定 DSH 运行时 base（逗号分隔，每项含 dsh-agent-instructions/lib）。
                       默认自动探测（~/.npm/_npx、运行进程、npm 全局、DSH_BASE）。
                       测试/CI 用，可把补丁目标限定到夹具目录
  --port <端口>        重启后探活端口（默认 3080）
  --force-prompt-inject  兼容参数（与 ps1 相同：当前无行为）
  --help               显示本帮助

示例:
  node install-macos.mjs --pack ../dsh-pack --dsh-home /private/tmp/dsh-test --no-restart --no-open-links
  node install-macos.mjs --uninstall --dsh-home /private/tmp/dsh-test --no-restart

安全提示: 测试请使用 --dsh-home /private/tmp/dsh-test；不要指向正在使用的 ~/.dsh。`);
}

// ═══════════════════════════════════════════════════════════════════
//  日志（沿用 install.ps1 的 [OK] / [WARN] / ==> 样式与阶段编号）
// ═══════════════════════════════════════════════════════════════════

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const C = {
  cyan: (s) => paint(36, s),
  green: (s) => paint(32, s),
  yellow: (s) => paint(33, s),
  red: (s) => paint(31, s),
};
function step(msg) { console.log(C.cyan(`==> ${msg}`)); }
function ok(msg) { console.log(C.green(`[OK] ${msg}`)); }
function warn(msg) { console.log(C.yellow(`[WARN] ${msg}`)); }
function info(msg) { console.log(msg); }
function dryLog(msg) { console.log(`[DRY] ${msg}`); }

// ═══════════════════════════════════════════════════════════════════
//  通用小工具
// ═══════════════════════════════════════════════════════════════════

let DRY = false;

function expandHome(p) {
  if (!p) return p;
  let s = String(p);
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/')) s = path.join(os.homedir(), s.slice(2));
  s = s.replace(/^\$HOME(?=$|[\\/])/, os.homedir());
  return path.resolve(s);
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeLstat(p) { try { return fs.lstatSync(p); } catch { return null; } }
function safeReal(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
function readText(p) { return fs.readFileSync(p, 'utf8'); }
function readJson(p) { return JSON.parse(readText(p).replace(/^\uFEFF/, '')); }

function mkdirp(d) { if (!DRY) fs.mkdirSync(d, { recursive: true }); }
function copyFileF(src, dst) {
  if (DRY) { dryLog(`复制文件: ${src} -> ${dst}`); return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
function writeFileF(p, text) {
  if (DRY) { dryLog(`写入文件: ${p}`); return; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
function appendFileF(p, text) { if (!DRY) fs.appendFileSync(p, text); }
function rmrfF(p) { if (DRY) { dryLog(`删除: ${p}`); return; } fs.rmSync(p, { recursive: true, force: true }); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }

function listDirNames(d) { try { return fs.readdirSync(d).sort(); } catch { return []; } }
function listDirs(d) {
  const out = [];
  for (const n of listDirNames(d)) {
    const st = safeLstat(path.join(d, n));
    if (st && st.isDirectory() && !st.isSymbolicLink()) out.push(n);
  }
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function filesEqual(a, b, norm) {
  try {
    let ta = readText(a);
    let tb = readText(b);
    if (norm) { ta = norm(ta); tb = norm(tb); }
    return ta === tb;
  } catch { return false; }
}

// 备份去重/变化判定的默认归一化：
//  - .json 按语义比较（格式化、缩进、末尾换行差异不算变化）
//  - 其余忽略行尾空白与末尾空行
function normText(rel, text) {
  let t = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (/\.json$/i.test(rel)) {
    try { return JSON.stringify(JSON.parse(t)); } catch { /* 非法 JSON 走文本规则 */ }
  }
  return t.replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
}

function hashTree(root) {
  const h = crypto.createHash('sha1');
  const walk = (dir, rel) => {
    let names;
    try { names = fs.readdirSync(dir).sort(); } catch { h.update('ERR\0'); return; }
    for (const n of names) {
      const p = path.join(dir, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = safeLstat(p);
      if (!st) continue;
      if (st.isDirectory()) { h.update(`D:${r}\n`); walk(p, r); }
      else if (st.isSymbolicLink()) { let t = ''; try { t = fs.readlinkSync(p); } catch {} h.update(`L:${r}:${t}\n`); }
      else if (st.isFile()) h.update(`F:${r}:${st.size}:${crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')}\n`);
    }
  };
  walk(root, '');
  return h.digest('hex');
}
function treesEqual(a, b) { try { return hashTree(a) === hashTree(b); } catch { return false; } }

function pruneEmptyDirs(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = path.join(dir, n);
    const st = safeLstat(p);
    if (st && st.isDirectory()) {
      pruneEmptyDirs(p);
      try { if (fs.readdirSync(p).length === 0) fs.rmdirSync(p); } catch {}
    }
  }
}

// super-injector registry 的归一化比较：忽略易变的 at 时间戳，只比 name/dir
function regNorm(text) {
  try {
    let arr = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    if (arr && !Array.isArray(arr) && Array.isArray(arr.value)) arr = arr.value;
    if (!Array.isArray(arr)) return String(text);
    return JSON.stringify(
      arr.map((x) => [x && x.name, x && x.dir]).sort((p, q) => String(p[0]).localeCompare(String(q[0])))
    );
  } catch { return String(text); }
}

// registry 是否已有条目（空表没有可保护的内容，覆盖前不必备份）
function regHasEntries(text) {
  try {
    let arr = JSON.parse(String(text).replace(/^\uFEFF/, ''));
    if (arr && !Array.isArray(arr) && Array.isArray(arr.value)) arr = arr.value;
    return Array.isArray(arr) && arr.length > 0;
  } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════════
//  备份日志（backups/<时间戳>/，写前快照 + 按内容去重，重复执行不重复备份）
// ═══════════════════════════════════════════════════════════════════

class BackupJournal {
  constructor(dshHome, stamp, dry) {
    this.dshHome = dshHome;
    this.stamp = stamp;
    this.dry = dry;
    this.baseDir = path.join(dshHome, 'backups', stamp);
    this.pending = new Map(); // rel -> { abs, kind: 'file'|'dir', norm }
    this.done = false;
  }
  get pendingDir() { return path.join(this.baseDir, '.pending'); }

  snapshotFile(rel, abs, norm) {
    if (this.dry || this.done || this.pending.has(rel)) return;
    try {
      if (!fs.existsSync(abs)) return;
      const st = fs.lstatSync(abs);
      if (!st.isFile()) return;
      const dst = path.join(this.pendingDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(abs, dst);
      this.pending.set(rel, { abs, kind: 'file', norm });
    } catch (e) { warn(`备份暂存失败（忽略）: ${rel}: ${e.message}`); }
  }

  snapshotDir(rel, absDir) {
    if (this.dry || this.done || this.pending.has(rel)) return;
    try {
      if (!fs.existsSync(absDir)) return;
      const st = fs.lstatSync(absDir);
      if (!st.isDirectory() || st.isSymbolicLink()) return;
      const dst = path.join(this.pendingDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(absDir, dst, { recursive: true });
      this.pending.set(rel, { abs: absDir, kind: 'dir' });
    } catch (e) { warn(`备份暂存失败（忽略）: ${rel}: ${e.message}`); }
  }

  commit() {
    if (this.dry || this.done) return;
    this.done = true;
    let any = false;
    for (const [rel, info] of this.pending) {
      const cur = path.join(this.pendingDir, rel);
      const norm = info.norm || ((s) => normText(rel, s));
      try {
        const unchanged = info.kind === 'file'
          ? filesEqual(cur, info.abs, norm)
          : treesEqual(cur, info.abs);
        if (unchanged) { rmrf(cur); continue; }               // 实际没变化 → 丢弃暂存
        if (this._alreadyBackedUp(rel, cur, info)) { rmrf(cur); continue; } // 已有同内容备份 → 不重复
        const dst = path.join(this.baseDir, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(cur, dst);
        any = true;
      } catch (e) { warn(`备份提交失败（忽略）: ${rel}: ${e.message}`); }
    }
    if (!any) { rmrf(this.baseDir); return; }
    rmrf(this.pendingDir);
    pruneEmptyDirs(this.baseDir);
    ok(`备份: ${this.baseDir}`);
  }

  _alreadyBackedUp(rel, cand, info) {
    const root = path.join(this.dshHome, 'backups');
    for (const name of listDirNames(root)) {
      if (name === this.stamp) continue;
      const p = path.join(root, name, rel);
      if (!fs.existsSync(p)) continue;
      try {
        const norm = info.norm || ((s) => normText(rel, s));
        if (info.kind === 'file' ? filesEqual(p, cand, norm) : treesEqual(p, cand)) return true;
      } catch { /* ignore */ }
    }
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  运行时探测（等价 install.ps1 的 Resolve-DshBase / dsh-purge findAiBase）
// ═══════════════════════════════════════════════════════════════════

function isDshBase(d) {
  try { return fs.existsSync(path.join(d, 'dsh-agent-instructions', 'lib')); } catch { return false; }
}

function readBaseVersion(base) {
  for (const rel of [['dsh', 'package.json'], ['..', '..', 'package.json'], ['package.json']]) {
    try {
      const v = JSON.parse(readText(path.join(base, ...rel)).replace(/^\uFEFF/, '')).version;
      if (v) return v;
    } catch { /* try next */ }
  }
  return '?';
}

function compareSemver(a, b) {
  const pa = String(a || '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  const ra = parseInt((String(a).match(/rc\.(\d+)/) || [])[1] || '999', 10);
  const rb = parseInt((String(b).match(/rc\.(\d+)/) || [])[1] || '999', 10);
  return ra - rb;
}

function psList() {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const rows = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
    }
    return rows;
  } catch { return []; }
}

function whichSync(cmd) {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

// 把 "<...>/@deepseek-ai/dsh/lib/bin.js" 反推为候选 base
function basesFromBinReal(binReal) {
  const out = [];
  const m = String(binReal).match(/^(.*)[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/);
  if (m) {
    const aiParent = m[1]; // 含 @deepseek-ai 的那层 node_modules 的父目录
    out.push(path.join(aiParent, '@deepseek-ai')); // npx 布局：与 dsh 同级
    out.push(path.join(aiParent, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')); // 全局安装：嵌套在 dsh 包内
  }
  return out;
}

function resolveDshBin(tok) {
  try {
    let p = tok;
    if (!p.includes('/') && !p.includes('\\')) { p = whichSync(tok); if (!p) return null; }
    const real = fs.realpathSync(p);
    return /[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/.test(real) ? real : null;
  } catch { return null; }
}

// 判断进程是否为 DSH 进程；是则尽量给出其 bin.js 真实路径
function classifyDshProc(cmd) {
  if (!cmd) return { isDsh: false, binJs: null };
  let binJs = null;
  const m = cmd.match(/([^\s"']*@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js)/);
  if (m) return { isDsh: true, binJs: m[1] };
  for (const tok of cmd.split(/\s+/)) {
    if (tok === 'dsh' || /[\\/]dsh$/.test(tok)) {
      const real = resolveDshBin(tok);
      if (real) return { isDsh: true, binJs: real };
    }
  }
  return { isDsh: false, binJs: null };
}

function npmPrefix() {
  try {
    const out = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out && fs.existsSync(out) ? out : null;
  } catch { return null; }
}

// 收集全部 DSH 运行时 base（macOS 版 Resolve-DshBase：进程 > npx 缓存 > DSH_BASE > npm 全局）
function collectDshBases() {
  const found = [];
  const add = (p, source, runtime) => {
    if (!p) return;
    const rp = safeReal(p);
    if (!isDshBase(rp)) return;
    found.push({ path: rp, version: readBaseVersion(rp), runtime: !!runtime, source });
  };

  // 1) 运行中的 DSH 进程（实跑版本，最高优先）
  for (const pr of psList()) {
    if (!pr.cmd) continue;
    for (const m of pr.cmd.matchAll(/([^\s"']*node_modules[\\/]@deepseek-ai)/g)) add(m[1], 'process', true);
    for (const tok of pr.cmd.split(/\s+/)) {
      if (tok === 'dsh' || /[\\/]dsh$/.test(tok)) {
        const real = resolveDshBin(tok);
        if (real) for (const b of basesFromBinReal(real)) add(b, 'process', true);
      }
    }
  }
  // 2) npx 缓存（~/.npm/_npx/<hash>/node_modules/@deepseek-ai）
  const npxRoot = path.join(os.homedir(), '.npm', '_npx');
  for (const name of listDirNames(npxRoot)) add(path.join(npxRoot, name, 'node_modules', '@deepseek-ai'), 'npx', false);
  // 3) DSH_BASE 环境变量
  if (process.env.DSH_BASE && process.env.DSH_BASE.trim()) add(process.env.DSH_BASE.trim(), 'env', false);
  // 4) npm 全局前缀 + `which dsh` 解析
  const prefix = npmPrefix();
  if (prefix) {
    add(path.join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'), 'npm-prefix', false);
    add(path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'), 'npm-prefix', false);
    add(path.join(prefix, 'lib', 'node_modules', '@deepseek-ai'), 'npm-prefix', false);
    add(path.join(prefix, 'node_modules', '@deepseek-ai'), 'npm-prefix', false);
  }
  const whichDsh = resolveDshBin('dsh');
  if (whichDsh) for (const b of basesFromBinReal(whichDsh)) add(b, 'which', false);

  // 去重（同路径优先保留 runtime 标记）
  const byPath = new Map();
  for (const c of found) {
    const prev = byPath.get(c.path);
    if (!prev || (c.runtime && !prev.runtime)) byPath.set(c.path, c);
  }
  return [...byPath.values()];
}

function pickPrimary(bases) {
  const rt = bases.find((c) => c.runtime);
  if (rt) return rt;
  return [...bases].sort((x, y) => compareSemver(y.version, x.version))[0];
}

function parseDshBasesOverride(rawList) {
  const out = [];
  for (const item of String(rawList).split(',')) {
    const s = item.trim();
    if (!s) continue;
    const rp = expandHome(s);
    if (!isDshBase(rp)) warn(`--dsh-bases: ${rp} 缺少 dsh-agent-instructions/lib（仍会尝试）`);
    out.push({ path: rp, version: readBaseVersion(rp), runtime: false, source: 'override' });
  }
  if (out.length === 0) die('--dsh-bases 为空');
  return out;
}

// ═══════════════════════════════════════════════════════════════════
//  执行封装
// ═══════════════════════════════════════════════════════════════════

let NODE_BIN = process.execPath;

function resolveNodeBin() {
  const p = whichSync('node');
  if (p) return p;
  warn(`PATH 中未找到 node，改用当前 Node 解释器: ${process.execPath}`);
  return process.execPath;
}

function helperRun(args, { allowFail = false } = {}) {
  const helper = path.join(ctx.pack, 'tools', 'json-edit.js');
  if (DRY) { dryLog(`node ${helper} ${args.join(' ')}`); return { code: 0, stdout: '', stderr: '' }; }
  if (!fs.existsSync(helper)) die(`缺少 ${helper}（包目录不完整？）`);
  const r = spawnSync(NODE_BIN, [helper, ...args], { encoding: 'utf8' });
  if (r.error) die(`无法执行 json-edit.js: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) die(`node json-edit.js ${args[0]} 失败（exit=${r.status}）\n${r.stderr || ''}`);
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runNodeCapture(args, env, timeoutMs = 120000) {
  if (DRY) { dryLog(`node ${args.join(' ')}`); return { code: 0, out: '' }; }
  const r = spawnSync(NODE_BIN, args, { encoding: 'utf8', env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { code: r.status === null ? 1 : r.status, out };
}

// 目录链接（Junction 等价物）：已指向同一目标则跳过；重建时只删链接本身，绝不进目标
function ensureSymlinkDir(target, link, relForBackup) {
  const t = path.resolve(target);
  const l = path.resolve(link);
  const st = safeLstat(l);
  if (st) {
    if (st.isSymbolicLink()) {
      const cur = safeReal(l);
      const want = safeReal(t);
      if (cur === want) return 'skip';
      if (DRY) { dryLog(`重建链接: ${l} -> ${t}`); return 'relink'; }
      fs.unlinkSync(l); // 只删链接本身
    } else {
      // 非链接（旧目录）：ps1 语义为整体替换；先备份再删除
      warn(`目标已存在且不是链接，替换: ${l}`);
      if (relForBackup) ctx.journal.snapshotDir(relForBackup, l);
      rmrfF(l);
    }
  }
  if (DRY) { dryLog(`创建目录链接: ${l} -> ${t}`); return 'create'; }
  fs.mkdirSync(path.dirname(l), { recursive: true });
  fs.symlinkSync(t, l, 'dir');
  return 'create';
}

function ensureExecutable(p) {
  if (DRY) return;
  try { fs.chmodSync(p, 0o755); } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════════
//  自动重启（等价 Restart-DshRuntime：杀旧 DSH → 同 bin.js 拉起 → 探活 → 开浏览器）
// ═══════════════════════════════════════════════════════════════════

function ancestorPids() {
  const set = new Set();
  let pid = process.pid;
  for (let i = 0; i < 64; i++) {
    let ppid = null;
    try { ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()); } catch { break; }
    if (!ppid || ppid <= 1 || set.has(ppid)) break;
    set.add(ppid);
    pid = ppid;
  }
  return set;
}

function portOpen(host, port, timeoutMs = 900) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { sock.destroy(); } catch {} resolve(v); } };
    const sock = net.createConnection({ host, port });
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

async function restartDshRuntime({ noRestart, dshHome, portHint, noOpenLinks, primary }) {
  if (noRestart) { ok('-NoRestart：跳过自动重启（改动需手动重启 DSH 生效）'); return; }
  if (DRY) { info('[DRY] 跳过自动重启（--dry-run）'); return; }

  // 1) 停止旧 DSH 进程
  let binJs = null;
  const selfChain = ancestorPids();
  selfChain.add(process.pid);
  const killed = [];
  for (const pr of psList()) {
    const r = classifyDshProc(pr.cmd);
    if (!r.isDsh) continue;
    if (selfChain.has(pr.pid)) {
      info(`        | 跳过安装器自身进程链上的 DSH 进程 PID ${pr.pid}（避免自杀式重启）`);
      if (!binJs && r.binJs) binJs = r.binJs;
      continue;
    }
    if (!binJs && r.binJs) binJs = r.binJs;
    try {
      process.kill(pr.pid, 'SIGTERM');
      killed.push(pr.pid);
      ok(`已停止旧 DSH 进程 PID ${pr.pid}`);
    } catch (e) { warn(`停止 PID ${pr.pid} 失败: ${e.message}`); }
  }
  if (killed.length) {
    await sleep(700);
    for (const pid of killed) {
      try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }

  // 2) 兜底：从主运行时推断 bin.js
  if (!binJs && primary) {
    const cand = path.join(primary.path, 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(cand)) binJs = cand;
  }
  if (!binJs || !NODE_BIN) { warn('找不到 DSH bin.js 或 node，跳过自动重启（请手动启动 DSH）'); return; }

  // 3) 拉起（stdout/stderr 重定向到日志，失败时回显尾部）
  const bootLog = path.join(dshHome, 'logs', 'dsh-boot.log');
  mkdirp(path.dirname(bootLog));
  try {
    const fdOut = fs.openSync(bootLog, 'w');
    const fdErr = fs.openSync(`${bootLog}.err`, 'w');
    const child = spawn(NODE_BIN, [binJs, 'web'], { detached: true, stdio: ['ignore', fdOut, fdErr] });
    child.unref();
    try { fs.closeSync(fdOut); fs.closeSync(fdErr); } catch {}
    ok(`DSH 已重新拉起: ${NODE_BIN} ${binJs} web`);
  } catch (e) { warn(`拉起失败: ${e.message}（请手动启动 DSH）`); return; }

  // 4) 探活 15s
  let up = false;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    if (await portOpen('127.0.0.1', portHint)) { up = true; break; }
  }
  if (up) {
    ok(`端口 ${portHint} 已就绪`);
    try { execFileSync('open', [`http://127.0.0.1:${portHint}`], { stdio: 'ignore' }); } catch {}
  } else {
    warn(`等待 15s 端口 ${portHint} 未就绪 —— DSH 很可能启动即崩，以下为启动日志尾部：`);
    let shown = false;
    for (const lf of [`${bootLog}.err`, bootLog]) {
      try {
        const st = fs.statSync(lf);
        if (st.size > 0) {
          const lines = readText(lf).split(/\r?\n/);
          for (const ln of lines.slice(-25)) info(`        | ${ln}`);
          shown = true;
        }
      } catch { /* missing */ }
    }
    if (!shown) warn(`（日志为空）请手动前台运行看报错: ${NODE_BIN} "${binJs}" web`);
    info(`        完整日志: ${bootLog}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  上下文
// ═══════════════════════════════════════════════════════════════════

let ctx = null; // { opts, pack, dshHome, profile, profileDir, pkgPath, journal, stamp, primary, bases }

// ═══════════════════════════════════════════════════════════════════
//  安装主流程（等价 install.ps1，阶段编号沿用 [0/7] … [8/8]）
// ═══════════════════════════════════════════════════════════════════

async function install() {
  const { opts, pack, dshHome, profile, profileDir, pkgPath, stamp, journal } = ctx;
  const Mat = path.join(pack, 'materials');

  // ── [0/7] 环境检查
  step('[0/7] 环境检查');
  NODE_BIN = resolveNodeBin();
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) die(`需要 Node.js >= 18（当前 v${process.versions.node}）`);
  if (!fs.existsSync(pkgPath)) die(`DSH profile not found: ${pkgPath} （先安装并运行过一次 DSH）`);

  let bases;
  let primary;
  if (opts.dshBases) {
    bases = parseDshBasesOverride(opts.dshBases);
    primary = bases[0];
    info(`        | --dsh-bases 已指定 ${bases.length} 个运行时（跳过自动探测）`);
  } else {
    bases = collectDshBases();
    if (bases.length === 0) die('未找到 DSH 运行时（~/.npm/_npx 与 npm 全局目录均无 @deepseek-ai）。先运行一次 dsh 再装。');
    primary = pickPrimary(bases);
  }
  ctx.bases = bases;
  ctx.primary = primary;
  ok(`DSH 运行时: ${primary.path}  版本 ${primary.version}${primary.runtime ? '（实跑进程命中）' : '（版本择优）'}`);

  if (!opts.dshBases && process.env.DSH_BASE && process.env.DSH_BASE.trim()) {
    const envReal = safeReal(expandHome(process.env.DSH_BASE.trim()));
    if (envReal !== primary.path) warn(`DSH_BASE 指向旧位置: ${process.env.DSH_BASE} -> ${primary.path}（将写入 ${path.join(dshHome, 'env.sh')}）`);
  }

  // 推广（与官网/群保持一致；--no-open-links 关闭自动弹窗，仅打印）
  if (opts.noOpenLinks) {
    ok('苏苏官网 https://susu.wiki/  QQ群 1041209479（-NoOpenLinks：未自动打开）');
  } else if (DRY) {
    info('[DRY] 将打开官网 https://susu.wiki/ 与 QQ 群链接');
  } else {
    try { execFileSync('open', ['https://susu.wiki/'], { stdio: 'ignore' }); } catch {}
    try { execFileSync('open', ['https://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=&jump_from=webapi&group_code=1041209479'], { stdio: 'ignore' }); } catch {}
    ok('苏苏官网 https://susu.wiki/  QQ群 1041209479');
  }

  // ── [1] profile package.json 一次性备份（.bak 命名与 ps1 一致）
  const pkgBak = `${pkgPath}.bak-dsh-lazy-v5`;
  journal.snapshotFile(path.posix.join('profiles', profile, 'package.json'), pkgPath);
  if (fs.existsSync(pkgPath) && !fs.existsSync(pkgBak)) {
    copyFileF(pkgPath, pkgBak);
    ok(`profile 备份: ${pkgBak}`);
  }

  // ── [2/7] 安装插件
  step('[2/7] 安装插件（purge / prompt-inject / shield / super-injector）');
  const plugins = opts.lean
    ? ['dsh-purge', 'dsh-prompt-inject', 'dsh-shield']
    : ['dsh-purge', 'dsh-prompt-inject', 'dsh-shield', 'dsh-super-injector'];
  const storeRoot = path.join(dshHome, 'plugins');
  const nm = path.join(profileDir, 'node_modules');
  for (const pl of plugins) {
    const src = path.join(pack, 'plugins', pl);
    if (!fs.existsSync(path.join(src, 'package.json'))) { warn(`缺插件源: ${pl}`); continue; }
    const pkgName = readJson(path.join(src, 'package.json')).name;
    const rel = pkgName; // scoped 包保留 '/'（macOS 路径分隔符）
    const target = path.join(storeRoot, rel);
    rmrfF(target);
    if (!DRY) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(src, target, { recursive: true }); }
    ensureSymlinkDir(target, path.join(nm, rel), path.posix.join('profiles', profile, 'node_modules', rel));
    helperRun(['add-plugin', pkgPath, pkgName, target]);
    ok(`${pkgName} -> ${target}`);
  }
  ensureExecutable(path.join(storeRoot, 'dsh-purge', 'bin', 'dsh-purge.js'));

  // prompt-inject 运行时依赖链接（否则 ERR_MODULE_NOT_FOUND）
  const piDir = path.join(storeRoot, '@wasd258', 'dsh-prompt-inject');
  if (fs.existsSync(piDir)) {
    ensureSymlinkDir(primary.path, path.join(piDir, 'node_modules', '@deepseek-ai'),
      path.posix.join('plugins', '@wasd258', 'dsh-prompt-inject', 'node_modules', '@deepseek-ai'));
    ok('prompt-inject 依赖链接 -> 实跑 DSH 运行时');
  }

  // super-injector registry：登记 prompt-inject + shield 供运行时恢复
  const regPath = path.join(dshHome, 'super-injector', 'registry.json');
  mkdirp(path.dirname(regPath));
  if (fs.existsSync(regPath) && regHasEntries(readText(regPath))) {
    journal.snapshotFile('super-injector/registry.json', regPath, regNorm);
  }
  for (const entry of [
    { name: '@wasd258/dsh-prompt-inject', dir: piDir },
    { name: '@dsh-external/dsh-shield', dir: path.join(storeRoot, '@dsh-external', 'dsh-shield') },
  ]) {
    if (!fs.existsSync(entry.dir)) continue;
    helperRun(['registry-add', regPath, entry.name, entry.dir]);
  }
  ok(`super-injector registry: ${regPath}`);

  // ── [3/7] AGENTS.md 常驻层
  step('[3/7] AGENTS.md（石井人设 + SHIYI-DSH 协议）');
  const agentsDst = path.join(dshHome, 'AGENTS.md');
  const agentsBak = `${agentsDst}.bak-dsh-lazy-v5`;
  journal.snapshotFile('AGENTS.md', agentsDst);
  if (fs.existsSync(agentsDst) && !fs.existsSync(agentsBak)) copyFileF(agentsDst, agentsBak);
  const curAgents = fs.existsSync(agentsDst) ? readText(agentsDst) : '';
  if (/SHIYI-DSH/.test(curAgents)) ok('已是 v5 协议，覆盖更新');
  copyFileF(path.join(Mat, 'AGENTS.md'), agentsDst);
  ok(`AGENTS.md -> ${agentsDst}`);

  // ── [4/7] shield 协议文件（插件读盘热更）
  step('[4/7] shield-protocol.md（每轮重锁载荷）');
  journal.snapshotFile('shield-protocol.md', path.join(dshHome, 'shield-protocol.md'));
  copyFileF(path.join(Mat, 'shield-protocol.md'), path.join(dshHome, 'shield-protocol.md'));
  ok('shield 协议已部署（修改此文件即时生效，无需重装）');

  // ── [5/7] prompt 模板（过云审措辞版）
  step('[5/7] 注入模板');
  const globalPrompt = path.join(dshHome, 'prompt-inject.md');
  const tplNew = path.join(pack, 'prompts', 'operator-config-v5.md');
  const promptBak = `${globalPrompt}.bak-v5`;
  journal.snapshotFile('prompt-inject.md', globalPrompt);
  if (fs.existsSync(globalPrompt) && !fs.existsSync(promptBak)) copyFileF(globalPrompt, promptBak);
  copyFileF(tplNew, globalPrompt);
  ok('prompt-inject.md 已升级为操作者配置风格（旧版备份 .bak-v5）');

  if (fs.existsSync(piDir)) {
    const cfg = path.join(dshHome, 'dsh-prompt-inject.json');
    journal.snapshotFile('dsh-prompt-inject.json', cfg);
    helperRun(['write-prompt-config', globalPrompt, cfg]);
    ok('prompt-inject 默认模板 = operator-config-v5');
    if (!opts.noColdCoffee) {
      helperRun(['add-template', path.join(pack, 'prompts', 'cold-coffee.md'), cfg, 'cold-coffee', '冷咖啡']);
      ok('冷咖啡急救模板已注册');
    }
  }

  // ── [6/7] 技能包（DSH 原生发现路径）
  if (!opts.skipSkills) {
    step('[6/7] 技能包安装（150+）');
    const skillsSrc = path.join(Mat, 'skills');
    const skillsDst = path.join(dshHome, 'skills');
    mkdirp(skillsDst);
    let n = 0;
    for (const d of listDirs(skillsSrc)) {
      if (!fs.existsSync(path.join(skillsSrc, d, 'SKILL.md'))) continue;
      const t = path.join(skillsDst, d);
      if (fs.existsSync(t)) {
        // 内容一致则无需备份；被改过的先入备份
        if (!treesEqual(t, path.join(skillsSrc, d))) journal.snapshotDir(`skills/${d}`, t);
        rmrfF(t);
      }
      if (!DRY) fs.cpSync(path.join(skillsSrc, d), t, { recursive: true });
      n++;
    }
    ok(`已安装 ${n} 个技能 -> ${skillsDst}`);
  } else {
    step('[6/7] 技能包：已按 -SkipSkills 跳过');
  }

  // ── [7/7] dsh-purge 打补丁到【所有 DSH 运行时】
  step('[7/7] dsh-purge 清洗（遍历全部 DSH 运行时，幂等）');
  const purgeBin = path.join(storeRoot, 'dsh-purge', 'bin', 'dsh-purge.js');
  const failedBases = [];
  for (const b of bases) {
    info(`   -> ${b.path}`);
    if (DRY) { dryLog(`node ${purgeBin} --apply --base ${b.path}`); continue; }
    const env = { ...process.env, DSH_BASE: b.path, DSH_TARGET_BASE: b.path, DSH_HOME: dshHome };
    const { code, out } = runNodeCapture([purgeBin, '--apply', '--base', b.path], env);
    const lines = out.split(/\r?\n/).filter((l) => /patch|done|ERROR|失败|完成/i.test(l));
    for (const l of lines.slice(-4)) info(l);
    if (code !== 0) {
      failedBases.push(b.path);
      warn(`该运行时清洗失败 (exit=${code}，可能版本不匹配)，继续下一个`);
    }
  }
  if (failedBases.length > 0 && failedBases.length === bases.length) {
    warn('所有运行时清洗均失败，请检查 DSH 版本是否受支持');
  }
  // DSH_BASE / DSH_PERMISSION_MODE：注册表 → env.sh（--shell-env 追加进 shell 启动文件）
  const envSh = path.join(dshHome, 'env.sh');
  const envBody = [
    '# DSH 破甲懒人包 v5 — 运行时环境（install-macos.mjs 自动生成）',
    `export DSH_BASE=${shellQuote(primary.path)}`,
    "export DSH_PERMISSION_MODE='danger-full-access'",
    '',
  ].join('\n');
  writeFileF(envSh, envBody);
  if (!DRY) { try { fs.chmodSync(envSh, 0o644); } catch {} }
  ok(`DSH_BASE / DSH_PERMISSION_MODE 已写入 ${envSh}`);
  if (opts.shellEnv) {
    appendShellRc(envSh);
  } else {
    info(`        提示: 将 \`. ${shellQuote(envSh)}\` 加入 shell 启动文件（或加 --shell-env 自动写入）`);
  }

  // ── [8/8] profile patch 自愈（cordis.patch.yml 缺顶层 [] 补全）
  step('[8/8] profile patch 自愈（cordis.patch.yml 缺顶层 [] 补全）');
  const profRoot = path.join(dshHome, 'profiles');
  let fixed = 0;
  for (const pd of listDirs(profRoot)) {
    const cp = path.join(profRoot, pd, 'cordis.patch.yml');
    if (!fs.existsSync(cp)) continue;
    const raw = readText(cp);
    const effective = raw.split(/\r?\n/).filter((l) => !/^\s*#/.test(l) && l.trim() !== '');
    if (effective.length === 0) {
      journal.snapshotFile(path.posix.join('profiles', pd, 'cordis.patch.yml'), cp);
      appendFileF(cp, '\n[]\n');
      fixed++;
      warn(`已修复 ${pd}/cordis.patch.yml（原缺顶层 []，会导致 DSH 启动崩溃）`);
    }
  }
  if (fixed === 0) ok('profile patch 无需修复');
  else ok(`已修复 ${fixed} 个 profile（DSH 现在可以正常启动）`);

  // ── 收尾
  journal.commit();
  console.log('');
  console.log(C.green('============================================================'));
  console.log(C.green(' DSH 破甲懒人包 v5 安装完成'));
  console.log(C.green('------------------------------------------------------------'));
  console.log(` 运行时: ${primary.path} (${primary.version})`);
  console.log(' 官网:  https://susu.wiki/   QQ群: 1041209479');
  console.log(C.green('============================================================'));
  await restartDshRuntime({
    noRestart: opts.noRestart,
    dshHome,
    portHint: opts.port,
    noOpenLinks: opts.noOpenLinks,
    primary,
  });
  console.log(' 验证:  新会话发「冷咖啡」→ 应回「来杯冰美式…」');
}

function shellQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

function appendShellRc(envSh) {
  const block = `# >>> dsh-lazy-pack v5 >>>\n[ -f ${shellQuote(envSh)} ] && . ${shellQuote(envSh)}\n# <<< dsh-lazy-pack v5 <<<\n`;
  for (const rc of [path.join(os.homedir(), '.zshrc'), path.join(os.homedir(), '.bash_profile')]) {
    try {
      const cur = fs.existsSync(rc) ? readText(rc) : '';
      if (cur.includes('dsh-lazy-pack v5')) continue;
      if (DRY) { dryLog(`追加 source 行到 ${rc}`); continue; }
      fs.appendFileSync(rc, (cur === '' || cur.endsWith('\n') ? '' : '\n') + block);
      ok(`shell 启动文件已更新: ${rc}`);
    } catch (e) { warn(`写入 ${rc} 失败: ${e.message}`); }
  }
}

// ═══════════════════════════════════════════════════════════════════
//  卸载（等价 install.ps1 -Uninstall，按备份与标记精准回滚）
// ═══════════════════════════════════════════════════════════════════

async function uninstall() {
  const { opts, dshHome, profile, profileDir, pkgPath, journal } = ctx;
  step('Uninstall dsh-lazy-pack v5');

  // 1) profile 依赖与 bundles 清理
  if (fs.existsSync(pkgPath)) {
    journal.snapshotFile(path.posix.join('profiles', profile, 'package.json'), pkgPath);
    helperRun(['remove-plugins', pkgPath]);
  }

  // 2) node_modules 链接/目录清理（链接只删链接本身）
  const nm = path.join(profileDir, 'node_modules');
  for (const rel of ['dsh-purge', '@wasd258/dsh-prompt-inject', '@dsh-external/dsh-shield', '@dsh-external/dsh-super-injector', 'dsh-infinite-gen-2']) {
    const p = path.join(nm, rel);
    const st = safeLstat(p);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      if (DRY) { dryLog(`删除链接: ${p}`); continue; }
      fs.unlinkSync(p);
    } else {
      journal.snapshotDir(path.posix.join('profiles', profile, 'node_modules', rel), p);
      rmrfF(p);
    }
  }

  // 3) super-injector registry 里本包登记的条目
  const reg = path.join(dshHome, 'super-injector', 'registry.json');
  if (fs.existsSync(reg) && fs.existsSync(path.join(ctx.pack, 'tools', 'json-edit.js'))) {
    if (regHasEntries(readText(reg))) journal.snapshotFile('super-injector/registry.json', reg, regNorm);
    for (const name of ['@wasd258/dsh-prompt-inject', '@dsh-external/dsh-shield']) {
      helperRun(['registry-remove', reg, name], { allowFail: true });
    }
  }

  // 4) 按备份恢复用户文件
  const agentsBak = path.join(dshHome, 'AGENTS.md.bak-dsh-lazy-v5');
  if (fs.existsSync(agentsBak)) {
    journal.snapshotFile('AGENTS.md', path.join(dshHome, 'AGENTS.md'));
    copyFileF(agentsBak, path.join(dshHome, 'AGENTS.md'));
  }
  const promptBak = path.join(dshHome, 'prompt-inject.md.bak-v5');
  if (fs.existsSync(promptBak)) {
    journal.snapshotFile('prompt-inject.md', path.join(dshHome, 'prompt-inject.md'));
    copyFileF(promptBak, path.join(dshHome, 'prompt-inject.md'));
    ok('prompt-inject.md 已从 .bak-v5 恢复');
  }

  ok('卸载完成（技能目录与补丁备份保留在 .dsh 下，可手动清理 backups/）');
  journal.commit();
  await restartDshRuntime({
    noRestart: opts.noRestart,
    dshHome,
    portHint: opts.port,
    noOpenLinks: opts.noOpenLinks,
    primary: ctx.primary || (() => { try { const b = collectDshBases(); return b.length ? pickPrimary(b) : null; } catch { return null; } })(),
  });
}

// ═══════════════════════════════════════════════════════════════════
//  main
// ═══════════════════════════════════════════════════════════════════

function resolvePack(explicit) {
  const valid = (d) => {
    try {
      return fs.existsSync(path.join(d, 'install.ps1'))
        || (fs.existsSync(path.join(d, 'materials', 'AGENTS.md'))
          && fs.existsSync(path.join(d, 'plugins', 'dsh-purge', 'package.json'))
          && fs.existsSync(path.join(d, 'tools', 'json-edit.js')));
    } catch { return false; }
  };
  const cands = [];
  if (explicit) cands.push(expandHome(explicit));
  if (process.env.DSH_PACK_DIR) cands.push(expandHome(process.env.DSH_PACK_DIR));
  cands.push(
    path.join(scriptDir, 'pack'),
    path.join(scriptDir, 'dsh-pack'),
    path.join(scriptDir, 'dsh'),
    scriptDir,
  );
  let up = scriptDir;
  for (let i = 0; i < 8; i++) {
    const next = path.dirname(up);
    if (next === up) break;
    up = next;
    cands.push(path.join(up, 'packs', 'dsh'), path.join(up, 'dsh-pack'), path.join(up, 'pack-dsh'));
  }
  for (const c of cands) { if (c && valid(c)) return path.resolve(c); }
  if (explicit) die(`--pack 指向的目录不是有效的 DSH 包（缺 install.ps1 / materials / plugins / tools）: ${explicit}`);
  die('未能自动定位 DSH 包目录，请用 --pack <包目录> 指定');
}

async function run(opts) {
  DRY = opts.dryRun;

  const profile = opts.profile;
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) die(`--profile 名称不合法: ${profile}`);

  const pack = resolvePack(opts.pack);
  const dshHome = opts.dshHome ? expandHome(opts.dshHome)
    : expandHome(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const profileDir = path.join(dshHome, 'profiles', profile);
  const pkgPath = path.join(profileDir, 'package.json');
  const stamp = ts();

  ctx = { opts, pack, dshHome, profile, profileDir, pkgPath, stamp, journal: null };
  ctx.journal = new BackupJournal(dshHome, stamp, DRY);

  if (DRY) info(`[DRY] dry-run 模式：不写文件、不重启（stamp=${stamp}）`);
  try {
    if (opts.uninstall) await uninstall();
    else await install();
  } finally {
    ctx.journal.commit();
  }
}

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); process.exit(0); }
  await run(opts);
} catch (e) {
  console.error(C.red(`[FAIL] ${e && e.message ? e.message : e}`));
  process.exitCode = 1;
}
