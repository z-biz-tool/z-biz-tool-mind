/**
 * IPC 契约门（mind 仓）：前后端**命令**与**事件**的对应关系。
 *
 * 跑法：`node tests/run.mjs ipcContract`
 *
 * ── 为什么要有这道门 ──────────────────────────────────────────────
 * 这道门是**博采众长**从 z-biz-tool-note / z-biz-tool-box 搬过来的，
 * 但比那两个仓的版本多走了一步（见下面「转接」那一节）。
 *
 * 它守四件事：
 *   1) 前端调的命令，后端必须真的注册了（点了必崩）；
 *   2) 后端注册的命令，要么被前端调用，要么在「预留未接线」清单里写明理由
 *      （不许有既没入口、也没登记的功能）；
 *   3) **Rust emit 的每个事件，前端必须 listen** —— 发了没人收，界面毫无反应，
 *      而且**两端都不报错**（这是最安静的一类坏）；
 *   4) 「快照」判据只有一处（见最后一节）。
 *
 * ── 这道门比 note/box 多走的一步：转接 ─────────────────────────────
 * note 与 box 的版本只认 `listen("事件名", …)` 这种**字面量**形态。
 * mind 自己的代码不是这个形态：
 *
 *     const pairs: [string, () => Promise<void>][] = [
 *       ["autosave-fired", () => useRecent.getState().refreshAutosave()],
 *       ["emmx-saved",    () => useRecent.getState().refreshBackups(…)],
 *     ];
 *     for (const [name, handler] of pairs) {
 *       const un = await listen(name, () => void handler());
 *     }
 *
 * 事件名走**常量表**，再由循环变量喂给 `listen` ⇒ 字面量版扫不到 ⇒
 * 会把两个**真的在听**的事件报成「发了没人收」。
 * （家族探针 family_probe_events.py 就在这上面误报过 mind —— 探针自己错了要改探针，
 *   这道门就是探针的加强版。）
 * ⇒ 所以这里把**常量表**解析出来：`const NAME = [...]` 里的字符串字面量，
 *   经由 `listen(NAME)` 或 `for (const [x] of NAME)` 喂进 listen 的，都算「在听」。
 *
 * ⚠ 解析器可能自己坏掉 ⇒ **门禁自带合成样本自证**（见「解析器自证」那一节）：
 *   解析器坏了 ⇒ 门禁自己先红，而不是变成一个永远绿的空门。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { done, eq, ok } from "./_harness.ts";

/**
 * 仓根 = 进程的工作目录。
 *
 * 不能用 `import.meta.url` 反推：跑子会把测试文件**打包到临时目录**再执行
 * （tests/run.mjs 用 esbuild 单文件打包），那里离仓库十万八千里。
 * 本仓既有的读文件测试（emmx / fold）也是用 `process.cwd()`。
 */
const repoRoot = process.cwd();

/* ────────────────────────── 通用小工具 ────────────────────────── */

/** 剥注释：注释里的例子不算（否则「// listen("x")」会把一条没接的线算成接了）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === "node_modules" || e === "dist" || e === "tests") continue;
      out.push(...walk(p, exts));
    } else if (exts.some((x) => e.endsWith(x))) {
      out.push(p);
    }
  }
  return out;
}

/** 从 src[start]（必须是 open）开始配平到对应的 close，返回闭区间右端（不含）。 */
function matchBalanced(src: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

/** 源码里所有字符串字面量的内容（不含引号）。 */
function stringLiterals(src: string): string[] {
  const out: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  for (const m of src.matchAll(re)) out.push(m[1] ?? m[2] ?? "");
  return out;
}

/** 跳过泛型参数：src[i] === "<" 时配平到 ">"，返回其后的下标；不是 "<" 返回 i。 */
function skipGenerics(src: string, i: number): number {
  if (src[i] !== "<") return i;
  let depth = 0;
  for (let k = i; k < src.length; k++) {
    if (src[k] === "<") depth++;
    else if (src[k] === ">") {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  return i;
}

/* ────────────────────────── 后端：注册的命令 ────────────────────────── */

/** `generate_handler![]` 里注册的命令名（去掉 `module::` 前缀）。 */
function registeredCommands(): Set<string> {
  const lib = readFileSync(path.join(repoRoot, "src-tauri/src/lib.rs"), "utf8");
  const m = /generate_handler!\s*\[/.exec(lib);
  ok("lib.rs 里找得到 generate_handler![]（解析器没坏）", !!m);
  if (!m) return new Set();
  const open = lib.indexOf("[", m.index);
  const end = matchBalanced(lib, open, "[", "]");
  const body = lib.slice(open + 1, end - 1);
  const out = new Set<string>();
  for (const cm of body.matchAll(
    /([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*)\s*(?:::|,|$)/gm
  )) {
    out.add(cm[1]!.split("::").pop()!);
  }
  return out;
}

/* ────────────────────────── 后端：emit 的事件 ────────────────────────── */

/**
 * Rust 侧 emit 的事件名。
 *
 * 两个形态都要认：
 *   · `app.emit("autosave-fired", …)` —— 字面量；
 *   · `app.emit(EVENT, ())` —— **常量**（openfile.rs 的 `pub const EVENT: &str = "open-path"`）。
 *     上一版只认字面量的话，这条事件会被漏掉 ⇒ 门禁会拿一个「没人发的事件」去比前端，
 *     比出一个假的「前端多监听了」—— 结论方向对、论证是错的。
 */
function rustEmittedEvents(): Map<string, string[]> {
  const files = walk(path.join(repoRoot, "src-tauri/src"), [".rs"]);
  const consts = new Map<string, string>();
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"));
    for (const m of src.matchAll(
      /\b(?:pub\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*:\s*&str\s*=\s*"([^"]+)"/g
    )) {
      consts.set(m[1]!, m[2]!);
    }
  }
  const out = new Map<string, string[]>();
  const record = (ev: string, where: string) => {
    const list = out.get(ev) ?? [];
    list.push(where);
    out.set(ev, list);
  };
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"));
    for (const m of src.matchAll(/\bemit\w*\s*\(/g)) {
      const open = src.indexOf("(", m.index + m[0].length - 1);
      const close = matchBalanced(src, open, "(", ")");
      const args = src.slice(open + 1, close - 1);
      const where = `${path.relative(repoRoot, f)}:${src.slice(0, m.index).split("\n").length}`;
      // 第一个实参是标识符 ⇒ 当常量解析；否则取实参里第一个字符串字面量。
      const ident = /^\s*&?\s*([A-Za-z_][A-Za-z0-9_]*)\s*(,|$)/.exec(args);
      if (ident && consts.has(ident[1]!)) {
        record(consts.get(ident[1]!)!, where);
        continue;
      }
      const lit = /"([^"]+)"/.exec(args);
      if (lit) record(lit[1]!, where);
    }
  }
  return out;
}

/* ────────────────────────── 前端：调用的命令 ────────────────────────── */

/**
 * 前端调后端命令的调用点。
 *
 * mind 的 IPC 出口是 `services/native.ts` 里的 `call()`（**不是** `invoke()`），
 * 而且泛型可以嵌套：`call<Record<string, unknown>>("config_get")` ——
 * 只认 `call<T>(` 会漏掉后面这一半（嵌套泛型里第一个 ">" 就结束了）。
 * ⇒ 这里用 `skipGenerics` 配平尖括号，而不是正则里的 `<[^>]*>`。
 */
function frontendCalledCommands(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const record = (cmd: string, where: string) => {
    const list = out.get(cmd) ?? [];
    list.push(where);
    out.set(cmd, list);
  };
  for (const f of walk(path.join(repoRoot, "src"), [".ts", ".tsx"])) {
    const src = stripComments(readFileSync(f, "utf8"));
    for (const m of src.matchAll(/(?<![\w.$])call\b/g)) {
      let i = skipGenerics(src, m.index + m[0].length);
      while (i < src.length && /\s/.test(src[i]!)) i++;
      if (src[i] !== "(") continue;
      let k = i + 1;
      while (k < src.length && /\s/.test(src[k]!)) k++;
      const q = src[k];
      if (q !== '"' && q !== "'") continue; // 声明 `function call<T>(cmd: …)` 的参数不是字面量
      const end = src.indexOf(q, k + 1);
      if (end < 0) continue;
      record(src.slice(k + 1, end), `${path.relative(repoRoot, f)}:${src.slice(0, m.index).split("\n").length}`);
    }
  }
  return out;
}

/* ────────────────────────── 前端：listen 的事件（含转接） ────────────────────────── */

/** 一个事件被 listen 的来源：`literal` = 直接写死；`table` = 经常量表转接。 */
export interface ListenHit {
  event: string;
  via: "literal" | "table";
  where: string;
  /** 转接时用的那张表（常量名）。 */
  table?: string;
}

/**
 * 解析一个文件里「哪张表喂给了 listen」。
 *
 * 两种喂法都要认：
 *   · `listen(TABLE)` —— 直接把表交给 listen；
 *   · `for (const [name, handler] of TABLE) { listen(name, …) }` —— 表里的元素被解构后喂进去。
 */
function listenHitsIn(src: string, file: string): ListenHit[] {
  const hits: ListenHit[] = [];
  const line = (idx: number) => src.slice(0, idx).split("\n").length;

  // ① 表：`const NAME = [...]` / `const NAME = {...}`（类型标注里有 `=>`，要跳过去）
  const tables = new Map<string, string[]>();
  const decl = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of src.matchAll(decl)) {
    let i = m.index + m[0].length;
    let eq = -1;
    while (i < src.length) {
      if (src[i] === "=") {
        if (src[i + 1] === "=" || src[i + 1] === ">") {
          i += 2;
          continue;
        }
        eq = i;
        break;
      }
      i++;
    }
    if (eq < 0) continue;
    let j = eq + 1;
    while (j < src.length && /\s/.test(src[j]!)) j++;
    const ch = src[j];
    if (ch !== "[" && ch !== "{") continue;
    const end = matchBalanced(src, j, ch, ch === "[" ? "]" : "}");
    tables.set(m[1]!, stringLiterals(src.slice(j, end)));
  }

  // ② 循环绑定：`for (const [a, b] of TABLE)` / `for (const x of TABLE)`
  const loopBinding = new Map<string, string>(); // 绑定名 → 表名
  const forOf = /\bfor\s*\(\s*(?:const|let|var)\s+(\[[^\]]*\]|[A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)\s*\)/g;
  for (const m of src.matchAll(forOf)) {
    const table = m[2]!;
    const binding = m[1]!;
    const names = binding.startsWith("[")
      ? [...binding.slice(1, -1).matchAll(/[A-Za-z_$][\w$]*/g)].map((x) => x[0])
      : [binding];
    for (const n of names) loopBinding.set(n, table);
  }

  // ③ listen 调用点
  for (const m of src.matchAll(/(?<![\w.$])listen\b/g)) {
    const after = src.slice(0, m.index);
    // 排除声明与 import：`function listen(` / `async function listen(` / `listen,`
    if (/function\s*$/.test(after) || /import[^;]*$/.test(after)) continue;
    let i = skipGenerics(src, m.index + m[0].length);
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] !== "(") continue;
    let k = i + 1;
    while (k < src.length && /\s/.test(src[k]!)) k++;
    const q = src[k];
    const where = `${file}:${line(m.index)}`;
    if (q === '"' || q === "'") {
      const end = src.indexOf(q, k + 1);
      if (end < 0) continue;
      hits.push({ event: src.slice(k + 1, end), via: "literal", where });
      continue;
    }
    const idm = /^[A-Za-z_$][\w$]*/.exec(src.slice(k));
    if (!idm) continue;
    const ident = idm[0];
    // 直接把表交给 listen
    if (tables.has(ident)) {
      for (const ev of tables.get(ident)!) {
        hits.push({ event: ev, via: "table", where, table: ident });
      }
      continue;
    }
    // 循环变量：从 for…of 的表里取
    const table = loopBinding.get(ident);
    if (table && tables.has(table)) {
      for (const ev of tables.get(table)!) {
        hits.push({ event: ev, via: "table", where, table });
      }
    }
  }
  return hits;
}

function frontendListens(): ListenHit[] {
  const out: ListenHit[] = [];
  for (const f of walk(path.join(repoRoot, "src"), [".ts", ".tsx"])) {
    const src = stripComments(readFileSync(f, "utf8"));
    out.push(...listenHitsIn(src, path.relative(repoRoot, f)));
  }
  return out;
}

/* ────────────────────────── 预留未接线清单 ────────────────────────── */

/**
 * 刻意不做界面入口的命令，每条都要写明理由。
 * 清单不是豁免名单 —— 门禁会反过来检查它：接了就必须删掉。
 */
const RESERVED_NOT_WIRED = new Map<string, string>([]);

/* ────────────────────────── 门禁 ────────────────────────── */

async function main(): Promise<void> {
  const registered = registeredCommands();
  const called = frontendCalledCommands();
  const emitted = rustEmittedEvents();
  const listens = frontendListens();
  const listenedEvents = new Set(listens.map((h) => h.event));
  const viaTable = listens.filter((h) => h.via === "table");

  /* ---------------- 量具本身有效（不是空跑） ---------------- */
  ok(`后端注册的命令太少，解析器可能坏了: ${registered.size}`, registered.size >= 40);
  ok(`前端调用点太少，扫描范围可能不对: ${called.size}`, called.size >= 40);
  ok(`Rust 事件太少，扫描范围可能不对: ${emitted.size}`, emitted.size >= 3);
  ok(
    `转接分支一次都没走到 ⇒ 这道门退化成了 note/box 的字面量版（会误报 mind 自己的转接形态）`,
    viaTable.length >= 2
  );
  ok(
    "Rust 侧的常量形态没解析出来（openfile.rs 的 pub const EVENT）",
    emitted.has("open-path")
  );
  eq(
    "mind 自己那两个走常量表的事件必须被转接分支认出来",
    viaTable.map((h) => h.event).sort(),
    ["autosave-fired", "emmx-saved"]
  );

  /* ---------------- 前端调的命令，后端必须真的注册了 ---------------- */
  const notRegistered = [...called.keys()].filter((c) => !registered.has(c));
  eq(
    `前端调了后端没注册的命令: ${notRegistered.join(", ")}`,
    notRegistered,
    []
  );

  /* ---------------- 后端注册的命令，要么被前端调用，要么登记为预留 ---------------- */
  const unaccounted = [...registered].filter(
    (c) => !called.has(c) && !RESERVED_NOT_WIRED.has(c)
  );
  eq(
    `这些命令实现了、注册了，却既没有界面入口、也没登记为预留: ${unaccounted.join(", ")}`,
    unaccounted,
    []
  );

  /* ---------------- 「预留未接线」清单自身也要是真的 ---------------- */
  for (const [cmd, why] of RESERVED_NOT_WIRED) {
    ok(`${cmd} 的预留理由太短，等于没写`, why.length > 20);
    ok(`${cmd} 后端已不存在 ⇒ 预留清单该删了`, registered.has(cmd));
    ok(`${cmd} 已经被前端调用了 ⇒ 应从预留清单移除`, !called.has(cmd));
  }

  /* ---------------- Rust emit 的每个事件，前端必须 listen ---------------- */
  const nobodyListens = [...emitted.keys()].filter((e) => !listenedEvents.has(e));
  eq(
    `Rust 发的事件前端没监听 ⇒ 事件发出去没有任何效果: ${nobodyListens.join(", ")}`,
    nobodyListens,
    []
  );

  /* ---------------- 反向：前端监听了 Rust 从没发过的事件 ---------------- */
  const neverEmitted = [...listenedEvents].filter((e) => !emitted.has(e));
  eq(
    `前端监听了 Rust 从不发的事件（要么是写错了名字，要么是那段代码永远不跑）: ${neverEmitted.join(", ")}`,
    neverEmitted,
    []
  );

  /* ---------------- 解析器自证（合成样本）：解析器坏了要自己先红 ---------------- */
  {
    const synth = `
      const pairs: [string, () => void][] = [
        ["evt-a", () => 1],
        ["evt-b", () => 2],
      ];
      for (const [name, handler] of pairs) {
        listen(name, handler);
      }
      listen("evt-c", () => 3);
    `;
    const hits = listenHitsIn(synth, "synthetic.ts");
    const evs = hits.map((h) => h.event).sort();
    eq("合成样本里的三个事件都要被认出来", evs, ["evt-a", "evt-b", "evt-c"]);
    eq(
      "合成样本里的 evt-c 必须走字面量这条路",
      hits.filter((h) => h.event === "evt-c").map((h) => h.via),
      ["literal"]
    );
    ok(
      "合成样本里的 evt-a 必须被认成转接（否则这道门对 mind 自己的形态无效）",
      hits.some((h) => h.event === "evt-a" && h.via === "table")
    );

    // 反向对照：一个**只**写死字面量的解析器（note/box 的那一版）在这段样本上会漏掉 evt-a/evt-b。
    const literalOnly = [...synth.matchAll(/\blisten(?:<[^>]*>)?\s*\(\s*["']([a-z-]+)["']/g)].map(
      (m) => m[1]!
    );
    eq(
      "字面量版在这段样本上确实漏掉了两个（所以 mind 需要转接这一层）",
      literalOnly.sort(),
      ["evt-c"]
    );
  }

  /* ---------------- 专项：「快照」判据只有一处 ---------------- */
  {
    // autosave_list 与 autosave_drop 以前各写各的：列表不挑扩展名、删除只准 .emmx。
    // ⇒ 面板份数虚高 + 弹窗把它当快照追问 + 用户点「忽略」却删不掉（每次开机再问一遍）。
    // 现在两侧共用 is_snapshot_file 一条判据 ⇒ 这条门把「只能有一处」钉住。
    const backup = readFileSync(path.join(repoRoot, "src-tauri/src/backup.rs"), "utf8");
    const emmxJudges = backup.match(/eq_ignore_ascii_case\("emmx"\)/g) ?? [];
    eq(
      "backup.rs 里的 .emmx 判据必须只有一处（列表侧与删除侧共用同一个谓词）",
      emmxJudges.length,
      1
    );
    ok(
      "那个唯一的谓词必须叫 is_snapshot_file（名字变了要一起改这条门）",
      /fn\s+is_snapshot_file\s*\(/.test(backup)
    );
    ok(
      "列表侧必须真的用它（不是只在删除侧用）",
      /autosave_list[\s\S]{0,400}?is_snapshot_file/.test(backup)
    );
  }

  done();
}

main().catch((e) => {
  console.log("THROW", e);
  process.exitCode = 1;
});
