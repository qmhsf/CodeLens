/**
 * C / C++（C 子集）抽象语法树（AST）类型定义
 * ------------------------------------------------------------------
 * 解析器不依赖任何第三方原生模块：手写词法分析 + 递归下降语法分析，
 * 因此可以在浏览器中离线运行，并保留精确的源码区间，便于语义高亮、
 * 点击释义、结构树以及逐行执行可视化共用同一份语法结构。
 *
 * 设计约定：
 * 1. 每个节点都有全局唯一的 id 与 SourceRange；
 * 2. 类型信息（TypeRef）与声明符（Declarator）分开保存，
 *    这样才能正确区分 `int *p`, `int a[3]`, `LNode *p` 等写法；
 * 3. 所有节点 kind 使用英文枚举，界面展示时再翻译成中文。
 */
import type { SourceRange, SourceFile } from './source';

export type NodeId = string;

/** 基础节点：所有语法节点都具备 */
export interface BaseNode {
  id: NodeId;
  range: SourceRange;
}

/** 类型引用：例如 int、char、struct LNode、自定义 typedef 类型 */
export interface TypeRef {
  /** 原始类型文本，如 "unsigned int" / "struct LNode" */
  raw: string;
  /** 基础类型名或自定义类型名，如 "int" / "LNode" */
  name: string;
  /** 是否由 struct 关键字引入 */
  isStruct: boolean;
  /** struct 标签名，如 struct LNode 中的 LNode */
  structTag?: string;
  /** 是否自定义（typedef / struct）类型 */
  isCustom: boolean;
  isConst: boolean;
  isUnsigned: boolean;
  range: SourceRange;
}

/** 声明符：描述一个变量的「名字 + 指针/数组/初始化」部分 */
export interface Declarator {
  id: NodeId;
  /** 变量名节点 */
  name: IdentifierNode;
  /** 指针层数：LNode **p 为 2 */
  pointerDepth: number;
  /** 指针声明中每个 '*'（或 C++ 的 '&'）的源码区间，用于青色高亮 */
  pointerStars: SourceRange[];
  /** C++ 引用声明 & */
  isReference: boolean;
  /** 数组维度；空数组 [] 使用 null 占位 */
  arrayDims: (ExprNode | null)[];
  /** 初始化表达式 */
  initializer?: ExprNode;
  range: SourceRange;
}

export interface ProgramNode extends BaseNode {
  kind: 'Program';
  items: TopLevelNode[];
  comments: CommentNode[];
}

export interface PreprocessorNode extends BaseNode {
  kind: 'Preprocessor';
  /** 指令名：include / define / ifdef ... */
  directive: string;
  raw: string;
}

export interface CommentNode extends BaseNode {
  kind: 'Comment';
  text: string;
  isBlock: boolean;
}

export interface VarDeclNode extends BaseNode {
  kind: 'VarDecl';
  type: TypeRef;
  declarators: Declarator[];
  /** static / extern / register / auto */
  storage?: string;
  isGlobal: boolean;
}

export interface ParamNode extends BaseNode {
  kind: 'Param';
  type: TypeRef;
  pointerDepth: number;
  /** 参数指针声明中每个 '*' 的源码区间 */
  pointerStars: SourceRange[];
  isReference: boolean;
  name?: IdentifierNode;
  arrayDims: (ExprNode | null)[];
}

export interface FuncDeclNode extends BaseNode {
  kind: 'FuncDecl';
  returnType: TypeRef;
  returnPointerDepth: number;
  /** 返回值指针 '*' 的源码区间，如 char *f() 中的 '*' */
  returnPointerStars: SourceRange[];
  name: IdentifierNode;
  params: ParamNode[];
  /** 函数体；仅有声明时为空 */
  body?: BlockNode;
  storage?: string;
  isDefinition: boolean;
}

export interface StructFieldNode extends BaseNode {
  kind: 'StructField';
  type: TypeRef;
  declarators: Declarator[];
}

export interface StructDeclNode extends BaseNode {
  kind: 'StructDecl';
  /** struct 标签名，如 struct LNode 中的 LNode */
  tag?: IdentifierNode;
  fields: StructFieldNode[];
  /** typedef struct {...} LNode; 中的别名 */
  typedefNames: IdentifierNode[];
  isUnion: boolean;
  /** 是否为 enum 定义（成员保存在 fields 中） */
  isEnum?: boolean;
}

export interface TypedefNode extends BaseNode {
  kind: 'Typedef';
  alias: IdentifierNode;
  target: TypeRef;
  pointerDepth: number;
  pointerStars: SourceRange[];
}

export interface BlockNode extends BaseNode {
  kind: 'Block';
  statements: StmtNode[];
}

export interface ExprStmtNode extends BaseNode {
  kind: 'ExprStmt';
  expression: ExprNode;
}

export interface EmptyStmtNode extends BaseNode {
  kind: 'EmptyStmt';
}

export interface IfNode extends BaseNode {
  kind: 'If';
  test: ExprNode;
  consequent: StmtNode;
  alternate?: StmtNode;
}

export interface ForNode extends BaseNode {
  kind: 'For';
  init?: VarDeclNode | ExprStmtNode | EmptyStmtNode;
  test?: ExprNode;
  update?: ExprNode;
  body: StmtNode;
}

export interface WhileNode extends BaseNode {
  kind: 'While';
  test: ExprNode;
  body: StmtNode;
}

export interface DoWhileNode extends BaseNode {
  kind: 'DoWhile';
  body: StmtNode;
  test: ExprNode;
}

export interface CaseClauseNode extends BaseNode {
  kind: 'CaseClause';
  /** 单值 case 或范围 case 的起始值；default 为空 */
  test?: ExprNode;
  isDefault: boolean;
  statements: StmtNode[];
}

export interface SwitchNode extends BaseNode {
  kind: 'Switch';
  discriminant: ExprNode;
  clauses: CaseClauseNode[];
}

export interface ReturnNode extends BaseNode {
  kind: 'Return';
  argument?: ExprNode;
}

export interface BreakNode extends BaseNode {
  kind: 'Break';
}

export interface ContinueNode extends BaseNode {
  kind: 'Continue';
}

/** 无法解析但已跳过并记录的语法结构（不静默丢弃） */
export interface UnknownNode extends BaseNode {
  kind: 'Unknown';
  raw: string;
  note: string;
}

export interface IdentifierNode extends BaseNode {
  kind: 'Identifier';
  name: string;
}

export type LiteralKind = 'int' | 'float' | 'char' | 'string' | 'bool' | 'null';

export interface LiteralNode extends BaseNode {
  kind: 'Literal';
  literalKind: LiteralKind;
  raw: string;
}

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '&&'
  | '||'
  | '&'
  | '|'
  | '^'
  | '<<'
  | '>>';

export interface BinaryNode extends BaseNode {
  kind: 'Binary';
  op: BinaryOp;
  left: ExprNode;
  right: ExprNode;
}

export type UnaryOp = '!' | '~' | '-' | '+' | '*' | '&' | '++' | '--';

/** 一元表达式（* 解引用、& 取地址、! 逻辑非等） */
export interface UnaryNode extends BaseNode {
  kind: 'Unary';
  op: UnaryOp;
  operand: ExprNode;
}

/** 自增 / 自减（前缀或后缀） */
export interface UpdateNode extends BaseNode {
  kind: 'Update';
  op: '++' | '--';
  prefix: boolean;
  operand: ExprNode;
}

export type AssignOp = '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '&=' | '|=' | '^=' | '<<=' | '>>=';

export interface AssignNode extends BaseNode {
  kind: 'Assign';
  op: AssignOp;
  target: ExprNode;
  value: ExprNode;
}

export interface CallNode extends BaseNode {
  kind: 'Call';
  callee: ExprNode;
  args: ExprNode[];
}

export interface IndexNode extends BaseNode {
  kind: 'Index';
  base: ExprNode;
  index: ExprNode;
}

/** 成员访问：p->next（arrow=true）或 s.next（arrow=false） */
export interface MemberNode extends BaseNode {
  kind: 'Member';
  object: ExprNode;
  member: IdentifierNode;
  arrow: boolean;
}

export interface ConditionalNode extends BaseNode {
  kind: 'Conditional';
  test: ExprNode;
  consequent: ExprNode;
  alternate: ExprNode;
}

export interface CastNode extends BaseNode {
  kind: 'Cast';
  type: TypeRef;
  pointerDepth: number;
  pointerStars: SourceRange[];
  expr: ExprNode;
}

export interface SizeofNode extends BaseNode {
  kind: 'Sizeof';
  operand?: ExprNode;
  typeName?: TypeRef;
  pointerDepth: number;
  pointerStars: SourceRange[];
  raw: string;
}

export interface CommaNode extends BaseNode {
  kind: 'Comma';
  items: ExprNode[];
}

export interface InitListNode extends BaseNode {
  kind: 'InitList';
  elements: ExprNode[];
}

export type ExprNode =
  | IdentifierNode
  | LiteralNode
  | BinaryNode
  | UnaryNode
  | UpdateNode
  | AssignNode
  | CallNode
  | IndexNode
  | MemberNode
  | ConditionalNode
  | CastNode
  | SizeofNode
  | CommaNode
  | InitListNode;

export type StmtNode =
  | BlockNode
  | VarDeclNode
  | ExprStmtNode
  | EmptyStmtNode
  | IfNode
  | ForNode
  | WhileNode
  | DoWhileNode
  | SwitchNode
  | ReturnNode
  | BreakNode
  | ContinueNode
  | UnknownNode;

export type TopLevelNode =
  | PreprocessorNode
  | FuncDeclNode
  | VarDeclNode
  | StructDeclNode
  | TypedefNode
  | CommentNode
  | UnknownNode;

export type CNode =
  | ProgramNode
  | PreprocessorNode
  | CommentNode
  | VarDeclNode
  | FuncDeclNode
  | ParamNode
  | StructDeclNode
  | StructFieldNode
  | TypedefNode
  | BlockNode
  | ExprStmtNode
  | EmptyStmtNode
  | IfNode
  | ForNode
  | WhileNode
  | DoWhileNode
  | SwitchNode
  | CaseClauseNode
  | ReturnNode
  | BreakNode
  | ContinueNode
  | UnknownNode
  | ExprNode;

/** 语法节点索引：id → 节点、父节点、按源码位置排序的节点列表，以及类型索引 */
export interface CNodeIndex {
  byId: Map<NodeId, CNode>;
  parent: Map<NodeId, CNode | undefined>;
  /** 所有节点（不含 Program），按 start 升序、end 降序排列 */
  ordered: CNode[];
  /** 结构体/枚举：标签名或 typedef 别名 → 定义节点 */
  structs: Map<string, StructDeclNode>;
  /** typedef 别名 → 定义节点 */
  typedefs: Map<string, TypedefNode>;
  /** 函数名 → 所有声明/定义（C 中同名函数只应有一个定义） */
  functions: Map<string, FuncDeclNode[]>;
}

/** 获取某个节点的直接子节点（保持源码顺序） */
export function getChildren(node: CNode): CNode[] {
  switch (node.kind) {
    case 'Program':
      return [...node.items, ...node.comments].sort((a, b) => a.range.start - b.range.start);
    case 'VarDecl':
      return node.declarators.flatMap(declaratorChildren);
    case 'FuncDecl':
      return [
        node.name,
        ...node.params,
        ...(node.body ? [node.body] : []),
      ];
    case 'Param':
      return node.name ? [node.name] : [];
    case 'StructDecl':
      return [...(node.tag ? [node.tag] : []), ...node.fields, ...node.typedefNames];
    case 'StructField':
      return node.declarators.flatMap(declaratorChildren);
    case 'Typedef':
      return [node.alias];
    case 'Block':
      return node.statements;
    case 'ExprStmt':
      return [node.expression];
    case 'If':
      return [node.test, node.consequent, ...(node.alternate ? [node.alternate] : [])];
    case 'For':
      return [
        ...(node.init ? [node.init] : []),
        ...(node.test ? [node.test] : []),
        ...(node.update ? [node.update] : []),
        node.body,
      ];
    case 'While':
      return [node.test, node.body];
    case 'DoWhile':
      return [node.body, node.test];
    case 'Switch':
      return [node.discriminant, ...node.clauses];
    case 'CaseClause':
      return [...(node.test ? [node.test] : []), ...node.statements];
    case 'Return':
      return node.argument ? [node.argument] : [];
    case 'Binary':
      return [node.left, node.right];
    case 'Unary':
      return [node.operand];
    case 'Update':
      return [node.operand];
    case 'Assign':
      return [node.target, node.value];
    case 'Call':
      return [node.callee, ...node.args];
    case 'Index':
      return [node.base, node.index];
    case 'Member':
      return [node.object, node.member];
    case 'Conditional':
      return [node.test, node.consequent, node.alternate];
    case 'Cast':
      return [node.expr];
    case 'Sizeof':
      return node.operand ? [node.operand] : [];
    case 'Comma':
      return node.items;
    case 'InitList':
      return node.elements;
    default:
      return [];
  }
}

function declaratorChildren(decl: Declarator): CNode[] {
  return [
    decl.name,
    ...decl.arrayDims.filter((dim): dim is ExprNode => Boolean(dim)),
    ...(decl.initializer ? [decl.initializer] : []),
  ];
}

/** 深度优先遍历 AST */
export function walkAst(root: CNode, visit: (node: CNode, parent?: CNode) => void): void {
  const visitNode = (node: CNode, parent?: CNode) => {
    visit(node, parent);
    for (const child of getChildren(node)) visitNode(child, node);
  };
  visitNode(root);
}

/** 收集 AST 中所有表达式节点 */
export function collectExpressions(root: CNode): ExprNode[] {
  const result: ExprNode[] = [];
  walkAst(root, (node) => {
    if (isExpression(node)) result.push(node);
  });
  return result;
}

const EXPRESSION_KINDS = new Set([
  'Identifier',
  'Literal',
  'Binary',
  'Unary',
  'Update',
  'Assign',
  'Call',
  'Index',
  'Member',
  'Conditional',
  'Cast',
  'Sizeof',
  'Comma',
  'InitList',
]);

export function isExpression(node: CNode): node is ExprNode {
  return EXPRESSION_KINDS.has(node.kind);
}

/** 建立节点索引，供点击定位与解释器快速查找 */
export function buildIndex(program: ProgramNode): CNodeIndex {
  const byId = new Map<NodeId, CNode>();
  const parent = new Map<NodeId, CNode | undefined>();
  const ordered: CNode[] = [];
  const structs = new Map<string, StructDeclNode>();
  const typedefs = new Map<string, TypedefNode>();
  const functions = new Map<string, FuncDeclNode[]>();

  walkAst(program, (node, p) => {
    byId.set(node.id, node);
    parent.set(node.id, p);
    if (node.kind !== 'Program') ordered.push(node);
  });

  // 收集类型与函数索引，供符号解析、成员访问释义与执行器使用
  for (const node of ordered) {
    if (node.kind === 'StructDecl') {
      if (node.tag) structs.set(node.tag.name, node);
      for (const alias of node.typedefNames) structs.set(alias.name, node);
    } else if (node.kind === 'Typedef') {
      typedefs.set(node.alias.name, node);
      // typedef struct ... Alias; 这种写法让别名指向结构体定义
      if (node.target.isStruct && node.target.structTag) {
        const target = structs.get(node.target.structTag);
        if (target) structs.set(node.alias.name, target);
      }
    } else if (node.kind === 'FuncDecl') {
      const list = functions.get(node.name.name) ?? [];
      list.push(node);
      functions.set(node.name.name, list);
    }
  }

  ordered.sort((a, b) => {
    if (a.range.start !== b.range.start) return a.range.start - b.range.start;
    return b.range.end - a.range.end;
  });

  return { byId, parent, ordered, structs, typedefs, functions };
}

/**
 * 找到包含指定偏移量的最深层节点。
 * 子节点使用右开区间判断：当光标恰好落在某个名字的末尾（例如 `arr|[...]`）时，
 * 会优先返回外层结构（如数组下标表达式），而不是刚刚结束的标识符。
 */
export function findDeepestNodeAt(
  root: CNode,
  offset: number,
  accept: (node: CNode) => boolean = () => true,
): CNode | undefined {
  let best: CNode | undefined;
  const search = (node: CNode): void => {
    if (offset < node.range.start || offset > node.range.end) return;
    if (accept(node)) best = node;
    // 子节点按源码顺序排列；用倒序保证找到更深、更靠后的候选
    const children = getChildren(node);
    for (const child of children) {
      if (offset >= child.range.start && offset < child.range.end) search(child);
    }
  };
  search(root);
  return best;
}

/** 根据 id 取节点 */
export function getNode(index: CNodeIndex, id: NodeId | undefined): CNode | undefined {
  return id ? index.byId.get(id) : undefined;
}

/** 取节点所在的最近语句节点（用于执行与释义上下文） */
export function findAncestor(
  index: CNodeIndex,
  node: CNode,
  predicate: (candidate: CNode) => boolean,
): CNode | undefined {
  let current: CNode | undefined = node;
  while (current) {
    if (predicate(current)) return current;
    current = index.parent.get(current.id);
  }
  return undefined;
}

/** 判断节点是否是语句（用于解释器与结构树） */
export function isStatement(node: CNode): boolean {
  switch (node.kind) {
    case 'Block':
    case 'ExprStmt':
    case 'EmptyStmt':
    case 'If':
    case 'For':
    case 'While':
    case 'DoWhile':
    case 'Switch':
    case 'Return':
    case 'Break':
    case 'Continue':
    case 'Unknown':
      return true;
    default:
      return false;
  }
}

/** 便捷：从 SourceFile 和 AST 生成节点对应的源码文本 */
export function nodeText(source: SourceFile, node: Pick<CNode, 'range'>): string {
  return source.slice(node.range);
}
