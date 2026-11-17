/**
 * Python 结构分析器
 * ------------------------------------------------------------------
 * 能力定位：结构级（structural）分析。
 * 1. 自实现 Python 分词器：字符串（含三引号 / 前缀）、注释、数字、
 *    标识符（支持 Unicode）、运算符、换行与缩进；
 * 2. 基于缩进块做真正的结构解析（不是逐行正则）：import/from、def、
 *    class、if/elif/else、for/while、try/except/finally、with、
 *    return/break/continue/pass、赋值、函数调用等；
 * 3. 生成语义 token、中文结构树、简单作用域符号表与 issues；
 * 4. 明确标注结构级能力边界，不支持执行且不伪造执行结果。
 *
 * 所有位置均为 0-based 字符偏移，行列通过 SourceFile.range() 换算。
 */
import type { SourceFile } from '../source';
import type {
  LanguageAnalysis,
  OccurrenceRole,
  ParseIssue,
  SemanticCategory,
  SemanticToken,
  StructureNode,
  SymbolInfo,
  SymbolKind,
} from '../analysisTypes';

// ==================================================================
// 分词器
// ==================================================================

type PyTokenKind =
  | 'keyword'
  | 'identifier'
  | 'number'
  | 'string'
  | 'operator'
  | 'punct'
  | 'comment'
  | 'newline'
  | 'indent'
  | 'dedent'
  | 'eof';

interface PyToken {
  kind: PyTokenKind;
  value: string;
  start: number;
  end: number;
}

/** Python 关键字（软关键字 match/case 不在此列，避免误伤普通变量名） */
const PY_KEYWORDS = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

const PY_KEYWORD_CATEGORY: Record<string, SemanticCategory> = {
  False: 'data',
  None: 'data',
  True: 'data',
  and: 'operator',
  as: 'control',
  assert: 'control',
  async: 'function',
  await: 'control',
  break: 'control',
  class: 'type',
  continue: 'control',
  def: 'function',
  del: 'control',
  elif: 'control',
  else: 'control',
  except: 'control',
  finally: 'control',
  for: 'control',
  from: 'control',
  global: 'control',
  if: 'control',
  import: 'control',
  in: 'operator',
  is: 'operator',
  lambda: 'function',
  nonlocal: 'control',
  not: 'operator',
  or: 'operator',
  pass: 'control',
  raise: 'control',
  return: 'control',
  try: 'control',
  while: 'control',
  with: 'control',
  yield: 'control',
};

/** 常见内置类型 / 内置异常：在语义高亮中归为 type */
const PY_BUILTIN_TYPES = new Set([
  'int',
  'float',
  'str',
  'bool',
  'list',
  'dict',
  'set',
  'tuple',
  'frozenset',
  'bytes',
  'bytearray',
  'complex',
  'object',
  'range',
  'type',
  'super',
  'Exception',
  'BaseException',
  'ValueError',
  'TypeError',
  'IndexError',
  'KeyError',
  'ZeroDivisionError',
  'StopIteration',
  'RuntimeError',
  'FileNotFoundError',
  'OSError',
  'AttributeError',
  'NameError',
  'NotImplementedError',
  'ArithmeticError',
  'LookupError',
  'AssertionError',
  'IOError',
]);

/** 常见内置函数：在语义高亮中归为 function */
const PY_BUILTIN_FUNCTIONS = new Set([
  'print',
  'input',
  'len',
  'open',
  'sum',
  'min',
  'max',
  'sorted',
  'reversed',
  'enumerate',
  'zip',
  'map',
  'filter',
  'abs',
  'round',
  'isinstance',
  'issubclass',
  'hasattr',
  'getattr',
  'setattr',
  'delattr',
  'callable',
  'iter',
  'next',
  'chr',
  'ord',
  'hex',
  'oct',
  'bin',
  'id',
  'hash',
  'repr',
  'format',
  'exec',
  'eval',
  'dir',
  'globals',
  'locals',
  'vars',
  'all',
  'any',
  'pow',
  'divmod',
]);

const PY_MULTI_OPERATORS = [
  '**=',
  '//=',
  '>>=',
  '<<=',
  '...',
  '==',
  '!=',
  '<=',
  '>=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '@=',
  '**',
  '//',
  '<<',
  '>>',
  ':=',
  '->',
];

const PY_SINGLE_OPERATORS = new Set(['+', '-', '*', '/', '%', '@', '&', '|', '^', '~', '<', '>', '=', '!']);
const PY_PUNCTUATION = new Set(['(', ')', '[', ']', '{', '}', ',', ':', ';', '.']);

const ASSIGNMENT_OPERATORS = new Set(['=', '+=', '-=', '*=', '/=', '//=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '@=']);

const ID_START = /[\p{L}_]/u;
const ID_CONTINUE = /[\p{L}\p{N}_]/u;

function isIdentifierStart(char: string | undefined): boolean {
  return Boolean(char) && ID_START.test(char as string);
}

function isIdentifierContinue(char: string | undefined): boolean {
  return Boolean(char) && ID_CONTINUE.test(char as string);
}

/** 识别字符串前缀（r/b/f/u 及其组合） */
function stringPrefixLength(text: string, index: number): number {
  if (!/^[rRbBuUfF]$/.test(text[index] ?? '')) return -1;
  let cursor = index;
  let letters = 0;
  while (cursor < text.length && letters < 2 && /^[rRbBuUfF]$/.test(text[cursor])) {
    cursor += 1;
    letters += 1;
  }
  const quote = text[cursor];
  if (quote === '"' || quote === "'") return cursor - index;
  return -1;
}

function truncate(text: string, max = 80): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

interface TokenizeResult {
  tokens: PyToken[];
  issues: ParseIssue[];
}

/**
 * 自实现 Python 分词器。
 * 缩进处理规则与 CPython 类似：空行 / 纯注释行不产生 NEWLINE 与缩进变化；
 * 括号内换行属于隐式续行；反斜杠换行为显式续行。
 */
function tokenizePython(source: SourceFile): TokenizeResult {
  const text = source.text;
  const tokens: PyToken[] = [];
  const issues: ParseIssue[] = [];
  const indentStack = [0];
  let index = 0;
  let parenDepth = 0;
  let atLineStart = true;
  let lastOpenBracket: { char: string; offset: number } | undefined;

  const issueAt = (message: string, offset: number, severity: 'error' | 'warning' = 'error', hint?: string) => {
    const range = source.range(offset, Math.min(offset + 1, text.length));
    issues.push({ severity, message, hint, range, line: range.startLine });
  };

  const push = (kind: PyTokenKind, start: number, end: number): void => {
    tokens.push({ kind, value: text.slice(start, end), start, end });
  };

  while (index < text.length) {
    if (atLineStart && parenDepth === 0) {
      const measureStart = index;
      let cursor = index;
      let width = 0;
      let sawTab = false;
      let sawSpace = false;
      while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) {
        if (text[cursor] === '\t') {
          sawTab = true;
          width += 8 - (width % 8);
        } else {
          sawSpace = true;
          width += 1;
        }
        cursor += 1;
      }
      if (sawTab && sawSpace) {
        issueAt('缩进混用了 Tab 与空格，建议统一使用空格。', measureStart, 'warning', 'Python 官方建议每级缩进使用 4 个空格。');
      }
      if (cursor >= text.length) {
        index = cursor;
        break;
      }
      if (text[cursor] === '\n') {
        index = cursor + 1;
        atLineStart = true;
        continue;
      }
      if (text[cursor] === '#') {
        const newline = text.indexOf('\n', cursor);
        const stop = newline < 0 ? text.length : newline;
        push('comment', cursor, stop);
        index = newline < 0 ? stop : stop + 1;
        atLineStart = true;
        continue;
      }
      const top = indentStack[indentStack.length - 1] ?? 0;
      if (width > top) {
        indentStack.push(width);
        push('indent', measureStart, cursor);
      } else if (width < top) {
        while (indentStack.length > 1 && (indentStack[indentStack.length - 1] ?? 0) > width) {
          indentStack.pop();
          tokens.push({ kind: 'dedent', value: '', start: measureStart, end: measureStart });
        }
        if ((indentStack[indentStack.length - 1] ?? 0) !== width) {
          issueAt(
            `缩进不一致：当前行缩进 ${width} 列，与已建立的缩进层级不匹配。`,
            measureStart,
            'error',
            '请检查该行缩进是否少了或多了空格。',
          );
          indentStack.push(width);
          push('indent', measureStart, cursor);
        }
      }
      index = cursor;
      atLineStart = false;
      continue;
    }

    const char = text[index] ?? '';
    if (char === '\n') {
      if (parenDepth > 0) {
        index += 1;
        continue;
      }
      tokens.push({ kind: 'newline', value: '\n', start: index, end: index + 1 });
      index += 1;
      atLineStart = true;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      index += 1;
      continue;
    }
    if (char === '\\' && text[index + 1] === '\n') {
      index += 2;
      atLineStart = false;
      continue;
    }
    if (char === '#') {
      const newline = text.indexOf('\n', index);
      const stop = newline < 0 ? text.length : newline;
      push('comment', index, stop);
      index = stop;
      continue;
    }

    const prefixLength = stringPrefixLength(text, index);
    if (char === '"' || char === "'" || prefixLength >= 0) {
      const quoteIndex = prefixLength >= 0 ? index + prefixLength : index;
      const quote = text[quoteIndex] ?? '"';
      const triple = text.startsWith(quote.repeat(3), quoteIndex);
      let cursor = quoteIndex + (triple ? 3 : 1);
      let terminated = false;
      while (cursor < text.length) {
        const current = text[cursor];
        if (current === '\\') {
          cursor += 2;
          continue;
        }
        if (triple) {
          if (text.startsWith(quote.repeat(3), cursor)) {
            cursor += 3;
            terminated = true;
            break;
          }
          cursor += 1;
          continue;
        }
        if (current === quote) {
          cursor += 1;
          terminated = true;
          break;
        }
        if (current === '\n') break;
        cursor += 1;
      }
      const stop = Math.min(cursor, text.length);
      push('string', index, stop);
      if (!terminated) {
        issueAt(triple ? '三引号字符串未闭合。' : '字符串未闭合。', index, 'error', '请检查引号是否成对出现。');
      }
      index = stop;
      atLineStart = false;
      continue;
    }

    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(text[index + 1] ?? ''))) {
      let cursor = index;
      if (char === '0' && /[xXoObB]/.test(text[index + 1] ?? '')) {
        cursor = index + 2;
        while (cursor < text.length && /[0-9a-fA-F_]/.test(text[cursor] ?? '')) cursor += 1;
      } else {
        while (cursor < text.length && /[0-9_]/.test(text[cursor] ?? '')) cursor += 1;
        if (text[cursor] === '.') {
          cursor += 1;
          while (cursor < text.length && /[0-9_]/.test(text[cursor] ?? '')) cursor += 1;
        }
        if (/[eE]/.test(text[cursor] ?? '')) {
          cursor += 1;
          if (text[cursor] === '+' || text[cursor] === '-') cursor += 1;
          while (cursor < text.length && /[0-9]/.test(text[cursor] ?? '')) cursor += 1;
        }
        if (/[jJ]/.test(text[cursor] ?? '')) cursor += 1;
      }
      push('number', index, cursor);
      index = cursor;
      continue;
    }

    if (isIdentifierStart(char)) {
      let cursor = index + 1;
      while (cursor < text.length && isIdentifierContinue(text[cursor])) cursor += 1;
      const word = text.slice(index, cursor);
      push(PY_KEYWORDS.has(word) ? 'keyword' : 'identifier', index, cursor);
      index = cursor;
      continue;
    }

    const multi = PY_MULTI_OPERATORS.find((operator) => text.startsWith(operator, index));
    if (multi) {
      if (multi === '...') push('punct', index, index + multi.length);
      else push('operator', index, index + multi.length);
      index += multi.length;
      continue;
    }
    if (PY_SINGLE_OPERATORS.has(char)) {
      push('operator', index, index + 1);
      index += 1;
      continue;
    }
    if (PY_PUNCTUATION.has(char)) {
      if (char === '(' || char === '[' || char === '{') {
        parenDepth += 1;
        lastOpenBracket = { char, offset: index };
      } else if (char === ')' || char === ']' || char === '}') {
        if (parenDepth === 0) {
          issueAt(`多余的右括号“${char}”。`, index, 'error');
        } else {
          parenDepth -= 1;
        }
      }
      push('punct', index, index + 1);
      index += 1;
      continue;
    }

    issueAt(`无法识别的字符“${char}”。`, index, 'error');
    index += 1;
  }

  if (parenDepth > 0 && lastOpenBracket) {
    issueAt(
      `括号“${lastOpenBracket.char}”未闭合，共缺少 ${parenDepth} 个右括号。`,
      lastOpenBracket.offset,
      'error',
    );
  }
  const previous = tokens[tokens.length - 1];
  if (tokens.length > 0 && previous?.kind !== 'newline') {
    tokens.push({ kind: 'newline', value: '', start: text.length, end: text.length });
  }
  while (indentStack.length > 1) {
    indentStack.pop();
    tokens.push({ kind: 'dedent', value: '', start: text.length, end: text.length });
  }
  tokens.push({ kind: 'eof', value: '', start: text.length, end: text.length });
  return { tokens, issues };
}

// ==================================================================
// Python 符号表
// ==================================================================

type PyScopeKind = 'module' | 'function' | 'class';

interface PyScopeRecord {
  id: string;
  kind: PyScopeKind;
  parent?: string;
  label: string;
  declarations: Map<string, string>;
  ownerClassScope?: string;
  classSymbolId?: string;
}

interface PySymbolDraft {
  id: string;
  name: string;
  kind: SymbolKind;
  scopeId: string;
  typeText?: string;
  detail?: string;
  declaration?: { start: number; end: number };
  occurrences: Array<{ start: number; end: number; role: OccurrenceRole }>;
  occurrenceKeys: Set<string>;
}

interface PySemanticFact {
  category: SemanticCategory;
  subkind?: string;
  symbolId?: string;
}

interface PyDeclareOptions {
  typeText?: string;
  detail?: string;
}

class PythonSymbolCollector {
  readonly scopes = new Map<string, PyScopeRecord>();
  readonly symbols = new Map<string, PySymbolDraft>();
  private readonly facts = new Map<string, PySemanticFact>();
  private readonly classScopeBySymbol = new Map<string, string>();
  private readonly scopeCounter = { value: 0 };
  private readonly symbolCounter = { value: 0 };
  readonly moduleScopeId: string;

  constructor(private readonly source: SourceFile) {
    const id = this.createScope('module', undefined, '模块作用域');
    this.moduleScopeId = id;
  }

  private createScope(kind: PyScopeKind, parent: string | undefined, label: string, ownerClassScope?: string): string {
    const id = `py-scope-${++this.scopeCounter.value}`;
    this.scopes.set(id, { id, kind, parent, label, declarations: new Map(), ownerClassScope });
    return id;
  }

  addFunctionScope(parentScopeId: string, name: string): string {
    const parent = this.scopes.get(parentScopeId);
    if (!parent) return this.moduleScopeId;
    const ownerClass = parent.kind === 'class' ? parent.id : this.findOwnerClass(parentScopeId);
    const actualParent = parent.kind === 'class' ? (parent.parent ?? this.moduleScopeId) : parentScopeId;
    return this.createScope('function', actualParent, `函数 ${name}`, ownerClass);
  }

  addClassScope(parentScopeId: string, name: string): string {
    return this.createScope('class', parentScopeId, `类 ${name}`);
  }

  bindClassScope(symbolId: string, classScopeId: string): void {
    this.classScopeBySymbol.set(symbolId, classScopeId);
    const scope = this.scopes.get(classScopeId);
    if (scope) scope.classSymbolId = symbolId;
  }

  findOwnerClass(scopeId: string): string | undefined {
    let current: string | undefined = scopeId;
    while (current) {
      const scope = this.scopes.get(current);
      if (!scope) return undefined;
      if (scope.ownerClassScope) return scope.ownerClassScope;
      if (scope.kind === 'class') return scope.id;
      current = scope.parent;
    }
    return undefined;
  }

  classSymbolForScope(classScopeId: string): PySymbolDraft | undefined {
    const scope = this.scopes.get(classScopeId);
    return scope?.classSymbolId ? this.symbols.get(scope.classSymbolId) : undefined;
  }

  findMember(classSymbol: PySymbolDraft, memberName: string): PySymbolDraft | undefined {
    const classScopeId = this.classScopeBySymbol.get(classSymbol.id);
    const declarations = classScopeId ? this.scopes.get(classScopeId)?.declarations : undefined;
    const symbolId = declarations?.get(memberName);
    return symbolId ? this.symbols.get(symbolId) : undefined;
  }

  resolveClass(scopeId: string, name: string): PySymbolDraft | undefined {
    const symbol = this.resolve(scopeId, name);
    return symbol && (symbol.kind === 'class' || symbol.kind === 'typedef') ? symbol : undefined;
  }

  declare(scopeId: string, name: string, kind: SymbolKind, token: PyToken, options: PyDeclareOptions = {}): PySymbolDraft {
    const scope = this.scopes.get(scopeId) ?? this.scopes.get(this.moduleScopeId);
    if (!scope) throw new Error('Python 符号作用域未初始化');
    const existingId = scope.declarations.get(name);
    if (existingId) {
      const existing = this.symbols.get(existingId);
      if (existing) {
        if (!existing.typeText && options.typeText) existing.typeText = options.typeText;
        if (!existing.detail && options.detail) existing.detail = options.detail;
        this.addOccurrence(existing, token, 'declaration');
        return existing;
      }
    }
    const id = `py-symbol-${++this.symbolCounter.value}`;
    const draft: PySymbolDraft = {
      id,
      name,
      kind,
      scopeId,
      typeText: options.typeText,
      detail: options.detail,
      declaration: { start: token.start, end: token.end },
      occurrences: [],
      occurrenceKeys: new Set(),
    };
    this.symbols.set(id, draft);
    scope.declarations.set(name, id);
    this.addOccurrence(draft, token, 'declaration');
    return draft;
  }

  resolveLocal(scopeId: string, name: string): PySymbolDraft | undefined {
    const scope = this.scopes.get(scopeId);
    const id = scope?.declarations.get(name);
    return id ? this.symbols.get(id) : undefined;
  }

  resolve(scopeId: string, name: string): PySymbolDraft | undefined {
    let current: string | undefined = scopeId;
    while (current) {
      const scope = this.scopes.get(current);
      if (!scope) return undefined;
      const symbolId = scope.declarations.get(name);
      if (symbolId) return this.symbols.get(symbolId);
      current = scope.parent;
    }
    return undefined;
  }

  addOccurrence(symbol: PySymbolDraft, token: PyToken, role: OccurrenceRole): void {
    const key = `${role}:${token.start}:${token.end}`;
    if (symbol.occurrenceKeys.has(key)) return;
    symbol.occurrenceKeys.add(key);
    symbol.occurrences.push({ start: token.start, end: token.end, role });
  }

  recordFact(token: PyToken, category: SemanticCategory, subkind?: string, symbolId?: string): void {
    this.facts.set(`${token.start}:${token.end}`, { category, subkind, symbolId });
  }

  factAt(start: number, end: number): PySemanticFact | undefined {
    return this.facts.get(`${start}:${end}`);
  }

  finalize(): Record<string, SymbolInfo> {
    const result: Record<string, SymbolInfo> = {};
    for (const draft of this.symbols.values()) {
      const declaration = draft.declaration
        ? this.makeOccurrence(draft.declaration.start, draft.declaration.end, 'declaration')
        : undefined;
      result[draft.id] = {
        id: draft.id,
        name: draft.name,
        kind: draft.kind,
        declaration,
        occurrences: draft.occurrences.map((occurrence) => this.makeOccurrence(occurrence.start, occurrence.end, occurrence.role)),
        typeText: draft.typeText,
        detail: draft.detail,
        scopeName: this.scopes.get(draft.scopeId)?.label,
      };
    }
    return result;
  }

  private makeOccurrence(start: number, end: number, role: OccurrenceRole) {
    const range = this.source.range(start, end);
    return {
      range,
      role,
      line: range.startLine,
      snippet: truncate(this.source.lineText(range.startLine), 160),
    };
  }
}

// ==================================================================
// 基于缩进块的结构解析器
// ==================================================================

interface ParameterInfo {
  name: string;
  nameToken?: PyToken;
  annotationTokens: PyToken[];
  defaultTokens: PyToken[];
  isRest: boolean;
}

class PythonParser {
  private index = 0;
  private lastContentEnd = 0;
  private currentScopeId: string;
  private structureCounter = { value: 0 };

  constructor(
    private readonly source: SourceFile,
    private readonly tokens: PyToken[],
    private readonly collector: PythonSymbolCollector,
    private readonly issues: ParseIssue[],
  ) {
    this.currentScopeId = collector.moduleScopeId;
  }

  parseProgram(): StructureNode[] {
    this.skipNewlines();
    const children: StructureNode[] = [];
    if (!this.atEnd()) children.push(...this.parseBlock());
    return [this.makeNode('程序', 'program', 0, this.source.text.length, children)];
  }

  // ---------- 基础 token 操作 ----------

  private peek(offset = 0): PyToken {
    const position = Math.min(this.index + offset, this.tokens.length - 1);
    return this.tokens[position] ?? { kind: 'eof', value: '', start: this.source.text.length, end: this.source.text.length };
  }

  private atEnd(): boolean {
    return this.peek().kind === 'eof';
  }

  private advance(): PyToken {
    const token = this.peek();
    if (this.index < this.tokens.length - 1) this.index += 1;
    if (token.kind !== 'newline' && token.kind !== 'indent' && token.kind !== 'dedent' && token.kind !== 'eof') {
      this.lastContentEnd = Math.max(this.lastContentEnd, token.end);
    }
    return token;
  }

  private skipNewlines(): void {
    while (this.peek().kind === 'newline') this.advance();
  }

  private skipToLineEnd(): void {
    while (!this.atEnd() && this.peek().kind !== 'newline' && this.peek().kind !== 'dedent') this.advance();
    if (this.peek().kind === 'newline') this.advance();
  }

  private expectColon(): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === ':') {
      this.advance();
      return true;
    }
    this.issue('error', '语句头缺少冒号“:”。', token, 'Python 的 if/for/while/def/class 等语句头必须以冒号结尾。');
    return false;
  }

  /** 收集语句头 token（到本层冒号为止，不消费冒号） */
  private gatherHeader(): PyToken[] {
    const collected: PyToken[] = [];
    let depth = 0;
    while (!this.atEnd()) {
      const token = this.peek();
      if (token.kind === 'newline' || token.kind === 'dedent') break;
      if (depth === 0 && token.kind === 'punct' && token.value === ':') break;
      if (token.kind === 'punct') {
        if (token.value === '(' || token.value === '[' || token.value === '{') depth += 1;
        else if (token.value === ')' || token.value === ']' || token.value === '}') depth = Math.max(0, depth - 1);
      }
      collected.push(this.advance());
    }
    return collected;
  }

  /** 收集一行剩余 token（用于 import/return 等简单语句） */
  private gatherLine(): PyToken[] {
    const collected: PyToken[] = [];
    while (!this.atEnd() && this.peek().kind !== 'newline' && this.peek().kind !== 'dedent') {
      collected.push(this.advance());
    }
    return collected;
  }

  /** 收集一条简单语句的 token（遇到顶层分号或换行停止） */
  private gatherSimpleStatement(): PyToken[] {
    const collected: PyToken[] = [];
    let depth = 0;
    while (!this.atEnd()) {
      const token = this.peek();
      if (token.kind === 'newline' || token.kind === 'dedent') break;
      if (depth === 0 && token.kind === 'punct' && token.value === ';') break;
      if (token.kind === 'punct') {
        if (token.value === '(' || token.value === '[' || token.value === '{') depth += 1;
        else if (token.value === ')' || token.value === ']' || token.value === '}') depth = Math.max(0, depth - 1);
      }
      collected.push(this.advance());
    }
    return collected;
  }

  // ---------- 结构与错误处理 ----------

  private makeNode(
    label: string,
    kind: string,
    start: number,
    end: number,
    children: StructureNode[] = [],
    secondary?: string,
  ): StructureNode {
    const safeStart = Math.max(0, Math.min(start, this.source.text.length));
    const safeEnd = Math.max(safeStart, Math.min(end, this.source.text.length));
    return {
      id: `py-structure-${++this.structureCounter.value}`,
      label,
      kind,
      secondary,
      range: this.source.range(safeStart, safeEnd),
      children,
    };
  }

  private issue(severity: 'error' | 'warning' | 'info', message: string, token?: PyToken, hint?: string): void {
    const target = token ?? this.peek();
    const start = Math.max(0, Math.min(target.start, this.source.text.length));
    const range = this.source.range(start, Math.min(start + 1, this.source.text.length));
    this.issues.push({ severity, message, hint, range, line: range.startLine });
  }

  private parseBlock(): StructureNode[] {
    const statements: StructureNode[] = [];
    while (!this.atEnd()) {
      this.skipNewlines();
      if (this.atEnd() || this.peek().kind === 'dedent') break;
      if (this.peek().kind === 'indent') {
        const token = this.advance();
        this.issue('error', '意外的缩进：该行没有对应的代码块开始语句。', token, '请检查上一行是否以冒号结尾。');
        continue;
      }
      const before = this.index;
      statements.push(...this.parseStatement());
      if (this.index === before) this.advance();
    }
    return statements;
  }

  /**
   * 解析冒号后的语句体：
   * - 换行 + INDENT → 缩进块；
   * - 否则按单行语句处理（if x: print(x)）。
   */
  private parseSuite(scopeId: string): { nodes: StructureNode[]; end: number } {
    const previousScope = this.currentScopeId;
    this.currentScopeId = scopeId;
    if (this.peek().kind === 'newline') {
      this.advance();
      if (this.peek().kind !== 'indent') {
        this.issue('error', '代码块缺少缩进的语句体。', this.peek(), '请在冒号后另起一行并缩进 4 个空格。');
        const end = this.lastContentEnd;
        this.currentScopeId = previousScope;
        return { nodes: [], end };
      }
      this.advance();
      const nodes = this.parseBlock();
      const end = this.lastContentEnd;
      if (this.peek().kind === 'dedent') this.advance();
      this.currentScopeId = previousScope;
      return { nodes, end };
    }
    const nodes = this.parseSimpleStatements(scopeId);
    const end = this.lastContentEnd;
    this.currentScopeId = previousScope;
    return { nodes, end };
  }

  private parseStatement(): StructureNode[] {
    const token = this.peek();
    if (token.kind === 'keyword') {
      switch (token.value) {
        case 'def':
          return [this.parseDef(false)];
        case 'class':
          return [this.parseClass()];
        case 'if':
          return [this.parseIf()];
        case 'for':
          return [this.parseFor()];
        case 'while':
          return [this.parseWhile()];
        case 'try':
          return [this.parseTry()];
        case 'with':
          return [this.parseWith()];
        case 'import':
          return [this.parseImport()];
        case 'from':
          return [this.parseFromImport()];
        case 'return':
          return [this.parseReturn()];
        case 'break':
        case 'continue':
        case 'pass':
          return [this.parseFlowKeyword()];
        case 'raise':
          return [this.parseKeywordStatement('抛出异常', 'raise')];
        case 'assert':
          return [this.parseKeywordStatement('断言', 'assert')];
        case 'del':
          return [this.parseKeywordStatement('删除引用', 'del')];
        case 'global':
          return [this.parseScopeDeclaration('全局声明', true)];
        case 'nonlocal':
          return [this.parseScopeDeclaration('非局部声明', false)];
        case 'async': {
          const next = this.peek(1);
          if (next.kind === 'identifier' && next.value === 'def') {
            this.advance();
            return [this.parseDef(true)];
          }
          if (next.kind === 'keyword' && (next.value === 'for' || next.value === 'with')) {
            this.advance();
            return next.value === 'for' ? [this.parseFor()] : [this.parseWith()];
          }
          return this.parseSimpleStatements(this.currentScopeId);
        }
        case 'elif':
        case 'else':
        case 'except':
        case 'finally':
          this.issue('error', `“${token.value}”没有与之匹配的语句。`, token);
          this.advance();
          this.skipToLineEnd();
          return [];
        default:
          return this.parseSimpleStatements(this.currentScopeId);
      }
    }
    if (token.kind === 'operator' && token.value === '@') return [this.parseDecorator()];
    if (token.kind === 'indent' || token.kind === 'dedent' || token.kind === 'newline') {
      this.advance();
      return [];
    }
    return this.parseSimpleStatements(this.currentScopeId);
  }

  // ---------- 各类语句 ----------

  private parseDef(async: boolean): StructureNode {
    const defToken = this.advance();
    const header = this.gatherHeader();
    const nameToken = header.find((token) => token.kind === 'identifier');
    if (!nameToken) this.issue('error', 'def 语句缺少函数名。', defToken);
    const functionName = nameToken?.value ?? '(匿名函数)';
    const parameters = this.extractParameters(header);
    const returnTokens = this.extractReturnAnnotation(header);
    this.expectColon();
    const functionScope = this.collector.addFunctionScope(this.currentScopeId, functionName);
    if (nameToken) {
      const symbol = this.collector.declare(this.currentScopeId, functionName, 'function', nameToken, {
        detail: async ? '异步函数' : '函数',
        typeText: this.parameterSignature(parameters),
      });
      this.collector.recordFact(nameToken, 'function', 'declaration', symbol.id);
    }
    const parameterNodes: StructureNode[] = [];
    for (const parameter of parameters) parameterNodes.push(this.declareParameter(parameter, functionScope));
    if (returnTokens.length > 0) this.analyzeTypeTokens(returnTokens, functionScope);
    const suite = this.parseSuite(functionScope);
    this.markDocstring(suite.nodes);
    return this.makeNode(
      '函数定义',
      'function',
      defToken.start,
      Math.max(suite.end, defToken.end),
      [...parameterNodes, ...suite.nodes],
      `${functionName}(${parameters.map((parameter) => parameter.name).join(', ')})`,
    );
  }

  private parameterSignature(parameters: ParameterInfo[]): string {
    return `(${parameters.map((parameter) => parameter.name).join(', ')})`;
  }

  private extractParameters(header: PyToken[]): ParameterInfo[] {
    const openIndex = header.findIndex((token) => token.kind === 'punct' && token.value === '(');
    if (openIndex < 0) return [];
    let depth = 0;
    let closeIndex = -1;
    for (let cursor = openIndex; cursor < header.length; cursor += 1) {
      const token = header[cursor];
      if (token.kind !== 'punct') continue;
      if (token.value === '(') depth += 1;
      else if (token.value === ')') {
        depth -= 1;
        if (depth === 0) {
          closeIndex = cursor;
          break;
        }
      }
    }
    if (closeIndex < 0) return [];
    const inner = header.slice(openIndex + 1, closeIndex);
    const segments = splitTopLevel(inner, ',');
    const parameters: ParameterInfo[] = [];
    for (const segment of segments) {
      if (segment.length === 0) continue;
      const first = segment[0];
      if (first.value === '/' || first.value === '*') {
        // 仅位置参数 / 仅关键字参数分隔符
        if (segment.length === 1) continue;
      }
      const rest = first.kind === 'operator' && first.value === '*';
      const doubleRest = first.kind === 'operator' && first.value === '**';
      const nameToken = segment.find((token) => token.kind === 'identifier');
      if (!nameToken) continue;
      const colonIndex = findTopLevel(segment, ':');
      const equalsIndex = findTopLevel(segment, '=');
      let annotationTokens: PyToken[] = [];
      if (colonIndex >= 0) {
        const stop = equalsIndex > colonIndex ? equalsIndex : segment.length;
        annotationTokens = segment.slice(colonIndex + 1, stop);
      }
      const defaultTokens = equalsIndex >= 0 ? segment.slice(equalsIndex + 1) : [];
      parameters.push({
        name: nameToken.value,
        nameToken,
        annotationTokens,
        defaultTokens,
        isRest: rest || doubleRest,
      });
    }
    return parameters;
  }

  private extractReturnAnnotation(header: PyToken[]): PyToken[] {
    const arrowIndex = header.findIndex((token) => token.kind === 'operator' && token.value === '->');
    if (arrowIndex < 0) return [];
    return header.slice(arrowIndex + 1);
  }

  private declareParameter(parameter: ParameterInfo, functionScope: string): StructureNode {
    if (parameter.nameToken) {
      const typeText = this.tokensText(parameter.annotationTokens) || undefined;
      const symbol = this.collector.declare(functionScope, parameter.name, 'parameter', parameter.nameToken, {
        detail: parameter.isRest ? '可变参数' : '参数',
        typeText,
      });
      this.collector.recordFact(parameter.nameToken, 'data', 'parameter', symbol.id);
    }
    if (parameter.annotationTokens.length > 0) this.analyzeTypeTokens(parameter.annotationTokens, functionScope);
    if (parameter.defaultTokens.length > 0) this.analyzeExpressionTokens(parameter.defaultTokens, functionScope);
    return this.makeNode(
      '参数',
      'parameter',
      parameter.nameToken?.start ?? this.lastContentEnd,
      parameter.nameToken?.end ?? this.lastContentEnd,
      [],
      this.tokensText(parameter.annotationTokens)
        ? `${parameter.name}: ${this.tokensText(parameter.annotationTokens)}`
        : parameter.name,
    );
  }

  private parseClass(): StructureNode {
    const classToken = this.advance();
    const header = this.gatherHeader();
    const nameToken = header.find((token) => token.kind === 'identifier');
    if (!nameToken) this.issue('error', 'class 语句缺少类名。', classToken);
    const className = nameToken?.value ?? '(匿名类)';
    const bases = this.extractBases(header);
    this.expectColon();
    const classScope = this.collector.addClassScope(this.currentScopeId, className);
    if (nameToken) {
      const symbol = this.collector.declare(this.currentScopeId, className, 'class', nameToken, {
        detail: '类',
        typeText: className,
      });
      this.collector.bindClassScope(symbol.id, classScope);
      this.collector.recordFact(nameToken, 'type', 'declaration', symbol.id);
    }
    for (const baseTokens of bases) this.analyzeTypeTokens(baseTokens, this.currentScopeId);
    const suite = this.parseSuite(classScope);
    this.markDocstring(suite.nodes);
    const baseNodes = bases.map((baseTokens) =>
      this.makeNode(
        `基类 ${this.tokensText(baseTokens) || '?'}`,
        'base-class',
        baseTokens[0]?.start ?? classToken.start,
        baseTokens[baseTokens.length - 1]?.end ?? classToken.end,
      ),
    );
    const secondary = bases.length > 0
      ? `class ${className}(${bases.map((baseTokens) => this.tokensText(baseTokens)).join(', ')})`
      : `class ${className}`;
    return this.makeNode('类定义', 'class', classToken.start, Math.max(suite.end, classToken.end), [...baseNodes, ...suite.nodes], secondary);
  }

  private extractBases(header: PyToken[]): PyToken[][] {
    const openIndex = header.findIndex((token) => token.kind === 'punct' && token.value === '(');
    if (openIndex < 0) return [];
    let depth = 0;
    let closeIndex = -1;
    for (let cursor = openIndex; cursor < header.length; cursor += 1) {
      const token = header[cursor];
      if (token.kind !== 'punct') continue;
      if (token.value === '(') depth += 1;
      else if (token.value === ')') {
        depth -= 1;
        if (depth === 0) {
          closeIndex = cursor;
          break;
        }
      }
    }
    if (closeIndex < 0) return [];
    return splitTopLevel(header.slice(openIndex + 1, closeIndex), ',').filter((segment) => segment.length > 0);
  }

  private parseIf(): StructureNode {
    const ifToken = this.advance();
    const conditionTokens = this.gatherHeader();
    this.analyzeExpressionTokens(conditionTokens, this.currentScopeId);
    this.expectColon();
    const firstSuite = this.parseSuite(this.currentScopeId);
    const branches: StructureNode[] = [
      this.makeNode('如果', 'if-branch', ifToken.start, firstSuite.end, firstSuite.nodes, truncate(this.tokensText(conditionTokens), 60)),
    ];
    let end = firstSuite.end;
    while (true) {
      this.skipNewlines();
      if (this.peek().kind === 'dedent') break;
      const keyword = this.peek();
      if (keyword.kind === 'keyword' && keyword.value === 'elif') {
        const elifToken = this.advance();
        const elifTokens = this.gatherHeader();
        this.analyzeExpressionTokens(elifTokens, this.currentScopeId);
        this.expectColon();
        const suite = this.parseSuite(this.currentScopeId);
        branches.push(
          this.makeNode('否则如果', 'elif-branch', elifToken.start, suite.end, suite.nodes, truncate(this.tokensText(elifTokens), 60)),
        );
        end = suite.end;
        continue;
      }
      if (keyword.kind === 'keyword' && keyword.value === 'else') {
        const elseToken = this.advance();
        this.expectColon();
        const suite = this.parseSuite(this.currentScopeId);
        branches.push(this.makeNode('否则', 'else-branch', elseToken.start, suite.end, suite.nodes));
        end = suite.end;
      }
      break;
    }
    return this.makeNode(
      '条件判断',
      'if',
      ifToken.start,
      Math.max(end, ifToken.end),
      branches,
      `if ${truncate(this.tokensText(conditionTokens), 60)}`,
    );
  }

  private parseFor(): StructureNode {
    const forToken = this.advance();
    const header = this.gatherHeader();
    const inIndex = header.findIndex((token) => token.kind === 'keyword' && token.value === 'in');
    const targetTokens = inIndex >= 0 ? header.slice(0, inIndex) : header;
    const iterableTokens = inIndex >= 0 ? header.slice(inIndex + 1) : [];
    this.declareLoopTargets(targetTokens);
    if (iterableTokens.length > 0) this.analyzeExpressionTokens(iterableTokens, this.currentScopeId);
    else this.issue('error', 'for 语句缺少可迭代对象。', header[0] ?? forToken);
    this.expectColon();
    const suite = this.parseSuite(this.currentScopeId);
    const children = [...suite.nodes];
    let end = suite.end;
    this.skipNewlines();
    if (this.peek().kind === 'keyword' && this.peek().value === 'else') {
      const elseToken = this.advance();
      this.expectColon();
      const elseSuite = this.parseSuite(this.currentScopeId);
      children.push(this.makeNode('循环正常结束', 'loop-else', elseToken.start, elseSuite.end, elseSuite.nodes));
      end = elseSuite.end;
    }
    return this.makeNode(
      '循环',
      'for',
      forToken.start,
      Math.max(end, forToken.end),
      children,
      `for ${truncate(this.tokensText(header), 70)}`,
    );
  }

  private declareLoopTargets(targetTokens: PyToken[]): void {
    const segments = splitTopLevel(targetTokens, ',');
    for (const segment of segments) {
      const nameToken = segment.find((token) => token.kind === 'identifier');
      if (!nameToken) continue;
      const existing = this.collector.resolveLocal(this.currentScopeId, nameToken.value);
      if (existing) {
        this.collector.addOccurrence(existing, nameToken, 'reference');
        this.collector.recordFact(nameToken, 'data', 'loop-target', existing.id);
      } else {
        const symbol = this.collector.declare(this.currentScopeId, nameToken.value, 'variable', nameToken, {
          detail: '循环变量',
        });
        this.collector.recordFact(nameToken, 'data', 'loop-target', symbol.id);
      }
    }
  }

  private parseWhile(): StructureNode {
    const whileToken = this.advance();
    const header = this.gatherHeader();
    this.analyzeExpressionTokens(header, this.currentScopeId);
    this.expectColon();
    const suite = this.parseSuite(this.currentScopeId);
    const children = [...suite.nodes];
    let end = suite.end;
    this.skipNewlines();
    if (this.peek().kind === 'keyword' && this.peek().value === 'else') {
      const elseToken = this.advance();
      this.expectColon();
      const elseSuite = this.parseSuite(this.currentScopeId);
      children.push(this.makeNode('循环正常结束', 'loop-else', elseToken.start, elseSuite.end, elseSuite.nodes));
      end = elseSuite.end;
    }
    return this.makeNode(
      '循环',
      'while',
      whileToken.start,
      Math.max(end, whileToken.end),
      children,
      `while ${truncate(this.tokensText(header), 60)}`,
    );
  }

  private parseTry(): StructureNode {
    const tryToken = this.advance();
    this.expectColon();
    const body = this.parseSuite(this.currentScopeId);
    const children: StructureNode[] = [this.makeNode('尝试', 'try-body', tryToken.start, body.end, body.nodes)];
    let end = body.end;
    let sawHandler = false;
    let sawFinally = false;
    while (true) {
      this.skipNewlines();
      if (this.peek().kind === 'dedent') break;
      const keyword = this.peek();
      if (keyword.kind === 'keyword' && keyword.value === 'except') {
        const exceptToken = this.advance();
        const header = this.gatherHeader();
        const asIndex = header.findIndex((token) => token.kind === 'keyword' && token.value === 'as');
        const conditionTokens = asIndex >= 0 ? header.slice(0, asIndex) : header;
        if (conditionTokens.length > 0) this.analyzeExpressionTokens(conditionTokens, this.currentScopeId);
        if (asIndex >= 0) {
          const alias = header.slice(asIndex + 1).find((token) => token.kind === 'identifier');
          if (alias) {
            const symbol = this.collector.declare(this.currentScopeId, alias.value, 'variable', alias, {
              detail: '异常变量',
            });
            this.collector.recordFact(alias, 'data', 'declaration', symbol.id);
          }
        }
        this.expectColon();
        const suite = this.parseSuite(this.currentScopeId);
        children.push(
          this.makeNode(
            '捕获异常',
            'except',
            exceptToken.start,
            suite.end,
            suite.nodes,
            conditionTokens.length > 0 ? truncate(this.tokensText(conditionTokens), 50) : '所有异常',
          ),
        );
        end = suite.end;
        sawHandler = true;
        continue;
      }
      if (keyword.kind === 'keyword' && keyword.value === 'else') {
        const elseToken = this.advance();
        this.expectColon();
        const suite = this.parseSuite(this.currentScopeId);
        children.push(this.makeNode('否则', 'try-else', elseToken.start, suite.end, suite.nodes));
        end = suite.end;
        continue;
      }
      if (keyword.kind === 'keyword' && keyword.value === 'finally') {
        const finallyToken = this.advance();
        this.expectColon();
        const suite = this.parseSuite(this.currentScopeId);
        children.push(this.makeNode('最终处理', 'finally', finallyToken.start, suite.end, suite.nodes));
        end = suite.end;
        sawFinally = true;
      }
      break;
    }
    if (!sawHandler && !sawFinally) this.issue('error', 'try 语句缺少 except 或 finally 分支。', tryToken);
    return this.makeNode('异常处理', 'try', tryToken.start, Math.max(end, tryToken.end), children);
  }

  private parseWith(): StructureNode {
    const withToken = this.advance();
    const header = this.gatherHeader();
    const items = splitTopLevel(header, ',');
    for (const item of items) {
      const asIndex = item.findIndex((token) => token.kind === 'keyword' && token.value === 'as');
      const expressionTokens = asIndex >= 0 ? item.slice(0, asIndex) : item;
      if (expressionTokens.length > 0) this.analyzeExpressionTokens(expressionTokens, this.currentScopeId);
      if (asIndex >= 0) {
        const alias = item.slice(asIndex + 1).find((token) => token.kind === 'identifier');
        if (alias) {
          const symbol = this.collector.declare(this.currentScopeId, alias.value, 'variable', alias, {
            detail: 'with 变量',
          });
          this.collector.recordFact(alias, 'data', 'declaration', symbol.id);
        }
      }
    }
    this.expectColon();
    const suite = this.parseSuite(this.currentScopeId);
    return this.makeNode(
      '上下文管理',
      'with',
      withToken.start,
      Math.max(suite.end, withToken.end),
      suite.nodes,
      `with ${truncate(this.tokensText(header), 60)}`,
    );
  }

  private parseImport(): StructureNode {
    const importToken = this.advance();
    const tokens = this.gatherLine();
    if (tokens.length === 0) {
      this.issue('error', 'import 语句缺少模块名。', importToken);
    }
    for (const segment of splitTopLevel(tokens, ',')) {
      const asIndex = segment.findIndex((token) => token.kind === 'keyword' && token.value === 'as');
      const importedToken = segment.find((token) => token.kind === 'identifier');
      const localToken =
        asIndex >= 0
          ? segment.slice(asIndex + 1).find((token) => token.kind === 'identifier')
          : importedToken;
      if (!localToken) continue;
      const symbol = this.collector.declare(this.currentScopeId, localToken.value, 'unknown', localToken, {
        detail: '导入的模块/对象',
        typeText: importedToken?.value,
      });
      this.collector.recordFact(localToken, 'data', 'import', symbol.id);
    }
    const end = tokens[tokens.length - 1]?.end ?? importToken.end;
    return this.makeNode(
      '导入',
      'import',
      importToken.start,
      end,
      [],
      truncate(this.source.slice({ start: importToken.start, end }), 70),
    );
  }

  private parseFromImport(): StructureNode {
    const fromToken = this.advance();
    const tokens = this.gatherLine();
    const importIndex = tokens.findIndex((token) => token.kind === 'keyword' && token.value === 'import');
    if (importIndex < 0) {
      this.issue('error', 'from 导入语句缺少 import 关键字。', fromToken);
      return this.makeNode('导入', 'import', fromToken.start, this.lastContentEnd);
    }
    const moduleTokens = tokens.slice(0, importIndex);
    const nameTokens = tokens.slice(importIndex + 1);
    for (const segment of splitTopLevel(nameTokens, ',')) {
      const filtered = segment.filter(
        (token) => !(token.kind === 'punct' && (token.value === '(' || token.value === ')')),
      );
      if (filtered.length === 0) continue;
      const asIndex = filtered.findIndex((token) => token.kind === 'keyword' && token.value === 'as');
      const importedToken = filtered.find((token) => token.kind === 'identifier');
      const localToken =
        asIndex >= 0 ? filtered.slice(asIndex + 1).find((token) => token.kind === 'identifier') : importedToken;
      if (!localToken) continue;
      const symbol = this.collector.declare(this.currentScopeId, localToken.value, 'unknown', localToken, {
        detail: `从 ${this.tokensText(moduleTokens)} 导入`,
        typeText: importedToken?.value,
      });
      this.collector.recordFact(localToken, 'data', 'import', symbol.id);
    }
    const end = tokens[tokens.length - 1]?.end ?? fromToken.end;
    return this.makeNode(
      '导入',
      'import',
      fromToken.start,
      end,
      [],
      truncate(this.source.slice({ start: fromToken.start, end }), 70),
    );
  }

  private parseReturn(): StructureNode {
    const returnToken = this.advance();
    const tokens = this.gatherLine();
    if (tokens.length > 0) this.analyzeExpressionTokens(tokens, this.currentScopeId);
    const end = tokens[tokens.length - 1]?.end ?? returnToken.end;
    return this.makeNode(
      '返回',
      'return',
      returnToken.start,
      end,
      this.callStructures(tokens),
      tokens.length > 0 ? truncate(this.tokensText(tokens), 60) : undefined,
    );
  }

  private parseFlowKeyword(): StructureNode {
    const token = this.advance();
    this.gatherLine();
    if (token.value === 'break') return this.makeNode('跳出循环', 'break', token.start, token.end);
    if (token.value === 'continue') return this.makeNode('继续循环', 'continue', token.start, token.end);
    return this.makeNode('占位语句 pass', 'pass', token.start, token.end);
  }

  private parseKeywordStatement(label: string, kind: string): StructureNode {
    const token = this.advance();
    const tokens = this.gatherLine();
    if (tokens.length > 0) this.analyzeExpressionTokens(tokens, this.currentScopeId);
    const end = tokens[tokens.length - 1]?.end ?? token.end;
    return this.makeNode(label, kind, token.start, end, this.callStructures(tokens));
  }

  private parseScopeDeclaration(label: string, isGlobal: boolean): StructureNode {
    const token = this.advance();
    const tokens = this.gatherLine();
    for (const nameToken of tokens.filter((item) => item.kind === 'identifier')) {
      if (isGlobal) {
        const symbol = this.collector.declare(this.collector.moduleScopeId, nameToken.value, 'variable', nameToken, {
          detail: 'global 变量',
        });
        this.collector.recordFact(nameToken, 'data', 'global', symbol.id);
      } else {
        this.collector.recordFact(nameToken, 'data', 'nonlocal');
      }
    }
    return this.makeNode(label, isGlobal ? 'global' : 'nonlocal', token.start, token.end);
  }

  private parseDecorator(): StructureNode {
    const atToken = this.advance();
    const tokens = this.gatherLine();
    if (tokens.length > 0) this.analyzeExpressionTokens(tokens, this.currentScopeId);
    const end = tokens[tokens.length - 1]?.end ?? atToken.end;
    return this.makeNode(
      '装饰器',
      'decorator',
      atToken.start,
      end,
      this.callStructures(tokens),
      truncate(this.tokensText(tokens), 60) || undefined,
    );
  }

  private parseSimpleStatements(scopeId: string): StructureNode[] {
    const nodes: StructureNode[] = [];
    while (!this.atEnd()) {
      const token = this.peek();
      if (token.kind === 'newline') {
        this.advance();
        break;
      }
      if (token.kind === 'dedent' || token.kind === 'eof') break;
      if (token.kind === 'punct' && token.value === ';') {
        this.advance();
        continue;
      }
      if (token.kind === 'indent') {
        this.advance();
        this.issue('error', '意外的缩进。', token);
        continue;
      }
      const before = this.index;
      const statementTokens = this.gatherSimpleStatement();
      if (statementTokens.length > 0) nodes.push(...this.buildSimpleStatementNodes(statementTokens, scopeId));
      if (this.index === before) this.advance();
      if (this.peek().kind === 'punct' && this.peek().value === ';') continue;
      if (this.peek().kind === 'newline') {
        this.advance();
        break;
      }
      if (this.peek().kind === 'dedent' || this.peek().kind === 'eof') break;
    }
    return nodes;
  }

  private buildSimpleStatementNodes(tokens: PyToken[], scopeId: string): StructureNode[] {
    const assignmentIndex = findTopLevelAssignment(tokens);
    if (assignmentIndex >= 0) {
      const targetTokens = tokens.slice(0, assignmentIndex);
      const valueTokens = tokens.slice(assignmentIndex + 1);
      if (targetTokens.length === 0) {
        this.issue('error', '赋值语句缺少左侧变量。', tokens[0]);
      } else {
        this.analyzeAssignmentTargets(targetTokens, scopeId);
      }
      if (valueTokens.length > 0) this.analyzeExpressionTokens(valueTokens, scopeId);
      const start = tokens[0]?.start ?? 0;
      const end = tokens[tokens.length - 1]?.end ?? start;
      return [
        this.makeNode(
          '赋值',
          'assign',
          start,
          end,
          this.callStructures(valueTokens),
          truncate(this.source.slice({ start, end }), 70),
        ),
      ];
    }
    this.analyzeExpressionTokens(tokens, scopeId);
    const calls = this.callStructures(tokens);
    if (calls.length > 0) return calls;
    const start = tokens[0]?.start ?? 0;
    const end = tokens[tokens.length - 1]?.end ?? start;
    if (tokens.length === 1 && tokens[0]?.kind === 'string') {
      return [this.makeNode('字符串', 'string', start, end, [], truncate(tokens[0].value.replace(/^[rubf]+/i, ''), 60))];
    }
    return [this.makeNode('表达式', 'expression', start, end, [], truncate(this.source.slice({ start, end }), 60))];
  }

  private analyzeAssignmentTargets(targetTokens: PyToken[], scopeId: string): void {
    const scope = this.collector.scopes.get(scopeId);
    const isClassScope = scope?.kind === 'class';
    for (const segment of splitTopLevel(targetTokens, ',')) {
      if (segment.length === 0) continue;
      const colonIndex = findTopLevel(segment, ':');
      const annotationTokens = colonIndex >= 0 ? segment.slice(colonIndex + 1) : [];
      const nameTokens = colonIndex >= 0 ? segment.slice(0, colonIndex) : segment;
      if (annotationTokens.length > 0) this.analyzeTypeTokens(annotationTokens, scopeId);
      const cleaned = nameTokens.filter(
        (token) =>
          !(token.kind === 'operator' && (token.value === '*' || token.value === '**')) &&
          !(token.kind === 'punct' && (token.value === '(' || token.value === ')')),
      );
      const identifier = cleaned.find((token) => token.kind === 'identifier');
      if (!identifier) continue;
      const isMemberTarget = cleaned.some(
        (token) => (token.kind === 'punct' && token.value === '.') || (token.kind === 'punct' && token.value === '['),
      );
      if (isMemberTarget) {
        this.analyzeExpressionTokens(cleaned, scopeId);
        continue;
      }
      const typeText = this.tokensText(annotationTokens) || undefined;
      const existing = this.collector.resolveLocal(scopeId, identifier.value);
      if (existing) {
        this.collector.addOccurrence(existing, identifier, 'reference');
        this.collector.recordFact(identifier, 'data', 'assignment-target', existing.id);
        if (typeText && !existing.typeText) existing.typeText = typeText;
        continue;
      }
      const symbol = this.collector.declare(scopeId, identifier.value, isClassScope ? 'field' : 'variable', identifier, {
        detail: isClassScope ? '类属性' : '变量',
        typeText,
      });
      this.collector.recordFact(identifier, 'data', 'declaration', symbol.id);
    }
  }

  private analyzeExpressionTokens(tokens: PyToken[], scopeId: string): void {
    for (let cursor = 0; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (!token || token.kind !== 'identifier') continue;
      const previous = tokens[cursor - 1];
      const next = tokens[cursor + 1];
      if (previous && previous.kind === 'punct' && previous.value === '.') {
        this.recordMemberAccess(tokens, cursor, scopeId);
        continue;
      }
      if (previous && previous.kind === 'keyword' && previous.value === 'as') continue;
      if (
        next &&
        next.kind === 'operator' &&
        next.value === '=' &&
        previous &&
        ((previous.kind === 'punct' && (previous.value === '(' || previous.value === ',')) ||
          (previous.kind === 'operator' && previous.value === '*'))
      ) {
        // 关键字参数 name=value，不当作变量引用
        this.collector.recordFact(token, 'data', 'keyword-argument');
        continue;
      }
      const isCall = Boolean(next && next.kind === 'punct' && next.value === '(');
      const symbol = this.collector.resolve(scopeId, token.value);
      if (isCall) {
        if (symbol) this.collector.addOccurrence(symbol, token, 'call');
        const category: SemanticCategory =
          symbol?.kind === 'class' || (!symbol && PY_BUILTIN_TYPES.has(token.value)) ? 'type' : 'function';
        this.collector.recordFact(
          token,
          category,
          symbol?.kind === 'class' ? 'class-call' : 'call',
          symbol?.id,
        );
        continue;
      }
      if (PY_BUILTIN_TYPES.has(token.value) && !symbol) {
        this.collector.recordFact(token, 'type', 'builtin-type');
        continue;
      }
      if (PY_BUILTIN_FUNCTIONS.has(token.value) && !symbol) {
        this.collector.recordFact(token, 'function', 'builtin-function');
        continue;
      }
      if (!symbol) {
        this.collector.recordFact(token, 'data', 'reference');
        continue;
      }
      const role: OccurrenceRole = symbol.kind === 'class' || symbol.kind === 'typedef' ? 'type' : 'reference';
      this.collector.addOccurrence(symbol, token, role);
      const category: SemanticCategory =
        symbol.kind === 'class' || symbol.kind === 'typedef'
          ? 'type'
          : symbol.kind === 'function'
            ? 'function'
            : 'data';
      this.collector.recordFact(token, category, symbol.kind === 'function' ? 'function-reference' : 'reference', symbol.id);
    }
  }

  private recordMemberAccess(tokens: PyToken[], cursor: number, scopeId: string): void {
    const propertyToken = tokens[cursor];
    if (!propertyToken) return;
    const objectToken = tokens[cursor - 2];
    const next = tokens[cursor + 1];
    const isCall = Boolean(next && next.kind === 'punct' && next.value === '(');
    let target: PySymbolDraft | undefined;
    if (objectToken?.kind === 'identifier') {
      if (objectToken.value === 'self' || objectToken.value === 'cls') {
        const ownerClass = this.collector.findOwnerClass(scopeId);
        const classSymbol = ownerClass ? this.collector.classSymbolForScope(ownerClass) : undefined;
        target = classSymbol ? this.collector.findMember(classSymbol, propertyToken.value) : undefined;
      } else {
        const objectSymbol = this.collector.resolve(scopeId, objectToken.value);
        if (objectSymbol?.kind === 'class') {
          target = this.collector.findMember(objectSymbol, propertyToken.value);
        } else if (objectSymbol?.typeText) {
          const classSymbol = this.collector.resolveClass(scopeId, objectSymbol.typeText);
          target = classSymbol ? this.collector.findMember(classSymbol, propertyToken.value) : undefined;
        }
      }
    }
    if (target) this.collector.addOccurrence(target, propertyToken, isCall ? 'call' : 'member');
    const category: SemanticCategory = target?.kind === 'function' || isCall ? 'function' : 'data';
    this.collector.recordFact(propertyToken, category, isCall ? 'method-call' : 'member', target?.id);
  }

  private analyzeTypeTokens(tokens: PyToken[], scopeId: string): void {
    for (const token of tokens) {
      if (token.kind !== 'identifier') continue;
      const symbol = this.collector.resolve(scopeId, token.value);
      if (symbol) this.collector.addOccurrence(symbol, token, 'type');
      this.collector.recordFact(
        token,
        'type',
        symbol ? 'type-reference' : PY_BUILTIN_TYPES.has(token.value) ? 'builtin-type' : 'type-name',
        symbol?.id,
      );
    }
  }

  /** 从 token 中提取函数调用结构（只取最外层调用，嵌套调用作为子节点） */
  private callStructures(tokens: PyToken[]): StructureNode[] {
    const result: StructureNode[] = [];
    for (let cursor = 0; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (!token || token.kind !== 'identifier') continue;
      const next = tokens[cursor + 1];
      if (!next || next.kind !== 'punct' || next.value !== '(') continue;
      let depth = 0;
      let closeIndex = -1;
      for (let scan = cursor + 1; scan < tokens.length; scan += 1) {
        const current = tokens[scan];
        if (current.kind !== 'punct') continue;
        if (current.value === '(') depth += 1;
        else if (current.value === ')') {
          depth -= 1;
          if (depth === 0) {
            closeIndex = scan;
            break;
          }
        }
      }
      if (closeIndex < 0) {
        this.issue('error', '函数调用缺少右括号。', token);
        return result;
      }
      const previous = tokens[cursor - 1];
      const beforePrevious = tokens[cursor - 2];
      const isAttributeCall = Boolean(previous && previous.kind === 'punct' && previous.value === '.' && beforePrevious?.kind === 'identifier');
      const start = isAttributeCall ? beforePrevious?.start ?? token.start : token.start;
      const end = tokens[closeIndex]?.end ?? token.end;
      const secondary = isAttributeCall ? `${beforePrevious?.value}.${token.value}` : token.value;
      const innerTokens = tokens.slice(cursor + 2, closeIndex);
      result.push(this.makeNode('函数调用', 'call', start, end, this.callStructures(innerTokens), secondary));
      cursor = closeIndex;
    }
    return result;
  }

  /** 把代码块中的第一节字符串语句标记为文档字符串 */
  private markDocstring(nodes: StructureNode[]): void {
    const first = nodes[0];
    if (first && first.kind === 'string') {
      first.label = '文档字符串';
      first.kind = 'docstring';
    }
  }

  private tokensText(tokens: PyToken[]): string {
    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    if (!first || !last) return '';
    return this.source.text.slice(first.start, last.end);
  }
}

// ---------- token 工具函数 ----------

function splitTopLevel(tokens: PyToken[], separator: string): PyToken[][] {
  const result: PyToken[][] = [];
  let current: PyToken[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === 'punct') {
      if (token.value === '(' || token.value === '[' || token.value === '{') depth += 1;
      else if (token.value === ')' || token.value === ']' || token.value === '}') depth = Math.max(0, depth - 1);
      else if (token.value === separator && depth === 0) {
        result.push(current);
        current = [];
        continue;
      }
    }
    current.push(token);
  }
  if (current.length > 0) result.push(current);
  return result;
}

function findTopLevel(tokens: PyToken[], value: string): number {
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === 'punct') {
      if (token.value === '(' || token.value === '[' || token.value === '{') depth += 1;
      else if (token.value === ')' || token.value === ']' || token.value === '}') depth = Math.max(0, depth - 1);
      else if (token.value === value && depth === 0) return index;
    } else if (token.kind === 'operator' && token.value === value && depth === 0) {
      return index;
    }
  }
  return -1;
}

function findTopLevelAssignment(tokens: PyToken[]): number {
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.kind === 'punct') {
      if (token.value === '(' || token.value === '[' || token.value === '{') depth += 1;
      else if (token.value === ')' || token.value === ']' || token.value === '}') depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && token.kind === 'operator' && ASSIGNMENT_OPERATORS.has(token.value)) {
      // 排除 ==、!=、<=、>=（它们本身就是独立的多字符运算符）
      return index;
    }
  }
  return -1;
}

// ==================================================================
// Python 语义 token
// ==================================================================

function buildPythonSemanticTokens(
  source: SourceFile,
  tokens: PyToken[],
  collector: PythonSymbolCollector,
): SemanticToken[] {
  const result: SemanticToken[] = [];
  const textLength = source.text.length;
  for (const token of tokens) {
    if (token.kind === 'newline' || token.kind === 'indent' || token.kind === 'dedent' || token.kind === 'eof') {
      continue;
    }
    const start = Math.max(0, Math.min(token.start, textLength));
    const end = Math.max(start, Math.min(token.end, textLength));
    if (start >= end) continue;
    switch (token.kind) {
      case 'comment': {
        result.push({ start, end, category: 'comment', subkind: 'comment' });
        continue;
      }
      case 'keyword': {
        result.push({
          start,
          end,
          category: PY_KEYWORD_CATEGORY[token.value] ?? 'control',
          subkind: token.value,
        });
        continue;
      }
      case 'identifier': {
        const fact = collector.factAt(start, end);
        if (fact) {
          result.push({
            start,
            end,
            category: fact.category,
            subkind: fact.subkind,
            symbolId: fact.symbolId,
          });
          continue;
        }
        if (PY_BUILTIN_TYPES.has(token.value)) {
          result.push({ start, end, category: 'type', subkind: 'builtin-type' });
          continue;
        }
        if (PY_BUILTIN_FUNCTIONS.has(token.value)) {
          result.push({ start, end, category: 'function', subkind: 'builtin-function' });
          continue;
        }
        result.push({ start, end, category: 'data', subkind: 'identifier' });
        continue;
      }
      case 'number': {
        result.push({ start, end, category: 'data', subkind: 'number' });
        continue;
      }
      case 'string': {
        result.push({ start, end, category: 'data', subkind: 'string' });
        continue;
      }
      case 'operator': {
        // 行首的 @ 是装饰器语法，不是矩阵乘法运算符
        const lineStart = source.text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
        const atLineStart = source.text.slice(lineStart, start).trim().length === 0;
        if (token.value === '@' && atLineStart) {
          result.push({ start, end, category: 'punctuation', subkind: 'decorator' });
          continue;
        }
        result.push({ start, end, category: 'operator', subkind: token.value });
        continue;
      }
      case 'punct': {
        result.push({ start, end, category: 'punctuation', subkind: token.value });
        continue;
      }
      default:
        continue;
    }
  }
  return result;
}

// ==================================================================
// 对外入口
// ==================================================================

const PY_EXECUTION_REASON = 'Python 暂未接入可靠执行引擎，CodeLens 不会伪造执行结果。';

const PY_SUPPORT_NOTES = [
  '结构级分析：自实现 Python 分词器 + 基于缩进块的结构解析器，不依赖外部运行时或第三方解析库。',
  '覆盖 import/from、def、class、if/elif/else、for/while、try/except/finally、with、return、break/continue/pass、赋值与函数调用等常见结构。',
  '不是完整 Python 语法解析器：装饰器、lambda、推导式、match、类型注解等只做有限处理；动态类型无法精确推断。',
  '缩进错误、字符串/括号未闭合、语句头缺少冒号等问题会以 issues 报告，并尽量恢复后续结构。',
  '不支持执行：Python 暂未接入可靠执行引擎，CodeLens 不会伪造执行结果。',
];

function dedupeIssues(issues: ParseIssue[]): ParseIssue[] {
  const seen = new Set<string>();
  const result: ParseIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.severity}:${issue.message}:${issue.line ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(issue);
  }
  result.sort((left, right) => (left.line ?? 0) - (right.line ?? 0));
  return result;
}

/** 分析 Python 源码，返回统一结构分析结果 */
export function analyzePython(source: SourceFile): LanguageAnalysis {
  const tokenized = tokenizePython(source);
  const collector = new PythonSymbolCollector(source);
  const syntaxTokens = tokenized.tokens.filter((token) => token.kind !== 'comment');
  const parser = new PythonParser(source, syntaxTokens, collector, tokenized.issues);
  const tree = parser.parseProgram();
  const tokens = buildPythonSemanticTokens(source, tokenized.tokens, collector);
  const issues = dedupeIssues(tokenized.issues);
  if (source.text.trim().length === 0) {
    return {
      language: 'python',
      languageLabel: 'Python',
      supportLevel: 'structural',
      supportNotes: PY_SUPPORT_NOTES,
      tree,
      tokens: [],
      symbols: {},
      issues,
      execution: { supported: false, reason: PY_EXECUTION_REASON },
      capabilities: {
        semanticHighlight: true,
        structureTree: true,
        explanations: 'basic',
        crossReference: true,
        execution: false,
        realParser: true,
      },
      analyzer: 'python-structural',
    };
  }
  return {
    language: 'python',
    languageLabel: 'Python',
    supportLevel: 'structural',
    supportNotes: PY_SUPPORT_NOTES,
    tree,
    tokens,
    symbols: collector.finalize(),
    issues,
    execution: { supported: false, reason: PY_EXECUTION_REASON },
    capabilities: {
      semanticHighlight: true,
      structureTree: true,
      explanations: 'basic',
      crossReference: true,
      execution: false,
      realParser: true,
    },
    analyzer: 'python-structural',
  };
}
