# -*- coding: utf-8 -*-
"""codex 破甲包 v10.2 · hook 信任同步器（换机注入失败的根治件）

=== macOS 适配副本（mac 分支 · 最小改动）===
本文件是包根 `Sync-HookTrust.py` 的逐字拷贝 + 下列最小改动（详见 installers/codex/README.md「助手 diff」）：
  1) 新增 IS_MAC / NL 常量；normalize_crlf 与全部 split/join 由硬编码 CRLF 改为按平台走
     （Windows=CRLF，POSIX=LF），避免在 mac 上把用户 LF 的 config.toml 整篇改写成 CRLF；
  2) `_exe_ok()` 由「只认 *.exe」放宽为「*.exe 或任意可执行文件」（mac 的 codex 是无扩展名垫片）；
  3) `_shim_children()` 增加对无扩展名 `codex` 子文件的递归查找；
  4) `resolve_codex_candidates()` 的固定位点补上 macOS 常见路径
     （/usr/local/bin/codex、/opt/homebrew/bin/codex、~/.codex/bin/codex、ChatGPT.app 内置 CLI）。
算法/退出码/写盘逻辑一字未改（本机实测原版直接跑会 exit 3「找不到 codex」，见 README）。

为什么需要这个文件
--------------------------------------------------------
Codex 0.146+ 的 hooks 是**受信任门控**的：hooks.json 里定义了钩子还不够，
`~/.codex/config.toml` 的 `[hooks.state.'<绝对路径>:<事件>:<组>:<序号>']`
里必须有一条与该钩子**逐字匹配**的 `trusted_hash`，否则钩子在运行时被
静默跳过 —— 安装日志一切正常、文件全部落地、但整条注入链路从不执行。
别人机器上「四个钩子一直注入失败」就是这个状态。

v10 / v10.1 的安装器把信任算错了
--------------------------------------------------------
旧实现（install-replica.ps1 [8/9] 步）写的是：

    $h256 = (Get-FileHash -LiteralPath <hook 脚本> -Algorithm SHA256).Hash
    trusted_hash = "sha256:<h256>"

即「钩子脚本文件的字节哈希」。实测证明**这个输入不进哈希**：

    只改脚本文件内容（hooks.json 不动）→ currentHash 完全不变

真正进哈希的字段是钩子的**声明**（事件名 / matcher / command / timeout /
handlerType）；脚本文件字节、hooks.json 的 description 都不参与。
而 `currentHash` 的规范序列化形式不是明文（36M 组明文候选全部不命中，
大概率是 bincode / 内部结构体编码）——**不必也不该去复刻它**。

本工具的做法
--------------------------------------------------------
不猜算法，直接问 Codex 本人：

    codex app-server --listen stdio://
      → {"method":"initialize", ...}
      → {"method":"hooks/list", "params":{"cwds":[...]}}
      ← 每个钩子返回 {key, currentHash, trustStatus, ...}

把返回的 `currentHash` 原样写回 `[hooks.state.'<key>'].trusted_hash`，
再重新查一次确认 `trustStatus` 变成 `trusted`。这是 TUI 点「信任」时
走的同一套数据，权威、离线、与算法无关。

顺带处理的第二个静默失效
--------------------------------------------------------
config.toml 里若出现**重复的** `[hooks.state.'…']` 表，整个 TOML 直接解析
失败 —— Codex 不会报错，而是把**全部**钩子和**全部**配置当作不存在
（实测：hooks/list 返回 0 个钩子）。所以本工具在写信任之前会先做一次
重复表去重，避免「补信任反而全灭」。

用法
--------------------------------------------------------
  python Sync-HookTrust.py                 # 修复 + 同步 + 自校验
  python Sync-HookTrust.py --check         # 只校验不写（退出码即结论）
  python Sync-HookTrust.py --home <dir>    # 指定 CODEX_HOME
  python Sync-HookTrust.py --codex <exe>   # 指定 codex 可执行文件
  python Sync-HookTrust.py --list-codex    # 列出候选 codex 与各自可见的钩子数
  python Sync-HookTrust.py --json          # 机器可读结果

退出码
--------------------------------------------------------
  0  全部钩子已可信 / 无钩子需要处理
  3  找不到 codex 可执行文件
  4  app-server 不支持 hooks/list（Codex 版本过旧）
  5  写入后自校验仍有钩子不可信
  6  hooks.json 声明了钩子，但 Codex 一个都没装载（config 失效 / hooks 被关闭）
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import threading
import time

BEGIN = "# SLO-RUNTIME:eni-solo:HOOK-TRUST:BEGIN"
END = "# SLO-RUNTIME:eni-solo:HOOK-TRUST:END"

# 官方托管 / 第三方插件来源：信任模型不由本工具接管
SKIP_SOURCES = {
    "system", "mdm", "plugin",
    "cloudRequirements", "cloudManagedConfig",
    "legacyManagedConfigFile", "legacyManagedConfigMdm",
}

IS_WIN = os.name == "nt"
# [mac 适配] 显式区分 darwin；换行风格按平台走 —— Windows 保持 CRLF（旧行为），
# POSIX 用 LF，避免把用户 LF 的 config.toml 整篇改写成 CRLF（那会造成无谓的全文件重写）。
IS_MAC = sys.platform == "darwin"
NL = "\r\n" if IS_WIN else "\n"
VERSION = "10.2"

# cmd 控制台可能是 cp936/GBK：中文能打，但个别符号（如某些破折号/引号变体）
# 不在码表里会让 print() 直接抛 UnicodeEncodeError。降级成 '?' 即可，不要中断安装。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(errors="replace")
    except Exception:
        pass


def hr(title: str = "") -> None:
    if title:
        print("-- %s %s" % (title, "-" * max(0, 66 - len(title))))
    else:
        print("-" * 70)


# --------------------------------------------------------------------------- #
# 文本 / TOML 工具
# --------------------------------------------------------------------------- #
def read_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def normalize_crlf(text: str) -> str:
    # [mac 适配] 原名保留（调用点不改）；实际归一目标由 NL 决定：Windows=CRLF，POSIX=LF。
    return text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", NL)


def write_text(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(normalize_crlf(text))


def toml_check(text: str):
    """-> (ok, 错误说明, 解析结果)"""
    try:
        import tomllib
    except Exception:
        return True, "tomllib 不可用（Python <3.11），跳过语法校验", None
    try:
        return True, "", tomllib.loads(text)
    except Exception as e:
        return False, str(e), None


def parse_state_header(line: str):
    """`[hooks.state.'KEY']` -> KEY；不是则返回 None。"""
    s = line.strip()
    if s.startswith("#") or not s.startswith("[") or s.startswith("[[") or not s.endswith("]"):
        return None
    body = s[1:-1].strip()
    for prefix in ("hooks.state.", "hooks.state "):
        if body.startswith(prefix):
            rest = body[len(prefix):].strip()
            if len(rest) >= 2 and rest[0] == rest[-1] and rest[0] in "'\"":
                inner = rest[1:-1]
                if rest[0] == '"':
                    inner = inner.replace('\\"', '"').replace("\\\\", "\\")
                return inner
            return None
    return None


def strip_trust(text: str, keys: set) -> str:
    """去掉旧的 HOOK-TRUST 标记块，以及任何将与本轮写入冲突的同名 hooks.state 表。"""
    out = []
    lines = normalize_crlf(text).split(NL)
    in_block = False
    i, n = 0, len(lines)
    while i < n:
        ln = lines[i]
        if BEGIN in ln:
            in_block = True
            i += 1
            continue
        if END in ln:
            in_block = False
            i += 1
            continue
        if in_block:
            i += 1
            continue
        hk = parse_state_header(ln)
        if hk is not None and hk in keys:
            i += 1
            while i < n:
                if lines[i].strip().startswith("["):
                    break
                i += 1
            continue
        out.append(ln)
        i += 1
    return NL.join(out)


def dedupe_tables(text: str) -> tuple:
    """删掉重复的表头（TOML 里重复声明同一张表 = 整个文件解析失败）。

    返回 (新文本, 删掉的条目数)。只处理 `[...]`，不碰 `[[...]]` 数组表。
    """
    lines = normalize_crlf(text).split(NL)
    out = []
    seen = set()
    removed = 0
    i, n = 0, len(lines)
    while i < n:
        s = lines[i].strip()
        if s.startswith("[") and not s.startswith("[[") and s.endswith("]"):
            norm = "".join(s.split())
            if norm in seen:
                removed += 1
                i += 1
                while i < n:
                    s2 = lines[i].strip()
                    if s2.startswith("["):
                        break
                    i += 1
                continue
            seen.add(norm)
        out.append(lines[i])
        i += 1
    return NL.join(out), removed


def toml_key_literal(key: str) -> str:
    if "'" not in key:
        return "'" + key + "'"
    return '"' + key.replace("\\", "\\\\").replace('"', '\\"') + '"'


def build_block(entries) -> str:
    out = ["", BEGIN]
    for key, h in entries:
        out.append("[hooks.state.%s]" % toml_key_literal(key))
        out.append('trusted_hash = "%s"' % h)
        out.append("")
    out.append(END)
    return NL.join(out)


def declare_handlers(hooks_json: str) -> int:
    """数一数 hooks.json 里声明了多少个 handler（不依赖 Codex）。"""
    try:
        with open(hooks_json, "r", encoding="utf-8-sig", errors="replace") as f:
            d = json.load(f)
    except Exception:
        return -1
    n = 0
    hk = d.get("hooks")
    if isinstance(hk, dict):
        for evt in hk.values():
            if isinstance(evt, list):
                for grp in evt:
                    if isinstance(grp, dict) and isinstance(grp.get("hooks"), list):
                        n += len(grp["hooks"])
    return n


# --------------------------------------------------------------------------- #
# 路径解析
# --------------------------------------------------------------------------- #
def resolve_home(arg) -> str:
    if arg:
        return os.path.abspath(os.path.expandvars(os.path.expanduser(arg)))
    env = os.environ.get("CODEX_HOME")
    if env and os.path.isdir(os.path.expandvars(env)):
        return os.path.abspath(os.path.expandvars(env))
    return os.path.abspath(os.path.join(os.path.expanduser("~"), ".codex"))


def _exe_ok(p) -> bool:
    # [mac 适配] 原实现只认 *.exe，在 macOS 上永远判「找不到 codex」。
    # 这里放宽为：.exe 文件，或任何可执行文件（含 node 垫片 /usr/local/bin/codex）。
    # 垫片同样能起 `codex app-server`（本机实测 codex-cli 0.162.1 垫片可用），故接受。
    if not p or not os.path.isfile(p):
        return False
    if p.lower().endswith(".exe"):
        return True
    return os.access(p, os.X_OK)


def _shim_children(shim: str):
    r"""codex.cmd 垫片 -> 递归找出真正的 codex.exe。

    官方 Windows 安装（也含 npm 全局）结构：
        %LOCALAPPDATA%\OpenAI\codex-<ver>\cli-native\codex.cmd
            -> x86_64-pc-windows-msvc\bin\codex.exe   （4 层子目录）
    只认 .exe 的旧实现会在这里直接判「找不到 codex」。
    """
    out = []
    d = os.path.dirname(os.path.abspath(shim))
    try:
        for p in glob.glob(os.path.join(d, "**", "codex.exe"), recursive=True):
            if _exe_ok(p):
                out.append(os.path.abspath(p))
        # [mac 适配] 无扩展名的 codex 可执行文件（.app 内 / 免安装目录）
        for p in glob.glob(os.path.join(d, "**", "codex"), recursive=True):
            if _exe_ok(p) and os.path.basename(p) == "codex":
                out.append(os.path.abspath(p))
    except Exception:
        pass
    return out


def resolve_codex_candidates(arg="") -> list:
    """按可信度排序返回**所有**候选 codex.exe。

    同一台机器常有多个 codex.exe（PATH 垫片指向的正式安装、插件宿主、
    沙盒副本），版本不一，旧版本没有 hooks/list。调用方应逐个探测，
    谁答得上用谁 —— 而不是找到一个就用。
    """
    if arg:
        return [os.path.abspath(arg)] if _exe_ok(arg) else []

    out, seen = [], set()

    def add(p):
        if not _exe_ok(p):
            return
        k = os.path.abspath(p).lower()
        if k not in seen:
            seen.add(k)
            out.append(os.path.abspath(p))

    # ① 显式环境变量
    env = os.environ.get("CODEX_BIN")
    if env:
        add(os.path.expandvars(env))

    # ② PATH 上的 codex（.exe 直接用；.cmd/.bat 垫片则回溯其子目录）
    w = shutil.which("codex")
    if w:
        if _exe_ok(w):
            add(w)
        else:
            for p in _shim_children(w):
                add(p)

    la = os.environ.get("LOCALAPPDATA", "")
    ap = os.environ.get("APPDATA", "")
    pf = os.environ.get("PROGRAMFILES", "")
    home = os.path.expanduser("~")

    # ③ 常见固定位点
    fixed = [os.path.join(home, ".codex", "bin", "codex.exe")]
    # [mac 适配] macOS 常见落点：Homebrew、npm 全局垫片、客户端内置 CLI
    if IS_MAC:
        fixed += [
            "/usr/local/bin/codex",
            "/opt/homebrew/bin/codex",
            os.path.join(home, ".codex", "bin", "codex"),
            os.path.join(home, ".npm-global", "bin", "codex"),
            "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
        ]
    if la:
        fixed += [os.path.join(la, "OpenAI", "Codex", "bin", "codex.exe"),
                  os.path.join(la, "Programs", "codex", "codex.exe")]
    for p in fixed:
        add(p)

    # ④ PATH 目录里的裸 codex.exe
    for d in (os.environ.get("PATH") or "").split(os.pathsep):
        if d:
            add(os.path.join(d, "codex.exe"))

    # ⑤ 兜底扫描 - A 层：用户的正式安装目录（按修改时间从新到旧）
    pats = []
    if la:
        pats += [os.path.join(la, "OpenAI", "**", "codex.exe"),
                 os.path.join(la, "Programs", "*", "codex.exe"),
                 os.path.join(la, "Programs", "*", "bin", "codex.exe"),
                 os.path.join(la, "Codex", "**", "codex.exe")]
    if ap:
        pats += [os.path.join(ap, "npm", "node_modules", "@openai", "**", "codex.exe")]
    if pf:
        pats += [os.path.join(pf, "*", "codex.exe"),
                 os.path.join(pf, "*", "*", "codex.exe")]
    for p in _scan(pats):
        add(p)

    # ⑥ 兜底扫描 - B 层：客户端自带的内部副本，最后才用
    for p in _scan([os.path.join(home, ".codex", ".sandbox-bin", "codex.exe"),
                    os.path.join(home, ".codex", "plugins", ".plugin-appserver", "codex.exe")]):
        add(p)

    return out


def _scan(pats):
    """对若干 glob 做去重 + 按 mtime 从新到旧排序。"""
    uniq = {}
    for pat in pats:
        try:
            found = glob.glob(pat, recursive=True)
        except Exception:
            continue
        for p in found:
            if _exe_ok(p):
                k = os.path.abspath(p).lower()
                try:
                    uniq[k] = max(uniq.get(k, 0), os.path.getmtime(p))
                except OSError:
                    uniq.setdefault(k, 0)
    return [p for p, _ in sorted(uniq.items(), key=lambda kv: kv[1], reverse=True)]


def resolve_codex(arg="") -> str:
    c = resolve_codex_candidates(arg)
    return c[0] if c else ""


# --------------------------------------------------------------------------- #
# app-server JSON-RPC 驱动
# --------------------------------------------------------------------------- #
class AppServer:
    def __init__(self, exe: str, home: str, workdir: str):
        self.exe, self.home, self.workdir = exe, home, workdir
        self.proc = None
        self.lines = []
        self.lock = threading.Lock()

    def start(self):
        env = dict(os.environ)
        env["CODEX_HOME"] = self.home
        env.pop("CODEX_BIN", None)
        kw = {}
        if IS_WIN:
            kw["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
        self.proc = subprocess.Popen(
            [self.exe, "app-server", "--listen", "stdio://"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, cwd=self.workdir, bufsize=0, **kw,
        )
        threading.Thread(target=self._pump, daemon=True).start()
        threading.Thread(target=self._drain, daemon=True).start()

    def _pump(self):
        try:
            for raw in self.proc.stdout:
                s = raw.decode("utf-8", "replace").strip()
                if s:
                    with self.lock:
                        self.lines.append(s)
        except Exception:
            pass

    def _drain(self):
        try:
            for _ in self.proc.stderr:
                pass
        except Exception:
            pass

    def close(self):
        if not self.proc:
            return
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass

    def send(self, obj):
        self.proc.stdin.write((json.dumps(obj) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def wait_for(self, rid: int, timeout: float):
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self.lock:
                snap = list(self.lines)
            for s in snap:
                if not s.startswith("{"):
                    continue
                try:
                    d = json.loads(s)
                except Exception:
                    continue
                if d.get("id") == rid:
                    return d
            time.sleep(0.05)
        return None


def query_hooks(codex: str, home: str, cwds, timeout: float):
    a = AppServer(codex, home, os.path.expanduser("~"))
    try:
        a.start()
    except OSError as e:
        return None, "无法启动 codex app-server: %s" % e
    try:
        a.send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"clientInfo": {"name": "eni-solo-trust-sync", "version": VERSION},
                           "capabilities": {"experimentalApi": True}}})
        if a.wait_for(1, timeout) is None:
            return None, "codex app-server 未响应 initialize（超时 %.0fs）" % timeout
        a.send({"jsonrpc": "2.0", "id": 2, "method": "hooks/list", "params": {"cwds": list(cwds)}})
        resp = a.wait_for(2, timeout)
        if resp is None:
            return None, "codex app-server 未响应 hooks/list（超时 %.0fs）" % timeout
        if "error" in resp:
            return None, "本机 Codex 版本不支持 hooks/list（%s）" % str(resp["error"])[:200]
        hooks = []
        for entry in (resp.get("result") or {}).get("data") or []:
            hooks.extend(entry.get("hooks") or [])
        return hooks, ""
    finally:
        a.close()


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--home", default="")
    ap.add_argument("--codex", default="")
    ap.add_argument("--list-codex", action="store_true",
                    help="只列出候选 codex.exe 及各自能看到的钩子数，然后退出")
    ap.add_argument("--cwd", action="append", default=[])
    ap.add_argument("--check", action="store_true", help="只校验，不写 config")
    ap.add_argument("--json", action="store_true", dest="as_json")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--timeout", type=float, default=30.0)
    args = ap.parse_args()

    quiet = args.quiet

    def say(m=""):
        if not quiet:
            print(m)

    home = resolve_home(args.home)
    hooks_json = os.path.join(home, "hooks.json")
    cfg_path = os.path.join(home, "config.toml")
    res = {"home": home, "ok": False, "trusted": [], "untrusted": [],
           "skipped": [], "repaired_tables": 0, "error": "", "codex": ""}

    if not os.path.isfile(hooks_json):
        res["error"] = "no-hooks-json"
        say("[trust] 未发现 %s，无需同步" % hooks_json)
        if args.as_json:
            print(json.dumps(res, ensure_ascii=False))
        return 0

    cands = resolve_codex_candidates(args.codex)
    if not cands:
        res["error"] = "codex-not-found"
        print("[trust][FAIL] 找不到 codex 可执行文件，无法同步 hook 信任。")
        print("             可显式指定：python Sync-HookTrust.py --codex <codex.exe>")
        if args.as_json:
            print(json.dumps(res, ensure_ascii=False))
        return 3

    say("[trust] CODEX_HOME: %s" % home)

    # ---- 0. 写入前先修 config.toml：重复表会让 Codex 丢弃全部配置 ------- #
    declared = declare_handlers(hooks_json)
    cfg_text = read_text(cfg_path)
    repaired = None
    if cfg_text.strip():
        ok, why, _ = toml_check(cfg_text)
        if not ok:
            fixed, n = dedupe_tables(cfg_text)
            ok2, why2, _ = toml_check(fixed)
            if ok2 and n:
                repaired = fixed
                res["repaired_tables"] = n
                say("[trust] config.toml 存在 %d 处重复表（会导致 Codex 丢弃全部配置），"
                    "已自动去重" % n)
            else:
                res["error"] = "config-toml-invalid"
                print("[trust][FAIL] config.toml 不是合法 TOML，且自动修复未成功：")
                print("             %s" % (why2 or why))
                print("             该状态下 Codex 会忽略**全部**钩子与配置。请先修好 config.toml。")
                if args.as_json:
                    print(json.dumps(res, ensure_ascii=False))
                return 6

    cwds = list(args.cwd) or [os.path.expanduser("~")]

    # ---- 诊断模式：把候选与各自能看到的钩子数打出来 -------------------- #
    if args.list_codex:
        print("[trust] 候选 codex.exe（共 %d 个）：" % len(cands))
        for i, c in enumerate(cands):
            h, e = query_hooks(c, home, cwds, args.timeout)
            if e:
                print("  [%d] hooks/list 不可用  %s" % (i, c))
                print("      %s" % e)
            else:
                print("  [%d] %2d 个钩子          %s" % (i, len(h), c))
        return 0

    # ---- 1. 选一个能真正装载钩子的 Codex，并拿权威哈希 ------------------ #
    # 机器上常同时存在多个 codex.exe（PATH 垫片指向的旧版、正式安装、插件宿主、
    # 沙盒副本），版本不一。旧版本**没有** hooks 功能：它不报错，只是安静地
    # 返回 0 个钩子 —— 若按「谁先答得上用谁」，会先选中旧版，再被误判成
    # exit 6「钩子声明了却一个都没装载」。所以按**返回的钩子数**择优。
    codex, hooks, first_err, tried = "", None, "", []
    zero_pick = None
    for cand in cands:
        h, e = query_hooks(cand, home, cwds, args.timeout)
        tried.append((cand, e, len(h) if e == "" else -1))
        if e == "":
            if h:
                codex, hooks = cand, h
                break
            if zero_pick is None:
                zero_pick = (cand, h)
        elif not first_err:
            first_err = e
    if hooks is None and zero_pick is not None:
        codex, hooks = zero_pick
    if hooks is None:
        res["error"] = first_err or "no-codex-responded"
        print("[trust][FAIL] %s" % (first_err or "没有任何 codex 能响应 hooks/list"))
        print("             已探测 %d 个候选：" % len(tried))
        for c, e, _ in tried:
            print("               %s %s" % ("fail", c))
        print("             旧版 Codex 不校验 hook 信任，本步骤可跳过；")
        print("             若本机 Codex 正常却报此错，请把上面这段反馈给包作者。")
        if args.as_json:
            print(json.dumps(res, ensure_ascii=False))
        return 4
    res["codex"] = codex
    res["probed"] = [{"codex": c, "err": e, "hooks": n} for c, e, n in tried]
    if len(cands) > 1:
        say("[trust] codex     : %s   (%d 个候选中选出，见到 %d 个钩子)"
            % (codex, len(cands), len(hooks)))
    else:
        say("[trust] codex     : %s" % codex)

    if not hooks:
        if declared and declared > 0:
            res["error"] = "hooks-declared-but-not-loaded"
            print("[trust][FAIL] hooks.json 声明了 %d 个钩子，但 Codex 一个都没装载。" % declared)
            print("             已试过 %d 个 codex，均看不到钩子。常见原因：" % len(tried))
            print("             config.toml 不是合法 TOML、hooks 功能被关闭、")
            print("             hooks.json 不是合法 JSON，或本机 Codex 版本过旧。")
            print('             诊断：python Sync-HookTrust.py --list-codex')
            if args.as_json:
                print(json.dumps(res, ensure_ascii=False))
            return 6
        say("[trust] hooks.json 未声明任何钩子，跳过。")
        if args.as_json:
            print(json.dumps(res, ensure_ascii=False))
        return 0

    # ---- 2. 组装待写条目 ------------------------------------------------ #
    want = []
    for h in hooks:
        key = h.get("key") or ""
        cur = h.get("currentHash") or ""
        src = h.get("source") or "unknown"
        if not key:
            continue
        if h.get("isManaged") or src in SKIP_SOURCES:
            res["skipped"].append({"key": key, "source": src})
            continue
        if not cur:
            res["skipped"].append({"key": key, "source": src, "why": "no-hash"})
            continue
        want.append((key, cur))

    if not want:
        say("[trust] 没有需要接管的钩子（全部属于托管/插件来源）。")
        res["ok"] = True
        if args.as_json:
            print(json.dumps(res, ensure_ascii=False))
        return 0

    # ---- 3. 写盘 -------------------------------------------------------- #
    if not args.check:
        base = repaired if repaired is not None else cfg_text
        keys = {k for k, _ in want}
        candidate = normalize_crlf(
            strip_trust(base, keys).rstrip() + NL + build_block(want) + NL)

        ok, why, _ = toml_check(candidate)
        if not ok:
            res["error"] = "toml-invalid: %s" % why
            print("[trust][FAIL] 合并后的 config.toml 不是合法 TOML，已放弃写入：%s" % why)
            print("             config.toml 保持原样。")
            if args.as_json:
                print(json.dumps(res, ensure_ascii=False))
            return 5

        # 末尾换行差异不算变化，避免每次安装都重写/备份
        changed = (candidate.rstrip("\r\n")
                   != normalize_crlf(cfg_text).rstrip("\r\n"))
        if changed:
            stamp = time.strftime("%Y%m%d-%H%M%S")
            bdir = os.path.join(home, "backups", "hooktrust-sync-" + stamp)
            if cfg_text.strip():
                try:
                    os.makedirs(bdir, exist_ok=True)
                    with open(os.path.join(bdir, "config.toml"), "w",
                              encoding="utf-8", newline="") as f:
                        f.write(normalize_crlf(cfg_text))
                    say("[trust] 已备份原 config.toml -> %s" % bdir)
                except OSError as e:
                    say("[trust][WARN] 备份失败（继续）: %s" % e)
            write_text(cfg_path, candidate)
            say("[trust] 已写入 %d 条 hook 信任记录 -> %s" % (len(want), cfg_path))
        else:
            say("[trust] 信任记录已是最新，无需改动。")

    # ---- 4. 自校验 ------------------------------------------------------ #
    hooks2, err2 = query_hooks(codex, home, cwds, args.timeout)
    if err2:
        res["error"] = "verify: %s" % err2
        print("[trust][WARN] 写入后复查失败：%s" % err2)
        if args.as_json:
            print(json.dumps(res, ensure_ascii=False))
        return 5

    for h in hooks2:
        key = h.get("key") or ""
        src = h.get("source") or "unknown"
        if h.get("isManaged") or src in SKIP_SOURCES:
            continue
        st = h.get("trustStatus") or ""
        if st == "trusted":
            res["trusted"].append(key)
        else:
            res["untrusted"].append({"key": key, "status": st, "hash": h.get("currentHash")})

    if not quiet:
        say("")
        say("[trust] 钩子信任状态：")
        for k in res["trusted"]:
            say("   OK   trusted    %s" % k)
        for u in res["untrusted"]:
            say("   FAIL %-10s %s" % (u["status"], u["key"]))
        for s in res["skipped"]:
            say("   --   skipped    (%s) %s" % (s.get("source", "?"), s["key"]))

    if res["untrusted"]:
        print("")
        print("[trust][FAIL] 仍有 %d 个钩子未被信任 —— Codex 会在运行时静默跳过它们。"
              % len(res["untrusted"]))
        print("             请把本段输出反馈给包作者。")
        if args.as_json:
            print(json.dumps(res, ensure_ascii=False))
        return 5

    res["ok"] = True
    if not quiet:
        hr()
        say("[trust] 全部钩子已可信（%d 个）。" % len(res["trusted"]))
    if args.as_json:
        print(json.dumps(res, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
