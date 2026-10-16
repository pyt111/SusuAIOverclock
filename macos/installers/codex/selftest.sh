#!/usr/bin/env bash
# ============================================================
#  Codex 破甲包 macOS 安装器 · 沙箱化端到端自测
#
#  用例 A（增量场景，对齐真实使用）：安装 → 校验 → 二次安装（幂等）→ 卸载 → 重装
#  用例 B（干净场景）：安装 → 卸载，断言回滚到夹具原文（含符号链接技能）
#  用例 C（dry-run）：零写入
#  用例 D（--purge）：只清本 Kit 内容，不动 backups/ 其它内容
#
#  全程只写 /private/tmp（macOS 的 /tmp 是符号链接，必须写 /private/tmp），
#  不 kill 任何进程、不打开链接、不碰真实 ~/.codex。
#
#  用法: bash selftest.sh [--pack <包目录>] [--python <解释器>]
# ============================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/install-macos.mjs"
PACK="${CODEX_PACK_DIR:-}"
PY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --pack) PACK="${2:-}"; shift 2 ;;
    --python) PY="${2:-}"; shift 2 ;;
    *) echo "[FAIL] 未知参数: $1"; exit 2 ;;
  esac
done

if [ -z "$PACK" ]; then
  for c in "$HERE" "$HERE/../../../02-源码/v1.5.7/packs/codex"; do
    [ -f "$c/materials/AGENTS.md" ] && PACK="$c" && break
  done
fi
[ -n "$PACK" ] && [ -f "$PACK/materials/AGENTS.md" ] || { echo "[FAIL] 未找到 codex 包目录（用 --pack 指定含 materials/AGENTS.md 的目录）"; exit 2; }
PACK="$(cd "$PACK" && pwd)"

if [ -z "$PY" ]; then PY="$(command -v python3 || true)"; fi

ROOT=/private/tmp/codex-selftest
CASES="$ROOT/cases"
CASE="$CASES/caseA"
CASE_B="$CASES/caseB"
DRY="$CASES/caseC"
CASE_D="$CASES/caseD"
LOG="$ROOT/selftest.log"

PASS_N=0; FAIL_N=0
pass() { echo "  [PASS] $1"; PASS_N=$((PASS_N+1)); }
fail() { echo "  [FAIL] $1"; FAIL_N=$((FAIL_N+1)); }
assert_eq() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3（got '$1', want '$2'）"; fi; }
assert_ok() { if [ "$1" = "1" ]; then pass "$2"; else fail "$2"; fi; }
sha() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; }
ins() { node "$BIN" --pack "$PACK" --codex-home "$1" --no-open-links --skip-astra6 ${PY:+--python "$PY"} "${@:2}"; }
uni() { node "$BIN" --pack "$PACK" --codex-home "$1" --uninstall ${PY:+--python "$PY"} "${@:2}"; }

FIRST_SKILL="$(ls "$PACK/materials/skills" | head -1)"
SECOND_SKILL="$(ls "$PACK/materials/skills" | sed -n '2p')"

# 构造一套夹具：用户内容 + Legacy 旧块 + Foreign 块 + 旧 ishii 钩子 + 第三方钩子
#                + 冲突技能目录 + 符号链接技能 + backups/ 无关内容
make_fixture() {
  local C="$1" TAG="$2"
  rm -rf "$C"; mkdir -p "$C"
  cat > "$C/AGENTS.md" <<'MD'
# 我的工作区说明（用户自有内容，必须原样保留）

一些用户自己的约定：不要动这一段。

<!-- WORKSPACE-CONTRACT:BEGIN -->
## 旧的执行身份块（Legacy，安装后应被剥离）
FIXTURE-LEGACY-BODY
<!-- WORKSPACE-CONTRACT:END -->

<!-- SHIYI-V11:BEGIN -->
## SHIYI-V11 注入链路（外部块，必须原样保留）
FIXTURE-FOREIGN-BODY
<!-- SHIYI-V11:END -->

结尾的用户备注：也保留。
MD
  cat > "$C/hooks.json" <<'JSON'
{
  "description": "user hooks",
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "python \"C:\\Users\\Administrator\\.codex\\hooks\\ishii_auto_route.py\"", "timeout": 15 } ] },
      { "hooks": [ { "type": "command", "command": "python3 /Users/me/third-party-hook.py", "timeout": 10 } ] }
    ],
    "PreToolUse": [
      { "hooks": [ { "type": "command", "command": "python \"C:\\Users\\Administrator\\.codex\\hooks\\ishii_auto_route.py\"", "timeout": 15 } ] }
    ]
  }
}
JSON
  printf '{"models":[{"slug":"my-custom-model"}]}\n' > "$C/models.json"
  mkdir -p "$C/skills/$FIRST_SKILL"
  echo "USER-OWNED-SENTINEL" > "$C/skills/$FIRST_SKILL/sentinel.txt"
  # 符号链接技能项（对齐真实 ~/.codex：computer-use → ~/.agents/skills/*）
  mkdir -p "$ROOT/link-target/$SECOND_SKILL"
  echo "LINK-TARGET-SENTINEL" > "$ROOT/link-target/$SECOND_SKILL/keep.txt"
  ln -s "$ROOT/link-target/$SECOND_SKILL" "$C/skills/$SECOND_SKILL"
  # backups/ 无关内容（对齐真实 ~/.codex/backups：logs_2.sqlite-*、manual/）
  mkdir -p "$C/backups/manual"
  echo "UNRELATED-BACKUP" > "$C/backups/logs_2.sqlite-2026-01-01"
  echo "MANUAL-KEEP" > "$C/backups/manual/keep.txt"
  echo "fixture=$TAG" > "$ROOT/fixture-$TAG.txt"
}

echo "=================================================================="
echo " Codex 破甲包 macOS 安装器 · 沙箱自测"
echo " pack   : $PACK"
echo " python : ${PY:-<none>}"
echo " sandbox: $CASES"
echo "=================================================================="

# ─────────────────────────────────────────────────────────────
echo "== 0. 构造夹具 =="
make_fixture "$CASE" A
FIX_MD_A="$ROOT/fixture-A-AGENTS.md"; cp "$CASE/AGENTS.md" "$FIX_MD_A"
FIX_HOOKS_A="$ROOT/fixture-A-hooks.json"; cp "$CASE/hooks.json" "$FIX_HOOKS_A"
BK_UNRELATED_SHA="$(sha "$CASE/backups/logs_2.sqlite-2026-01-01")"
MODELS_SHA="$(sha "$CASE/models.json")"
pass "夹具 A 就绪：Legacy 块 / Foreign 块 / 第三方钩子 / 冲突技能 $FIRST_SKILL / 符号链接技能 $SECOND_SKILL / backups 无关内容"

# ─────────────────────────────────────────────────────────────
echo "== 1. 首次安装 =="
if ins "$CASE" > "$LOG" 2>&1; then pass "install 退出码 0"; else tail -30 "$LOG"; fail "install 退出码非 0"; fi

for f in "AGENTS.md" "hooks/ishii_auto_route.py" "prompts/eni-solo-v4.0.0.md" "eni-solo" "slo-runtime/eni-solo"; do
  [ -e "$CASE/$f" ] && pass "核心组件存在: $f" || fail "核心组件缺失: $f"
done

# AGENTS.md 合并正确性（legacy 剥除 / foreign 保留 / 新块插入 / 用户内容保留）
assert_eq "$(grep -c 'FIXTURE-LEGACY-BODY' "$CASE/AGENTS.md" 2>/dev/null || true)" "0" "夹具 Legacy 块正文已被剥离"
assert_eq "$(grep -c 'WORKSPACE-CONTRACT:BEGIN' "$CASE/AGENTS.md")" "1" "Legacy 标记块仅剩 1 个（来自本包 payload）"
assert_ok "$(grep -q 'FIXTURE-FOREIGN-BODY' "$CASE/AGENTS.md" && echo 1 || echo 0)" "外部块 SHIYI-V11 正文保留"
assert_eq "$(grep -c 'SHIYI-V11:BEGIN' "$CASE/AGENTS.md")" "1" "外部块标记未重复"
assert_ok "$(grep -q 'ENI-SOLO-AGENTS:BEGIN' "$CASE/AGENTS.md" && echo 1 || echo 0)" "新块 ENI-SOLO-AGENTS 已插入"
assert_ok "$(grep -q '我的工作区说明' "$CASE/AGENTS.md" && echo 1 || echo 0)" "用户开头内容保留"
assert_ok "$(grep -q '结尾的用户备注' "$CASE/AGENTS.md" && echo 1 || echo 0)" "用户结尾内容保留"

# hooks.json 校验（解析后的真实值，不做字符串近似）
HOOKS_OK="$(node -e '
const fs=require("fs");
const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const home=process.argv[2];
const ups=j.hooks.UserPromptSubmit||[];
const cmds=ups.flatMap(e=>(e.hooks||[]).map(h=>h.command));
const hasPy3=cmds.includes(`python3 "${home}/hooks/ishii_auto_route.py"`);
const hasThird=cmds.some(c=>c.includes("third-party-hook.py"));
const toolEvt=["PreToolUse","PostToolUse","SubagentStart"].some(e=>/ishii_auto_route|slo-runtime-hook/.test(JSON.stringify(j.hooks[e]||[])));
const oldGone=!JSON.stringify(j).includes("C:\\Users\\Administrator");
process.stdout.write([hasPy3,hasThird,!toolEvt,oldGone,cmds.length].map(x=>x===true?1:x===false?0:x).join(","));
' "$CASE/hooks.json" "$CASE")"
assert_eq "$(echo "$HOOKS_OK" | cut -d, -f1)" "1" "hooks.json 命令为 python3 + 真实 codexHome 绝对路径"
assert_eq "$(echo "$HOOKS_OK" | cut -d, -f2)" "1" "第三方钩子条目保留"
assert_eq "$(echo "$HOOKS_OK" | cut -d, -f3)" "1" "工具事件无本 Kit 条目"
assert_eq "$(echo "$HOOKS_OK" | cut -d, -f4)" "1" "旧 Windows 路径已替换"
# UserPromptSubmit = 第三方条目 + 本 Kit 条目（旧 ishii 条目已被清除）
assert_eq "$(echo "$HOOKS_OK" | cut -d, -f5)" "2" "UserPromptSubmit 条目数正确（第三方 + 本 Kit，旧 ishii 已清）"
assert_eq "$(node -e '
const j=require(process.argv[1]);
const cmds=(j.hooks.UserPromptSubmit||[]).flatMap(e=>(e.hooks||[]).map(h=>h.command));
const kit=cmds.filter(c=>/ishii_auto_route/.test(c));
process.stdout.write(String(kit.length));
' "$CASE/hooks.json")" "1" "旧 ishii 条目已清除（仅剩本 Kit 1 条）"

# hook 脚本反夹层（正则照抄 ps1）
node -e '
const t=require("fs").readFileSync(process.argv[1],"utf8");
const re=/_ctx\(\s*.?PreToolUse|_ctx\(\s*.?PostToolUse|_ctx\(\s*.?SubagentStart/;
process.exit(re.test(t)?1:0);
' "$CASE/hooks/ishii_auto_route.py" && pass "hooks 脚本无工具事件注入" || fail "hooks 脚本含工具事件注入"

# SKILL.md 的 UTF-8 BOM：装完必须为 0（否则 codex 报 missing YAML frontmatter 并静默丢弃技能）
assert_eq "$(node -e '
const fs=require("fs"),path=require("path");
let n=0;
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
  if(e.isSymbolicLink())continue;
  if(e.isDirectory())walk(p);
  else if(e.name==="SKILL.md"){const b=fs.readFileSync(p);if(b[0]===0xef&&b[1]===0xbb&&b[2]===0xbf)n++;}}})(process.argv[1]);
process.stdout.write(String(n));
' "$CASE/skills")" "0" "装后无带 BOM 的 SKILL.md（codex 能加载全部技能）"
assert_eq "$(node -e '
const fs=require("fs"),path=require("path");
let n=0,bad=0;
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
  if(e.isSymbolicLink())continue;
  if(e.isDirectory())walk(p);
  else if(e.name==="SKILL.md"){n++;const b=fs.readFileSync(p);if(b.slice(0,3).toString()!=="---")bad++;}}})(process.argv[1]);
process.stdout.write(bad===0&&n>0?"ok":"bad:"+bad+"/"+n);
' "$CASE/skills")" "ok" "装后每个 SKILL.md 都以 --- 开头（frontmatter 可解析）"

# manifest
MANIFEST="$(ls "$CASE"/eni-solo-replica-install-manifest-*.json 2>/dev/null | head -1)"
[ -n "$MANIFEST" ] && pass "manifest 已生成: $(basename "$MANIFEST")" || fail "manifest 未生成"
node -e '
const j=require(process.argv[1]);
const ok = j.name==="eni-solo" && j.version==="4.0.0" && j.config_toml_modified_by_this_install===false
  && j.hooks_installed===true && j.astra6_pool_patch===false && typeof j.installed_skills==="number"
  && j.installed_skills>0 && j.codex_home===process.argv[2] && Array.isArray(j.notes);
process.exit(ok?0:1);
' "$MANIFEST" "$CASE" && pass "manifest 字段正确（config_toml_modified_by_this_install=false / astra6_pool_patch=false）" || fail "manifest 字段异常"

assert_eq "$(sha "$CASE/models.json")" "$MODELS_SHA" "models.json 用户版本保留（未覆盖）"
assert_eq "$(cat "$CASE/AGENTS.md" | grep -c 'all your base')" "0" "占位哨兵不存在（防误判）"

# 冲突技能目录被替换 + 进备份
assert_eq "$([ -f "$CASE/skills/$FIRST_SKILL/sentinel.txt" ] && echo 1 || echo 0)" "0" "冲突技能目录已被替换"
BK="$(ls -d "$CASE"/backups/eni-solo-*-replica-* 2>/dev/null | head -1)"
assert_ok "$([ -f "$BK/$FIRST_SKILL/sentinel.txt" ] && echo 1 || echo 0)" "被替换技能已进备份"

# 符号链接技能：目标位被真实目录替换；备份里必须是**链接本身**（未解引用复制）
assert_ok "$([ ! -L "$CASE/skills/$SECOND_SKILL" ] && [ -d "$CASE/skills/$SECOND_SKILL" ] && echo 1 || echo 0)" "符号链接技能已被真实目录替换"
assert_ok "$([ -L "$BK/$SECOND_SKILL" ] && echo 1 || echo 0)" "备份中的符号链接仍是链接（未被解引用）"
assert_eq "$(readlink "$BK/$SECOND_SKILL" 2>/dev/null || true)" "$ROOT/link-target/$SECOND_SKILL" "备份中符号链接指向原目标"
assert_eq "$([ -e "$CASE/skills/$SECOND_SKILL/keep.txt" ] && echo 1 || echo 0)" "0" "链接目标内容未被改动（keep.txt 不在包内技能中）"

# backups/ 隔离：不得动无关内容
assert_eq "$(sha "$CASE/backups/logs_2.sqlite-2026-01-01")" "$BK_UNRELATED_SHA" "backups 无关文件未被改动"
assert_ok "$([ -f "$CASE/backups/manual/keep.txt" ] && echo 1 || echo 0)" "backups/manual 未被清理"

MD1="$(sha "$CASE/AGENTS.md")"; HJ1="$(sha "$CASE/hooks.json")"

# ─────────────────────────────────────────────────────────────
echo "== 2. 二次安装（幂等）=="
if ins "$CASE" > "$LOG" 2>&1; then pass "二次 install 退出码 0"; else tail -30 "$LOG"; fail "二次 install 退出码非 0"; fi
assert_eq "$(sha "$CASE/AGENTS.md")" "$MD1" "重装 AGENTS.md 逐字节不变（幂等）"
assert_eq "$(sha "$CASE/hooks.json")" "$HJ1" "重装 hooks.json 逐字节不变（幂等）"
assert_eq "$(grep -c 'ENI-SOLO-AGENTS:BEGIN' "$CASE/AGENTS.md")" "1" "重装后新块未重复插入"

# ─────────────────────────────────────────────────────────────
echo "== 3. 卸载（增量场景：恢复到最初装前态）=="
if uni "$CASE" > "$LOG" 2>&1; then pass "uninstall 退出码 0"; else tail -30 "$LOG"; fail "uninstall 退出码非 0"; fi
BK2="$(ls -d "$CASE"/backups/eni-solo-*-replica-* 2>/dev/null | sort | tail -1)"
# 语义（真实缺陷修复）：卸载必须恢复到**最初装前态**，而不是"最近一次安装备份"。
# 二次安装产出的备份本身已是注入态（脏备份），照它回滚等于把注入复制回来。
assert_eq "$(sha "$CASE/AGENTS.md")" "$(sha "$ROOT/fixture-A-AGENTS.md")" "AGENTS.md 已恢复到最初装前态（逐字节，含被剥离的 Legacy 块）"
# hooks.json：恢复为装前状态（本 Kit 条目清零、用户条目零丢失）。
assert_eq "$(node -e '
const fs=require("fs");
const cur=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const all=JSON.stringify(cur);
const kit=/ishii_auto_route|slo-runtime-hook/.test(all);
const third=all.includes("third-party-hook.py");
process.stdout.write([third,!kit].map(x=>x?1:0).join(","));
' "$CASE/hooks.json")" "1,1" "hooks.json 已恢复为装前状态（第三方钩子保留、本 Kit 条目清零）"
assert_eq "$(node -e '
const j=require(process.argv[1]);
process.stdout.write(JSON.stringify(j).includes("third-party-hook.py")?"1":"0");
' "$CASE/hooks.json")" "1" "回滚后第三方钩子仍在（用户数据零丢失）"
assert_ok "$(ls -d "$CASE"/backups/pre-uninstall-* >/dev/null 2>&1 && echo 1 || echo 0)" "卸载前安全备份已生成"
assert_eq "$(grep -c 'ishii_auto_route' "$CASE/hooks.json" 2>/dev/null || true)" "0" "hooks.json 注入条目已移除"
assert_eq "$(sha "$CASE/backups/logs_2.sqlite-2026-01-01")" "$BK_UNRELATED_SHA" "卸载未动 backups 无关文件"
assert_ok "$([ -f "$CASE/backups/manual/keep.txt" ] && echo 1 || echo 0)" "卸载未清理 backups/manual"

# ─────────────────────────────────────────────────────────────
echo "== 4. 重装 =="
if ins "$CASE" > "$LOG" 2>&1; then pass "重装退出码 0"; else tail -30 "$LOG"; fail "重装退出码非 0"; fi
assert_ok "$(grep -q 'ENI-SOLO-AGENTS:BEGIN' "$CASE/AGENTS.md" && echo 1 || echo 0)" "重装后新块重新出现"
assert_ok "$(node -e '
const j=require(process.argv[1]);
const home=process.argv[2];
process.exit((j.hooks.UserPromptSubmit||[]).flatMap(e=>(e.hooks||[]).map(h=>h.command))
  .includes(`python3 "${home}/hooks/ishii_auto_route.py"`)?0:1);
' "$CASE/hooks.json" "$CASE" && echo 1 || echo 0)" "重装后 hooks 命令正确"

# ─────────────────────────────────────────────────────────────
echo "== 5. 干净场景：安装 → 卸载 回滚到夹具原文 =="
make_fixture "$CASE_B" B
FIX_MD_B="$ROOT/fixture-B-AGENTS.md"; cp "$CASE_B/AGENTS.md" "$FIX_MD_B"
FIX_HOOKS_B="$ROOT/fixture-B-hooks.json"; cp "$CASE_B/hooks.json" "$FIX_HOOKS_B"
if ins "$CASE_B" > "$LOG" 2>&1; then pass "caseB install 退出码 0"; else tail -30 "$LOG"; fail "caseB install 退出码非 0"; fi
if uni "$CASE_B" > "$LOG" 2>&1; then pass "caseB uninstall 退出码 0"; else tail -30 "$LOG"; fail "caseB uninstall 退出码非 0"; fi
assert_eq "$(sha "$CASE_B/AGENTS.md")" "$(sha "$FIX_MD_B")" "AGENTS.md 已回滚到夹具原文（逐字节）"
# hooks.json：先按备份回滚到夹具内容，再由 [4] 步剥掉本 Kit 条目（与 ps1 同语义）。
# 断言：第三方钩子仍在、本 Kit 条目为零（夹具里那条旧 ishii 也属本 Kit，会被清掉）。
assert_eq "$(node -e '
const j=require(process.argv[1]);
const all=JSON.stringify(j);
const third=all.includes("third-party-hook.py");
const kit=/ishii_auto_route|slo-runtime-hook/.test(all);
process.stdout.write([third,!kit].map(x=>x?1:0).join(","));
' "$CASE_B/hooks.json")" "1,1" "hooks.json 回滚后：第三方钩子保留、本 Kit 条目已清"
assert_ok "$([ -f "$CASE_B/skills/$FIRST_SKILL/sentinel.txt" ] && echo 1 || echo 0)" "冲突技能目录已回滚（哨兵文件回来了）"
assert_ok "$([ -L "$CASE_B/skills/$SECOND_SKILL" ] && echo 1 || echo 0)" "符号链接技能已按链接原样还原"
assert_eq "$(readlink "$CASE_B/skills/$SECOND_SKILL" 2>/dev/null || true)" "$ROOT/link-target/$SECOND_SKILL" "还原后的符号链接仍指向原目标"
assert_ok "$([ ! -e "$CASE_B/skills/$SECOND_SKILL/keep.txt" ] || [ -L "$CASE_B/skills/$SECOND_SKILL" ] && echo 1 || echo 0)" "还原的链接未被实体化为目录副本"

# 卸载彻底性（三个真实缺陷的回归断言）：
#   ① 本 Kit 自建的 hooks/ tools/ eni-solo/ prompts/ 必须被删掉（旧版只"从备份恢复"，首次安装后卸载会残留）
#   ② hooks.json 不得留 eni-solo 空壳（旧版只过滤条目，留下 description 空文件）
#   ③ 脏备份不得把注入复制回来（重复安装 → 备份里已是注入态 → 卸载等于还原注入）
echo "  -- 卸载彻底性 --"
assert_ok "$([ ! -e "$CASE_B/hooks" ] && echo 1 || echo 0)" "卸载后 hooks/ 目录已删除（不再残留 ishii_auto_route.py）"
assert_ok "$([ ! -e "$CASE_B/tools" ] && echo 1 || echo 0)" "卸载后 tools/ 目录已删除"
assert_ok "$([ ! -e "$CASE_B/eni-solo" ] && echo 1 || echo 0)" "卸载后 eni-solo/ 已删除"
assert_ok "$([ ! -e "$CASE_B/slo-runtime/eni-solo" ] && echo 1 || echo 0)" "卸载后 slo-runtime/eni-solo 已删除"
assert_eq "$(ls "$CASE_B"/prompts/eni-solo-*.md 2>/dev/null | wc -l | tr -d ' ')" "0" "卸载后注入 prompt 已删除"
assert_ok "$([ ! -e "$CASE_B/prompts" ] && echo 1 || echo 0)" "卸载后 prompts/ 空目录已回收"
assert_ok "$([ ! -e "$CASE_B/slo-runtime" ] && echo 1 || echo 0)" "卸载后 slo-runtime/ 空目录已回收"
assert_eq "$(grep -c 'eni-solo managed hooks' "$CASE_B/hooks.json" 2>/dev/null || true)" "0" "hooks.json 无 eni-solo 空壳残留"
assert_eq "$(grep -c 'ENI-SOLO-AGENTS:BEGIN' "$CASE_B/AGENTS.md" 2>/dev/null || true)" "0" "AGENTS.md 无托管块残留"
# 夹具装前有 models.json（用户自建）→ 卸载必须保留/还原用户那份，绝不能删
assert_ok "$(grep -q 'my-custom-model' "$CASE_B/models.json" 2>/dev/null && echo 1 || echo 0)" "卸载后 models.json 保留用户原有内容（装前已存在）"

# ③ 脏备份回归：同一目录连续装两次 → 再卸载，AGENTS.md 必须回到夹具原文
echo "  -- 脏备份回归（连装两次再卸载）--"
make_fixture "$CASE_D" D
FIX_MD_D="$ROOT/fixture-D-AGENTS.md"; cp "$CASE_D/AGENTS.md" "$FIX_MD_D"
if ins "$CASE_D" > "$LOG" 2>&1; then pass "caseD 首次安装退出码 0"; else tail -30 "$LOG"; fail "caseD 首次安装失败"; fi
if ins "$CASE_D" > "$LOG" 2>&1; then pass "caseD 二次安装退出码 0"; else tail -30 "$LOG"; fail "caseD 二次安装失败"; fi
assert_ok "$(grep -q 'ENI-SOLO-AGENTS:BEGIN' "$CASE_D/AGENTS.md" && echo 1 || echo 0)" "caseD 二次安装后托管块在位"
assert_eq "$(grep -c 'ENI-SOLO-AGENTS:BEGIN' "$CASE_D/backups"/eni-solo-*-replica-*/AGENTS.md 2>/dev/null | grep -v ':0$' | wc -l | tr -d ' ')" "0" "所有安装备份里的 AGENTS.md 都是干净原始态（无脏备份）"
if uni "$CASE_D" > "$LOG" 2>&1; then pass "caseD 卸载退出码 0"; else tail -30 "$LOG"; fail "caseD 卸载失败"; fi
assert_eq "$(sha "$CASE_D/AGENTS.md")" "$(sha "$FIX_MD_D")" "连装两次再卸载：AGENTS.md 逐字节回到夹具原文（脏备份已修）"
# 只查本 Kit 的注入面；夹具原文自带的 WORKSPACE-CONTRACT 等 Legacy 块属于用户内容，
# 安装时被有意剥离、卸载时必须还原回来（所以不能把它们算作"残留"）。
assert_eq "$(grep -c 'ENI-SOLO-AGENTS' "$CASE_D/AGENTS.md" 2>/dev/null || true)" "0" "连装两次再卸载：本 Kit 托管块零残留"
assert_ok "$([ ! -e "$CASE_D/hooks/ishii_auto_route.py" ] && echo 1 || echo 0)" "连装两次再卸载：hook 脚本已清除"

# ─────────────────────────────────────────────────────────────
echo "== 6. dry-run 零写入 =="
make_fixture "$DRY" C
DRY_MD="$(sha "$DRY/AGENTS.md")"; DRY_HJ="$(sha "$DRY/hooks.json")"
BEFORE_LIST="$(cd "$DRY" && find . | sort | shasum -a 256)"
if ins "$DRY" --dry-run > "$LOG" 2>&1; then pass "dry-run 退出码 0"; else tail -30 "$LOG"; fail "dry-run 退出码非 0"; fi
assert_eq "$(sha "$DRY/AGENTS.md")" "$DRY_MD" "dry-run 未改 AGENTS.md"
assert_eq "$(sha "$DRY/hooks.json")" "$DRY_HJ" "dry-run 未改 hooks.json"
assert_eq "$(cd "$DRY" && find . | sort | shasum -a 256)" "$BEFORE_LIST" "dry-run 未新增/删除任何文件"
assert_eq "$(ls "$DRY"/eni-solo-replica-install-manifest-*.json 2>/dev/null | wc -l | tr -d ' ')" "0" "dry-run 未生成 manifest"
assert_eq "$([ -e "$DRY/hooks/ishii_auto_route.py" ] && echo 1 || echo 0)" "0" "dry-run 未部署 hook 脚本"
assert_eq "$([ -e "$DRY/skills/README.md" ] && echo 1 || echo 0)" "0" "dry-run 未铺开技能目录"

# ─────────────────────────────────────────────────────────────
echo "== 7. --purge 只清本 Kit 内容 =="
if uni "$CASE" --purge > "$LOG" 2>&1; then pass "uninstall --purge 退出码 0"; else tail -30 "$LOG"; fail "uninstall --purge 退出码非 0"; fi
assert_eq "$(ls -d "$CASE"/backups/eni-solo-*-replica-* 2>/dev/null | wc -l | tr -d ' ')" "0" "purge 已清 backups/eni-solo-*"
assert_eq "$(ls "$CASE"/eni-solo-replica-install-manifest-*.json 2>/dev/null | wc -l | tr -d ' ')" "0" "purge 已清 manifest"
assert_eq "$(sha "$CASE/backups/logs_2.sqlite-2026-01-01")" "$BK_UNRELATED_SHA" "purge 未动 backups 无关文件"
assert_ok "$([ -f "$CASE/backups/manual/keep.txt" ] && echo 1 || echo 0)" "purge 未清理 backups/manual"
assert_ok "$(ls -d "$CASE"/backups/pre-uninstall-* >/dev/null 2>&1 && echo 1 || echo 0)" "purge 保留本次 pre-uninstall 安全备份"

# ─────────────────────────────────────────────────────────────
echo
echo "=================================================================="
echo " 自测结果：PASS=$PASS_N  FAIL=$FAIL_N"
echo "=================================================================="
if [ "$FAIL_N" -eq 0 ]; then
  echo "ALL PASS ✔  （夹具保留在 $CASES 供人工复核）"
  exit 0
else
  echo "SELFTEST FAILED"
  exit 1
fi
