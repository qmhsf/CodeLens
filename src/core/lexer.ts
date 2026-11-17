/**
 * C / C++（C 子集）词法分析器
 * ------------------------------------------------------------------
 * 纯手写扫描器，在浏览器中运行，无原生依赖。
 * 输出带精确源码偏移的 token 流，注释与预处理指令单独保留：
 * - 注释供语义高亮（灰色）与释义使用；
 * - 预处理指令保留原文，供解释器处理 #define 常量与 #include 提示。
 */
import type { ParseIssue } from './analysisTypes';
import { SourceFile, type SourceRange } from './source';

export type TokenType =
  | 'identifier'
  | 'keyword'
  | 'typeKeyword'
  | 'number'
  | 'string'
  | 'char'
  | 'operator'
  | 'punctuation'
  | 'preprocessor'
  | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  start: number;
  end: number;
  /** 1-based 行列 */
  line: number;
  col: number;
}

export interface CommentToken {
  text: string;
  isBlock: boolean;
  start: number;
  end: number;
  line: number;
  col: number;
}

export interface LexResult {
  tokens: Token[];
  comments: CommentToken[];
  issues: ParseIssue[];
  source: SourceFile;
}

/** 控制结构关键字：语义高亮为紫色 */
export const CONTROL_KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'return',
  'goto',
  'try',
  'catch',
  'throw',
]);

/** 类型/声明相关关键字：语义高亮为蓝色 */
export const TYPE_KEYWORDS = new Set([
  'void',
  'char',
  'short',
  'int',
  'long',
  'float',
  'double',
  'signed',
  'unsigned',
  '_Bool',
  'bool',
  'wchar_t',
  'struct',
  'union',
  'enum',
  'typedef',
  'const',
  'volatile',
  'static',
  'extern',
  'register',
  'auto',
  'inline',
  'restrict',
  'constexpr',
  'class',
  'typename',
  'namespace',
  'using',
  'public',
  'private',
  'protected',
  'virtual',
  'override',
  'friend',
  'operator',
  'template',
  'this',
]);

/** 其余关键字（sizeof 等由解析器单独处理分类） */
export const OTHER_KEYWORDS = new Set(['sizeof', 'new', 'delete', 'nullptr', 'true', 'false', 'this']);

const STORAGE_KEYWORDS = new Set([
  'static',
  'extern',
  'register',
  'auto',
  'inline',
  'constexpr',
  'typedef',
  'virtual',
  'friend',
  'template',
  'public',
  'private',
  'protected',
]);

const TYPE_SPECIFIER_KEYWORDS = new Set([
  'void',
  'char',
  'short',
  'int',
  'long',
  'float',
  'double',
  'signed',
  'unsigned',
  '_Bool',
  'bool',
  'wchar_t',
]);

const QUALIFIER_KEYWORDS = new Set(['const', 'volatile', 'restrict']);

export function isStorageKeyword(value: string): boolean {
  return STORAGE_KEYWORDS.has(value);
}

export function isTypeSpecifierKeyword(value: string): boolean {
  return TYPE_SPECIFIER_KEYWORDS.has(value);
}

export function isQualifierKeyword(value: string): boolean {
  return QUALIFIER_KEYWORDS.has(value);
}

const MULTI_CHAR_OPERATORS = [
  '<<=',
  '>>=',
  '...',
  '->',
  '++',
  '--',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '<<',
  '>>',
  '::',
  '.*',
];

const SINGLE_CHAR_OPERATORS = new Set('+-*/%=<>!&|^~?:');
const SINGLE_CHAR_PUNCTUATION = new Set('(){}[];,.');

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

/**
 * 执行词法分析。
 * @param input 源码文本或 SourceFile（便于与解析器共享同一份行索引）
 */
export function tokenizeC(input: string | SourceFile): LexResult {
  const source = typeof input === 'string' ? new SourceFile(input) : input;
  const text = source.text;
  const tokens: Token[] = [];
  const comments: CommentToken[] = [];
  const issues: ParseIssue[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  /** 更新行列信息 */
  const positionOf = (offset: number) => {
    if (offset > lineStart) {
      // 快速路径：同一行内
      return { line, col: offset - lineStart + 1 };
    }
    const p = source.positionAt(offset);
    return { line: p.line, col: p.column };
  };
  const advanceTo = (offset: number) => {
    if (offset < i) return;
    const slice = text.slice(i, offset);
    const newlines = slice.split('\n').length - 1;
    if (newlines > 0) {
      line += newlines;
      lineStart = i + slice.lastIndexOf('\n') + 1;
    }
    i = offset;
  };
  const pushToken = (type: TokenType, start: number, end: number) => {
    const pos = positionOf(start);
    tokens.push({ type, value: text.slice(start, end), start, end, line: pos.line, col: pos.col });
  };
  const report = (message: string, hint: string | undefined, start: number, end: number) => {
    const range: SourceRange = source.range(start, end);
    issues.push({ severity: 'warning', message, hint, range, line: range.startLine });
  };

  while (i < text.length) {
    const ch = text[i];

    // 空白
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      advanceTo(i + 1);
      continue;
    }

    // 预处理指令：行首（可有前导空白）的 #
    let k = i;
    while (k > 0 && (text[k - 1] === ' ' || text[k - 1] === '\t')) k--;
    const isLineStart = k === 0 || text[k - 1] === '\n';
    if (ch === '#' && isLineStart) {
      let end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
      // 处理反斜杠续行
      while (end < text.length && /\\\s*$/.test(text.slice(i, end))) {
        end = text.indexOf('\n', end + 1);
        if (end === -1) {
          end = text.length;
          break;
        }
      }
      pushToken('preprocessor', i, end);
      advanceTo(end);
      continue;
    }

    // 注释
    if (ch === '/' && text[i + 1] === '/') {
      let end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
      const pos = positionOf(i);
      comments.push({ text: text.slice(i, end), isBlock: false, start: i, end, line: pos.line, col: pos.col });
      advanceTo(end);
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const pos = positionOf(i);
      if (close === -1) {
        report('块注释没有闭合（缺少 */）', '请补全注释的结束标记', i, text.length);
        const end = text.length;
        comments.push({ text: text.slice(i, end), isBlock: true, start: i, end, line: pos.line, col: pos.col });
        advanceTo(end);
        continue;
      }
      const end = close + 2;
      comments.push({ text: text.slice(i, end), isBlock: true, start: i, end, line: pos.line, col: pos.col });
      advanceTo(end);
      continue;
    }

    // 字符串
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j++;
          closed = true;
          break;
        }
        if (text[j] === '\n') break;
        j++;
      }
      if (!closed) report('字符串字面量没有闭合（缺少引号）', '检查双引号是否成对', i, j);
      pushToken('string', i, j);
      advanceTo(j);
      continue;
    }

    // 字符字面量
    if (ch === "'") {
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === "'") {
          j++;
          closed = true;
          break;
        }
        if (text[j] === '\n') break;
        j++;
      }
      if (!closed) report('字符字面量没有闭合（缺少单引号）', '检查单引号是否成对', i, j);
      pushToken('char', i, j);
      advanceTo(j);
      continue;
    }

    // 数字
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (ch === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X')) {
        j += 2;
        while (j < text.length && /[0-9a-fA-F]/.test(text[j])) j++;
      } else {
        while (j < text.length && /[0-9]/.test(text[j])) j++;
        if (text[j] === '.') {
          isFloat = true;
          j++;
          while (j < text.length && /[0-9]/.test(text[j])) j++;
        }
        if (text[j] === 'e' || text[j] === 'E') {
          const probe = text[j + 1] === '+' || text[j + 1] === '-' ? j + 2 : j + 1;
          if (/[0-9]/.test(text[probe] ?? '')) {
            isFloat = true;
            j = probe;
            while (j < text.length && /[0-9]/.test(text[j])) j++;
          }
        }
      }
      // 后缀 f/F/u/U/l/L
      while (j < text.length && /[fFuUlL]/.test(text[j])) j++;
      pushToken('number', i, j);
      void isFloat;
      advanceTo(j);
      continue;
    }

    // 标识符 / 关键字
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < text.length && isIdentPart(text[j])) j++;
      const value = text.slice(i, j);
      let type: TokenType = 'identifier';
      if (TYPE_KEYWORDS.has(value)) type = 'typeKeyword';
      else if (CONTROL_KEYWORDS.has(value) || OTHER_KEYWORDS.has(value)) type = 'keyword';
      pushToken(type, i, j);
      advanceTo(j);
      continue;
    }

    // 多字符运算符
    const multi = MULTI_CHAR_OPERATORS.find((op) => text.startsWith(op, i));
    if (multi) {
      pushToken('operator', i, i + multi.length);
      advanceTo(i + multi.length);
      continue;
    }

    // 单字符运算符
    if (SINGLE_CHAR_OPERATORS.has(ch)) {
      pushToken('operator', i, i + 1);
      advanceTo(i + 1);
      continue;
    }

    // 标点
    if (SINGLE_CHAR_PUNCTUATION.has(ch)) {
      pushToken('punctuation', i, i + 1);
      advanceTo(i + 1);
      continue;
    }

    // 无法识别的字符
    report(`无法识别的字符 "${ch}"`, 'C 语言标识符只能包含字母、数字和下划线；如果这是中文说明，请切换到「中文伪代码」语言', i, i + 1);
    advanceTo(i + 1);
  }

  const eofPos = source.positionAt(text.length);
  tokens.push({ type: 'eof', value: '', start: text.length, end: text.length, line: eofPos.line, col: eofPos.column });

  return { tokens, comments, issues, source };
}
