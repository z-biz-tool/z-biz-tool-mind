/**
 * 只依赖字符串的 XML 解析 / 序列化。
 *
 * 为什么不用 DOMParser：那是浏览器 API，node 里跑不了。而 .emmx 的解析-回写
 * 是这个项目最容易坏的一环（用户的原稿在里面），必须能在 CI 之外用真实文件跑回归。
 * 这个解析器只覆盖 .emmx 实际用到的语法：元素、属性、文本、注释、CDATA、
 * XML 声明、DOCTYPE、自闭合标签、五种预定义实体和数字字符引用。
 * 命名空间前缀按字面保留（亿图的文件里没有出现 xmlns 前缀，保留字面最安全）。
 */

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** 直接文本子节点（已解码）。含 CDATA 时也会并进来。 */
  text: string;
  /** true 表示这个节点在源文件里是自闭合写法（仅信息性，序列化按内容判断）。 */
  selfShrink?: boolean;
}

export class XmlError extends Error {}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body.startsWith("#x") || body.startsWith("#X");
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const hit = ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

export function encodeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function encodeAttr(s: string): string {
  return encodeText(s).replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
}

/** V 型属性节点的便捷构造：`<Width V="111"/>`。 */
export function vNode(tag: string, v: string | number): XmlNode {
  const n: XmlNode = { tag, attrs: { V: String(v) }, children: [], text: "" };
  return n;
}

export function el(tag: string, attrs: Record<string, string | number | undefined> = {}, children: XmlNode[] = []): XmlNode {
  const a: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== "") a[k] = String(v);
  return { tag, attrs: a, children, text: "" };
}

export function parseXml(src: string): XmlNode {
  const input = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  const root: XmlNode = { tag: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt < 0) {
      const tail = input.slice(i);
      if (tail.trim()) top().text += decodeEntities(tail);
      break;
    }
    if (lt > i) {
      const chunk = input.slice(i, lt);
      if (chunk.trim()) top().text += decodeEntities(chunk);
    }
    // 特殊结构
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end < 0 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9);
      top().text += input.slice(lt + 9, end < 0 ? input.length : end);
      i = end < 0 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<?", lt)) {
      const end = input.indexOf("?>", lt + 2);
      i = end < 0 ? input.length : end + 2;
      continue;
    }
    if (input.startsWith("<!", lt)) {
      const end = input.indexOf(">", lt + 2);
      i = end < 0 ? input.length : end + 1;
      continue;
    }
    const gt = findTagEnd(input, lt + 1);
    if (gt < 0) throw new XmlError(`标签未闭合：${input.slice(lt, lt + 40)}`);
    const body = input.slice(lt + 1, gt);
    i = gt + 1;

    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      if (stack.length <= 1) throw new XmlError(`多余的结束标签 </${name}>`);
      const open = stack[stack.length - 1];
      if (open.tag !== name) throw new XmlError(`标签不匹配：<${open.tag}> 遇到 </${name}>`);
      stack.pop();
      continue;
    }

    const selfClose = body.endsWith("/");
    const inner = selfClose ? body.slice(0, -1) : body;
    const { name, attrs } = parseTagHead(inner);
    const node: XmlNode = { tag: name, attrs, children: [], text: "" };
    top().children.push(node);
    if (!selfClose) stack.push(node);
  }

  if (stack.length !== 1) {
    throw new XmlError(`文档结束时仍有 ${stack.length - 1} 个标签未闭合：${top().tag}`);
  }
  const elements = root.children;
  if (!elements.length) throw new XmlError("XML 里没有任何元素");
  return elements.length === 1 ? elements[0] : root;
}

/** 找到标签结束的 `>`，跳过属性值里的 `>`。 */
function findTagEnd(src: string, from: number): number {
  let quote = "";
  for (let j = from; j < src.length; j += 1) {
    const c = src[j];
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === ">") return j;
  }
  return -1;
}

function parseTagHead(inner: string): { name: string; attrs: Record<string, string> } {
  const m = /^([^\s/>]+)/.exec(inner);
  if (!m) throw new XmlError("空标签名");
  const name = m[1];
  const attrs: Record<string, string> = {};
  const rest = inner.slice(m[0].length);
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(rest))) {
    const key = hit[1];
    const value = hit[3] !== undefined ? hit[3] : hit[4] ?? "";
    attrs[key] = decodeEntities(value);
  }
  return { name, attrs };
}

export function attr(n: XmlNode | undefined, key: string, dflt = ""): string {
  return n?.attrs[key] ?? dflt;
}

export function numAttr(n: XmlNode | undefined, key: string, dflt = 0): number {
  const raw = n?.attrs[key];
  if (raw === undefined) return dflt;
  const v = Number(raw);
  return Number.isFinite(v) ? v : dflt;
}

export function find(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find((c) => c.tag === tag);
}

export function findAll(node: XmlNode, tag: string): XmlNode[] {
  return node.children.filter((c) => c.tag === tag);
}

/** 取 `<X V="..."/>` 形式的值；没有子节点时回落到 dflt。 */
export function vnode(node: XmlNode | undefined, tag: string, dflt?: string): string | undefined {
  const hit = node ? find(node, tag) : undefined;
  if (!hit) return dflt;
  return hit.attrs.V ?? dflt;
}

export function numVnode(node: XmlNode | undefined, tag: string, dflt = 0): number {
  const raw = vnode(node, tag);
  if (raw === undefined) return dflt;
  const v = Number(raw);
  return Number.isFinite(v) ? v : dflt;
}

/** V 属性缺失时（`<Text>` 这种承载正文的元素）取节点文本。 */
export function valueOrText(node: XmlNode | undefined, dflt = ""): string {
  if (!node) return dflt;
  return node.attrs.V ?? (node.text || dflt);
}

export function serializeXml(root: XmlNode, indent = "    "): string {
  const out: string[] = ['<?xml version="1.0" encoding="utf-8"?>'];
  emit(root, 0, indent, out);
  return out.join("\n") + "\n";
}

function emit(node: XmlNode, depth: number, indent: string, out: string[]): void {
  const pad = indent.repeat(depth);
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${encodeAttr(v)}"`)
    .join("");
  if (node.tag === "#document") {
    for (const c of node.children) emit(c, depth, indent, out);
    return;
  }
  if (!node.children.length) {
    if (!node.text) {
      out.push(`${pad}<${node.tag}${attrs}/>`);
    } else {
      out.push(`${pad}<${node.tag}${attrs}>${encodeText(node.text)}</${node.tag}>`);
    }
    return;
  }
  out.push(`${pad}<${node.tag}${attrs}>`);
  if (node.text) out.push(`${pad}${indent}${encodeText(node.text)}`);
  for (const c of node.children) emit(c, depth + 1, indent, out);
  out.push(`${pad}</${node.tag}>`);
}

/** 结构等价比较：忽略属性顺序之外的所有差异（属性顺序在亿图的文件里本身不稳定）。 */
export function nodeEquals(a: XmlNode, b: XmlNode): boolean {
  if (a.tag !== b.tag) return false;
  if (a.text !== b.text) return false;
  const ka = Object.keys(a.attrs).sort();
  const kb = Object.keys(b.attrs).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return false;
    if (a.attrs[ka[i]] !== b.attrs[ka[i]]) return false;
  }
  if (a.children.length !== b.children.length) return false;
  for (let i = 0; i < a.children.length; i += 1) {
    if (!nodeEquals(a.children[i], b.children[i])) return false;
  }
  return true;
}
