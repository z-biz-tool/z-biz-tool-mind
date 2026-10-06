#!/usr/bin/env node
/**
 * 桌面安装包的唯一入口：先体检，再调 tauri build。
 *
 * 为什么要多这一层：这台机器上 `tauri build` 的失败信息是 "cargo: command not found"，
 * 而真正缺的东西每个系统装法不同 —— Windows 要 MSVC 工具链（或换成 -gnu），
 * macOS 要 Xcode 命令行工具；装错一次就白等一趟几分钟起步的编译。体检只花几毫秒。
 *
 *   node scripts/build-desktop.mjs                    # 按当前系统出安装包
 *   node scripts/build-desktop.mjs --arch=universal   # 仅 macOS：arm64 + x86_64 通用包
 *   node scripts/build-desktop.mjs --arch=x86_64      # 仅 macOS：只出 Intel 包
 *   node scripts/build-desktop.mjs --skip-check       # CI 里工具链已就位，直接编
 *   其余参数原样转给 tauri build，例如 -- --features devtools
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (f) => args.some((a) => a === f || a.startsWith(`${f}=`));
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

/** 体检结果：缺什么就直接告诉用户怎么补，别让他去猜 cargo 的错误。 */
function check(os) {
  const problems = [];
  const cargo = spawnSync("cargo", ["--version"], { encoding: "utf8", shell: os === "win32" });
  // rustup 装在 ~/.cargo/bin，但 --no-modify-path（或装完没重开终端）时不在 PATH 里。
  // 这种情况要说"PATH 里没有"，不能说"缺 Rust 工具链"——后者会把人引去再装一遍。
  const rustupCargo = join(
    process.env.CARGO_HOME || join(process.env.HOME || process.env.USERPROFILE || "", ".cargo", "bin"),
    os === "win32" ? "cargo.exe" : "cargo"
  );
  if (cargo.error || cargo.status !== 0) {
    if (existsSync(rustupCargo)) {
      problems.push(
        `Rust 已经装了（${rustupCargo}），但不在 PATH 里：把 %USERPROFILE%\\.cargo\\bin 加进 PATH，或本次用 "$env:PATH;$env:USERPROFILE\\.cargo\\bin" 那样的方式跑`
      );
    } else {
      problems.push(
        os === "win32"
          ? "缺 Rust 工具链。装 rustup：https://rustup.rs（Windows 上还要 “使用 C++ 的桌面开发” 工作负载，或改装 stable-x86_64-pc-windows-gnu）"
          : "缺 Rust 工具链。装 rustup：curl https://sh.rustup.rs -sSf | sh，再 xcode-select --install"
      );
    }
  } else {
    const host = /host: (\S+)/.exec(spawnSync("rustc", ["-vV"], { encoding: "utf8" }).stdout ?? "")?.[1] ?? "";
    if (os === "win32" && host.endsWith("-msvc") && !existsSync(join("C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe"))) {
      problems.push(`Rust 是 ${host}，但系统里没有 Visual Studio 安装器 → 链接阶段会找不到 link.exe。要么装 “C++ 桌面开发” 工作负载，要么 rustup default stable-x86_64-pc-windows-gnu`);
    }
  }
  if (!existsSync(join(ROOT, "node_modules", "@tauri-apps", "cli"))) {
    problems.push("缺 tauri CLI：先跑 npm ci");
  }
  // 图标缺失是打包阶段才报的错，而且报的是 "resource not found"，看不出跟图标有关。
  for (const rel of ["icons/icon.ico", "icons/icon.icns", "icons/32x32.png"]) {
    if (!existsSync(join(ROOT, "src-tauri", rel))) problems.push(`缺 src-tauri/${rel}：跑 npm run icons 生成`);
  }
  return problems;
}

const os = process.platform;
const arch = flag("arch");
const TRIPLE = { arm64: "aarch64-apple-darwin", x86_64: "x86_64-apple-darwin", universal: "universal-apple-darwin" };
if (arch && os !== "darwin") {
  console.error(`--arch 只在 macOS 上有意义（当前 ${os}）`);
  process.exit(2);
}
if (arch && !TRIPLE[arch]) {
  console.error(`--arch 只能是 arm64 / x86_64 / universal，收到 ${arch}`);
  process.exit(2);
}

let bundles = "";
const extra = [];

if (os === "win32") {
  bundles = "nsis,msi"; // .exe（NSIS）+ .msi（WiX）
} else if (os === "darwin") {
  bundles = "app,dmg";
  if (arch) extra.push("--target", TRIPLE[arch]);
} else {
  console.log("当前不是 Windows / macOS：交给 tauri 按本机默认格式打包（deb / rpm / appimage）。");
}

if (!has("--skip-check")) {
  const problems = check(os);
  if (problems.length) {
    console.error("打包前置条件没满足：");
    for (const p of problems) console.error(`  · ${p}`);
    process.exit(1);
  }
}

// 用当前 Node 直接跑 CLI 的 JS 入口：node_modules/.bin/tauri 在 Windows 上是 .cmd，
// Node 18.17 之后不经 shell 拒绝启动它（EINVAL），CI 里那台机器就会在第一步翻车。
const cli = join(ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js");
const cmd = [cli, "build"];
if (bundles) cmd.push("--bundles", bundles);
cmd.push(...extra, ...args.filter((a) => a !== "--skip-check" && !a.startsWith("--arch=")));

console.log(`→ ${process.execPath} ${cmd.join(" ")}（在 ${ROOT}）`);
const r = spawnSync(process.execPath, cmd, { stdio: "inherit", cwd: ROOT });
if (r.error) {
  console.error(`启动 tauri 失败：${r.error.message}`);
  process.exit(1);
}
if (r.status !== 0) process.exit(r.status ?? 1);

// 产物目录未必是 src-tauri/target：CARGO_TARGET_DIR 能把编译产物整体挪走（本机 D: 是机械盘，
// 编译这类小文件密集的 IO 在 SSD 上快好几倍）。真实位置问 cargo，别拼字符串骗用户。
const meta = spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
  encoding: "utf8",
  cwd: join(ROOT, "src-tauri"),
});
let targetDir = join(ROOT, "src-tauri", "target");
try {
  const parsed = JSON.parse(meta.stdout).target_directory;
  if (parsed) targetDir = parsed;
} catch {
  // cargo 不在 PATH 上：按默认位置提示，至少不是空字符串。
}
const outDir = join(targetDir, ...((extra[1] ? [extra[1]] : []).concat("release", "bundle")));
console.log(`\n安装包在：${outDir}`);
console.log(os === "win32" ? "  nsis/*.exe（当前用户安装）  msi/*.msi" : "  dmg/*.dmg  macos/*.app");
