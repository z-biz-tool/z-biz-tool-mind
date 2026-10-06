#!/usr/bin/env bash
# macOS 本地安装脚本（把 tauri 产出的 .app 装进 /Applications 或 --install-dir）。
# 用法：scripts/install.sh [--local] [--no-launch] [--ignore-isolation] [--install-dir <p>] [--grace <s>]
#
# 为什么不是 `cp -R` 一行：目标位置可能已经有旧版本且正在运行。直接覆盖会得到一个
# "半个新半个旧"的 .app（FrameWorks 被删掉一半），下次打开是白屏而不是报错。
# 所以流程是：优雅退出 → 移到暂存名 → 复制新的 → 校验 → 删旧的；任何一步失败都能回滚。
set -euo pipefail

APP_NAME="z-biz-tool-mind"
BUNDLE_ID="com.zifang.z-biz-tool-mind"

LOCAL_BUILD=0
NO_LAUNCH=0
IGNORE_ISOLATION=0
INSTALL_DIR="/Applications"
GRACE=5

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) LOCAL_BUILD=1; shift ;;
    --no-launch) NO_LAUNCH=1; shift ;;
    --ignore-isolation) IGNORE_ISOLATION=1; shift ;;
    --install-dir) INSTALL_DIR="${2:?--install-dir 需要一个路径}"; shift 2 ;;
    --grace) GRACE="${2:?--grace 需要秒数}"; shift 2 ;;
    -h|--help)
      sed -n '1,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

USE_SUDO=0
elev() { if [[ "$USE_SUDO" -eq 1 ]]; then sudo "$@"; else "$@"; fi; }

if [[ ! -w "$INSTALL_DIR" ]]; then
  if [[ -t 0 ]]; then USE_SUDO=1; else
    echo "目标目录不可写且当前非交互终端：$INSTALL_DIR" >&2; exit 1
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

APP_BUNDLE="${APP_NAME}.app"

if [[ "$LOCAL_BUILD" -eq 1 ]]; then
  command -v npm >/dev/null || { echo "找不到 npm，无法本地构建" >&2; exit 1; }
  npm run build
  # 只出 .app：这个脚本要把应用装进 /Applications，dmg 是分发用的外壳，本地装一遍反而多一步挂载。
  npx tauri build --bundles app
fi

# 定位产物：优先 cargo metadata 的 target_directory，拿不到再退回默认路径。
# `|| true` 是必须的 —— set -euo pipefail 下，没装 tauri CLI 时 metadata 会退出 101，
# 整个脚本会在走到 fallback 之前就结束。
TARGET_DIR="$(cargo metadata --no-deps --format-version 1 2>/dev/null \
  | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p' || true)"
[[ -z "${TARGET_DIR:-}" ]] && TARGET_DIR="$ROOT/src-tauri/target"

CANDIDATES=(
  "$TARGET_DIR/release/bundle/macos/$APP_BUNDLE"
  "$TARGET_DIR/aarch64-apple-darwin/release/bundle/macos/$APP_BUNDLE"
  "$TARGET_DIR/x86_64-apple-darwin/release/bundle/macos/$APP_BUNDLE"
)
SRC_APP=""
for c in "${CANDIDATES[@]}"; do
  if [[ -d "$c" ]]; then SRC_APP="$c"; break; fi
done
[[ -z "$SRC_APP" ]] && { echo "找不到已构建的 $APP_BUNDLE，请先加 --local" >&2; exit 1; }

DEST="$INSTALL_DIR/$APP_BUNDLE"

# 1) 优雅退出旧实例
if [[ -d "$DEST" ]]; then
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  deadline=$((SECONDS + GRACE))
  while pgrep -f "MacOS/${APP_NAME}$" >/dev/null 2>&1 && [[ $SECONDS -lt $deadline ]]; do
    sleep 0.3
  done
  if pgrep -f "MacOS/${APP_NAME}$" >/dev/null 2>&1; then
    pid="$(pgrep -f "MacOS/${APP_NAME}$" | head -1)"
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
    sleep 1
  fi
  if pgrep -f "MacOS/${APP_NAME}$" >/dev/null 2>&1; then
    pkill -9 -f "MacOS/${APP_NAME}$" 2>/dev/null || true
  fi
fi

# 2) 暂法式安装：先把旧版本改名挪开，新的复制进来后再删旧的。
INCOMING="$INSTALL_DIR/.${APP_NAME}.app.incoming"
PREVIOUS="$INSTALL_DIR/.${APP_NAME}.app.previous"
elev rm -rf "$INCOMING" "$PREVIOUS"
[[ -d "$DEST" ]] && elev mv "$DEST" "$PREVIOUS"

elev cp -R "$SRC_APP" "$INCOMING"
elev mv "$INCOMING" "$DEST"

# 3) 校验：目录结构 + 可执行文件都在，才算装成功。
#    只看 .app 是否存在是不够的 —— 半成品 .app 一样"存在"。
ok=1
[[ -d "$DEST/Contents/MacOS" ]] || ok=0
[[ -x "$DEST/Contents/MacOS/$APP_NAME" ]] || ok=0
if [[ "$ok" -ne 1 ]]; then
  echo "安装校验失败，回滚到旧版本" >&2
  elev rm -rf "$DEST"
  [[ -d "$PREVIOUS" ]] && elev mv "$PREVIOUS" "$DEST"
  exit 1
fi

# 4) 隔离属性：本地构建的 .app 会被 Gatekeeper 拦住，按需去掉。
if [[ "$IGNORE_ISOLATION" -eq 1 ]]; then
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
fi
[[ -d "$PREVIOUS" ]] && elev rm -rf "$PREVIOUS"

if [[ "$NO_LAUNCH" -eq 0 ]]; then
  open "$DEST"
fi
echo "已安装：$DEST"
