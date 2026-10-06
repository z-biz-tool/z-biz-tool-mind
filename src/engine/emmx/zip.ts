/**
 * ZIP 读写（.emmx 就是一个 zip 容器）。
 *
 * 为什么在 TS 里做而不是在 Rust 里做：
 * ZIP 的解析和 XML 一样是"最容易静默损坏用户文件"的一环，放进 Rust 就只能等 CI 才能验证；
 * 放在 TS 里则可以直接拿亿图真实产出的 doc.zip 跑回归（tests/emmx-roundtrip.test.ts 就是这么做的）。
 * 后端只负责按白名单读写字节。
 *
 * 解压 / 压缩用平台的 DecompressionStream / CompressionStream("deflate-raw")，
 * WebView2 与 macOS 13+ 的 WKWebView 都有；压缩流不可用时自动退化为 store（不压缩），
 * 那仍是合法 ZIP，亿图照样能打开 —— 宁可不压缩，也不要写出打不开的文件。
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LF_SIG = 0x04034b50;

function u16(v: DataView, off: number): number {
  return v.getUint16(off, true);
}

function u32(v: DataView, off: number): number {
  return v.getUint32(off, true);
}

function le16(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}

function le32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const decoder = /* @__PURE__ */ new TextDecoder("utf-8");
const encoder = /* @__PURE__ */ new TextEncoder();

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("当前 WebView 不支持解压，请升级到 Windows 10/WebView2 或 macOS 13 以上");
  }
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const cs = new CompressionStream("deflate-raw");
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    const out = new Uint8Array(buf);
    // 只有真的省空间才用压缩，否则退回 store（小文件 deflate 反而更大）。
    return out.length < bytes.length ? out : null;
  } catch {
    return null;
  }
}

function findEocd(view: DataView): number {
  // 注释区最长 65535 字节，从尾部往回扫是唯一的定位办法。
  const maxBack = Math.min(view.byteLength, 65557);
  for (let i = view.byteLength - 22; i >= view.byteLength - maxBack; i -= 1) {
    if (i < 0) break;
    if (u32(view, i) === EOCD_SIG) return i;
  }
  return -1;
}

export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  if (bytes.length < 22 || u16(new DataView(bytes.buffer, bytes.byteOffset, 4), 0) !== 0x4b50) {
    throw new Error("文件不是 ZIP 容器（缺少 PK 头），可能已损坏或不是亿图脑图文件");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error("ZIP 中央目录缺失，文件已损坏");
  const count = u16(view, eocd + 10);
  let p = u32(view, eocd + 16);
  const out: ZipEntry[] = [];

  for (let n = 0; n < count; n += 1) {
    if (u32(view, p) !== CD_SIG) break;
    const method = u16(view, p + 10);
    const compSize = u32(view, p + 20);
    const nameLen = u16(view, p + 28);
    const extraLen = u16(view, p + 30);
    const commentLen = u16(view, p + 32);
    const localOffset = u32(view, p + 42);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;

    // 数据位置从本地头算：本地头的名字/扩展长度和中央目录可能不同，必须各读各的。
    if (u32(view, localOffset) !== LF_SIG) throw new Error(`条目 ${name} 的本地文件头损坏`);
    const lName = u16(view, localOffset + 26);
    const lExtra = u16(view, localOffset + 28);
    const dataStart = localOffset + 30 + lName + lExtra;
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? raw : method === 8 ? await inflateRaw(raw) : null;
    if (data === null) throw new Error(`不支持的压缩方式 ${method}（条目 ${name}）`);
    out.push({ name, data });
  }
  return out;
}

interface DosTime {
  date: number;
  time: number;
}

function dosNow(at: Date = new Date()): DosTime {
  const y = Math.max(1980, at.getFullYear());
  return {
    date: ((y - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (Math.floor(at.getSeconds() / 2) & 0x1f),
  };
}

export interface WriteOptions {
  compress?: boolean;
  modifiedAt?: Date;
}

export async function writeZip(entries: ZipEntry[], opts: WriteOptions = {}): Promise<Uint8Array> {
  const compress = opts.compress !== false;
  const { date, time } = dosNow(opts.modifiedAt);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = encoder.encode(e.name);
    // 默认 store；只有 deflate 真的带来收益才改方法号，两种写法都是合法 ZIP。
    let stored = 0;
    let payload = e.data;
    if (compress) {
      const z = await deflateRaw(e.data);
      if (z) {
        payload = z;
        stored = 8;
      }
    }
    const crc = crc32(e.data);

    const head = new Uint8Array([
      ...le32(LF_SIG),
      ...le16(20),
      ...le16(0),
      ...le16(stored),
      ...le16(time),
      ...le16(date),
      ...le32(crc),
      ...le32(payload.length),
      ...le32(e.data.length),
      ...le16(nameBytes.length),
      ...le16(0),
    ]);
    locals.push(head, nameBytes, payload);

    const cd = new Uint8Array([
      ...le32(CD_SIG),
      ...le16(20),
      ...le16(20),
      ...le16(0),
      ...le16(stored),
      ...le16(time),
      ...le16(date),
      ...le32(crc),
      ...le32(payload.length),
      ...le32(e.data.length),
      ...le16(nameBytes.length),
      ...le16(0),
      ...le16(0),
      ...le16(0),
      ...le16(0),
      ...le32(0),
      ...le32(offset),
    ]);
    centrals.push(cd, nameBytes);
    offset += head.length + nameBytes.length + payload.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of centrals) cdSize += c.length;
  const eocd = new Uint8Array([
    ...le32(EOCD_SIG),
    ...le16(0),
    ...le16(0),
    ...le16(entries.length),
    ...le16(entries.length),
    ...le32(cdSize),
    ...le32(cdStart),
    ...le16(0),
  ]);

  const total = cdStart + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

export function findEntry(entries: ZipEntry[], suffix: string): ZipEntry | undefined {
  return entries.find((e) => e.name.replace(/\\/g, "/") === suffix);
}

export function encodeText(s: string): Uint8Array {
  return encoder.encode(s);
}

export function decodeBytes(b: Uint8Array): string {
  return decoder.decode(b);
}
