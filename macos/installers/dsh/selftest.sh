#!/usr/bin/env bash
# DSH 破甲懒人包 macOS 安装器 · 端到端自测
# 流程：首次安装 → 幂等重装 → 卸载回滚 → 重装；全程只写 /private/tmp，不重启 DSH、不打开链接。
# 用法: bash selftest.sh --pack <包目录>       （包目录 = 含 install.ps1 / materials / plugins / tools）
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/install-macos.mjs"
PACK="${DSH_PACK_DIR:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --pack) PACK="${2:-}"; shift 2 ;;
    *) echo "[FAIL] 未知参数: $1"; exit 2 ;;
  esac
done
if [ -z "$PACK" ]; then
  for c in "$HERE/pack" "$HERE/dsh-pack" "$HERE/../dsh-pack"; do
    [ -f "$c/install.ps1" ] && PACK="$c" && break
  done
fi
[ -n "$PACK" ] && [ -f "$PACK/install.ps1" ] || { echo "[FAIL] 未找到包目录（用 --pack 指定含 install.ps1 的目录）"; exit 2; }

HOME_DIR=/private/tmp/dsh-selftest
RT=/private/tmp/dsh-selftest-runtime/node_modules/@deepseek-ai
FIX=/private/tmp/dsh-selftest-fixture.mjs
LOG=/private/tmp/dsh-selftest.log

pass() { echo "  [PASS] $1"; }
fail() { echo "  [FAIL] $1"; exit 1; }
assert_eq() { [ "$1" = "$2" ] || fail "$3（got '$1', want '$2'）"; }
stamps() { find "$HOME_DIR/backups" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' '; }
run_install() { node "$BIN" --pack "$PACK" --dsh-home "$HOME_DIR" --no-restart --no-open-links --dsh-bases "$RT" "$@"; }

echo "== 0. 生成夹具 =="
rm -rf "$HOME_DIR" /private/tmp/dsh-selftest-runtime
cat > "$FIX" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const HOME = process.argv[2];
const RT = process.argv[3];
fs.mkdirSync(path.join(HOME, 'profiles', 'web', 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'profiles', 'web', 'package.json'),
  '{"name":"dsh-profile-web","private":true,"dependencies":{},"dsh":{"profile":{"bundles":[]}}}\n');
fs.writeFileSync(path.join(HOME, 'profiles', 'web', 'cordis.patch.yml'), '# comment only — 缺顶层 []\n');
fs.mkdirSync(path.join(HOME, 'profiles', 'other'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'profiles', 'other', 'cordis.patch.yml'), '# note\n[]\n');
fs.writeFileSync(path.join(HOME, 'AGENTS.md'), 'OLD-AGENTS-v4-CONTENT\n');
fs.writeFileSync(path.join(HOME, 'prompt-inject.md'), 'OLD-PROMPT-v4-CONTENT\n');
const A = {
  'dsh-agent-instructions/lib/index.js': [
    'const WORKSPACE_CONTEXT_INTRO = "The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions."',
    'const REPLACEMENT_WORKSPACE_CONTEXT_INTRO = "This complete workspace instruction baseline replaces all earlier workspace instruction baselines. The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions."',
    'function hint() { return "Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions."; }',
  ].join('\n') + '\n',
  'dsh-web-app/cordis.patch.yml': [
    'deployment:', '  system-prompt:',
    '    personaSuffix: Your working directory is {{cwd}}.',
    '    personaPrefix: >-',
    '      You are a coding agent powered by the {{model}} model.',
  ].join('\n') + '\n',
  'dsh-user-approval/lib/types/index.js':
    'const NEVER = "Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).";\n',
  'dsh-sandbox-local/lib/index.js': 'const RULES = ["(deny file-write*)"].join("\\n");\n',
  'dsh-base/cordis.patch.yml': [
    'sandbox:', "  mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'",
    'approval:', "  policy: !!js \"(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'\"",
  ].join('\n') + '\n',
  'dsh/package.json': '{"name":"@deepseek-ai/dsh","version":"0.1.5-rc.1"}\n',
};
for (const [rel, text] of Object.entries(A)) {
  const p = path.join(RT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
NODE
node "$FIX" "$HOME_DIR" "$RT"
pass "夹具就绪：$HOME_DIR / $RT"

echo "== 1. 首次安装 =="
run_install > "$LOG" 2>&1 || { tail -20 "$LOG"; fail "install 退出码非 0"; }
tail -n 10 "$LOG" | sed 's/^/  | /'
assert_eq "$(ls "$HOME_DIR/skills" | wc -l | tr -d ' ')" "151" "技能数"
[ -L "$HOME_DIR/profiles/web/node_modules/dsh-purge" ] || fail "dsh-purge 链接缺失"
[ -L "$HOME_DIR/profiles/web/node_modules/@dsh-external/dsh-shield" ] || fail "dsh-shield 链接缺失"
grep -q '"dsh-purge"' "$HOME_DIR/profiles/web/package.json" || fail "package.json 缺依赖"
node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(a.length===2?0:1)' \
  "$HOME_DIR/super-injector/registry.json" || fail "registry 条目数 != 2"
DSH_HOME="$HOME_DIR" node "$HOME_DIR/plugins/dsh-purge/bin/dsh-purge.js" --status --base "$RT" | grep -q "8/8 已清洗" \
  || fail "dsh-purge 未达 8/8"
assert_eq "$(grep -c '^\[\]$' "$HOME_DIR/profiles/web/cordis.patch.yml")" "1" "cordis 自愈（web）"
assert_eq "$(grep -c '^\[\]$' "$HOME_DIR/profiles/other/cordis.patch.yml")" "1" "cordis 未误改（other）"
n1="$(stamps)"; assert_eq "$n1" "1" "首次安装备份数"
m1="$(stat -f %m "$HOME_DIR/AGENTS.md.bak-dsh-lazy-v5")"
pass "安装产物与补丁全部就位"

echo "== 2. 幂等重装 =="
run_install > "$LOG" 2>&1 || { tail -20 "$LOG"; fail "重装退出码非 0"; }
assert_eq "$(stamps)" "$n1" "重装不重复备份"
assert_eq "$(stat -f %m "$HOME_DIR/AGENTS.md.bak-dsh-lazy-v5")" "$m1" ".bak 未被重写"
pass "重装无副作用"

echo "== 3. 卸载回滚 =="
node "$BIN" --uninstall --pack "$PACK" --dsh-home "$HOME_DIR" --no-restart --no-open-links > "$LOG" 2>&1 \
  || { tail -20 "$LOG"; fail "uninstall 退出码非 0"; }
assert_eq "$(cat "$HOME_DIR/AGENTS.md")" "OLD-AGENTS-v4-CONTENT" "AGENTS.md 未恢复"
assert_eq "$(cat "$HOME_DIR/prompt-inject.md")" "OLD-PROMPT-v4-CONTENT" "prompt-inject.md 未恢复"
[ ! -L "$HOME_DIR/profiles/web/node_modules/dsh-purge" ] || fail "链接未清理"
grep -q '"dsh-purge"' "$HOME_DIR/profiles/web/package.json" && fail "依赖未清理"
node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(a.length===0?0:1)' \
  "$HOME_DIR/super-injector/registry.json" || fail "registry 未清空"
[ -f "$HOME_DIR/AGENTS.md.bak-dsh-lazy-v5" ] || fail ".bak 被误删"
n2="$(stamps)"
pass "卸载精准回滚"

echo "== 4. 重装 =="
run_install > "$LOG" 2>&1 || { tail -20 "$LOG"; fail "重装退出码非 0"; }
assert_eq "$(stamps)" "$n2" "重装不重复备份（跨卸载周期）"
[ -L "$HOME_DIR/profiles/web/node_modules/dsh-purge" ] || fail "重装后链接缺失"
grep -q "SHIYI-DSH" "$HOME_DIR/AGENTS.md" || fail "重装后 AGENTS.md 未更新"
pass "重装恢复产物"

echo
echo "ALL PASS ✔  （夹具保留在 $HOME_DIR 供人工复核）"
