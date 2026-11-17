/**
 * JavaScript / TypeScript 结构分析器
 * ------------------------------------------------------------------
 * 能力定位：结构级（structural）分析。
 * 1. 使用 @babel/parser 做真实 AST 解析（tokens + errorRecovery），
 *    因此语义高亮、结构树、符号关联都来自真实语法结构，而不是正则猜测；
 * 2. 自实现静态作用域分析：区分声明、引用、函数调用、类型引用与成员访问；
 * 3. 对语法错误显式报告，并尽量修复后继续给出结构树，绝不静默吞掉错误；
 * 4. 不提供执行能力，execution.supported 恒为 false 并给出原因。
 *
 * 所有位置均使用 0-based 字符偏移，再通过 SourceFile.range() 换算行列。
 */
import { parse } from '@babel/parser';
import type { ParserOptions } from '@babel/parser';
import type { SourceFile, SourceRange } from '../source';
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
// Babel AST / Token 的最小结构声明
// 只声明本项目真正读取的通用字段，具体节点类型通过 node.type 收窄。
// ==================================================================

interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

interface BabelTokenTypeLike {
  label: string;
  keyword?: string | null;
  beforeExpr?: boolean;
  startsExpr?: boolean;
  isAssign?: boolean;
  prefix?: boolean;
  postfix?: boolean;
  binop?: number | null;
}

interface BabelTokenLike {
  type: string | BabelTokenTypeLike;
  value?: unknown;
  start: number;
  end: number;
}

interface BabelParseErrorLike {
  message?: unknown;
  pos?: unknown;
  loc?: { line?: unknown; column?: unknown; index?: unknown };
}

interface ParseOutcome {
  program: AstNode;
  tokens: BabelTokenLike[];
  errors: BabelParseErrorLike[];
}

/** AST 节点上的元数据字段，遍历子节点时跳过，避免把注释/位置信息当成语法节点 */
const SKIP_CHILD_KEYS = new Set([
  'loc',
  'extra',
  'type',
  'start',
  'end',
  'range',
  'comments',
  'errors',
  'tokens',
  'leadingComments',
  'trailingComments',
  'innerComments',
]);

function isAstNode(value: unknown): value is AstNode {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; start?: unknown; end?: unknown };
  return typeof candidate.type === 'string' && typeof candidate.start === 'number' && typeof candidate.end === 'number';
}

function childNode(node: AstNode, key: string): AstNode | undefined {
  const value = node[key];
  return isAstNode(value) ? value : undefined;
}

function childNodes(node: AstNode, key: string): AstNode[] {
  const value = node[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isAstNode);
}

function stringField(node: AstNode, key: string): string | undefined {
  const value = node[key];
  return typeof value === 'string' ? value : undefined;
}

function booleanField(node: AstNode, key: string): boolean {
  return node[key] === true;
}

function nameOf(node: AstNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'Identifier' || node.type === 'JSXIdentifier') {
    return typeof node.name === 'string' ? node.name : undefined;
  }
  if (node.type === 'PrivateName') return nameOf(childNode(node, 'id'));
  if (node.type === 'StringLiteral') return typeof node.value === 'string' ? node.value : undefined;
  return undefined;
}

/** 结构树里展示「变量/参数」名字时使用的通用名称提取 */
function patternName(node: AstNode | undefined): string {
  if (!node) return '?';
  switch (node.type) {
    case 'Identifier':
      return nameOf(node) ?? '?';
    case 'ObjectPattern':
      return '{…}';
    case 'ArrayPattern':
      return '[…]';
    case 'AssignmentPattern':
      return patternName(childNode(node, 'left'));
    case 'RestElement':
      return `…${patternName(childNode(node, 'argument'))}`;
    case 'TSParameterProperty':
      return patternName(childNode(node, 'parameter'));
    case 'MemberExpression':
      return '成员';
    default:
      return '?';
  }
}

function forEachAstChild(node: AstNode, visit: (child: AstNode) => void): void {
  for (const key of Object.keys(node)) {
    if (SKIP_CHILD_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) visit(item);
      }
    } else if (isAstNode(value)) {
      visit(value);
    }
  }
}

function visitAst(root: AstNode, visit: (node: AstNode) => void): void {
  visit(root);
  forEachAstChild(root, (child) => visitAst(child, visit));
}

function astNodeId(node: AstNode): string {
  return `js-node-${node.start}-${node.end}`;
}

function rawText(source: SourceFile, node: AstNode | undefined): string {
  if (!node) return '';
  return source.slice({ start: node.start, end: node.end });
}

function truncate(text: string, max = 80): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

// ==================================================================
// 语义分类规则
// ==================================================================

type Phase = 'declare' | 'reference';
type ExprContext = 'value' | 'callee' | 'type' | 'assignment-target';

const CONTROL_KEYWORDS = new Set([
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
  'throw',
  'try',
  'catch',
  'finally',
  'yield',
  'await',
  'with',
  'debugger',
  'import',
  'export',
]);

const FUNCTION_KEYWORDS = new Set(['function', 'async', 'get', 'set']);

const TYPE_KEYWORDS = new Set([
  'class',
  'new',
  'extends',
  'implements',
  'interface',
  'type',
  'enum',
  'namespace',
  'module',
  'declare',
  'abstract',
  'readonly',
  'public',
  'private',
  'protected',
  'static',
  'override',
  'as',
  'satisfies',
  'keyof',
  'infer',
  'is',
  'asserts',
  'unique',
  'accessor',
]);

const DATA_KEYWORDS = new Set(['const', 'let', 'var', 'true', 'false', 'null', 'undefined', 'this', 'super']);

const OPERATOR_KEYWORDS = new Set(['typeof', 'instanceof', 'in', 'delete', 'void']);

/** 被 Babel 当成普通 name token 的 TypeScript 上下文关键字 */
const CONTEXTUAL_IDENTIFIER_CATEGORIES: Record<string, { category: SemanticCategory; subkind: string }> = {
  interface: { category: 'type', subkind: 'ts-keyword' },
  type: { category: 'type', subkind: 'ts-keyword' },
  enum: { category: 'type', subkind: 'ts-keyword' },
  namespace: { category: 'type', subkind: 'ts-keyword' },
  declare: { category: 'type', subkind: 'ts-keyword' },
  abstract: { category: 'type', subkind: 'ts-keyword' },
  readonly: { category: 'type', subkind: 'ts-keyword' },
  public: { category: 'type', subkind: 'ts-keyword' },
  private: { category: 'type', subkind: 'ts-keyword' },
  protected: { category: 'type', subkind: 'ts-keyword' },
  static: { category: 'type', subkind: 'ts-keyword' },
  override: { category: 'type', subkind: 'ts-keyword' },
  accessor: { category: 'type', subkind: 'ts-keyword' },
  implements: { category: 'type', subkind: 'ts-keyword' },
  keyof: { category: 'type', subkind: 'ts-keyword' },
  infer: { category: 'type', subkind: 'ts-keyword' },
  asserts: { category: 'type', subkind: 'ts-keyword' },
  satisfies: { category: 'type', subkind: 'ts-keyword' },
  as: { category: 'type', subkind: 'ts-keyword' },
  of: { category: 'control', subkind: 'loop-keyword' },
  from: { category: 'control', subkind: 'import-keyword' },
  undefined: { category: 'data', subkind: 'literal' },
  NaN: { category: 'data', subkind: 'literal' },
  Infinity: { category: 'data', subkind: 'literal' },
  globalThis: { category: 'data', subkind: 'identifier' },
  arguments: { category: 'data', subkind: 'identifier' },
};

const PUNCTUATION_LABELS = new Set([
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  ';',
  ':',
  '.',
  '@',
  '#',
  '`',
  '${',
  '...',
]);

const OPERATOR_LABELS = new Set([
  '=>',
  '?',
  '?.',
  '??',
  '||',
  '&&',
  '|',
  '^',
  '&',
  '==/!=/===/!==',
  '</>/<=/>=',
  '+/-',
  '*',
  '/',
  '%',
  '**',
  '<<',
  '>>',
  '>>>',
  '++/--',
  '!',
  '~',
  '=',
  '+=',
  '_=',
]);

function categoryForKeyword(keyword: string): SemanticCategory {
  if (DATA_KEYWORDS.has(keyword)) return 'data';
  if (FUNCTION_KEYWORDS.has(keyword)) return 'function';
  if (TYPE_KEYWORDS.has(keyword)) return 'type';
  if (CONTROL_KEYWORDS.has(keyword)) return 'control';
  if (OPERATOR_KEYWORDS.has(keyword)) return 'operator';
  return 'data';
}

/** 把 @babel/parser 的 token 类型统一成可读结构 */
function describeTokenType(type: string | BabelTokenTypeLike): {
  label: string;
  keyword?: string;
  comment: boolean;
  literal?: string;
  operatorLike: boolean;
} {
  if (typeof type === 'string') {
    return { label: type, comment: type.startsWith('Comment'), operatorLike: false };
  }
  const label = type.label;
  const comment = label === 'comment' || label === 'CommentLine' || label === 'CommentBlock';
  let literal: string | undefined;
  if (label === 'string') literal = 'string';
  else if (label === 'num') literal = 'number';
  else if (label === 'bigint') literal = 'bigint';
  else if (label === 'decimal') literal = 'number';
  else if (label === 'regexp') literal = 'regexp';
  else if (label === 'true' || label === 'false' || label === 'null') literal = 'literal';
  const operatorLike =
    !literal && (Boolean(type.isAssign) || Boolean(type.prefix) || Boolean(type.postfix) || typeof type.binop === 'number');
  return {
    label,
    keyword: typeof type.keyword === 'string' ? type.keyword : undefined,
    comment,
    literal,
    operatorLike,
  };
}

// ==================================================================
// 作用域与符号表
// ==================================================================

type ScopeKind = 'global' | 'function' | 'block' | 'class' | 'catch';

interface ScopeRecord {
  id: string;
  kind: ScopeKind;
  parent?: string;
  start: number;
  end: number;
  label: string;
  declarations: Map<string, string>;
  ownerSymbolId?: string;
}

interface SymbolDraft {
  id: string;
  name: string;
  kind: SymbolKind;
  scopeId: string;
  typeText?: string;
  detail?: string;
  declaration?: { start: number; end: number; nodeId?: string };
  occurrences: Array<{ start: number; end: number; role: OccurrenceRole; nodeId?: string }>;
  occurrenceKeys: Set<string>;
  classHint?: string;
  classStart?: number;
}

interface SemanticFact {
  category: SemanticCategory;
  subkind?: string;
  symbolId?: string;
  nodeId?: string;
}

interface DeclareOptions {
  typeText?: string;
  detail?: string;
  classStart?: number;
  classHint?: string;
}

class SymbolCollector {
  readonly scopes = new Map<string, ScopeRecord>();
  readonly symbols = new Map<string, SymbolDraft>();
  private readonly facts = new Map<string, SemanticFact>();
  private readonly keywordAnchors = new Map<number, SemanticFact>();
  private symbolCounter = 0;

  constructor(private readonly source: SourceFile) {
    this.scopes.set('global', {
      id: 'global',
      kind: 'global',
      parent: undefined,
      start: 0,
      end: source.text.length,
      label: '全局作用域',
      declarations: new Map(),
    });
  }

  ensureScope(id: string, kind: ScopeKind, parent: string, node: AstNode, label: string): string {
    if (!this.scopes.has(id)) {
      this.scopes.set(id, { id, kind, parent, start: node.start, end: node.end, label, declarations: new Map() });
    }
    return id;
  }

  setScopeOwner(scopeId: string, symbolId: string): void {
    const scope = this.scopes.get(scopeId);
    if (scope) scope.ownerSymbolId = symbolId;
  }

  nearestFunctionScope(scopeId: string): string {
    let current: string | undefined = scopeId;
    while (current) {
      const scope = this.scopes.get(current);
      if (!scope) return 'global';
      if (scope.kind === 'function' || scope.kind === 'global') return scope.id;
      current = scope.parent;
    }
    return 'global';
  }

  findEnclosingClassScope(scopeId: string): string | undefined {
    let current: string | undefined = scopeId;
    while (current) {
      const scope = this.scopes.get(current);
      if (!scope) return undefined;
      if (scope.kind === 'class') return scope.id;
      current = scope.parent;
    }
    return undefined;
  }

  classSymbolForScope(classScopeId: string): SymbolDraft | undefined {
    const scope = this.scopes.get(classScopeId);
    return scope?.ownerSymbolId ? this.symbols.get(scope.ownerSymbolId) : undefined;
  }

  resolveClass(scopeId: string, name: string): SymbolDraft | undefined {
    const symbol = this.resolve(scopeId, name);
    return symbol && (symbol.kind === 'class' || symbol.kind === 'typedef') ? symbol : undefined;
  }

  findMember(classSymbol: SymbolDraft, memberName: string): SymbolDraft | undefined {
    if (typeof classSymbol.classStart !== 'number') return undefined;
    const classScope = this.scopes.get(`class:${classSymbol.classStart}`);
    const id = classScope?.declarations.get(memberName);
    return id ? this.symbols.get(id) : undefined;
  }

  declare(scopeId: string, name: string, kind: SymbolKind, node: AstNode, options: DeclareOptions = {}): SymbolDraft {
    const scope = this.scopes.get(scopeId) ?? this.scopes.get('global');
    if (!scope) throw new Error('符号作用域未初始化');
    const existingId = scope.declarations.get(name);
    if (existingId) {
      const existing = this.symbols.get(existingId);
      if (existing) {
        if (existing.kind === 'unknown' && kind !== 'unknown') existing.kind = kind;
        if (!existing.typeText && options.typeText) existing.typeText = options.typeText;
        if (!existing.detail && options.detail) existing.detail = options.detail;
        if (typeof options.classStart === 'number' && existing.classStart === undefined) {
          existing.classStart = options.classStart;
        }
        this.addOccurrence(existing, node, 'declaration');
        return existing;
      }
    }
    const id = `js-symbol-${++this.symbolCounter}`;
    const draft: SymbolDraft = {
      id,
      name,
      kind,
      scopeId,
      typeText: options.typeText,
      detail: options.detail,
      declaration: { start: node.start, end: node.end, nodeId: astNodeId(node) },
      occurrences: [],
      occurrenceKeys: new Set(),
      classHint: options.classHint,
      classStart: options.classStart,
    };
    this.symbols.set(id, draft);
    scope.declarations.set(name, id);
    this.addOccurrence(draft, node, 'declaration');
    return draft;
  }

  addOccurrence(symbol: SymbolDraft, node: AstNode, role: OccurrenceRole): void {
    const key = `${role}:${node.start}:${node.end}`;
    if (symbol.occurrenceKeys.has(key)) return;
    symbol.occurrenceKeys.add(key);
    symbol.occurrences.push({ start: node.start, end: node.end, role, nodeId: astNodeId(node) });
  }

  resolve(scopeId: string, name: string): SymbolDraft | undefined {
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

  recordFact(node: AstNode, category: SemanticCategory, subkind?: string, symbolId?: string): void {
    this.facts.set(`${node.start}:${node.end}`, {
      category,
      subkind,
      symbolId,
      nodeId: astNodeId(node),
    });
  }

  addKeywordAnchor(start: number, category: SemanticCategory, subkind?: string, nodeId?: string): void {
    if (!this.keywordAnchors.has(start)) {
      this.keywordAnchors.set(start, { category, subkind, nodeId });
    }
  }

  factAt(start: number, end: number): SemanticFact | undefined {
    return this.facts.get(`${start}:${end}`);
  }

  keywordAnchorAt(start: number): SemanticFact | undefined {
    return this.keywordAnchors.get(start);
  }

  scopeNameOf(symbol: SymbolDraft): string {
    const scope = this.scopes.get(symbol.scopeId);
    if (!scope) return '全局作用域';
    // 块级/异常作用域没有独立的展示意义，补充其所属函数或类，便于符号面板理解
    if (scope.kind === 'block' || scope.kind === 'catch') {
      let parentId = scope.parent;
      while (parentId) {
        const parent = this.scopes.get(parentId);
        if (!parent) break;
        if (parent.kind === 'function' || parent.kind === 'class' || parent.kind === 'global') {
          return `${parent.label} 内的${scope.kind === 'catch' ? '异常块' : '代码块'}`;
        }
        parentId = parent.parent;
      }
    }
    return scope.label;
  }

  finalize(): Record<string, SymbolInfo> {
    const result: Record<string, SymbolInfo> = {};
    for (const draft of this.symbols.values()) {
      const declaration = draft.declaration
        ? this.makeOccurrence(draft.declaration.start, draft.declaration.end, 'declaration', draft.declaration.nodeId)
        : undefined;
      result[draft.id] = {
        id: draft.id,
        name: draft.name,
        kind: draft.kind,
        declaration,
        occurrences: draft.occurrences.map((occurrence) =>
          this.makeOccurrence(occurrence.start, occurrence.end, occurrence.role, occurrence.nodeId),
        ),
        typeText: draft.typeText,
        detail: draft.detail,
        scopeName: this.scopeNameOf(draft),
      };
    }
    return result;
  }

  private makeOccurrence(start: number, end: number, role: OccurrenceRole, nodeId?: string) {
    const range = this.source.range(start, end);
    return {
      range,
      nodeId,
      role,
      line: range.startLine,
      snippet: truncate(this.source.lineText(range.startLine), 160),
    };
  }
}

interface WalkContext {
  source: SourceFile;
  collector: SymbolCollector;
}

// ==================================================================
// 作用域分析：两遍遍历
// 第一遍收集声明（支持前向引用），第二遍解析引用/调用/类型/成员。
// ==================================================================

function walkProgram(program: AstNode, ctx: WalkContext): void {
  for (const phase of ['declare', 'reference'] as const) {
    for (const statement of childNodes(program, 'body')) {
      walkStatement(statement, 'global', phase, ctx);
    }
  }
}

function walkStatement(node: AstNode | undefined, scopeId: string, phase: Phase, ctx: WalkContext): void {
  if (!node) return;
  const { collector } = ctx;
  switch (node.type) {
    case 'ImportDeclaration': {
      if (phase === 'declare') {
        const sourceNode = childNode(node, 'source');
        const moduleName = sourceNode ? nameOf(sourceNode) ?? rawText(ctx.source, sourceNode) : '';
        for (const specifier of childNodes(node, 'specifiers')) {
          const local = childNode(specifier, 'local');
          const localName = nameOf(local);
          if (!local || !localName) continue;
          const imported = childNode(specifier, 'imported');
          const importedName = nameOf(imported) ?? (specifier.type === 'ImportDefaultSpecifier' ? 'default' : '*');
          const symbol = collector.declare(scopeId, localName, 'unknown', local, {
            detail: `从 ${moduleName} 导入`,
            typeText: importedName,
          });
          collector.recordFact(local, 'data', 'import', symbol.id);
        }
      }
      return;
    }
    case 'ExportNamedDeclaration': {
      const declaration = childNode(node, 'declaration');
      if (declaration) walkStatement(declaration, scopeId, phase, ctx);
      if (phase === 'reference') {
        for (const specifier of childNodes(node, 'specifiers')) {
          const local = childNode(specifier, 'local');
          const localName = nameOf(local);
          if (!local || !localName) continue;
          const symbol = collector.resolve(scopeId, localName);
          if (symbol) collector.addOccurrence(symbol, local, 'reference');
          collector.recordFact(local, 'data', 'export');
        }
      }
      return;
    }
    case 'ExportDefaultDeclaration': {
      const declaration = childNode(node, 'declaration');
      if (!declaration) return;
      if (isStatementNode(declaration)) walkStatement(declaration, scopeId, phase, ctx);
      else walkExpression(declaration, scopeId, phase, 'value', ctx);
      return;
    }
    case 'VariableDeclaration': {
      const declarationKind = stringField(node, 'kind') ?? 'let';
      const targetScope = declarationKind === 'var' ? collector.nearestFunctionScope(scopeId) : scopeId;
      for (const declarator of childNodes(node, 'declarations')) {
        const id = childNode(declarator, 'id');
        const init = childNode(declarator, 'init');
        if (id) {
          if (phase === 'declare') {
            const inferred = inferInitializer(init);
            declarePattern(id, targetScope, ctx, {
              kind: 'variable',
              detail: `${declarationKind} 变量`,
              typeText: inferred.typeText,
              classHint: inferred.classHint,
            });
          } else {
            walkPatternExtras(id, targetScope, ctx);
          }
        }
        if (init) walkExpression(init, targetScope, phase, 'value', ctx);
      }
      return;
    }
    case 'FunctionDeclaration':
    case 'TSDeclareFunction': {
      const id = childNode(node, 'id');
      const name = nameOf(id);
      if (id && name) {
        const symbol = collector.declare(scopeId, name, 'function', id, {
          detail: booleanField(node, 'async') ? '异步函数' : '函数',
          typeText: buildFunctionTypeText(node, ctx.source),
        });
        collector.recordFact(id, 'function', 'declaration', symbol.id);
      }
      handleFunctionLike(node, scopeId, phase, ctx);
      return;
    }
    case 'ClassDeclaration': {
      const id = childNode(node, 'id');
      const name = nameOf(id);
      if (id && name) {
        const symbol = collector.declare(scopeId, name, 'class', id, {
          detail: '类',
          typeText: name,
          classStart: node.start,
        });
        collector.setScopeOwner(`class:${node.start}`, symbol.id);
        collector.recordFact(id, 'type', 'declaration', symbol.id);
      }
      handleClassLike(node, scopeId, phase, ctx);
      return;
    }
    case 'TSInterfaceDeclaration': {
      handleInterfaceLike(node, scopeId, phase, ctx);
      return;
    }
    case 'TSTypeAliasDeclaration': {
      const id = childNode(node, 'id');
      const name = nameOf(id);
      if (phase === 'declare' && id && name) {
        const symbol = collector.declare(scopeId, name, 'typedef', id, { detail: '类型别名', typeText: name });
        collector.recordFact(id, 'type', 'declaration', symbol.id);
      }
      if (phase === 'reference') {
        walkTypeParameters(childNode(node, 'typeParameters'), scopeId, ctx);
        walkType(childNode(node, 'typeAnnotation'), scopeId, ctx);
      }
      return;
    }
    case 'TSEnumDeclaration': {
      handleEnumDeclaration(node, scopeId, phase, ctx);
      return;
    }
    case 'TSModuleDeclaration': {
      if (phase === 'reference') walkType(childNode(node, 'id'), scopeId, ctx);
      const body = childNode(node, 'body');
      if (body) {
        if (body.type === 'TSModuleBlock') {
          for (const statement of childNodes(body, 'body')) walkStatement(statement, scopeId, phase, ctx);
        } else {
          walkStatement(body, scopeId, phase, ctx);
        }
      }
      return;
    }
    case 'IfStatement': {
      walkExpression(childNode(node, 'test'), scopeId, phase, 'value', ctx);
      walkStatement(childNode(node, 'consequent'), scopeId, phase, ctx);
      walkStatement(childNode(node, 'alternate'), scopeId, phase, ctx);
      return;
    }
    case 'ForStatement': {
      const loopScope = collector.ensureScope(`block:${node.start}`, 'block', scopeId, node, scopeLabel(ctx, node));
      const init = childNode(node, 'init');
      if (init) {
        if (init.type === 'VariableDeclaration') walkStatement(init, loopScope, phase, ctx);
        else walkExpression(init, loopScope, phase, 'value', ctx);
      }
      walkExpression(childNode(node, 'test'), loopScope, phase, 'value', ctx);
      walkExpression(childNode(node, 'update'), loopScope, phase, 'value', ctx);
      walkStatement(childNode(node, 'body'), loopScope, phase, ctx);
      return;
    }
    case 'ForInStatement':
    case 'ForOfStatement': {
      const loopScope = collector.ensureScope(`block:${node.start}`, 'block', scopeId, node, scopeLabel(ctx, node));
      const left = childNode(node, 'left');
      if (left) {
        if (left.type === 'VariableDeclaration') walkStatement(left, loopScope, phase, ctx);
        else if (phase === 'reference') walkPatternReference(left, loopScope, ctx);
      }
      walkExpression(childNode(node, 'right'), loopScope, phase, 'value', ctx);
      walkStatement(childNode(node, 'body'), loopScope, phase, ctx);
      return;
    }
    case 'WhileStatement':
    case 'DoWhileStatement': {
      walkExpression(childNode(node, 'test'), scopeId, phase, 'value', ctx);
      walkStatement(childNode(node, 'body'), scopeId, phase, ctx);
      return;
    }
    case 'ReturnStatement':
    case 'ThrowStatement':
    case 'ExpressionStatement': {
      walkExpression(childNode(node, 'argument') ?? childNode(node, 'expression'), scopeId, phase, 'value', ctx);
      return;
    }
    case 'BlockStatement': {
      const blockScope = collector.ensureScope(`block:${node.start}`, 'block', scopeId, node, scopeLabel(ctx, node));
      for (const statement of childNodes(node, 'body')) walkStatement(statement, blockScope, phase, ctx);
      return;
    }
    case 'TryStatement': {
      walkStatement(childNode(node, 'block'), scopeId, phase, ctx);
      const handler = childNode(node, 'handler');
      if (handler) {
        const catchScope = collector.ensureScope(
          `catch:${handler.start}`,
          'catch',
          scopeId,
          handler,
          scopeLabel(ctx, handler),
        );
        const param = childNode(handler, 'param');
        if (param) {
          if (phase === 'declare') declarePattern(param, catchScope, ctx, { kind: 'variable', detail: 'catch 参数' });
          else walkPatternExtras(param, catchScope, ctx);
        }
        walkStatement(childNode(handler, 'body'), catchScope, phase, ctx);
      }
      walkStatement(childNode(node, 'finalizer'), scopeId, phase, ctx);
      return;
    }
    case 'SwitchStatement': {
      walkExpression(childNode(node, 'discriminant'), scopeId, phase, 'value', ctx);
      const switchScope = collector.ensureScope(`block:${node.start}`, 'block', scopeId, node, scopeLabel(ctx, node));
      for (const switchCase of childNodes(node, 'cases')) {
        walkExpression(childNode(switchCase, 'test'), switchScope, phase, 'value', ctx);
        for (const statement of childNodes(switchCase, 'consequent')) walkStatement(statement, switchScope, phase, ctx);
      }
      return;
    }
    case 'LabeledStatement': {
      walkStatement(childNode(node, 'body'), scopeId, phase, ctx);
      return;
    }
    case 'WithStatement': {
      walkExpression(childNode(node, 'object'), scopeId, phase, 'value', ctx);
      walkStatement(childNode(node, 'body'), scopeId, phase, ctx);
      return;
    }
    case 'EmptyStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
    case 'DebuggerStatement':
      return;
    default: {
      // 兜底：继续深入未知语句的子节点，避免遗漏其中的函数/类声明与引用
      forEachAstChild(node, (child) => {
        if (isStatementNode(child)) walkStatement(child, scopeId, phase, ctx);
        else walkExpression(child, scopeId, phase, 'value', ctx);
      });
      return;
    }
  }
}

function scopeLabel(ctx: WalkContext, node: AstNode): string {
  const line = ctx.source.positionAt(node.start).line;
  return `代码块（第${line}行）`;
}

function isStatementNode(node: AstNode): boolean {
  return (
    node.type.endsWith('Statement') ||
    node.type.endsWith('Declaration') ||
    node.type === 'ClassDeclaration' ||
    node.type === 'FunctionDeclaration' ||
    node.type === 'TSDeclareFunction' ||
    node.type === 'TSInterfaceDeclaration' ||
    node.type === 'TSTypeAliasDeclaration' ||
    node.type === 'TSEnumDeclaration' ||
    node.type === 'TSModuleDeclaration'
  );
}

function buildFunctionTypeText(node: AstNode, source: SourceFile): string {
  const params = childNodes(node, 'params').map((param) => {
    const annotation = childNode(param, 'typeAnnotation');
    const annotationText = annotation ? rawText(source, annotation).replace(/^:\s*/, '') : '';
    return annotationText ? `${patternName(param)}: ${annotationText}` : patternName(param);
  });
  const returnAnnotation = childNode(node, 'typeAnnotation');
  const returnText = returnAnnotation ? rawText(source, returnAnnotation).replace(/^:\s*/, '') : '';
  return `(${params.join(', ')})${returnText ? `: ${returnText}` : ''}`;
}

function inferInitializer(init: AstNode | undefined): { typeText?: string; classHint?: string } {
  if (!init) return {};
  switch (init.type) {
    case 'StringLiteral':
    case 'TemplateLiteral':
      return { typeText: 'string' };
    case 'NumericLiteral':
      return { typeText: 'number' };
    case 'BooleanLiteral':
      return { typeText: 'boolean' };
    case 'NullLiteral':
      return { typeText: 'null' };
    case 'BigIntLiteral':
      return { typeText: 'bigint' };
    case 'RegExpLiteral':
      return { typeText: 'RegExp' };
    case 'ArrayExpression':
      return { typeText: 'array' };
    case 'ObjectExpression':
      return { typeText: 'object' };
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return { typeText: 'function' };
    case 'NewExpression': {
      const callee = childNode(init, 'callee');
      const className = nameOf(callee);
      return className ? { typeText: className, classHint: className } : { typeText: 'object' };
    }
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
      return inferInitializer(childNode(init, 'expression'));
    default:
      return {};
  }
}

// ---------- 函数 / 类 / 接口 / 枚举 ----------

function handleFunctionLike(node: AstNode, scopeId: string, phase: Phase, ctx: WalkContext): void {
  const { collector } = ctx;
  const id = childNode(node, 'id');
  const functionName = nameOf(id);
  const functionScope = collector.ensureScope(
    `function:${node.start}`,
    'function',
    scopeId,
    node,
    functionName ? `函数 ${functionName}` : '匿名函数',
  );
  if (phase === 'declare') {
    for (const param of childNodes(node, 'params')) {
      declarePattern(param, functionScope, ctx, { kind: 'parameter', detail: '参数' });
      walkPatternDefaults(param, functionScope, phase, ctx);
    }
  } else {
    for (const param of childNodes(node, 'params')) walkPatternExtras(param, functionScope, ctx);
    walkTypeParameters(childNode(node, 'typeParameters'), functionScope, ctx);
    walkTypeAnnotation(childNode(node, 'typeAnnotation'), functionScope, ctx);
  }
  const body = childNode(node, 'body');
  if (!body) return;
  if (body.type === 'BlockStatement') walkStatement(body, functionScope, phase, ctx);
  else walkExpression(body, functionScope, phase, 'value', ctx);
}

function handleClassLike(node: AstNode, scopeId: string, phase: Phase, ctx: WalkContext): void {
  const { collector } = ctx;
  const id = childNode(node, 'id');
  const className = nameOf(id);
  const classScope = collector.ensureScope(
    `class:${node.start}`,
    'class',
    scopeId,
    node,
    className ? `类 ${className}` : '匿名类',
  );
  if (phase === 'declare' && id && className) {
    if (node.type === 'ClassExpression') {
      const symbol = collector.declare(classScope, className, 'class', id, {
        detail: '类表达式',
        typeText: className,
        classStart: node.start,
      });
      collector.setScopeOwner(classScope, symbol.id);
      collector.recordFact(id, 'type', 'declaration', symbol.id);
    }
  }
  if (phase === 'reference') {
    walkExpression(childNode(node, 'superClass'), classScope, phase, 'type', ctx);
    for (const implemented of childNodes(node, 'implements')) walkType(implemented, classScope, ctx);
    walkTypeParameters(childNode(node, 'typeParameters'), classScope, ctx);
    for (const decorator of childNodes(node, 'decorators')) {
      walkExpression(childNode(decorator, 'expression'), classScope, phase, 'value', ctx);
    }
  } else {
    // 声明阶段：类体中的字段初始化可能包含函数/类声明，需要继续收集
    const body = childNode(node, 'body');
    if (body) {
      for (const member of childNodes(body, 'body')) handleClassMember(member, classScope, phase, ctx);
    }
    return;
  }
  const body = childNode(node, 'body');
  if (body) {
    for (const member of childNodes(body, 'body')) handleClassMember(member, classScope, phase, ctx);
  }
}

function handleClassMember(member: AstNode, classScope: string, phase: Phase, ctx: WalkContext): void {
  const { collector } = ctx;
  switch (member.type) {
    case 'ClassProperty':
    case 'ClassAccessorProperty':
    case 'ClassPrivateProperty': {
      const key = childNode(member, 'key');
      const memberName = nameOf(key);
      if (phase === 'declare' && key && memberName) {
        const annotation = childNode(member, 'typeAnnotation');
        const symbol = collector.declare(classScope, memberName, 'field', key, {
          detail: booleanField(member, 'static') ? '静态字段' : '字段',
          typeText: annotation ? rawText(ctx.source, annotation).replace(/^:\s*/, '') : undefined,
        });
        collector.recordFact(key, 'data', 'field', symbol.id);
      }
      if (phase === 'reference') {
        walkTypeAnnotation(childNode(member, 'typeAnnotation'), classScope, ctx);
      }
      walkExpression(childNode(member, 'value'), classScope, phase, 'value', ctx);
      return;
    }
    case 'ClassMethod':
    case 'ClassPrivateMethod':
    case 'TSDeclareMethod': {
      const key = childNode(member, 'key');
      const methodName = nameOf(key);
      const methodScope = collector.ensureScope(
        `function:${member.start}`,
        'function',
        classScope,
        member,
        methodName ? `方法 ${methodName}` : '方法',
      );
      if (phase === 'declare') {
        if (key && methodName) {
          const symbol = collector.declare(classScope, methodName, 'function', key, {
            detail: methodName === 'constructor' ? '构造方法' : '方法',
            typeText: buildFunctionTypeText(member, ctx.source),
          });
          collector.recordFact(key, 'function', 'declaration', symbol.id);
        }
        for (const param of childNodes(member, 'params')) {
          declarePattern(param, methodScope, ctx, { kind: 'parameter', detail: '参数' });
          walkPatternDefaults(param, methodScope, phase, ctx);
        }
      } else {
        for (const param of childNodes(member, 'params')) walkPatternExtras(param, methodScope, ctx);
        walkTypeParameters(childNode(member, 'typeParameters'), methodScope, ctx);
        walkTypeAnnotation(childNode(member, 'typeAnnotation'), methodScope, ctx);
        for (const decorator of childNodes(member, 'decorators')) {
          walkExpression(childNode(decorator, 'expression'), methodScope, phase, 'value', ctx);
        }
      }
      walkStatement(childNode(member, 'body'), methodScope, phase, ctx);
      return;
    }
    case 'StaticBlock': {
      const blockScope = collector.ensureScope(`block:${member.start}`, 'block', classScope, member, '静态初始化块');
      for (const statement of childNodes(member, 'body')) walkStatement(statement, blockScope, phase, ctx);
      return;
    }
    case 'TSIndexSignature': {
      if (phase === 'reference') walkTypeAnnotation(childNode(member, 'typeAnnotation'), classScope, ctx);
      return;
    }
    default: {
      forEachAstChild(member, (child) => {
        if (child.type.startsWith('TS') || child.type === 'Identifier') {
          if (phase === 'reference') walkType(child, classScope, ctx);
        } else {
          walkExpression(child, classScope, phase, 'value', ctx);
        }
      });
      return;
    }
  }
}

function handleInterfaceLike(node: AstNode, scopeId: string, phase: Phase, ctx: WalkContext): void {
  const { collector } = ctx;
  const id = childNode(node, 'id');
  const name = nameOf(id);
  if (phase === 'declare' && id && name) {
    const symbol = collector.declare(scopeId, name, 'typedef', id, {
      detail: '接口',
      typeText: `interface ${name}`,
    });
    collector.recordFact(id, 'type', 'declaration', symbol.id);
  }
  if (phase !== 'reference') return;
  walkTypeParameters(childNode(node, 'typeParameters'), scopeId, ctx);
  for (const extending of childNodes(node, 'extends')) walkType(extending, scopeId, ctx);
  const body = childNode(node, 'body');
  if (!body) return;
  for (const member of childNodes(body, 'body')) {
    switch (member.type) {
      case 'TSPropertySignature': {
        const key = childNode(member, 'key');
        if (booleanField(member, 'computed')) walkExpression(key, scopeId, phase, 'value', ctx);
        else if (key) collector.recordFact(key, 'data', 'interface-field');
        walkTypeAnnotation(childNode(member, 'typeAnnotation'), scopeId, ctx);
        break;
      }
      case 'TSMethodSignature': {
        const key = childNode(member, 'key');
        if (booleanField(member, 'computed')) walkExpression(key, scopeId, phase, 'value', ctx);
        else if (key) collector.recordFact(key, 'function', 'interface-method');
        walkTypeParameters(childNode(member, 'typeParameters'), scopeId, ctx);
        for (const param of childNodes(member, 'parameters')) {
          walkTypeAnnotation(childNode(param, 'typeAnnotation'), scopeId, ctx);
        }
        walkTypeAnnotation(childNode(member, 'typeAnnotation'), scopeId, ctx);
        break;
      }
      case 'TSIndexSignature': {
        for (const param of childNodes(member, 'parameters')) {
          walkTypeAnnotation(childNode(param, 'typeAnnotation'), scopeId, ctx);
        }
        walkTypeAnnotation(childNode(member, 'typeAnnotation'), scopeId, ctx);
        break;
      }
      default:
        walkType(member, scopeId, ctx);
        break;
    }
  }
}

function handleEnumDeclaration(node: AstNode, scopeId: string, phase: Phase, ctx: WalkContext): void {
  const { collector } = ctx;
  const id = childNode(node, 'id');
  const name = nameOf(id);
  if (phase === 'declare' && id && name) {
    const symbol = collector.declare(scopeId, name, 'typedef', id, { detail: '枚举', typeText: `enum ${name}` });
    collector.recordFact(id, 'type', 'declaration', symbol.id);
  }
  const body = childNode(node, 'body');
  if (!body) return;
  for (const member of childNodes(body, 'members')) {
    const memberId = childNode(member, 'id');
    const memberName = nameOf(memberId);
    if (phase === 'declare' && memberId && memberName) {
      const symbol = collector.declare(scopeId, `${name ?? 'enum'}.${memberName}`, 'field', memberId, {
        detail: '枚举成员',
        typeText: name,
      });
      collector.recordFact(memberId, 'data', 'enum-member', symbol.id);
    }
    walkExpression(childNode(member, 'initializer'), scopeId, phase, 'value', ctx);
  }
}

// ---------- 模式（解构、默认参数、参数） ----------

interface PatternOptions {
  kind: SymbolKind;
  detail: string;
  typeText?: string;
  classHint?: string;
}

function declarePattern(pattern: AstNode | undefined, scopeId: string, ctx: WalkContext, options: PatternOptions): void {
  if (!pattern) return;
  const { collector } = ctx;
  switch (pattern.type) {
    case 'Identifier': {
      const name = nameOf(pattern);
      if (!name) return;
      const annotation = childNode(pattern, 'typeAnnotation');
      const typeText = annotation
        ? rawText(ctx.source, annotation).replace(/^:\s*/, '')
        : options.typeText;
      const symbol = collector.declare(scopeId, name, options.kind, pattern, {
        detail: options.detail,
        typeText,
        classHint: options.classHint,
      });
      collector.recordFact(
        pattern,
        options.kind === 'function' ? 'function' : 'data',
        options.kind === 'parameter' ? 'parameter' : 'declaration',
        symbol.id,
      );
      return;
    }
    case 'ObjectPattern': {
      for (const property of childNodes(pattern, 'properties')) {
        if (property.type === 'ObjectProperty') {
          declarePattern(childNode(property, 'value'), scopeId, ctx, options);
        } else if (property.type === 'RestElement') {
          declarePattern(childNode(property, 'argument'), scopeId, ctx, options);
        }
      }
      return;
    }
    case 'ArrayPattern': {
      for (const element of childNodes(pattern, 'elements')) declarePattern(element, scopeId, ctx, options);
      return;
    }
    case 'AssignmentPattern': {
      declarePattern(childNode(pattern, 'left'), scopeId, ctx, options);
      return;
    }
    case 'RestElement': {
      declarePattern(childNode(pattern, 'argument'), scopeId, ctx, options);
      return;
    }
    case 'TSParameterProperty': {
      declarePattern(childNode(pattern, 'parameter'), scopeId, ctx, options);
      return;
    }
    default:
      return;
  }
}

/** 声明阶段：遍历模式中的默认值表达式，收集其中嵌套的函数/类声明 */
function walkPatternDefaults(pattern: AstNode | undefined, scopeId: string, phase: Phase, ctx: WalkContext): void {
  if (!pattern) return;
  switch (pattern.type) {
    case 'AssignmentPattern': {
      walkPatternDefaults(childNode(pattern, 'left'), scopeId, phase, ctx);
      walkExpression(childNode(pattern, 'right'), scopeId, phase, 'value', ctx);
      return;
    }
    case 'ObjectPattern': {
      for (const property of childNodes(pattern, 'properties')) {
        if (property.type === 'ObjectProperty') {
          if (booleanField(property, 'computed')) walkExpression(childNode(property, 'key'), scopeId, phase, 'value', ctx);
          walkPatternDefaults(childNode(property, 'value'), scopeId, phase, ctx);
        } else if (property.type === 'RestElement') {
          walkPatternDefaults(childNode(property, 'argument'), scopeId, phase, ctx);
        }
      }
      return;
    }
    case 'ArrayPattern': {
      for (const element of childNodes(pattern, 'elements')) walkPatternDefaults(element, scopeId, phase, ctx);
      return;
    }
    case 'RestElement':
      walkPatternDefaults(childNode(pattern, 'argument'), scopeId, phase, ctx);
      return;
    case 'TSParameterProperty':
      walkPatternDefaults(childNode(pattern, 'parameter'), scopeId, phase, ctx);
      return;
    default:
      return;
  }
}

/** 引用阶段：模式中的类型注解、默认值、计算属性需要继续解析 */
function walkPatternExtras(pattern: AstNode | undefined, scopeId: string, ctx: WalkContext): void {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier': {
      walkTypeAnnotation(childNode(pattern, 'typeAnnotation'), scopeId, ctx);
      return;
    }
    case 'AssignmentPattern': {
      walkPatternExtras(childNode(pattern, 'left'), scopeId, ctx);
      walkExpression(childNode(pattern, 'right'), scopeId, 'reference', 'value', ctx);
      return;
    }
    case 'ObjectPattern': {
      for (const property of childNodes(pattern, 'properties')) {
        if (property.type === 'ObjectProperty') {
          if (booleanField(property, 'computed')) {
            walkExpression(childNode(property, 'key'), scopeId, 'reference', 'value', ctx);
          }
          walkPatternExtras(childNode(property, 'value'), scopeId, ctx);
        } else if (property.type === 'RestElement') {
          walkPatternExtras(childNode(property, 'argument'), scopeId, ctx);
        }
      }
      return;
    }
    case 'ArrayPattern': {
      for (const element of childNodes(pattern, 'elements')) walkPatternExtras(element, scopeId, ctx);
      return;
    }
    case 'RestElement': {
      walkPatternExtras(childNode(pattern, 'argument'), scopeId, ctx);
      return;
    }
    case 'TSParameterProperty': {
      walkPatternExtras(childNode(pattern, 'parameter'), scopeId, ctx);
      return;
    }
    default: {
      walkTypeAnnotation(childNode(pattern, 'typeAnnotation'), scopeId, ctx);
      return;
    }
  }
}

/** 赋值 / for-of 左侧模式作为「引用」处理 */
function walkPatternReference(pattern: AstNode | undefined, scopeId: string, ctx: WalkContext): void {
  if (!pattern) return;
  const { collector } = ctx;
  switch (pattern.type) {
    case 'Identifier': {
      const name = nameOf(pattern);
      if (!name) return;
      const symbol = collector.resolve(scopeId, name);
      if (symbol) collector.addOccurrence(symbol, pattern, 'reference');
      collector.recordFact(pattern, 'data', 'assignment-target', symbol?.id);
      return;
    }
    case 'AssignmentPattern': {
      walkPatternReference(childNode(pattern, 'left'), scopeId, ctx);
      walkExpression(childNode(pattern, 'right'), scopeId, 'reference', 'value', ctx);
      return;
    }
    case 'ObjectPattern': {
      for (const property of childNodes(pattern, 'properties')) {
        if (property.type === 'ObjectProperty') {
          if (booleanField(property, 'computed')) {
            walkExpression(childNode(property, 'key'), scopeId, 'reference', 'value', ctx);
          }
          walkPatternReference(childNode(property, 'value'), scopeId, ctx);
        } else if (property.type === 'RestElement') {
          walkPatternReference(childNode(property, 'argument'), scopeId, ctx);
        }
      }
      return;
    }
    case 'ArrayPattern': {
      for (const element of childNodes(pattern, 'elements')) walkPatternReference(element, scopeId, ctx);
      return;
    }
    case 'RestElement': {
      walkPatternReference(childNode(pattern, 'argument'), scopeId, ctx);
      return;
    }
    case 'MemberExpression': {
      walkExpression(pattern, scopeId, 'reference', 'assignment-target', ctx);
      return;
    }
    default:
      return;
  }
}

// ---------- 表达式 ----------

function walkExpression(
  node: AstNode | undefined,
  scopeId: string,
  phase: Phase,
  context: ExprContext,
  ctx: WalkContext,
): void {
  if (!node) return;
  const { collector } = ctx;
  switch (node.type) {
    case 'Identifier': {
      if (phase !== 'reference') return;
      const name = nameOf(node);
      if (!name) return;
      if (context === 'callee') {
        const symbol = collector.resolve(scopeId, name);
        const isClass = symbol?.kind === 'class' || symbol?.kind === 'typedef';
        if (symbol) collector.addOccurrence(symbol, node, 'call');
        collector.recordFact(node, isClass ? 'type' : 'function', isClass ? 'class-call' : 'call', symbol?.id);
        return;
      }
      if (context === 'type') {
        const symbol = collector.resolve(scopeId, name);
        if (symbol) collector.addOccurrence(symbol, node, 'type');
        collector.recordFact(node, 'type', 'type-reference', symbol?.id);
        return;
      }
      const symbol = collector.resolve(scopeId, name);
      if (symbol) collector.addOccurrence(symbol, node, 'reference');
      const subkind = context === 'assignment-target' ? 'assignment-target' : 'reference';
      collector.recordFact(node, 'data', subkind, symbol?.id);
      return;
    }
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'BigIntLiteral':
    case 'DecimalLiteral':
    case 'RegExpLiteral':
      return;
    case 'TemplateLiteral': {
      for (const expression of childNodes(node, 'expressions')) {
        walkExpression(expression, scopeId, phase, 'value', ctx);
      }
      return;
    }
    case 'TaggedTemplateExpression': {
      walkExpression(childNode(node, 'tag'), scopeId, phase, 'callee', ctx);
      walkExpression(childNode(node, 'quasi'), scopeId, phase, 'value', ctx);
      return;
    }
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      handleMemberExpression(node, scopeId, phase, context, ctx);
      return;
    }
    case 'CallExpression':
    case 'OptionalCallExpression': {
      walkExpression(childNode(node, 'callee'), scopeId, phase, 'callee', ctx);
      for (const argument of childNodes(node, 'arguments')) {
        walkExpression(argument, scopeId, phase, 'value', ctx);
      }
      if (phase === 'reference') {
        const typeArguments = childNode(node, 'typeParameters') ?? childNode(node, 'typeArguments');
        walkType(typeArguments, scopeId, ctx);
      }
      return;
    }
    case 'NewExpression': {
      walkExpression(childNode(node, 'callee'), scopeId, phase, 'callee', ctx);
      for (const argument of childNodes(node, 'arguments')) {
        walkExpression(argument, scopeId, phase, 'value', ctx);
      }
      if (phase === 'reference') {
        const typeArguments = childNode(node, 'typeParameters') ?? childNode(node, 'typeArguments');
        walkType(typeArguments, scopeId, ctx);
      }
      return;
    }
    case 'ImportExpression': {
      walkExpression(childNode(node, 'source'), scopeId, phase, 'value', ctx);
      return;
    }
    case 'ArrowFunctionExpression':
    case 'FunctionExpression': {
      handleFunctionExpression(node, scopeId, phase, ctx);
      return;
    }
    case 'ClassExpression': {
      handleClassLike(node, scopeId, phase, ctx);
      return;
    }
    case 'ThisExpression':
    case 'Super':
    case 'MetaProperty':
    case 'PrivateName':
    case 'Import': {
      return;
    }
    case 'ObjectExpression': {
      for (const property of childNodes(node, 'properties')) {
        if (property.type === 'ObjectProperty' || property.type === 'ObjectMethod') {
          const key = childNode(property, 'key');
          const computed = booleanField(property, 'computed');
          if (property.type === 'ObjectMethod') {
            handleObjectMethod(property, scopeId, phase, ctx);
          } else {
            if (key && computed) walkExpression(key, scopeId, phase, 'value', ctx);
            else if (key && booleanField(property, 'shorthand')) walkExpression(key, scopeId, phase, 'value', ctx);
            else if (key && phase === 'declare') collector.recordFact(key, 'data', 'property');
            walkExpression(childNode(property, 'value'), scopeId, phase, 'value', ctx);
          }
        } else if (property.type === 'SpreadElement') {
          walkExpression(childNode(property, 'argument'), scopeId, phase, 'value', ctx);
        }
      }
      return;
    }
    case 'ArrayExpression': {
      for (const element of childNodes(node, 'elements')) {
        walkExpression(element, scopeId, phase, 'value', ctx);
      }
      return;
    }
    case 'AssignmentExpression': {
      const left = childNode(node, 'left');
      if (left) {
        if (left.type === 'ObjectPattern' || left.type === 'ArrayPattern') {
          if (phase === 'reference') walkPatternReference(left, scopeId, ctx);
        } else {
          walkExpression(left, scopeId, phase, 'assignment-target', ctx);
        }
      }
      walkExpression(childNode(node, 'right'), scopeId, phase, 'value', ctx);
      return;
    }
    case 'UpdateExpression': {
      walkExpression(childNode(node, 'argument'), scopeId, phase, 'value', ctx);
      return;
    }
    case 'UnaryExpression':
    case 'AwaitExpression':
    case 'YieldExpression':
    case 'SpreadElement':
    case 'RestElement':
    case 'ChainExpression':
    case 'ParenthesizedExpression':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'TSTypeAssertion':
    case 'TSInstantiationExpression':
    case 'TypeCastExpression': {
      const child =
        childNode(node, 'argument') ??
        childNode(node, 'expression') ??
        childNode(node, 'callee') ??
        childNode(node, 'operand');
      walkExpression(child, scopeId, phase, context === 'callee' ? 'callee' : 'value', ctx);
      if (phase === 'reference' && node.type.startsWith('TS')) {
        walkTypeAnnotation(childNode(node, 'typeAnnotation'), scopeId, ctx);
      }
      return;
    }
    case 'BinaryExpression':
    case 'LogicalExpression': {
      walkExpression(childNode(node, 'left'), scopeId, phase, 'value', ctx);
      walkExpression(childNode(node, 'right'), scopeId, phase, 'value', ctx);
      return;
    }
    case 'ConditionalExpression': {
      walkExpression(childNode(node, 'test'), scopeId, phase, 'value', ctx);
      walkExpression(childNode(node, 'consequent'), scopeId, phase, 'value', ctx);
      walkExpression(childNode(node, 'alternate'), scopeId, phase, 'value', ctx);
      return;
    }
    case 'SequenceExpression': {
      for (const expression of childNodes(node, 'expressions')) {
        walkExpression(expression, scopeId, phase, 'value', ctx);
      }
      return;
    }
    case 'ObjectPattern':
    case 'ArrayPattern':
    case 'AssignmentPattern': {
      if (phase === 'reference') walkPatternReference(node, scopeId, ctx);
      return;
    }
    default: {
      // 兜底：优先按类型节点处理 TS 结构，其余继续深入
      forEachAstChild(node, (child) => {
        if (child.type.startsWith('TS') && phase === 'reference') walkType(child, scopeId, ctx);
        else walkExpression(child, scopeId, phase, 'value', ctx);
      });
      return;
    }
  }
}

function handleMemberExpression(
  node: AstNode,
  scopeId: string,
  phase: Phase,
  context: ExprContext,
  ctx: WalkContext,
): void {
  const { collector } = ctx;
  const object = childNode(node, 'object');
  const property = childNode(node, 'property');
  const computed = booleanField(node, 'computed');
  walkExpression(object, scopeId, phase, 'value', ctx);
  if (!property) return;
  if (computed) {
    walkExpression(property, scopeId, phase, 'value', ctx);
    return;
  }
  if (phase !== 'reference') return;
  const propertyName = nameOf(property);
  if (!propertyName) return;
  let target: SymbolDraft | undefined;
  if (object?.type === 'ThisExpression') {
    const classScope = collector.findEnclosingClassScope(scopeId);
    const classSymbol = classScope ? collector.classSymbolForScope(classScope) : undefined;
    target = classSymbol ? collector.findMember(classSymbol, propertyName) : undefined;
  } else if (object?.type === 'Identifier') {
    const objectName = nameOf(object);
    const objectSymbol = objectName ? collector.resolve(scopeId, objectName) : undefined;
    if (objectSymbol) {
      if (objectSymbol.kind === 'class' || objectSymbol.kind === 'typedef') {
        target = collector.findMember(objectSymbol, propertyName);
      } else if (objectSymbol.classHint) {
        const classSymbol = collector.resolveClass(scopeId, objectSymbol.classHint);
        target = classSymbol ? collector.findMember(classSymbol, propertyName) : undefined;
      }
    }
  }
  const isCall = context === 'callee';
  if (target) collector.addOccurrence(target, property, isCall ? 'call' : 'member');
  // 属性访问默认是数据；出现在调用位置时应按函数（方法调用）着色，即使对象类型未知
  const category: SemanticCategory = target?.kind === 'function' || isCall ? 'function' : 'data';
  collector.recordFact(property, category, isCall ? 'method-call' : 'member', target?.id);
}

function handleFunctionExpression(node: AstNode, scopeId: string, phase: Phase, ctx: WalkContext): void {
  const { collector } = ctx;
  const id = childNode(node, 'id');
  const name = nameOf(id);
  const functionScope = collector.ensureScope(
    `function:${node.start}`,
    'function',
    scopeId,
    node,
    name ? `函数 ${name}` : node.type === 'ArrowFunctionExpression' ? '箭头函数' : '匿名函数',
  );
  if (phase === 'declare') {
    if (id && name) {
      const symbol = collector.declare(functionScope, name, 'function', id, { detail: '函数表达式' });
      collector.recordFact(id, 'function', 'declaration', symbol.id);
    }
    for (const param of childNodes(node, 'params')) {
      declarePattern(param, functionScope, ctx, { kind: 'parameter', detail: '参数' });
      walkPatternDefaults(param, functionScope, phase, ctx);
    }
  } else {
    for (const param of childNodes(node, 'params')) walkPatternExtras(param, functionScope, ctx);
    walkTypeParameters(childNode(node, 'typeParameters'), functionScope, ctx);
    walkTypeAnnotation(childNode(node, 'typeAnnotation'), functionScope, ctx);
  }
  const body = childNode(node, 'body');
  if (!body) return;
  if (body.type === 'BlockStatement') walkStatement(body, functionScope, phase, ctx);
  else walkExpression(body, functionScope, phase, 'value', ctx);
}

function handleObjectMethod(node: AstNode, scopeId: string, phase: Phase, ctx: WalkContext): void {
  const { collector } = ctx;
  const key = childNode(node, 'key');
  const name = nameOf(key);
  const methodScope = collector.ensureScope(
    `function:${node.start}`,
    'function',
    scopeId,
    node,
    name ? `方法 ${name}` : '对象方法',
  );
  if (phase === 'declare') {
    if (key && name) collector.recordFact(key, 'function', 'method-definition');
    for (const param of childNodes(node, 'params')) {
      declarePattern(param, methodScope, ctx, { kind: 'parameter', detail: '参数' });
      walkPatternDefaults(param, methodScope, phase, ctx);
    }
  } else {
    for (const param of childNodes(node, 'params')) walkPatternExtras(param, methodScope, ctx);
    walkTypeAnnotation(childNode(node, 'typeAnnotation'), methodScope, ctx);
  }
  walkStatement(childNode(node, 'body'), methodScope, phase, ctx);
}

// ---------- 类型 ----------

function walkTypeAnnotation(node: AstNode | undefined, scopeId: string, ctx: WalkContext): void {
  if (!node) return;
  walkType(node, scopeId, ctx);
}

function walkTypeParameters(node: AstNode | undefined, scopeId: string, ctx: WalkContext): void {
  if (!node) return;
  for (const parameter of childNodes(node, 'params')) {
    walkType(childNode(parameter, 'constraint'), scopeId, ctx);
    walkType(childNode(parameter, 'default'), scopeId, ctx);
  }
}

function walkType(node: AstNode | undefined, scopeId: string, ctx: WalkContext): void {
  if (!node) return;
  switch (node.type) {
    case 'TSTypeAnnotation': {
      walkType(childNode(node, 'typeAnnotation'), scopeId, ctx);
      return;
    }
    case 'TSTypeReference': {
      walkTypeName(childNode(node, 'typeName'), scopeId, ctx);
      walkTypeParameters(childNode(node, 'typeParameters'), scopeId, ctx);
      return;
    }
    case 'TSTypeQuery': {
      walkExpression(childNode(node, 'exprName'), scopeId, 'reference', 'value', ctx);
      return;
    }
    case 'Identifier': {
      const name = nameOf(node);
      if (!name) return;
      const symbol = ctx.collector.resolve(scopeId, name);
      if (symbol) ctx.collector.addOccurrence(symbol, node, 'type');
      ctx.collector.recordFact(node, 'type', 'type-reference', symbol?.id);
      return;
    }
    case 'TSQualifiedName': {
      walkTypeName(childNode(node, 'left'), scopeId, ctx);
      walkType(childNode(node, 'right'), scopeId, ctx);
      return;
    }
    case 'TSTypeLiteral': {
      for (const member of childNodes(node, 'members')) walkTypeMember(member, scopeId, ctx);
      return;
    }
    case 'TSFunctionType':
    case 'TSConstructorType': {
      walkTypeParameters(childNode(node, 'typeParameters'), scopeId, ctx);
      for (const parameter of childNodes(node, 'parameters')) {
        walkType(childNode(parameter, 'typeAnnotation'), scopeId, ctx);
      }
      walkType(childNode(node, 'typeAnnotation'), scopeId, ctx);
      return;
    }
    case 'TSMethodSignature': {
      walkTypeParameters(childNode(node, 'typeParameters'), scopeId, ctx);
      for (const parameter of childNodes(node, 'parameters')) {
        walkType(childNode(parameter, 'typeAnnotation'), scopeId, ctx);
      }
      walkType(childNode(node, 'typeAnnotation'), scopeId, ctx);
      return;
    }
    case 'TSPropertySignature': {
      walkType(childNode(node, 'typeAnnotation'), scopeId, ctx);
      return;
    }
    case 'TSIndexSignature': {
      for (const parameter of childNodes(node, 'parameters')) {
        walkType(childNode(parameter, 'typeAnnotation'), scopeId, ctx);
      }
      walkType(childNode(node, 'typeAnnotation'), scopeId, ctx);
      return;
    }
    case 'TSCallSignatureDeclaration':
    case 'TSConstructSignatureDeclaration': {
      for (const parameter of childNodes(node, 'parameters')) {
        walkType(childNode(parameter, 'typeAnnotation'), scopeId, ctx);
      }
      walkType(childNode(node, 'typeAnnotation'), scopeId, ctx);
      return;
    }
    default: {
      forEachAstChild(node, (child) => {
        if (child.type === 'Identifier') walkType(child, scopeId, ctx);
        else if (child.type.startsWith('TS') || child.type.endsWith('Type')) walkType(child, scopeId, ctx);
        else walkType(child, scopeId, ctx);
      });
      return;
    }
  }
}

function walkTypeName(node: AstNode | undefined, scopeId: string, ctx: WalkContext): void {
  if (!node) return;
  if (node.type === 'TSQualifiedName') {
    walkTypeName(childNode(node, 'left'), scopeId, ctx);
    walkType(childNode(node, 'right'), scopeId, ctx);
    return;
  }
  walkType(node, scopeId, ctx);
}

function walkTypeMember(member: AstNode, scopeId: string, ctx: WalkContext): void {
  switch (member.type) {
    case 'TSPropertySignature': {
      const key = childNode(member, 'key');
      if (booleanField(member, 'computed')) {
        walkExpression(key, scopeId, 'reference', 'value', ctx);
      } else if (key) {
        ctx.collector.recordFact(key, 'data', 'property');
      }
      walkType(childNode(member, 'typeAnnotation'), scopeId, ctx);
      return;
    }
    default:
      walkType(member, scopeId, ctx);
      return;
  }
}

// ==================================================================
// 语义 token 生成
// ==================================================================

function buildSemanticTokens(
  source: SourceFile,
  rawTokens: BabelTokenLike[],
  collector: SymbolCollector,
): SemanticToken[] {
  const tokens: SemanticToken[] = [];
  const text = source.text;
  for (const raw of rawTokens) {
    const start = Math.max(0, Math.min(raw.start, text.length));
    const end = Math.max(start, Math.min(raw.end, text.length));
    if (start >= end) continue;
    const info = describeTokenType(raw.type);
    if (info.label === 'eof') continue;
    if (info.comment) {
      tokens.push({
        start,
        end,
        category: 'comment',
        subkind: info.label === 'CommentBlock' ? 'block-comment' : 'line-comment',
      });
      continue;
    }
    if (info.label.includes('`') || info.label.includes('${')) {
      tokens.push({ start, end, category: 'data', subkind: 'template' });
      continue;
    }
    const tokenText = text.slice(start, end);
    if (info.label === 'name' || info.label === '#name') {
      const fact = collector.factAt(start, end) ?? collector.keywordAnchorAt(start);
      if (fact) {
        tokens.push({
          start,
          end,
          category: fact.category,
          subkind: fact.subkind,
          nodeId: fact.nodeId,
          symbolId: fact.symbolId,
        });
        continue;
      }
      if (info.label === '#name') {
        tokens.push({ start, end, category: 'data', subkind: 'private-member' });
        continue;
      }
      const contextual = CONTEXTUAL_IDENTIFIER_CATEGORIES[tokenText];
      if (contextual) {
        tokens.push({ start, end, category: contextual.category, subkind: contextual.subkind });
        continue;
      }
      tokens.push({ start, end, category: 'data', subkind: 'identifier' });
      continue;
    }
    if (info.literal) {
      tokens.push({ start, end, category: 'data', subkind: info.literal });
      continue;
    }
    if (info.keyword) {
      tokens.push({ start, end, category: categoryForKeyword(info.keyword), subkind: info.keyword });
      continue;
    }
    if (PUNCTUATION_LABELS.has(info.label)) {
      tokens.push({ start, end, category: 'punctuation', subkind: info.label });
      continue;
    }
    if (OPERATOR_LABELS.has(info.label) || info.operatorLike) {
      tokens.push({ start, end, category: 'operator', subkind: truncate(tokenText, 8) });
      continue;
    }
    tokens.push({ start, end, category: 'punctuation', subkind: info.label });
  }
  return tokens;
}

/** 解析彻底失败时的兜底词法着色：至少不会让界面空白 */
function lexFallback(source: SourceFile): SemanticToken[] {
  const text = source.text;
  const tokens: SemanticToken[] = [];
  const keywords = new Set<string>([
    ...CONTROL_KEYWORDS,
    ...FUNCTION_KEYWORDS,
    ...TYPE_KEYWORDS,
    ...DATA_KEYWORDS,
    ...OPERATOR_KEYWORDS,
  ]);
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index);
      const stop = newline < 0 ? text.length : newline;
      tokens.push({ start: index, end: stop, category: 'comment', subkind: 'line-comment' });
      index = stop;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      const stop = close < 0 ? text.length : close + 2;
      tokens.push({ start: index, end: stop, category: 'comment', subkind: 'block-comment' });
      index = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      let cursor = index + 1;
      while (cursor < text.length) {
        if (text[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (text[cursor] === char) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      const stop = Math.min(cursor, text.length);
      tokens.push({ start: index, end: stop, category: 'data', subkind: 'string' });
      index = stop;
      continue;
    }
    if (/[0-9]/.test(char)) {
      let cursor = index + 1;
      while (cursor < text.length && /[0-9a-fA-FxXoO._]/.test(text[cursor])) cursor += 1;
      tokens.push({ start: index, end: cursor, category: 'data', subkind: 'number' });
      index = cursor;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let cursor = index + 1;
      while (cursor < text.length && /[A-Za-z0-9_$]/.test(text[cursor])) cursor += 1;
      const word = text.slice(index, cursor);
      if (keywords.has(word)) {
        tokens.push({ start: index, end: cursor, category: categoryForKeyword(word), subkind: word });
      } else {
        tokens.push({ start: index, end: cursor, category: 'data', subkind: 'identifier' });
      }
      index = cursor;
      continue;
    }
    const operator = ['===', '!==', '**=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>', '...'].find(
      (candidate) => text.startsWith(candidate, index),
    );
    if (operator) {
      tokens.push({ start: index, end: index + operator.length, category: 'operator', subkind: operator });
      index += operator.length;
      continue;
    }
    const category: SemanticCategory = /[[\](){}]/.test(char) || /[,;:.]/.test(char) ? 'punctuation' : 'operator';
    tokens.push({ start: index, end: index + 1, category, subkind: char });
    index += 1;
  }
  return tokens;
}

// ==================================================================
// 结构树（中文标签）
// ==================================================================

class StructureBuilder {
  private counter = 0;

  constructor(private readonly source: SourceFile) {}

  build(program: AstNode): StructureNode[] {
    const children = this.statements(childNodes(program, 'body'));
    return [this.make('程序', 'program', program.start, program.end, children)];
  }

  private make(
    label: string,
    kind: string,
    start: number,
    end: number,
    children: StructureNode[],
    secondary?: string,
    nodeId?: string,
    badges?: string[],
  ): StructureNode {
    const clampedEnd = Math.max(start, Math.min(end, this.source.text.length + 64));
    const range: SourceRange = this.source.range(start, clampedEnd);
    return {
      id: `js-structure-${++this.counter}`,
      label,
      kind,
      secondary,
      range,
      nodeId,
      badges,
      children,
    };
  }

  private statements(nodes: AstNode[]): StructureNode[] {
    return nodes.flatMap((node) => this.statement(node));
  }

  private statement(node: AstNode): StructureNode[] {
    switch (node.type) {
      case 'ImportDeclaration': {
        const sourceNode = childNode(node, 'source');
        const moduleName = sourceNode ? nameOf(sourceNode) ?? rawText(this.source, sourceNode).replace(/^["']|["']$/g, '') : '';
        const names = childNodes(node, 'specifiers')
          .map((specifier) => nameOf(childNode(specifier, 'local')))
          .filter((name): name is string => Boolean(name));
        return [
          this.makeForNode('导入', 'import', node, [], `from ${moduleName}${names.length ? `：${names.join(', ')}` : ''}`),
        ];
      }
      case 'ExportNamedDeclaration': {
        const declaration = childNode(node, 'declaration');
        if (declaration) {
          return this.statement(declaration).map((child) => ({ ...child, badges: [...(child.badges ?? []), '导出'] }));
        }
        const names = childNodes(node, 'specifiers')
          .map((specifier) => nameOf(childNode(specifier, 'local')))
          .filter((name): name is string => Boolean(name));
        return [this.makeForNode('导出', 'export', node, [], names.join(', '))];
      }
      case 'ExportDefaultDeclaration': {
        const declaration = childNode(node, 'declaration');
        if (!declaration) return [];
        const mapped = this.statementOrExpression(declaration);
        return mapped.map((child) => ({ ...child, badges: [...(child.badges ?? []), '默认导出'] }));
      }
      case 'VariableDeclaration':
        return [this.buildVariableDeclaration(node)];
      case 'FunctionDeclaration':
      case 'TSDeclareFunction':
        return [this.buildFunction(node, '函数定义')];
      case 'ClassDeclaration':
        return [this.buildClass(node, '类定义')];
      case 'TSInterfaceDeclaration':
        return [this.buildInterface(node)];
      case 'TSTypeAliasDeclaration': {
        const id = childNode(node, 'id');
        const typeNode = childNode(node, 'typeAnnotation');
        return [
          this.makeForNode(
            '类型别名',
            'type-alias',
            node,
            [],
            `${nameOf(id) ?? '?'} = ${typeNode ? truncate(rawText(this.source, typeNode), 60) : ''}`,
          ),
        ];
      }
      case 'TSEnumDeclaration': {
        const id = childNode(node, 'id');
        const body = childNode(node, 'body');
        const members = body ? childNodes(body, 'members') : [];
        const children = members.map((member) => {
          const memberId = childNode(member, 'id');
          return this.makeForNode(`枚举成员 ${nameOf(memberId) ?? '?'}`, 'enum-member', member, []);
        });
        return [this.makeForNode('枚举定义', 'enum', node, children, nameOf(id) ?? '?')];
      }
      case 'IfStatement':
        return [this.buildIf(node)];
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const body = childNode(node, 'body');
        const header = this.source.text.slice(node.start, body?.start ?? node.end);
        return [
          this.makeForNode('循环', 'loop', node, this.bodyNodes(body), `for ${truncate(header.replace(/^\s*for\s*/, ''), 60)}`),
        ];
      }
      case 'WhileStatement':
      case 'DoWhileStatement': {
        const test = childNode(node, 'test');
        const body = childNode(node, 'body');
        return [
          this.makeForNode(
            '循环',
            'loop',
            node,
            this.bodyNodes(body),
            `${node.type === 'DoWhileStatement' ? 'do-while' : 'while'} (${truncate(rawText(this.source, test), 60)})`,
          ),
        ];
      }
      case 'ReturnStatement': {
        const argument = childNode(node, 'argument');
        return [this.makeForNode('返回', 'return', node, this.expressionStructures(argument), argument ? truncate(rawText(this.source, argument), 60) : undefined)];
      }
      case 'BreakStatement':
        return [this.makeForNode('跳出循环', 'break', node, [])];
      case 'ContinueStatement':
        return [this.makeForNode('继续循环', 'continue', node, [])];
      case 'ThrowStatement': {
        const argument = childNode(node, 'argument');
        return [
          this.makeForNode('抛出异常', 'throw', node, this.expressionStructures(argument), argument ? truncate(rawText(this.source, argument), 60) : undefined),
        ];
      }
      case 'TryStatement':
        return [this.buildTry(node)];
      case 'SwitchStatement':
        return [this.buildSwitch(node)];
      case 'ExpressionStatement': {
        const expression = childNode(node, 'expression');
        return expression ? this.expressionStatementStructures(expression) : [];
      }
      case 'BlockStatement':
        return this.statements(childNodes(node, 'body'));
      case 'LabeledStatement': {
        const body = childNode(node, 'body');
        return [
          this.makeForNode(`标签 ${stringField(node, 'label') ?? ''}`, 'label', node, body ? this.statements([body]) : [], stringField(node, 'label')),
        ];
      }
      case 'WithStatement':
      case 'EmptyStatement':
      case 'DebuggerStatement':
        return [];
      default:
        return [this.makeForNode('语句', 'statement', node, [], truncate(rawText(this.source, node), 60))];
    }
  }

  private statementOrExpression(node: AstNode): StructureNode[] {
    if (isStatementNode(node)) return this.statement(node);
    return this.expressionStructures(node);
  }

  private expressionStatementStructures(expression: AstNode): StructureNode[] {
    if (expression.type === 'AssignmentExpression') {
      const left = childNode(expression, 'left');
      const right = childNode(expression, 'right');
      const operator = stringField(expression, 'operator') ?? '=';
      const children = this.expressionStructures(right);
      return [
        this.makeForNode(
          '赋值',
          'assign',
          expression,
          children,
          `${truncate(rawText(this.source, left), 40)} ${operator} ${truncate(rawText(this.source, right), 50)}`,
        ),
      ];
    }
    if (expression.type === 'UpdateExpression') {
      const argument = childNode(expression, 'argument');
      return [
        this.makeForNode('自增自减', 'update', expression, [], truncate(rawText(this.source, argument), 40)),
      ];
    }
    const calls = this.expressionStructures(expression);
    if (calls.length > 0) return calls;
    return [this.makeForNode('表达式', 'expression', expression, [], truncate(rawText(this.source, expression), 60))];
  }

  private expressionStructures(node: AstNode | undefined): StructureNode[] {
    if (!node) return [];
    switch (node.type) {
      case 'CallExpression':
      case 'OptionalCallExpression':
      case 'NewExpression': {
        const callee = childNode(node, 'callee');
        const children = childNodes(node, 'arguments').flatMap((argument) => this.expressionStructures(argument));
        const isNew = node.type === 'NewExpression';
        return [
          this.makeForNode(
            isNew ? '创建对象' : '函数调用',
            isNew ? 'new' : 'call',
            node,
            children,
            truncate(rawText(this.source, callee), 60),
          ),
        ];
      }
      case 'AssignmentExpression': {
        const right = childNode(node, 'right');
        const left = childNode(node, 'left');
        return [
          this.makeForNode(
            '赋值',
            'assign',
            node,
            this.expressionStructures(right),
            `${truncate(rawText(this.source, left), 30)} ${stringField(node, 'operator') ?? '='}`,
          ),
        ];
      }
      case 'AwaitExpression':
      case 'ChainExpression':
      case 'ParenthesizedExpression':
      case 'TSAsExpression':
      case 'TSNonNullExpression': {
        return this.expressionStructures(
          childNode(node, 'argument') ?? childNode(node, 'expression') ?? childNode(node, 'callee'),
        );
      }
      case 'SequenceExpression': {
        return childNodes(node, 'expressions').flatMap((expression) => this.expressionStructures(expression));
      }
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        return [this.buildFunction(node, '函数定义')];
      case 'ClassExpression':
        return [this.buildClass(node, '类定义')];
      default:
        return [];
    }
  }

  private bodyNodes(node: AstNode | undefined): StructureNode[] {
    if (!node) return [];
    if (node.type === 'BlockStatement') return this.statements(childNodes(node, 'body'));
    return this.statement(node);
  }

  private buildVariableDeclaration(node: AstNode): StructureNode {
    const declarationKind = stringField(node, 'kind') ?? 'let';
    const children = childNodes(node, 'declarations').map((declarator) => {
      const id = childNode(declarator, 'id');
      const init = childNode(declarator, 'init');
      const typeAnnotation = childNode(declarator, 'typeAnnotation') ?? (id ? childNode(id, 'typeAnnotation') : undefined);
      const initStructures = this.expressionStructures(init);
      const secondaryParts: string[] = [];
      if (typeAnnotation) secondaryParts.push(truncate(rawText(this.source, typeAnnotation).replace(/^:\s*/, ''), 40));
      if (init) secondaryParts.push(`= ${truncate(rawText(this.source, init), 50)}`);
      return this.makeForNode(
        `变量 ${patternName(id)}`,
        'variable',
        declarator,
        initStructures,
        secondaryParts.length ? secondaryParts.join(' ') : undefined,
      );
    });
    return this.makeForNode('变量声明', 'variable-declaration', node, children, declarationKind);
  }

  private buildFunction(node: AstNode, label: string): StructureNode {
    const id = childNode(node, 'id');
    const params = childNodes(node, 'params');
    const body = childNode(node, 'body');
    const children: StructureNode[] = params.map((param) => this.buildParameter(param));
    if (body?.type === 'BlockStatement') children.push(...this.statements(childNodes(body, 'body')));
    else if (body) children.push(...this.expressionStructures(body));
    const name = nameOf(id) ?? '匿名函数';
    const badges: string[] = [];
    if (booleanField(node, 'async')) badges.push('async');
    if (booleanField(node, 'generator')) badges.push('generator');
    if (node.type === 'ArrowFunctionExpression') badges.push('箭头函数');
    return this.makeForNode(label, 'function', node, children, `${name}(${params.map((param) => patternName(param)).join(', ')})`, badges);
  }

  private buildParameter(param: AstNode): StructureNode {
    const annotation = childNode(param, 'typeAnnotation');
    const name = patternName(param);
    const annotationText = annotation ? truncate(rawText(this.source, annotation).replace(/^:\s*/, ''), 40) : undefined;
    return this.makeForNode(
      '参数',
      'parameter',
      param,
      [],
      annotationText ? `${name}: ${annotationText}` : name,
    );
  }

  private buildClass(node: AstNode, label: string): StructureNode {
    const id = childNode(node, 'id');
    const superClass = childNode(node, 'superClass');
    const body = childNode(node, 'body');
    const children: StructureNode[] = [];
    if (body) {
      for (const member of childNodes(body, 'body')) {
        if (member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') {
          const key = childNode(member, 'key');
          const params = childNodes(member, 'params');
          const methodBody = childNode(member, 'body');
          const methodChildren = params.map((param) => this.buildParameter(param));
          if (methodBody?.type === 'BlockStatement') methodChildren.push(...this.statements(childNodes(methodBody, 'body')));
          children.push(
            this.makeForNode(
              stringField(member, 'kind') === 'constructor' ? '构造方法' : '方法定义',
              'method',
              member,
              methodChildren,
              `${nameOf(key) ?? '方法'}(${params.map((param) => patternName(param)).join(', ')})`,
            ),
          );
        } else if (member.type === 'ClassProperty' || member.type === 'ClassAccessorProperty') {
          const key = childNode(member, 'key');
          const value = childNode(member, 'value');
          children.push(
            this.makeForNode(
              `字段 ${nameOf(key) ?? '?'}`,
              'field',
              member,
              this.expressionStructures(value),
              value ? truncate(rawText(this.source, value), 40) : undefined,
            ),
          );
        } else if (member.type === 'StaticBlock') {
          children.push(
            this.makeForNode('静态初始化块', 'static-block', member, this.statements(childNodes(member, 'body'))),
          );
        }
      }
    }
    const className = nameOf(id) ?? '匿名类';
    const secondary = superClass ? `class ${className} extends ${truncate(rawText(this.source, superClass), 40)}` : `class ${className}`;
    return this.makeForNode(label, 'class', node, children, secondary);
  }

  private buildInterface(node: AstNode): StructureNode {
    const id = childNode(node, 'id');
    const body = childNode(node, 'body');
    const children: StructureNode[] = [];
    if (body) {
      for (const member of childNodes(body, 'body')) {
        if (member.type === 'TSPropertySignature') {
          const key = childNode(member, 'key');
          const annotation = childNode(member, 'typeAnnotation');
          children.push(
            this.makeForNode(
              `字段 ${nameOf(key) ?? '?'}`,
              'field',
              member,
              [],
              annotation ? truncate(rawText(this.source, annotation).replace(/^:\s*/, ''), 40) : undefined,
            ),
          );
        } else if (member.type === 'TSMethodSignature') {
          const key = childNode(member, 'key');
          children.push(this.makeForNode(`方法签名 ${nameOf(key) ?? '?'}`, 'method-signature', member, []));
        }
      }
    }
    return this.makeForNode('接口定义', 'interface', node, children, `interface ${nameOf(id) ?? '?'}`);
  }

  private buildIf(node: AstNode): StructureNode {
    const test = childNode(node, 'test');
    const consequent = childNode(node, 'consequent');
    const alternate = childNode(node, 'alternate');
    const children: StructureNode[] = [
      this.makeGroup('条件成立', 'then', consequent, this.bodyNodes(consequent)),
    ];
    if (alternate) {
      if (alternate.type === 'IfStatement') {
        children.push(this.buildIf(alternate));
      } else {
        children.push(this.makeGroup('否则', 'else', alternate, this.bodyNodes(alternate)));
      }
    }
    return this.makeForNode('条件判断', 'if', node, children, `if (${truncate(rawText(this.source, test), 60)})`);
  }

  private makeGroup(label: string, kind: string, node: AstNode | undefined, children: StructureNode[]): StructureNode {
    return this.makeForNode(label, kind, node ?? this.fallbackNode(), children);
  }

  private fallbackNode(): AstNode {
    return { type: 'Unknown', start: 0, end: 0 };
  }

  private buildTry(node: AstNode): StructureNode {
    const children: StructureNode[] = [];
    const block = childNode(node, 'block');
    children.push(this.makeGroup('尝试', 'try', block, this.bodyNodes(block)));
    const handler = childNode(node, 'handler');
    if (handler) {
      const param = childNode(handler, 'param');
      const handlerChildren = this.bodyNodes(childNode(handler, 'body'));
      children.push(
        this.makeForNode(
          '捕获异常',
          'catch',
          handler,
          handlerChildren,
          param ? `catch (${patternName(param)})` : undefined,
        ),
      );
    }
    const finalizer = childNode(node, 'finalizer');
    if (finalizer) children.push(this.makeGroup('最终处理', 'finally', finalizer, this.bodyNodes(finalizer)));
    return this.makeForNode('异常处理', 'try', node, children);
  }

  private buildSwitch(node: AstNode): StructureNode {
    const discriminant = childNode(node, 'discriminant');
    const children = childNodes(node, 'cases').map((switchCase) => {
      const test = childNode(switchCase, 'test');
      return this.makeForNode(
        test ? `情况 ${truncate(rawText(this.source, test), 40)}` : '默认分支',
        'case',
        switchCase,
        this.statements(childNodes(switchCase, 'consequent')),
      );
    });
    return this.makeForNode('多分支选择', 'switch', node, children, `switch (${truncate(rawText(this.source, discriminant), 40)})`);
  }

  private makeForNode(
    label: string,
    kind: string,
    node: AstNode,
    children: StructureNode[],
    secondary?: string,
    badges?: string[],
  ): StructureNode {
    return this.make(label, kind, node.start, node.end, children, secondary, astNodeId(node), badges);
  }
}

// ==================================================================
// 解析与错误恢复
// ==================================================================

function runBabelParse(text: string, language: 'javascript' | 'typescript'): ParseOutcome {
  const options: ParserOptions = {
    sourceType: 'module',
    tokens: true,
    errorRecovery: true,
  };
  if (language === 'typescript') options.plugins = ['typescript'];
  const raw = parse(text, options) as unknown as {
    program: AstNode;
    tokens?: BabelTokenLike[];
    errors?: BabelParseErrorLike[];
  };
  return { program: raw.program, tokens: raw.tokens ?? [], errors: raw.errors ?? [] };
}

interface ErrorInfo {
  message: string;
  index: number;
  line: number;
}

function normalizeParseError(error: unknown): ErrorInfo {
  const candidate = error as {
    message?: unknown;
    pos?: unknown;
    loc?: { line?: unknown; index?: unknown };
  };
  const message = typeof candidate?.message === 'string' ? candidate.message : '无法解析的语法错误';
  const index =
    typeof candidate?.loc?.index === 'number'
      ? candidate.loc.index
      : typeof candidate?.pos === 'number'
        ? candidate.pos
        : 0;
  const line = typeof candidate?.loc?.line === 'number' ? candidate.loc.line : 1;
  return { message, index, line };
}

function toParseIssue(error: unknown, source: SourceFile): ParseIssue {
  const info = normalizeParseError(error);
  const range = source.range(info.index, Math.min(info.index + 1, source.text.length));
  return {
    severity: 'error',
    message: `语法错误：${info.message}`,
    hint: 'CodeLens 会尽量跳过或补全问题片段后继续分析，但该位置附近的结构可能不完整。',
    range,
    line: range.startLine,
  };
}

function astErrorToIssue(error: BabelParseErrorLike, source: SourceFile): ParseIssue {
  const message = typeof error.message === 'string' ? error.message : '语法错误';
  const index =
    typeof error.loc?.index === 'number'
      ? error.loc.index
      : typeof error.pos === 'number'
        ? error.pos
        : 0;
  const range = source.range(index, Math.min(index + 1, source.text.length));
  return {
    severity: 'error',
    message: `语法错误：${message}`,
    hint: '解析器已跳过部分无法恢复的语法，结构树可能不完整。',
    range,
    line: range.startLine,
  };
}

/**
 * 计算尚未闭合的括号。
 * 语法错误发生在文件末尾（典型场景：漏写 } 或 )）时，补全括号是最有效的恢复方式。
 */
function missingClosers(text: string): string {
  const stack: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '/' && next === '/') {
      const newline = text.indexOf('\n', index);
      index = newline < 0 ? text.length : newline + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close < 0 ? text.length : close + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      let cursor = index + 1;
      while (cursor < text.length) {
        if (text[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (text[cursor] === char) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      index = cursor;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') stack.push(char);
    else if (char === ')' || char === ']' || char === '}') {
      const expected = char === ')' ? '(' : char === ']' ? '[' : '{';
      const last = stack.lastIndexOf(expected);
      if (last >= 0) stack.length = last;
    }
    index += 1;
  }
  const closers = stack
    .slice(-6)
    .reverse()
    .map((open) => (open === '(' ? ')' : open === '[' ? ']' : '}'))
    .join('');
  return closers;
}

/** 对一次解析错误做最小修复：坏行置空 或 在末尾补全括号 */
function repairSource(text: string, error: unknown): string {
  const info = normalizeParseError(error);
  const index = Math.max(0, Math.min(info.index, text.length));
  const lineStart = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const newline = text.indexOf('\n', index);
  const lineEnd = newline < 0 ? text.length : newline;
  const lineText = text.slice(lineStart, lineEnd);
  const blanked = lineText.replace(/[^\t]/g, ' ');
  if (lineText.trim().length > 0 && blanked !== lineText) {
    return text.slice(0, lineStart) + blanked + text.slice(lineEnd);
  }
  const closers = missingClosers(text);
  if (closers.length > 0) return `${text}\n${closers}`;
  if (lineStart > 0 && lineText.length === 0) return text.slice(0, lineStart);
  return text;
}

interface RecoveryResult {
  outcome: ParseOutcome | null;
  issues: ParseIssue[];
  recovered: boolean;
}

function parseWithRecovery(source: SourceFile, language: 'javascript' | 'typescript'): RecoveryResult {
  const issues: ParseIssue[] = [];
  let working = source.text;
  let repaired = false;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const outcome = runBabelParse(working, language);
      for (const error of outcome.errors) issues.push(astErrorToIssue(error, source));
      return { outcome, issues, recovered: repaired };
    } catch (error) {
      issues.push(toParseIssue(error, source));
      const next = repairSource(working, error);
      if (next === working) return { outcome: null, issues, recovered: repaired };
      working = next;
      repaired = true;
    }
  }
  return { outcome: null, issues, recovered: repaired };
}

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

// ==================================================================
// 对外入口
// ==================================================================

const EXECUTION_REASON = 'JavaScript/TypeScript 暂未接入可靠执行引擎，CodeLens 不会伪造执行结果。';

const SUPPORT_NOTES = [
  '结构级分析：使用 @babel/parser 生成真实 AST，提供语义高亮、中文结构树与基础符号关联。',
  '符号分析覆盖变量、函数、参数、类、字段、TS 接口/类型别名/枚举；引用解析为静态作用域近似结果。',
  '不做完整类型检查与类型推断，跨模块、动态属性等无法解析的引用会标记为普通引用，不会报错。',
  'JSX、装饰器（decorators 插件）等未启用的语法可能产生解析错误；错误会明确报告并尽量恢复结构。',
  '不支持执行：JavaScript/TypeScript 暂未接入可靠执行引擎，CodeLens 不会伪造执行结果。',
];

/** 分析 JavaScript / TypeScript 源码，返回统一结构分析结果 */
export function analyzeJavaScript(
  source: SourceFile,
  language: 'javascript' | 'typescript',
): LanguageAnalysis {
  const languageLabel = language === 'typescript' ? 'TypeScript' : 'JavaScript';
  const recovery = parseWithRecovery(source, language);
  const issues = [...recovery.issues];

  let tree: StructureNode[];
  let tokens: SemanticToken[];
  let symbols: Record<string, SymbolInfo>;

  if (!recovery.outcome) {
    // 解析彻底失败：仍给出根节点 + 兜底词法着色，并在 issues 中说明
    issues.push({
      severity: 'warning',
      message: '语法错误过多，无法建立完整的 AST；当前仅提供有限的结构与词法着色。',
      hint: '建议先修复标红的语法错误，再查看结构树与符号关联。',
      range: source.range(0, source.text.length),
      line: 1,
    });
    tree = [
      {
        id: 'js-structure-root',
        label: '程序',
        kind: 'program',
        range: source.range(0, source.text.length),
        children:
          source.text.trim().length === 0
            ? []
            : [
                {
                  id: 'js-structure-unparsed',
                  label: '无法解析的代码',
                  kind: 'unparsed',
                  secondary: '存在无法恢复的语法错误',
                  range: source.range(0, source.text.length),
                  children: [],
                },
              ],
      },
    ];
    tokens = lexFallback(source);
    symbols = {};
  } else {
    const { program } = recovery.outcome;
    const collector = new SymbolCollector(source);
    const ctx: WalkContext = { source, collector };
    walkProgram(program, ctx);
    markTypeKeywordAnchors(program, collector);
    symbols = collector.finalize();
    tokens = buildSemanticTokens(source, recovery.outcome.tokens, collector);
    if (tokens.length === 0 && source.text.trim().length > 0) tokens = lexFallback(source);
    tree = new StructureBuilder(source).build(program);
    if (recovery.recovered) {
      issues.push({
        severity: 'warning',
        message: '源码存在语法错误，CodeLens 已跳过或补全问题片段后继续分析，结构树可能不完整。',
        hint: '请结合行号检查被标记的语法错误。',
        line: issues.length > 0 ? issues[0].line : 1,
      });
    }
  }

  const finalIssues = dedupeIssues(issues);
  return {
    language,
    languageLabel,
    supportLevel: 'structural',
    supportNotes: SUPPORT_NOTES,
    tree,
    tokens,
    symbols,
    issues: finalIssues,
    execution: { supported: false, reason: EXECUTION_REASON },
    capabilities: {
      semanticHighlight: true,
      structureTree: true,
      explanations: 'basic',
      crossReference: true,
      execution: false,
      realParser: true,
    },
    analyzer: 'babel-parser',
  };
}

/** 收集 TS 类型关键字的位置，供词法着色时把 `string`、`interface` 等标记为类型 */
function markTypeKeywordAnchors(program: AstNode, collector: SymbolCollector): void {
  visitAst(program, (node) => {
    if (/^TS.*(Keyword|ThisType)$/.test(node.type)) {
      collector.addKeywordAnchor(node.start, 'type', 'type-keyword', astNodeId(node));
      return;
    }
    switch (node.type) {
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration':
      case 'TSEnumDeclaration':
      case 'TSModuleDeclaration':
        collector.addKeywordAnchor(node.start, 'type', 'type-keyword', astNodeId(node));
        break;
      default:
        break;
    }
  });
}
