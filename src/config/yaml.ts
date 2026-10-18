/**
 * YAML 子集解析器（design.md §1.5）。零依赖。
 * 支持：块映射/序列、流式映射/序列、单双引号、注释、空行、多级缩进、`---` 头、
 *       顶层值位置的整行流式结构（订阅 proxies 的单行 JSON 形态）。
 * 不支持（报错）：锚点/别名、块标量（| >）、tab 缩进、多文档（取第一个）、重复键。
 * 错误信息带 行:列。
 */

export class YamlError extends Error {
  line: number;
  col: number;
  constructor(msg: string, line: number, col: number) {
    super(`yaml:${line}:${col}: ${msg}`);
    this.name = 'YamlError';
    this.line = line;
    this.col = col;
  }
}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

interface Line {
  indent: number;
  text: string; // 去缩进后的内容（含注释与引号原文）
  no: number;
}

interface Ctx {
  lines: Line[];
  pos: number; // lines 索引
}

// ---------- 词法辅助 ----------

/** 剥离行内注释（引号外才生效） */
function stripComment(s: string, lineNo: number): string {
  let inS = false;
  let inD = false;
  let depth = 0; // 流式结构深度
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (inS) {
      if (c === "'") {
        if (s[i + 1] === "'") i++;
        else inS = false;
      }
      continue;
    }
    if (inD) {
      if (c === '\\') i++;
      else if (c === '"') inD = false;
      continue;
    }
    if (c === "'") inS = true;
    else if (c === '"') inD = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1] as string)) && depth === 0) {
      return s.slice(0, i).replace(/\s+$/, '');
    }
  }
  return s.replace(/\s+$/, '');
}

function parseScalar(raw: string, lineNo: number, col: number): YamlValue {
  const s = raw.trim();
  if (s === '') return null;
  if (s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new YamlError('unterminated double quote', lineNo, col);
    return unescapeDouble(s.slice(1, -1));
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError('unterminated single quote', lineNo, col);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[-+]?\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
    return s;
  }
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  return s;
}

function unescapeDouble(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = s[++i];
    switch (n) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '0': out += '\0'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      case 'u': {
        const hex = s.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else out += 'u';
        break;
      }
      case undefined: out += '\\'; break;
      default: out += n;
    }
  }
  return out;
}

// ---------- 流式解析（[...] 与 {...}） ----------

class FlowParser {
  s: string;
  i = 0;
  lineNo: number;
  baseCol: number;
  constructor(s: string, lineNo: number, baseCol: number) {
    this.s = s;
    this.lineNo = lineNo;
    this.baseCol = baseCol;
  }
  err(msg: string): YamlError {
    return new YamlError(msg, this.lineNo, this.baseCol + this.i);
  }
  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i] as string)) this.i++;
  }
  parseValue(): YamlValue {
    this.ws();
    const c = this.s[this.i];
    if (c === '[') return this.parseSeq();
    if (c === '{') return this.parseMap();
    return this.parseScalarUntil([',', ']', '}']);
  }
  parseSeq(): YamlValue[] {
    this.i++; // [
    const out: YamlValue[] = [];
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      if (c === undefined) throw this.err('unterminated flow sequence');
      if (c === ']') {
        this.i++;
        return out;
      }
      out.push(this.parseValue());
      this.ws();
      const t = this.s[this.i];
      if (t === ',') {
        this.i++;
      } else if (t !== ']') {
        throw this.err(`expected ',' or ']' got '${t}'`);
      }
    }
  }
  parseMap(): { [k: string]: YamlValue } {
    this.i++; // {
    const out: { [k: string]: YamlValue } = {};
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      if (c === undefined) throw this.err('unterminated flow map');
      if (c === '}') {
        this.i++;
        return out;
      }
      const key = this.parseKey();
      this.ws();
      let colon = this.s[this.i];
      if (colon !== ':') throw this.err(`expected ':' got '${colon}'`);
      this.i++;
      this.ws();
      const v = this.parseValue();
      if (key in out) throw this.err(`duplicate key '${key}'`);
      out[key] = v;
      this.ws();
      const t = this.s[this.i];
      if (t === ',') this.i++;
      else if (t !== '}') throw this.err(`expected ',' or '}' got '${t}'`);
    }
  }
  parseKey(): string {
    this.ws();
    const c = this.s[this.i];
    if (c === '"' || c === "'") {
      const v = this.parseQuoted();
      return String(v);
    }
    const rest = this.s.slice(this.i);
    const m = /^[^:,{}\[\]]+/.exec(rest);
    if (!m) throw this.err('empty key');
    this.i += m[0].length;
    return m[0].trim();
  }
  parseQuoted(): string {
    const q = this.s[this.i] as string;
    this.i++;
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i] as string;
      if (q === '"' && c === '\\') {
        // 双引号内转义：复用 unescapeDouble 的单字符语义
        const n = this.s[this.i + 1];
        this.i += 2;
        out += n === undefined ? '\\' : unescapeDouble('\\' + n).slice(1);
        continue;
      }
      if (c === q) {
        // 双引号内 \" 已在上面处理；单引号内 '' 转义
        if (q === "'" && this.s[this.i + 1] === "'") {
          out += "'";
          this.i += 2;
          continue;
        }
        this.i++;
        return out;
      }
      out += c;
      this.i++;
    }
    throw this.err('unterminated quoted string');
  }
  parseScalarUntil(stop: string[]): YamlValue {
    this.ws();
    const c = this.s[this.i];
    if (c === '"' || c === "'") {
      return this.parseQuoted();
    }
    let j = this.i;
    while (j < this.s.length && !stop.includes(this.s[j] as string)) j++;
    const raw = this.s.slice(this.i, j).trim();
    this.i = j;
    if (raw === '') return null;
    return parseScalar(raw, this.lineNo, this.baseCol + this.i);
  }
}

// ---------- 块结构解析 ----------

function splitKeyValue(text: string, lineNo: number): { key: string; rest: string; keyCol: number } | null {
  // 返回 null 表示不是 key: 形式
  let inS = false;
  let inD = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inS) {
      if (c === "'") {
        if (text[i + 1] === "'") i++;
        else inS = false;
      }
      continue;
    }
    if (inD) {
      if (c === '\\') i++;
      else if (c === '"') inD = false;
      continue;
    }
    if (c === "'") inS = true;
    else if (c === '"') inD = true;
    else if (c === ':' && (i + 1 >= text.length || /\s/.test(text[i + 1] as string))) {
      const keyRaw = text.slice(0, i).trim();
      const key = keyRaw.startsWith('"') || keyRaw.startsWith("'")
        ? String(parseScalar(keyRaw, lineNo, i + 1))
        : keyRaw;
      return { key, rest: text.slice(i + 1).trim(), keyCol: 0 };
    } else if (c === '#' && i > 0 && /\s/.test(text[i - 1] as string)) {
      return null; // 注释开始前无冒号
    }
  }
  return null;
}

function parseBlock(ctx: Ctx, indent: number): YamlValue {
  const first = ctx.lines[ctx.pos];
  if (first === undefined) return null;

  // 序列？
  if (first.text.startsWith('- ') || first.text === '-') {
    const arr: YamlValue[] = [];
    while (ctx.pos < ctx.lines.length) {
      const ln = ctx.lines[ctx.pos] as Line;
      if (ln.indent < indent) break;
      if (ln.indent > indent) throw new YamlError('bad indentation', ln.no, ln.indent + 1);
      if (!(ln.text.startsWith('- ') || ln.text === '-')) break;
      const itemIndent = ln.indent + 2;
      const restText = ln.text === '-' ? '' : ln.text.slice(2);
      ctx.pos++;
      if (restText.trim() === '') {
        // 子结构在后续行
        const next = ctx.lines[ctx.pos];
        if (next !== undefined && next.indent > ln.indent) {
          arr.push(parseBlock(ctx, next.indent));
        } else {
          arr.push(null);
        }
      } else if (restText.trim().startsWith('- ')) {
        // 行内连续序列项 "- - a"
        throw new YamlError('inline nested sequence items are not supported', ln.no, 1);
      } else if (restText.trim().startsWith('{') || restText.trim().startsWith('[')) {
        // 流式结构值（订阅 proxies 的单行 JSON 形态）：不走 key:value 切分
        arr.push(parseInlineOrScalar(restText, ln.no, itemIndent));
      } else {
        const kv = splitKeyValue(restText, ln.no);
        if (kv) {
          // 行内 map 起点："- name: x" 后续同缩进的键合并进该 map
          const map: { [k: string]: YamlValue } = {};
          if (kv.rest !== '') {
            map[kv.key] = parseInlineOrScalar(kv.rest, ln.no, itemIndent);
          } else {
            const next = ctx.lines[ctx.pos];
            if (next !== undefined && next.indent > ln.indent && !(next.text.startsWith('- ') || next.text === '-')) {
              map[kv.key] = parseBlock(ctx, next.indent);
            } else if (
              next !== undefined &&
              next.indent === itemIndent &&
              (next.text.startsWith('- ') || next.text === '-')
            ) {
              map[kv.key] = parseBlock(ctx, itemIndent);
            } else {
              map[kv.key] = null;
            }
          }
          // 继续吸收 itemIndent 缩进的键
          while (ctx.pos < ctx.lines.length) {
            const n2 = ctx.lines[ctx.pos] as Line;
            if (n2.indent !== itemIndent) break;
            if (n2.text.startsWith('- ') || n2.text === '-') break;
            const kv2 = splitKeyValue(n2.text, n2.no);
            if (!kv2) break;
            ctx.pos++;
            if (kv2.rest !== '') {
              map[kv2.key] = parseInlineOrScalar(kv2.rest, n2.no, n2.indent + 1);
            } else {
              const next = ctx.lines[ctx.pos];
              if (next !== undefined && next.indent > n2.indent) {
                map[kv2.key] = parseBlock(ctx, next.indent);
              } else {
                map[kv2.key] = null;
              }
            }
          }
          arr.push(map);
        } else {
          arr.push(parseInlineOrScalar(restText, ln.no, itemIndent));
        }
      }
    }
    return arr;
  }

  // 映射
  const map: { [k: string]: YamlValue } = {};
  while (ctx.pos < ctx.lines.length) {
    const ln = ctx.lines[ctx.pos] as Line;
    if (ln.indent < indent) break;
    if (ln.indent > indent) throw new YamlError('bad indentation', ln.no, ln.indent + 1);
    const kv = splitKeyValue(ln.text, ln.no);
    if (!kv) throw new YamlError(`expected 'key: value' at block map`, ln.no, 1);
    if (kv.key in map) throw new YamlError(`duplicate key '${kv.key}'`, ln.no, 1);
    ctx.pos++;
    if (kv.rest !== '') {
      map[kv.key] = parseInlineOrScalar(kv.rest, ln.no, ln.indent + 1);
    } else {
      const next = ctx.lines[ctx.pos];
      if (next === undefined || next.indent < ln.indent) {
        map[kv.key] = null;
      } else if (next.indent === ln.indent && (next.text.startsWith('- ') || next.text === '-')) {
        // YAML 允许序列项与父键同缩进（订阅 proxy-groups 的真实形态）
        map[kv.key] = parseBlock(ctx, next.indent);
      } else if (next.indent > ln.indent) {
        map[kv.key] = parseBlock(ctx, next.indent);
      } else {
        map[kv.key] = null;
      }
    }
  }
  return map;
}

/** 行内值：流式结构 / 标量；锚点与别名在此拒报（design.md §1.5） */
function parseInlineOrScalar(rest: string, lineNo: number, col: number): YamlValue {
  const s = rest.trim();
  if (s.startsWith('&') || s.startsWith('*')) {
    throw new YamlError(`anchors/aliases are not supported: '${s.slice(0, 12)}'`, lineNo, col);
  }
  if (s === '|' || s === '>' || s.startsWith('|') || s.startsWith('>')) {
    throw new YamlError('block scalars are not supported', lineNo, col);
  }
  if (s.startsWith('[') || s.startsWith('{')) {
    const fp = new FlowParser(s, lineNo, col);
    const v = fp.parseValue();
    fp.ws();
    if (fp.i < fp.s.length) throw fp.err(`unexpected trailing content '${fp.s.slice(fp.i)}'`);
    return v;
  }
  return parseScalar(s, lineNo, col);
}

/** 解析入口 */
export function parseYaml(text: string): YamlValue {
  const rawLines = text.split('\n');
  const lines: Line[] = [];
  let docSeen = false;
  rawLines.forEach((raw, idx) => {
    const no = idx + 1;
    // tab 检查（缩进区域）
    const indentMatch = /^[ \t]*/.exec(raw) as RegExpExecArray;
    const indentStr = indentMatch[0];
    if (indentStr.includes('\t')) {
      throw new YamlError('tab indentation is not allowed', no, indentStr.indexOf('\t') + 1);
    }
    const stripped = stripComment(raw.trimEnd(), no);
    if (stripped.trim() === '') return;
    if (stripped.trim() === '---') {
      if (docSeen) throw new YamlError('multiple documents are not supported', no, 1);
      if (lines.length > 0) throw new YamlError('--- must be at the beginning', no, 1);
      docSeen = true;
      return;
    }
    if (stripped.trim() === '...') return;
    if (/^[ \t]*[%&]/.test(raw)) {
      throw new YamlError('directives/anchors are not supported', no, 1);
    }
    lines.push({ indent: indentStr.length, text: stripped.trim(), no });
  });
  if (lines.length === 0) return null;
  const ctx: Ctx = { lines, pos: 0 };
  return parseBlock(ctx, lines[0]!.indent);
}

/** 类型收窄辅助（调用方用） */
export function asMap(v: YamlValue, where: string): { [k: string]: YamlValue } {
  if (v === null || v === undefined || typeof v !== 'object' || Array.isArray(v)) {
    throw new YamlError(`${where}: expected mapping`, 0, 0);
  }
  return v;
}
export function asSeq(v: YamlValue, where: string): YamlValue[] {
  if (!Array.isArray(v)) throw new YamlError(`${where}: expected sequence`, 0, 0);
  return v;
}
export function asStr(v: YamlValue, where: string): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new YamlError(`${where}: expected string`, 0, 0);
}
export function asNum(v: YamlValue, where: string): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  throw new YamlError(`${where}: expected number`, 0, 0);
}
export function asBool(v: YamlValue, where: string): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1) return true;
  if (v === 'false' || v === 0) return false;
  throw new YamlError(`${where}: expected boolean`, 0, 0);
}
export function optStr(v: YamlValue | undefined): string | undefined {
  return v === undefined || v === null ? undefined : asStr(v, 'optional string');
}
export function optNum(v: YamlValue | undefined): number | undefined {
  return v === undefined || v === null ? undefined : asNum(v, 'optional number');
}
export function optBool(v: YamlValue | undefined): boolean | undefined {
  return v === undefined || v === null ? undefined : asBool(v, 'optional boolean');
}
