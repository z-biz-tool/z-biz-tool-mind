#!/usr/bin/env bash
# 版本发布：校验一致性 → 跑门禁 → 写回三处版本号 → commit → tag → push。
# 用法：scripts/release.sh [--bump=patch|minor|major] [--yes] [--dry-run]
#
# 关键约束（都是踩过坑留下来的）：
# 1. 版本基线取 max(package.json, Cargo.toml, tauri.conf.json, 最高 v* tag)。
#    只读 package.json 的话，tag 领先于文件时会把版本"发回去"，CI 打出旧号的新包。
# 2. 语义化版本只在 JSON 顶层 version / TOML 的 [package] 段里找，
#    绝不用"正则找第一个 x.y.z"（依赖表里全是 x.y.z）。
# 3. 写回后逐份读回校验，任何一处不等于目标版本就报错退出；
#    校验失败时前面的写入会被还原（见 python 里的 rollback）。
set -euo pipefail

BUMP="minor"
ASSUME_YES=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bump=*) BUMP="${1#*=}"; shift ;;
    --yes | -y) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help)
      sed -n '1,13p' "$0"
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      exit 2
      ;;
  esac
done

case "$BUMP" in
  patch | minor | major) : ;;
  *) echo "--bump 只能是 patch/minor/major，收到 $BUMP" >&2; exit 2 ;;
esac

git rev-parse --git-dir >/dev/null 2>&1 || { echo "不在 git 仓库里" >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo "工作区不干净，先提交或 stash" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "需要 python3（3.11+，使用 tomllib）" >&2; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || {
  echo "python3 版本过低，需要 3.11+ 才有 tomllib" >&2; exit 1;
}

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "main" ]] || { echo "只能在 main 上发布，当前分支 $BRANCH" >&2; exit 1; }
git remote get-url origin >/dev/null 2>&1 || { echo "没有配置 origin 远端" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

export REL_BUMP="$BUMP"
export REL_DRY="$DRY_RUN"

NEW="$(python3 <<'PY'
import json, os, re, subprocess, sys

bump = os.environ["REL_BUMP"]
dry = os.environ["REL_DRY"] == "1"


def die(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def top_level_version(data):
    # 只认顶层 key：嵌套在 dependencies 里的 version 字段不算版本号。
    if not isinstance(data, dict):
        die("配置根节点不是对象")
    v = data.get("version")
    if not isinstance(v, str) or not re.fullmatch(r"\d+\.\d+\.\d+", v):
        die("缺少语义化版本字段 version（要求 x.y.z）")
    return v


def cargo_version():
    import tomllib

    with open("src-tauri/Cargo.toml", "rb") as f:
        doc = tomllib.load(f)
    pkg = doc.get("package", {})
    v = pkg.get("version")
    if not isinstance(v, str):
        die("Cargo.toml 的 [package] version 缺失")
    return v


def highest_tag():
    out = subprocess.run(["git", "tag", "-l", "v*"], capture_output=True, text=True).stdout
    best = None
    for line in out.splitlines():
        m = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)(?:-.*)?", line.strip())
        if not m:
            continue
        t = tuple(int(x) for x in m.groups())
        if best is None or t > best:
            best = t
    return ".".join(str(x) for x in best) if best else None


def bump_of(v, kind):
    a, b, c = (int(x) for x in v.split("."))
    if kind == "major":
        return f"{a + 1}.0.0"
    if kind == "minor":
        return f"{a}.{b + 1}.0"
    return f"{a}.{b}.{c + 1}"


def key_index(text, key):
    """找到顶层 "key": 的值起点，用于原地替换而不重排整个文件。"""
    m = re.search(r'^([ \t]*)"version"[ \t]*:[ \t]*"', text, re.M)
    if not m:
        die("找不到 version 字段")
    return m.end()


def replace_json_version(text, new):
    i = key_index(text, "version")
    j = text.index('"', i)
    return text[:i] + new + text[j:]


def replace_toml_version(text, new):
    # 只替换 [package] 段内第一次出现的 version=
    seg = re.search(r"^\[package\][^\[]*", text, re.M | re.S)
    if not seg:
        die("Cargo.toml 缺少 [package] 段")
    body = seg.group(0)
    m = re.search(r'^version\s*=\s*"([^"]*)"', body, re.M)
    if not m:
        die("Cargo.toml 的 [package] 缺少 version")
    start = seg.start() + m.start(1)
    end = seg.start() + m.end(1)
    return text[:start] + new + text[end:]


targets = {
    "package.json": ("json", read_json("package.json")),
    "src-tauri/Cargo.toml": ("toml", cargo_version()),
    "src-tauri/tauri.conf.json": ("json", read_json("src-tauri/tauri.conf.json")),
}

current = {}
for path, (kind, value) in targets.items():
    v = value if isinstance(value, str) else top_level_version(value)
    current[path] = v

tag = highest_tag()
cands = sorted(set(list(current.values()) + ([tag] if tag else [])), key=lambda s: tuple(int(x) for x in s.split(".")))
base = cands[-1]
new = bump_of(base, bump)

print(f"当前：{current} 最高 tag：{tag or '(无)'} → 新版本：{new}")

if dry:
    print("dry-run，未写入任何文件")
    sys.exit(0)

if len(set(current.values())) != 1:
    die("三处版本号不一致，先手工对齐再发布（禁止脚本猜测基线）")

# 先全部写，再全部读回校验；任何一处不符就把原件写回去。
originals = {}
for path in targets:
    with open(path, encoding="utf-8") as f:
        originals[path] = f.read()

try:
    for path, (kind, _) in targets.items():
        text = originals[path]
        out = replace_json_version(text, new) if kind == "json" else replace_toml_version(text, new)
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(out)

    bad = []
    for path in targets:
        got = targets[path][0] == "toml" and cargo_version() or top_level_version(read_json(path))
        if got != new:
            bad.append((path, got))
    if bad:
        raise RuntimeError(f"读回校验失败：{bad}")
except Exception as e:
    for path, text in originals.items():
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text)
    die(f"版本写入失败，已还原：{e}")

print(new)
PY
)"

[[ -n "$NEW" ]] || { echo "没有取得新版本号" >&2; exit 1; }
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "dry-run 结束（目标版本 ${NEW}）"
  exit 0
fi

echo ">> 门禁：typecheck"
[[ -f package.json ]] && npm run typecheck

if [[ -d src-tauri ]]; then
  echo ">> 门禁：cargo test --lib"
  (cd src-tauri && cargo test --lib)
fi

if [[ -x scripts/release-gate.sh ]]; then
  echo ">> 门禁：release-gate"
  ./scripts/release-gate.sh
fi

git diff --quiet || { echo "门禁过程中工作区被改动，中止" >&2; exit 1; }
# 版本号写入发生在门禁之后，这里只确认它仍然在位。
git diff --name-only | grep -q package.json || { echo "版本号未写入，中止" >&2; exit 1; }

if [[ "$ASSUME_YES" -ne 1 ]]; then
  printf "将提交并推送 v%s（会触发四平台构建），确认？[y/N] " "$NEW"
  read -r REPLY
  [[ "$REPLY" == "y" || "$REPLY" == "Y" ]] || { echo "已取消，文件保持修改状态" >&2; exit 1; }
fi

git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "chore(release): bump version to ${NEW}"
git push origin main
git tag "v${NEW}"
git push origin "v${NEW}"

echo "已发布 v${NEW}，构建进度看 Actions 的 Build & Release"
