/**
 * 中文伪代码 → C 代码生成器
 * ------------------------------------------------------------------
 * 职责：
 * 1. 把分析器推断出的 PseudoStatement 树翻译成语法正确的 C 代码
 *    （包含 `#include <stdio.h>` 与 `int main(void)`）；
 * 2. 回填每条语句对应的 generatedStartLine / generatedEndLine（1-based，含两端）；
 * 3. 提供「中文表达式 → C 表达式」「中文官方类型 → C 类型」「标识符合法化」等工具，
 *    供 analyzer 在推断阶段复用，保证「推断文本」与「生成代码」使用同一套名字。
 *
 * 注意：生成结果只是系统根据推断给出的建议，并不代表用户原文。
 */

import type { PseudoStatement } from './types';

/** 生成器支持的 C 基础类型（字符串用 char[] 表示） */
export type CType = 'int' | 'double' | 'char' | 'char[]' | 'void';

/** 中文/英文类型词 → C 类型；无法识别时返回 undefined */
const TYPE_ALIASES: Record<string, CType> = {
  整数: 'int',
  整型: 'int',
  整: 'int',
  长整数: 'int',
  长整型: 'int',
  int: 'int',
  long: 'int',
  short: 'int',
  小数: 'double',
  浮点数: 'double',
  浮点: 'double',
  实数: 'double',
  双精度: 'double',
  双精度小数: 'double',
  double: 'double',
  float: 'double',
  字符: 'char',
  字符型: 'char',
  char: 'char',
  布尔: 'int',
  布尔型: 'int',
  逻辑: 'int',
  逻辑型: 'int',
  bool: 'int',
  boolean: 'int',
  字符串: 'char[]',
  字符串型: 'char[]',
  文本: 'char[]',
  文本型: 'char[]',
  string: 'char[]',
  'char[]': 'char[]',
  无返回值: 'void',
  无返回: 'void',
  空: 'void',
  void: 'void',
};

/** 把类型词映射为 C 类型 */
export function mapPseudoType(raw: string | undefined): CType | undefined {
  if (!raw) return undefined;
  const key = raw.trim().replace(/\s+/g, '').toLowerCase();
  if (!key) return undefined;
  return TYPE_ALIASES[key];
}

/** C 关键字集合：用户变量名若与关键字同名需要重命名 */
const C_RESERVED = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum',
  'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return',
  'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void',
  'volatile', 'while', '_Bool', 'bool', 'true', 'false', 'NULL', 'printf', 'scanf', 'main',
]);

/**
 * 标识符映射器。
 * - 合法的 ASCII C 标识符原样保留（关键字/冲突时加后缀）；
 * - 中文等非 ASCII 标识符无法在 C 中表示，按首次出现顺序替换为 v1/f1 之类，
 *   并记录一条提示，保证「不静默改写」。
 */
export class IdentifierMapper {
  private readonly mappings = new Map<string, string>();
  private readonly used = new Set<string>();
  private readonly renameNotes: string[] = [];

  /** 映射一个原始名字，kind 仅决定自动生成名字的前缀 */
  map(name: string, kind: 'var' | 'func' = 'var'): string {
    const raw = name.trim();
    if (!raw) return raw;
    const existing = this.mappings.get(raw);
    if (existing) return existing;

    let candidate = raw;
    const valid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) && !C_RESERVED.has(raw);
    if (!valid) {
      const prefix = kind === 'func' ? 'f' : 'v';
      let index = 1;
      do {
        candidate = `${prefix}${index}`;
        index += 1;
      } while (this.used.has(candidate) || C_RESERVED.has(candidate));
      this.renameNotes.push(
        `标识符「${raw}」不是合法的 C 标识符${C_RESERVED.has(raw) ? '（与 C 关键字冲突）' : ''}，生成代码中已替换为「${candidate}」`,
      );
    } else {
      let index = 2;
      while (this.used.has(candidate)) {
        candidate = `${raw}_${index}`;
        index += 1;
      }
    }
    this.used.add(candidate);
    this.mappings.set(raw, candidate);
    return candidate;
  }

  /** 查询已映射的名字 */
  get(name: string): string | undefined {
    return this.mappings.get(name.trim());
  }

  /** 全部映射（供 UI 展示「系统改名」记录） */
  entries(): Record<string, string> {
    return Object.fromEntries(this.mappings.entries());
  }

  /** 改名相关提示 */
  warnings(): string[] {
    return this.renameNotes.slice();
  }
}

/** 表达式翻译结果 */
export interface TranslatedExpression {
  /** 是否完整翻译成功（字符级） */
  ok: boolean;
  /** 翻译后的 C 表达式文本 */
  text: string;
  /** 表达式里引用到的原始标识符（用于检查是否声明） */
  identifiers: string[];
  /** 翻译过程中的提示 */
  notes: string[];
  /** 是否引号包裹的字符串字面量 */
  isStringLiteral: boolean;
}

/** 全角字符 → 半角字符（表达式环境） */
const EXPR_CHAR_MAP: Record<string, string> = {
  '（': '(',
  '）': ')',
  '［': '[',
  '］': ']',
  '｛': '{',
  '｝': '}',
  '：': ':',
  '，': ',',
  '；': ';',
  '。': '.',
  '、': ',',
  '＝': '=',
  '＋': '+',
  '－': '-',
  '×': '*',
  '÷': '/',
  '％': '%',
  '！': '!',
  '＞': '>',
  '＜': '<',
  '≥': '>=',
  '≤': '<=',
  '≠': '!=',
  '≈': '==',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '「': '"',
  '」': '"',
  '『': '"',
  '』': '"',
  '　': ' ',
};

/** 统一表达式里的全角标点与全角数字 */
function normalizeExpressionChars(raw: string): string {
  let text = raw.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  text = text.replace(/[^\x00-\xff]/g, (ch) => EXPR_CHAR_MAP[ch] ?? ch);
  return text;
}

/** 去掉表达式首尾成对的引号；不是字符串时返回 undefined */
export function unquoteString(raw: string): string | undefined {
  const text = raw.trim();
  if (text.length < 2) return undefined;
  const pairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
    ['「', '」'],
  ];
  for (const [open, close] of pairs) {
    if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
      return text.slice(open.length, text.length - close.length);
    }
  }
  return undefined;
}

/** 转义 C 字符串字面量内容 */
export function escapeCString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** 生成 C 字符串字面量（含引号） */
export function toCStringLiteral(text: string): string {
  return `"${escapeCString(text)}"`;
}

/** 生成 C 字符字面量（含引号） */
export function toCCharLiteral(text: string): string {
  const ch = text.slice(0, 1);
  if (ch === '') return "''";
  if (ch === '\\') return "'\\\\'";
  if (ch === "'") return "'\\''";
  if (ch === '\n') return "'\\n'";
  if (ch === '\t') return "'\\t'";
  if (ch === '\r') return "'\\r'";
  return `'${ch}'`;
}

/** 判断一段文本是否像一个可以被直接嵌入 C 的表达式（字符串内允许中文） */
export function isLikelyCExpression(text: string | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  let inDouble = false;
  let inSingle = false;
  let depth = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inDouble) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === '\\') i += 1;
      else if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') {
      depth -= 1;
      if (depth < 0) return false;
    } else if (!/[A-Za-z0-9_+\-*/%<>=!&|,.\s]/.test(ch)) {
      return false;
    }
  }
  return !inDouble && !inSingle && depth === 0;
}

/** 把可能含注释结束符、换行的文本安全地放进 C 块注释 */
function commentSafe(text: string): string {
  return text.replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' ').trim();
}

/** 中文自然语言运算符词 → C 运算符（按长度优先替换） */
const WORD_OPERATOR_RULES: { pattern: RegExp; replacement: string }[] = [
  { pattern: /(大于等于|大于或等于|不小于|不少于|不低于)/g, replacement: ' >= ' },
  { pattern: /(小于等于|小于或等于|不大于|不超过|不高于)/g, replacement: ' <= ' },
  { pattern: /(不等于|不相同|不为)/g, replacement: ' != ' },
  { pattern: /(大于|超过|高于)/g, replacement: ' > ' },
  { pattern: /(小于|低于|少于|不足)/g, replacement: ' < ' },
  { pattern: /(等于|相同于)/g, replacement: ' == ' },
  { pattern: /(并且|而且|同时满足|同时成立|且)/g, replacement: ' && ' },
  { pattern: /(或者|或是|或)/g, replacement: ' || ' },
  { pattern: /(乘以|乘)/g, replacement: ' * ' },
  { pattern: /(除以|除)/g, replacement: ' / ' },
  { pattern: /(取余|取模|模)/g, replacement: ' % ' },
  { pattern: /(加上|加)/g, replacement: ' + ' },
  { pattern: /(减去|减)/g, replacement: ' - ' },
];

/** 表达式分词正则：字符串、数字、ASCII/CJK 标识符、运算符 */
const EXPR_TOKEN_RE =
  /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\d+\.\d+|\d+|[A-Za-z_][A-Za-z0-9_]*|[\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9_]*|>=|<=|==|!=|&&|\|\||<<|>>|[-+*/%!<>=(),.]/g;

/** 表达式里可以忽略的中文助词 */
const IGNORED_CJK_TOKENS = new Set(['的', '地', '得', '为', '是', '那么', '然后', '并且的']);

/**
 * 中文/自然语言表达式 → C 表达式。
 * 例：`a 大于 5 并且 b 不等于 0` → `a > 5 && b != 0`
 */
export function translateExpressionToC(raw: string, mapper: IdentifierMapper): TranslatedExpression {
  const notes: string[] = [];
  const identifiers: string[] = [];
  const original = raw.trim();
  if (!original) {
    return { ok: false, text: '', identifiers, notes: ['表达式为空'], isStringLiteral: false };
  }

  // 整体就是一个字符串字面量
  const quoted = unquoteString(original);
  if (quoted !== undefined) {
    return { ok: true, text: toCStringLiteral(quoted), identifiers, notes, isStringLiteral: true };
  }

  // 整体否定：「不是 / 并非 / 非 + 条件」→ !(条件)
  const negation = original.match(/^(?:不是|并非|非)\s*(.+)$/);
  if (negation) {
    const inner = translateExpressionToC(negation[1].trim(), mapper);
    if (inner.ok && inner.text) {
      return {
        ok: true,
        text: `!(${inner.text})`,
        identifiers: inner.identifiers,
        notes: inner.notes,
        isStringLiteral: false,
      };
    }
  }

  let text = normalizeExpressionChars(original);
  for (const rule of WORD_OPERATOR_RULES) {
    text = text.replace(rule.pattern, rule.replacement);
  }
  text = text.replace(/\s+/g, ' ').trim();

  const tokens: string[] = [];
  let fatal = false;
  let lastIndex = 0;
  EXPR_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null = EXPR_TOKEN_RE.exec(text);
  while (match) {
    const gap = text.slice(lastIndex, match.index).trim();
    if (gap) {
      notes.push(`表达式中有无法解析的内容「${gap}」`);
      fatal = true;
    }
    lastIndex = match.index + match[0].length;
    const token = match[0];
    if (token.startsWith('"') || token.startsWith("'")) {
      if (token.startsWith("'") && token.length > 3) {
        // 多字符单引号按字符串处理，避免生成非法 C
        tokens.push(toCStringLiteral(token.slice(1, -1)));
      } else {
        tokens.push(token);
      }
    } else if (/^\d/.test(token)) {
      tokens.push(token);
    } else if (token === '真' || token === '成立' || token === 'true' || token === 'TRUE') {
      tokens.push('1');
    } else if (token === '假' || token === '不成立' || token === 'false' || token === 'FALSE') {
      tokens.push('0');
    } else if (IGNORED_CJK_TOKENS.has(token)) {
      // 忽略介词/助词
    } else if (/^[A-Za-z_]/.test(token)) {
      if (C_RESERVED.has(token)) {
        tokens.push(token);
      } else {
        identifiers.push(token);
        tokens.push(mapper.map(token, 'var'));
      }
    } else if (/^[\u4e00-\u9fff]/.test(token)) {
      identifiers.push(token);
      tokens.push(mapper.map(token, 'var'));
    } else {
      tokens.push(token);
    }
    match = EXPR_TOKEN_RE.exec(text);
  }
  const tail = text.slice(lastIndex).trim();
  if (tail) {
    notes.push(`表达式结尾有无法解析的内容「${tail}」`);
    fatal = true;
  }
  if (tokens.length === 0) {
    return { ok: false, text: '', identifiers, notes: [...notes, '表达式未能转换为 C 表达式'], isStringLiteral: false };
  }
  if (fatal) {
    notes.push('表达式未能完整转换，生成代码仅作示意');
  }

  let output = tokens.join(' ');
  output = output
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*,\s*/g, ', ')
    .replace(/!\s+/g, '!')
    .replace(/\s*\.\s*/g, '.')
    .replace(/([A-Za-z0-9_)])\s+\(/g, '$1(')
    .replace(/\s+/g, ' ')
    .trim();

  return { ok: !fatal, text: output, identifiers, notes, isStringLiteral: false };
}

/** 代码生成选项 */
export interface CodegenOptions {
  /** 与 analyzer 共享的标识符映射器，保证推断文本与生成代码名字一致 */
  mapper?: IdentifierMapper;
}

/** 代码生成结果 */
export interface CodegenResult {
  /** 生成的 C 代码文本（只是建议，不代表用户原文） */
  code: string;
  /** 生成过程中的风险提示 */
  warnings: string[];
  /** 标识符替换记录：原文名字 → C 名字 */
  identifierMap: Record<string, string>;
}

interface EmittedFunction {
  statement: PseudoStatement;
  rawName: string;
  cName: string;
  returnType: CType;
  params: { rawName: string; cName: string; type: CType }[];
  duplicate: boolean;
}

/** 把 CType 渲染为参数声明（字符串参数用 char *） */
function renderParam(type: CType, name: string): string {
  if (type === 'char[]') return `char *${name}`;
  if (type === 'void') return name ? `int ${name}` : '';
  return `${type} ${name}`;
}

/** 把 CType 渲染为函数返回类型 */
function renderReturnType(type: CType): string {
  if (type === 'char[]') return 'char *';
  return type;
}

/** 生成器内部状态 */
class CEmitter {
  private readonly lines: string[] = [];
  private indentLevel = 0;
  private loopDepth = 0;
  private readonly warnings: string[] = [];
  private readonly variableTypes = new Map<string, CType>();
  private readonly functionSignatures = new Map<string, EmittedFunction>();
  private readonly functions: EmittedFunction[] = [];

  constructor(private readonly mapper: IdentifierMapper) {}

  private push(text: string): number {
    this.lines.push('    '.repeat(this.indentLevel) + text);
    return this.lines.length;
  }

  private setRange(statement: PseudoStatement, start: number, end: number): void {
    statement.generatedStartLine = start;
    statement.generatedEndLine = Math.max(start, end);
  }

  private expressionOrFallback(text: string | undefined, label: string): string {
    if (text && isLikelyCExpression(text)) return text;
    const raw = text ?? '';
    return `/* ${label}未能转换为 C 表达式${raw ? `：${commentSafe(raw)}` : ''} */ 0`;
  }

  private condition(text: string | undefined): string {
    if (text && isLikelyCExpression(text)) return text;
    return this.expressionOrFallback(text, '条件');
  }

  private collectFunctions(statements: PseudoStatement[]): void {
    const seen = new Set<string>();
    for (const statement of statements) {
      if (statement.kind !== 'function') continue;
      const rawName = statement.inference.functionName ?? '';
      const cName = rawName ? this.mapper.map(rawName, 'func') : `f${this.functions.length + 1}`;
      const returnType = mapPseudoType(statement.inference.functionReturnType) ?? 'void';
      const params = (statement.inference.functionParams ?? [])
        .filter((param) => param.name.trim().length > 0)
        .map((param) => ({
          rawName: param.name,
          cName: this.mapper.map(param.name, 'var'),
          type: mapPseudoType(param.type) ?? 'int',
        }));
      const duplicate = seen.has(cName);
      if (duplicate) {
        this.warnings.push(`函数「${rawName}」被重复定义，生成代码中只保留第一次定义`);
      }
      seen.add(cName);
      const emitted: EmittedFunction = { statement, rawName, cName, returnType, params, duplicate };
      this.functions.push(emitted);
      if (!duplicate) this.functionSignatures.set(cName, emitted);
    }
  }

  /** 生成签名文本（定义与原型共用） */
  private signatureText(fn: EmittedFunction): string {
    const params = fn.params.length
      ? fn.params.map((param) => renderParam(param.type, param.cName)).filter(Boolean).join(', ')
      : 'void';
    return `${renderReturnType(fn.returnType)} ${fn.cName}(${params})`;
  }

  generate(statements: PseudoStatement[]): CodegenResult {
    this.push('#include <stdio.h>');
    this.push('');
    this.push('/* 由 CodeLens 根据中文伪代码自动推断生成，仅供参考，不代表用户原文。 */');
    this.collectFunctions(statements);

    // 先输出函数原型，避免函数之间相互调用时的「隐式声明」
    if (this.functions.length > 0) {
      for (const fn of this.functions) {
        if (fn.duplicate) continue;
        this.push(`${this.signatureText(fn)};`);
      }
      this.push('');
      for (const fn of this.functions) this.emitFunction(fn);
      this.push('');
    }

    // main：按源码顺序生成顶层非函数语句
    this.push('int main(void) {');
    this.indentLevel += 1;
    const mainStatements = statements.filter((statement) => statement.kind !== 'function');
    if (mainStatements.length === 0) {
      this.push('return 0;');
    } else {
      this.emitStatements(mainStatements);
      const lastLine = (this.lines[this.lines.length - 1] ?? '').trim();
      if (!lastLine.startsWith('return')) this.push('return 0;');
    }
    this.indentLevel -= 1;
    this.push('}');

    // 嵌套函数（理论上 analyzer 会放在函数体内）在这里给出提示
    return {
      code: this.lines.join('\n'),
      warnings: [...this.warnings, ...this.mapper.warnings()],
      identifierMap: this.mapper.entries(),
    };
  }

  private emitFunction(fn: EmittedFunction): void {
    if (fn.duplicate) {
      const line = this.push(`/* 函数「${commentSafe(fn.rawName)}」重复定义，已跳过 */`);
      this.setRange(fn.statement, line, line);
      return;
    }
    const start = this.push(`${this.signatureText(fn)} {`);
    this.indentLevel += 1;

    // 注册参数类型，供 printf 格式与 scanf 推断使用
    const backup = new Map<string, CType>();
    for (const param of fn.params) {
      backup.set(param.cName, this.variableTypes.get(param.cName) as CType);
      this.variableTypes.set(param.cName, param.type);
    }
    this.emitStatements(fn.statement.children);
    if (fn.returnType !== 'void' && !hasReturnStatement(fn.statement)) {
      this.push('/* 函数缺少返回语句，补充默认返回值 0，请人工确认 */');
      this.push('return 0;');
      this.warnings.push(`函数「${fn.rawName}」缺少返回语句，生成代码中补充了默认返回值 0`);
    }
    for (const param of fn.params) {
      const previous = backup.get(param.cName);
      if (previous === undefined) this.variableTypes.delete(param.cName);
      else this.variableTypes.set(param.cName, previous);
    }

    this.indentLevel -= 1;
    const end = this.push('}');
    this.setRange(fn.statement, start, end);
  }

  private emitStatements(statements: PseudoStatement[]): void {
    let index = 0;
    while (index < statements.length) {
      const statement = statements[index];
      if (statement.kind === 'if') {
        const chain: PseudoStatement[] = [statement];
        let next = index + 1;
        while (next < statements.length) {
          const candidate = statements[next];
          if (candidate.kind === 'elseif' || candidate.kind === 'else') {
            chain.push(candidate);
            next += 1;
          } else {
            break;
          }
        }
        this.emitIfChain(chain);
        index = next;
        continue;
      }
      this.emitStatement(statement);
      index += 1;
    }
  }

  /** 一条 if / else if / else 链：共享最后的 `}` */
  private emitIfChain(chain: PseudoStatement[]): void {
    const first = chain[0];
    const ifStart = this.push(`if (${this.condition(first.inference.condition)}) {`);
    this.indentLevel += 1;
    this.emitStatements(first.children);
    this.indentLevel -= 1;
    first.generatedStartLine = ifStart;

    const branches: { statement: PseudoStatement; start: number }[] = [];
    for (let i = 1; i < chain.length; i += 1) {
      const branch = chain[i];
      const start = this.push(
        branch.kind === 'elseif'
          ? `} else if (${this.condition(branch.inference.condition)}) {`
          : '} else {',
      );
      this.indentLevel += 1;
      this.emitStatements(branch.children);
      this.indentLevel -= 1;
      branch.generatedStartLine = start;
      branches.push({ statement: branch, start });
    }

    const close = this.push('}');
    first.generatedEndLine = close;
    for (const branch of branches) {
      branch.statement.generatedStartLine = branch.start;
      branch.statement.generatedEndLine = close;
    }
  }

  private emitStatement(statement: PseudoStatement): void {
    switch (statement.kind) {
      case 'declare':
        this.emitDeclare(statement);
        return;
      case 'assign':
        this.emitAssign(statement);
        return;
      case 'print':
        this.emitPrint(statement);
        return;
      case 'input':
        this.emitInput(statement);
        return;
      case 'loop':
        this.emitLoop(statement);
        return;
      case 'function': {
        // 只有嵌套函数会走到这里（顶层函数在 generate 中单独生成）
        const name = statement.inference.functionName ?? '';
        const line = this.push(`/* C 不支持函数内定义函数「${commentSafe(name)}」，此处仅保留注释 */`);
        this.setRange(statement, line, line);
        this.warnings.push(`第 ${statement.line} 行在函数内部定义了函数「${name}」，C 不支持嵌套函数，生成代码已跳过该定义`);
        return;
      }
      case 'return':
        this.emitReturn(statement);
        return;
      case 'break':
      case 'continue': {
        if (this.loopDepth === 0) {
          const line = this.push(`/* ${statement.kind === 'break' ? '跳出循环' : '继续循环'}语句不在循环内，未生成 C 语句 */`);
          this.setRange(statement, line, line);
          this.warnings.push(`第 ${statement.line} 行的 ${statement.kind === 'break' ? 'break' : 'continue'} 不在循环内，生成代码中已改为注释`);
          return;
        }
        const line = this.push(statement.kind === 'break' ? 'break;' : 'continue;');
        this.setRange(statement, line, line);
        return;
      }
      case 'call':
        this.emitCall(statement);
        return;
      case 'comment': {
        const content = statement.inference.summary.replace(/^注释[：:]\s*/, '');
        const line = this.push(`// ${commentSafe(content)}`);
        this.setRange(statement, line, line);
        return;
      }
      case 'if':
        this.emitIfChain([statement]);
        return;
      case 'elseif':
      case 'else': {
        // 没有配对的 else / else if：按普通代码块生成，避免丢失块内语句
        const label = statement.kind === 'else' ? '否则' : '否则如果';
        const start = this.push(`/* ${label}分支未找到配对的条件，已按普通代码块生成，请人工确认 */`);
        this.push('{');
        this.indentLevel += 1;
        this.emitStatements(statement.children);
        this.indentLevel -= 1;
        const end = this.push('}');
        this.setRange(statement, start, end);
        return;
      }
      case 'unknown':
      default: {
        const original = statement.original.trim();
        const line = this.push(`/* 未能理解: ${commentSafe(original)} */`);
        this.setRange(statement, line, line);
        return;
      }
    }
  }

  private emitDeclare(statement: PseudoStatement): void {
    const inference = statement.inference;
    const rawName = inference.declaredName ?? '';
    const cName = this.mapper.map(rawName, 'var');
    const type = mapPseudoType(inference.declaredType) ?? 'int';
    const rawValue = inference.declaredValue;
    let lineText: string;

    if (type === 'char[]') {
      const content = rawValue ?? '';
      lineText = content === '' ? `char ${cName}[100];` : `char ${cName}[100] = ${toCStringLiteral(content)};`;
      this.variableTypes.set(cName, type);
    } else if (type === 'char') {
      const content = rawValue ?? '';
      lineText = content === '' ? `char ${cName};` : `char ${cName} = ${toCCharLiteral(content)};`;
      this.variableTypes.set(cName, type);
    } else if (type === 'void') {
      lineText = `/* 变量「${commentSafe(rawName)}」不能声明为 void，已跳过 */`;
      this.warnings.push(`第 ${statement.line} 行把变量声明为 void，生成代码已跳过该声明`);
    } else {
      this.variableTypes.set(cName, type);
      if (!rawValue) {
        lineText = `${type} ${cName};`;
      } else if (isLikelyCExpression(rawValue) && !/^["']/.test(rawValue.trim())) {
        lineText = `${type} ${cName} = ${rawValue};`;
      } else {
        lineText = `${type} ${cName}; /* 初值「${commentSafe(rawValue)}」与类型不匹配或无法转换 */`;
        this.warnings.push(`第 ${statement.line} 行变量「${rawName}」的初值无法转换为 ${type} 表达式，生成代码只保留声明`);
      }
    }
    const line = this.push(lineText);
    this.setRange(statement, line, line);
  }

  private emitAssign(statement: PseudoStatement): void {
    const inference = statement.inference;
    const rawTarget = inference.assignmentTarget ?? '';
    const target = this.mapper.map(rawTarget, 'var');
    const value = inference.assignmentValue ?? '';
    const operator = inference.assignmentOperator ?? '=';
    const line = this.push(
      isLikelyCExpression(value)
        ? `${target} ${operator} ${value};`
        : `/* 未能转换赋值：${commentSafe(statement.original.trim())} */`,
    );
    this.setRange(statement, line, line);
    if (!isLikelyCExpression(value)) {
      this.warnings.push(`第 ${statement.line} 行的赋值表达式无法转换为 C 表达式，生成代码中仅保留注释`);
    }
  }

  private emitPrint(statement: PseudoStatement): void {
    const inference = statement.inference;
    const content = inference.printExpression ?? '';
    let lineText: string;
    if (!inference.printIsExpression) {
      lineText = `printf("${escapeCString(content)}\\n");`;
    } else if (!content) {
      lineText = 'printf("\\n");';
    } else {
      const format = this.inferPrintFormat(content);
      lineText = `printf("${format}\\n", ${this.expressionOrFallback(content, '输出表达式')});`;
    }
    const line = this.push(lineText);
    this.setRange(statement, line, line);
  }

  /** 根据表达式里出现的变量类型推断 printf 格式串 */
  private inferPrintFormat(expression: string): string {
    const plainString = expression.trim();
    if (plainString.startsWith('"')) return '%s';
    const tokens = plainString.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    let hasString = false;
    let hasDouble = false;
    let hasChar = false;
    for (const token of tokens) {
      const type = this.variableTypes.get(token) ?? this.functionSignatures.get(token)?.returnType;
      if (type === 'char[]') hasString = true;
      else if (type === 'double') hasDouble = true;
      else if (type === 'char') hasChar = true;
    }
    if (hasString) return '%s';
    if (hasDouble) return '%g';
    if (hasChar) return '%c';
    if (/\d+\.\d+/.test(plainString)) return '%g';
    return '%d';
  }

  private emitInput(statement: PseudoStatement): void {
    const inference = statement.inference;
    const rawName = inference.assignmentTarget ?? '';
    const cName = this.mapper.map(rawName, 'var');
    let start = 0;
    let type = this.variableTypes.get(cName) ?? mapPseudoType(inference.declaredType);

    // 源码里没有显式声明该变量时，补一条带注释的声明，避免生成无法编译的 scanf
    if (!this.variableTypes.has(cName)) {
      const declaredType = type ?? 'int';
      if (declaredType === 'char[]') {
        start = this.push(`char ${cName}[100]; /* 根据输入语句补充的声明（系统推断），请确认 */`);
      } else if (declaredType === 'char') {
        start = this.push(`char ${cName}; /* 根据输入语句补充的声明（系统推断），请确认 */`);
      } else if (declaredType === 'void') {
        start = this.push(`/* 输入目标「${commentSafe(rawName)}」不能声明为 void，已跳过 */`);
      } else {
        start = this.push(`${declaredType} ${cName}; /* 根据输入语句补充的声明（系统推断），请确认 */`);
      }
      if (declaredType !== 'void') this.variableTypes.set(cName, declaredType);
      type = declaredType === 'void' ? undefined : declaredType;
    }

    let lineText: string;
    switch (type) {
      case 'char[]':
        lineText = `scanf("%99s", ${cName});`;
        break;
      case 'double':
        lineText = `scanf("%lf", &${cName});`;
        break;
      case 'char':
        lineText = `scanf(" %c", &${cName});`;
        break;
      default:
        lineText = `scanf("%d", &${cName});`;
        break;
    }
    const line = this.push(lineText);
    this.setRange(statement, start || line, line);
    if (!type) {
      this.warnings.push(`第 ${statement.line} 行的输入目标「${rawName}」没有已知类型，生成代码按 int 使用 scanf("%d")，请人工确认`);
    }
  }

  private emitLoop(statement: PseudoStatement): void {
    const inference = statement.inference;
    const kind = inference.loopKind ?? 'while';
    this.loopDepth += 1;

    if (kind === 'dowhile') {
      const start = this.push('do {');
      this.indentLevel += 1;
      this.emitStatements(statement.children);
      this.indentLevel -= 1;
      const end = this.push(`} while (!(${this.condition(inference.loopWhile)}));`);
      this.setRange(statement, start, end);
    } else if (kind === 'for') {
      const rawVariable = inference.loopVariable ?? 'i';
      const loopVariable = this.mapper.map(rawVariable, 'var');
      const from = this.expressionOrFallback(inference.loopFrom, '循环起点');
      const to = this.expressionOrFallback(inference.loopTo, '循环终点');
      const step = this.expressionOrFallback(inference.loopStep ?? '1', '循环步长');
      this.variableTypes.set(loopVariable, 'int');
      const start = this.push(`for (int ${loopVariable} = ${from}; ${loopVariable} <= ${to}; ${loopVariable} += ${step}) {`);
      this.indentLevel += 1;
      this.emitStatements(statement.children);
      this.indentLevel -= 1;
      const end = this.push('}');
      this.setRange(statement, start, end);
    } else {
      const start = this.push(`while (${this.condition(inference.loopWhile)}) {`);
      this.indentLevel += 1;
      this.emitStatements(statement.children);
      this.indentLevel -= 1;
      const end = this.push('}');
      this.setRange(statement, start, end);
    }

    this.loopDepth -= 1;
  }

  private emitReturn(statement: PseudoStatement): void {
    const value = statement.inference.returnValue;
    let lineText: string;
    if (!value) {
      lineText = 'return;';
    } else if (isLikelyCExpression(value)) {
      lineText = `return ${value};`;
    } else {
      lineText = `/* 返回值未能转换：${commentSafe(value)} */ return 0;`;
      this.warnings.push(`第 ${statement.line} 行的返回值无法转换为 C 表达式，生成代码中暂用 return 0`);
    }
    const line = this.push(lineText);
    this.setRange(statement, line, line);
  }

  private emitCall(statement: PseudoStatement): void {
    const inference = statement.inference;
    const rawName = inference.callName ?? '';
    const cName = this.mapper.map(rawName, 'func');
    const args = (inference.callArgs ?? [])
      .map((arg) => (isLikelyCExpression(arg) ? arg : '/* 参数未能转换 */ 0'))
      .join(', ');
    const known = this.functionSignatures.has(cName);
    let start = 0;
    if (!known) {
      start = this.push(`/* 调用了未定义的函数「${commentSafe(rawName)}」，生成代码需要补充该函数 */`);
      this.warnings.push(`第 ${statement.line} 行调用了未定义的函数「${rawName}」，生成的 C 代码需要补充函数定义才能编译`);
    }
    const line = this.push(`${cName}(${args});`);
    this.setRange(statement, known ? line : start, line);
  }
}

/** 判断函数体内是否存在 return 语句（递归） */
function hasReturnStatement(statement: PseudoStatement): boolean {
  if (statement.kind === 'return') return true;
  return statement.children.some((child) => hasReturnStatement(child));
}

/**
 * 根据推断出的语句树生成 C 代码，并把每一条语句的生成行号范围回填到语句对象上。
 *
 * @param statements analyzer 输出的顶层语句树
 * @param options 可传入与 analyzer 共享的标识符映射器
 */
export function generateCCode(statements: PseudoStatement[], options: CodegenOptions = {}): CodegenResult {
  const mapper = options.mapper ?? new IdentifierMapper();
  const emitter = new CEmitter(mapper);
  return emitter.generate(statements);
}
