# z-biz-tool-mind

思维导图桌面工具，对标亿图脑图 MindMaster：大纲 ⇄ 树同构编辑、多页画布、
.xmind 导入导出、原生菜单栏、权益/配额门控、AI 生成主题入口。

技术栈：Tauri 2 + React 19 + AntD 6 + Zustand 5 + Vite。

## 快速开始

```bash
npm ci                # 安装依赖（根 .npmrc 指到 npmmirror，国内网络友好）
npm run dev           # 纯前端开发（vite，localhost:5173）
npm run tauri dev     # 桌面壳开发（Rust 侧一并编译）
```

## 测试与体检

```bash
npm test                       # 自研零依赖 runner（tests/run.mjs，esbuild 逐文件打包）
npm run typecheck              # tsc --noEmit
cd src-tauri && cargo test     # Rust 侧（含 3 条 #[cfg(windows)] 用例，非 Windows 跳过）
```

新增 `tests/*.test.ts` 会被 runner 自动枚举，无需注册；不引入 vitest/jest。

## 打包与发布

```bash
node scripts/build-desktop.mjs --skip-check   # 本机构建当前平台安装包
scripts/release.sh --dry-run                  # 发布先看计划，别跳过
scripts/release.sh                            # 校验 → 门禁 → 写回三处版本号 → commit → tag → push
```

- 版本基线 = max(package.json, Cargo.toml, tauri.conf.json, 最高 v* tag)。
- push `v*` tag 触发 `.github/workflows/desktop-build.yml`：ubuntu 前端闸门
  （typecheck + 全量测试 + vite 构建）与 Rust fmt 先行，windows 出 .exe/.msi，
  macOS 出 arm64/x86_64 两份 .dmg/.app。

## 文档

- `doc/复刻方案/00_业务逻辑梳理.md` —— 需求事实源（§3.1–3.19 蓝本拆解）
- `doc/优化方案/` —— 优化方案与唯一进度台账（`07_实施进度.md`）
