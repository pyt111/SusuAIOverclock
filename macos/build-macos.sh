#!/bin/bash
# 苏苏 AI超频 · macOS 组装脚本
#
# 用官方 Electron darwin 运行时 + 便携版 resources/ 组装一个可运行的 macOS 应用，
# 自动写 LSEnvironment（DANGO_PYTHON / PATH，Finder 启动也能找到 python3）并做 ad-hoc 签名。
#
# 用法:
#   bash macos/build-macos.sh \
#     --resources <目录：含 app.asar / packs / library> \
#     --electron-zip <electron-darwin-x64.zip> \
#     [--out <输出目录>] [--name "苏苏 AI超频"] [--no-sign]
#
# resources/ 的获取（Windows 便携版 → 资源目录，已实测）：
#   7z x SusuAIOverclock-<版本>-portable.exe '$PLUGINSDIR/app-64.7z'
#   7z x app-64.7z resources -o./resources
#
# Electron 运行时：官方 release（须与应用构建时的版本一致，v1.5.7 为 44.4.3）
#   https://github.com/electron/electron/releases/download/v44.4.3/electron-v44.4.3-darwin-x64.zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="苏苏 AI超频"
OUT="$ROOT/release/mac"
RESOURCES=""
ELECTRON_ZIP=""
SIGN=1

while [ $# -gt 0 ]; do
  case "$1" in
    --resources) RESOURCES="${2:?--resources 需要一个目录}"; shift 2 ;;
    --electron-zip) ELECTRON_ZIP="${2:?--electron-zip 需要一个文件}"; shift 2 ;;
    --out) OUT="${2:?--out 需要一个目录}"; shift 2 ;;
    --name) NAME="${2:?--name 需要一个名称}"; shift 2 ;;
    --no-sign) SIGN=0; shift ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
done

if [ -z "$RESOURCES" ] || [ ! -d "$RESOURCES" ]; then
  echo "缺少 --resources（含 app.asar / packs / library 的目录）" >&2
  exit 2
fi
if [ -z "$ELECTRON_ZIP" ] || [ ! -f "$ELECTRON_ZIP" ]; then
  echo "缺少 --electron-zip（官方 electron-v<版本>-darwin-x64.zip）" >&2
  exit 2
fi
for need in app.asar packs library; do
  if [ ! -e "$RESOURCES/$need" ]; then
    echo "$RESOURCES 下缺少 $need" >&2
    exit 2
  fi
done

VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || echo '0.0.0')"
echo "应用：$NAME $VERSION"

echo "[1/6] 解压 Electron 运行时"
WORK="$(mktemp -d /tmp/susu-mac-build.XXXXXX)"
ditto -x -k "$ELECTRON_ZIP" "$WORK"
if [ ! -d "$WORK/Electron.app" ]; then
  echo "Electron 压缩包里没有 Electron.app（应使用 darwin 版）" >&2
  exit 1
fi
mv "$WORK/Electron.app" "$WORK/$NAME.app"
APP="$WORK/$NAME.app"
RES="$APP/Contents/Resources"

echo "[2/6] 注入应用源码与素材（app.asar / packs / library）"
cp "$RESOURCES/app.asar" "$RES/app.asar"
if [ -d "$RESOURCES/app.asar.unpacked" ]; then
  cp -R "$RESOURCES/app.asar.unpacked" "$RES/app.asar.unpacked"
fi
cp -R "$RESOURCES/packs" "$RES/packs"
cp -R "$RESOURCES/library" "$RES/library"

echo "[3/6] 品牌信息（名称 / 版本 / Bundle ID）"
P="$APP/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy
$PB -c "Set :CFBundleDisplayName $NAME" "$P"
$PB -c "Set :CFBundleName $NAME" "$P"
$PB -c "Set :CFBundleShortVersionString $VERSION" "$P"
$PB -c "Set :CFBundleVersion $VERSION" "$P"
$PB -c 'Set :CFBundleIdentifier com.wanghan.dangodesk' "$P"

echo "[4/6] 注入环境变量（DANGO_PYTHON / PATH）"
PY_BIN="${DANGO_PYTHON:-}"
if [ -z "$PY_BIN" ]; then
  if [ -x "$HOME/.pyenv/shims/python3" ]; then
    PY_BIN="$HOME/.pyenv/shims/python3"
  elif command -v python3 >/dev/null 2>&1; then
    PY_BIN="$(command -v python3)"
  fi
fi
$PB -c 'Delete :LSEnvironment' "$P" >/dev/null 2>&1 || true
$PB -c 'Add :LSEnvironment dict' "$P"
if [ -n "$PY_BIN" ]; then
  $PB -c "Add :LSEnvironment:DANGO_PYTHON string $PY_BIN" "$P"
  echo "  DANGO_PYTHON=$PY_BIN"
else
  echo "  警告：未找到 python3，cursor / claude 包将无法安装（可稍后设置 DANGO_PYTHON）"
fi
$PB -c "Add :LSEnvironment:PATH string /usr/local/bin:/opt/homebrew/bin:$HOME/.pyenv/shims:$HOME/.opencode/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$P"

echo "[5/6] 清理隔离属性 + ad-hoc 签名"
xattr -cr "$APP"
if [ "$SIGN" = "1" ]; then
  codesign --force --deep --sign - "$APP"
  codesign -v "$APP" && echo "  签名校验 OK"
fi

echo "[6/6] 输出"
mkdir -p "$OUT"
rm -rf "$OUT/$NAME.app"
ditto "$APP" "$OUT/$NAME.app"
echo "完成：$OUT/$NAME.app"
echo "安装到 /Applications：ditto \"$OUT/$NAME.app\" \"/Applications/$NAME.app\""
