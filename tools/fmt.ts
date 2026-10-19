/**
 * 零依赖 formatter（design.md D2）。规范化排版并幂等：
 * - 尾随空白去除、行尾统一 LF、文件尾保单个换行；
 * - 连续空行压缩为最多 1 行；
 * - 缩进统一 2 空格（TS 源码本就手写 2 空格，这里只做一致性兜底）；
 * --check 模式：不写回，仅报告非规范文件（CI 门禁用），退出码 1 = 有文件需格式化。
 */
import { Glob } from 'bun';

const ROOT = import.meta.dir + '/..';
const GLOBS = ['src/**/*.ts', 'tools/**/*.ts', 'tests/**/*.ts', 'docs/**/*.md'];
const CHECK = process.argv.includes('--check');

function normalize(text: string): string {
  let out = text.replace(/\r\n?/g, '\n');
  const lines = out.split('\n').map((l) => l.replace(/[ \t]+$/g, ''));
  // 压缩 3+ 连续空行（含空字符串行）为 1 空行
  const condensed: string[] = [];
  let blankRun = 0;
  for (const l of lines) {
    if (l.trim() === '') {
      blankRun++;
      if (blankRun <= 1) condensed.push('');
    } else {
      blankRun = 0;
      condensed.push(l);
    }
  }
  out = condensed.join('\n');
  // 文件尾：恰好一个换行
  out = out.replace(/\n+$/, '\n');
  if (out === '\n') out = '';
  return out;
}

let dirty = 0;
let files = 0;
for (const g of GLOBS) {
  for await (const path of new Glob(g).scan({ cwd: ROOT, onlyFiles: true })) {
    files++;
    const normPath = path.replace(/\\/g, '/');
    const full = ROOT + '/' + normPath;
    const text = await Bun.file(full).text();
    const norm = normalize(text);
    if (norm !== text) {
      if (CHECK) {
        console.log(`fmt: ${normPath} not normalized`);
        dirty++;
      } else {
        await Bun.write(full, norm);
        console.log(`fmt: fixed ${normPath}`);
        dirty++;
      }
    }
  }
}
if (!CHECK) {
  console.log(`fmt: ${files} files scanned, ${dirty} fixed`);
} else if (dirty === 0) {
  console.log(`fmt: ${files} files clean`);
}
process.exit(CHECK && dirty > 0 ? 1 : 0);
