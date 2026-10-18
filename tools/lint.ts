/**
 * 零依赖 lint（bun 1.4.3 无内置 lint，npm 不可达 —— design.md D2）。
 * 规则集见 docs/test-plan.md §4。退出码：0 = 干净，1 = 有问题。
 */
import { Glob } from 'bun';

const ROOT = import.meta.dir + '/..';
const GLOBS = ['src/**/*.ts', 'tools/**/*.ts', 'tests/**/*.ts'];
const MAX_LINE = 120;

type Issue = { file: string; line: number; rule: string; msg: string };

const issues: Issue[] = [];
let files = 0;

function isComment(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

function stripStrings(line: string): string {
  // 粗剥离字符串与模板字面量，避免字符串内容触发规则（如 "any" 出现在文案里）；
  // 覆盖不了多行模板字面量，R5 超长检查用原行。
  return line
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

for (const g of GLOBS) {
  for await (const path of new Glob(g).scan({ cwd: ROOT, onlyFiles: true })) {
    files++;
    const full = ROOT + '/' + path;
    const text = await Bun.file(full).text();
    const lines = text.split('\n');
    let inBlockComment = false;
    lines.forEach((raw, i) => {
      const line = stripStrings(raw);
      const lineNo = i + 1;
      const opens = (line.match(/\/\*/g) ?? []).length;
      const closes = (line.match(/\*\//g) ?? []).length;
      const wasInBlock = inBlockComment;
      inBlockComment = opens > closes ? true : closes > opens ? false : inBlockComment;

      const inCommentCtx = wasInBlock || isComment(raw);
      // R1/R2 仅查代码行（注释与块注释内不查）；正则用拼接避免自举触发
      const ANY_PAT = new RegExp(':[\\s]*any\\b|as[\\s]+any\\b|<any>|any\\[\\]|Array<any>');
      const BARE_CATCH = /\bcatch\s*\{/;
      if (!inCommentCtx) {
        if (ANY_PAT.test(line)) {
          issues.push({ file: path, line: lineNo, rule: 'R1', msg: 'no `any` type' });
        }
        if (BARE_CATCH.test(line) || /catch\s*\(\s*\)/.test(line)) {
          issues.push({ file: path, line: lineNo, rule: 'R2', msg: 'bare `catch` without error binding' });
        }
      }
      // R3 console.*（tools/main/log 免检）
      const consoleOk = /^(tools\/|src\/main\.ts|src\/core\/log\.ts|src\/cli\.ts|src\/start\.ts|src\/config-cmd\.ts)/;
      if (!consoleOk.test(path) && /\bconsole\./.test(line)) {
        issues.push({ file: path, line: lineNo, rule: 'R3', msg: 'no console.* (use core/log)' });
      }
      // R4 待办标记禁止（不留占位代码）；标记词用拼接避免自举触发
      const MARK = new RegExp('\\b(' + ['TO', 'DO'].join('') + '|' + ['FIX', 'ME'].join('') + ')\\b');
      if (MARK.test(raw)) {
        issues.push({ file: path, line: lineNo, rule: 'R4', msg: 'placeholder markers not allowed' });
      }
      // R5 超长行
      if (raw.length > MAX_LINE) {
        issues.push({ file: path, line: lineNo, rule: 'R5', msg: `line too long (${raw.length} > ${MAX_LINE})` });
      }
    });
  }
}

for (const it of issues) {
  console.error(`${it.file}:${it.line}  [${it.rule}] ${it.msg}`);
}
console.error(`lint: ${files} files, ${issues.length} issues`);
process.exit(issues.length > 0 ? 1 : 0);
