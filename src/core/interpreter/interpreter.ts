/**
 * CodeLens C 子集逐行执行解释器
 * ==================================================================
 * 设计目标：
 * 1. 真实执行：所有快照都来自对 AST 的逐语句解释执行，不针对示例硬编码；
 * 2. 可解释：每一步记录行号、中文说明、作用域、堆对象、调用栈与输出；
 * 3. 诚实报错：遇到不支持的能力（scanf、文件 IO、goto、函数指针、C++ 等）
 *    或运行期错误（除零、空指针、越界、未初始化、步数超限）时明确中止并报告；
 * 4. 纯前端：不依赖浏览器 API / Node API，纯 TypeScript，可重复执行。
 *
 * 内存模型（面向初学者，地址使用可读的十六进制）：
 * - 全局/静态区：0x1000 起
 * - 栈区：0x4000 起（函数参数与局部变量）
 * - 堆区：0x9000 起（malloc 与字符串字面量）
 * 变量、数组元素、结构体成员都拥有独立地址，指针变量保存目标地址，
 * 因此 UI 可以据此绘制指针箭头、链表节点与悬空指针引用。
 */
import {
  buildIndex,
  type CNodeIndex,
  type Declarator,
  type ExprNode,
  type FuncDeclNode,
  type ParamNode,
  type ProgramNode,
  type StmtNode,
  type StructDeclNode,
  type StructFieldNode,
  type TypeRef,
  type VarDeclNode,
} from '../ast';
import type { SourceFile, SourceRange } from '../source';
import type {
  CallFrameView,
  ExecutionErrorInfo,
  ExecutionResult,
  ExecutionSnapshot,
  HeapObjectView,
  ScopeView,
  ValueView,
  VariableView,
} from './types';

/** 执行引擎标识（写入 ExecutionResult.engine，便于 UI 展示能力来源） */
export const ENGINE = 'CodeLens C 子集解释器 v1';

/** 执行器可配置项（全部可选，默认值适合课堂演示） */
export interface ExecuteOptions {
  /** 最大执行步数（快照数量上限），默认 3000；超出视为疑似死循环 */
  maxSteps?: number;
  /** 最大函数调用深度，默认 100；超出报「递归过深」 */
  maxCallDepth?: number;
  /** 堆内存上限（字节），默认 1 MiB；malloc 超出时返回 NULL 并给出警告 */
  maxHeapBytes?: number;
}

/** 默认步数上限：超过即视为疑似死循环 */
const DEFAULT_MAX_STEPS = 3000;
const DEFAULT_MAX_CALL_DEPTH = 100;
const DEFAULT_MAX_HEAP_BYTES = 1024 * 1024;
/** 全局/静态区起始地址 */
const GLOBAL_BASE = 0x1000;
/** 栈区起始地址（函数参数、局部变量） */
const STACK_BASE = 0x4000;
/** 堆区起始地址（malloc / 字符串字面量） */
const HEAP_BASE = 0x9000;

// ==================================================================
// 错误与内部信号
// ==================================================================

/** 解释执行失败：区分运行期错误、不支持能力、步数/深度限制 */
class ExecutionFailure extends Error {
  readonly kind: ExecutionErrorInfo['kind'];
  readonly hint?: string;
  readonly line?: number;
  readonly range?: SourceRange;

  constructor(
    kind: ExecutionErrorInfo['kind'],
    message: string,
    options: { hint?: string; line?: number; range?: SourceRange } = {},
  ) {
    super(message);
    this.name = 'ExecutionFailure';
    this.kind = kind;
    this.hint = options.hint;
    this.line = options.line;
    this.range = options.range;
  }
}

/** return 语句的内部信号：携带返回值与行号，向上抛出到函数调用处 */
class ReturnSignal {
  constructor(readonly value: RValue | undefined) {}
}

/** break 信号：由最近的循环或 switch 捕获 */
class BreakSignal {}

/** continue 信号：由最近的循环捕获（switch 不拦截） */
class ContinueSignal {}

// ==================================================================
// C 类型模型
// ==================================================================

type CTypeKind =
  | 'int'
  | 'char'
  | 'float'
  | 'double'
  | 'void'
  | 'pointer'
  | 'array'
  | 'struct'
  | 'union'
  | 'enum';

/** 结构体成员布局：偏移量用于把结构体字段映射到连续地址空间 */
interface StructFieldLayout {
  name: string;
  type: CType;
  offset: number;
}

interface CType {
  kind: CTypeKind;
  /** 展示用类型名，如 "int" / "char *" / "struct LNode" */
  name: string;
  /** 字节大小（用于 sizeof 与指针算术） */
  size: number;
  /** 对齐字节数 */
  align: number;
  /** 指针/数组的元素类型 */
  base?: CType;
  /** 数组长度 */
  count?: number;
  /** struct / union / enum 标签名 */
  tag?: string;
  /** 结构体成员布局（首次使用时惰性计算） */
  fields?: StructFieldLayout[];
  layoutReady?: boolean;
  layoutComputing?: boolean;
  isUnsigned?: boolean;
}

const TYPE_INT: CType = { kind: 'int', name: 'int', size: 4, align: 4 };
const TYPE_UINT: CType = { kind: 'int', name: 'unsigned int', size: 4, align: 4, isUnsigned: true };
const TYPE_CHAR: CType = { kind: 'char', name: 'char', size: 1, align: 1 };
const TYPE_FLOAT: CType = { kind: 'float', name: 'float', size: 4, align: 4 };
const TYPE_DOUBLE: CType = { kind: 'double', name: 'double', size: 8, align: 8 };
const TYPE_VOID: CType = { kind: 'void', name: 'void', size: 0, align: 1 };
const TYPE_LONG: CType = { kind: 'int', name: 'long', size: 8, align: 8 };
const TYPE_ULONG: CType = { kind: 'int', name: 'unsigned long', size: 8, align: 8, isUnsigned: true };

function makePointer(base: CType): CType {
  return {
    kind: 'pointer',
    name: `${typeText(base)} *`,
    size: 8,
    align: 8,
    base,
  };
}

function makeArray(base: CType, count: number): CType {
  return {
    kind: 'array',
    name: `${typeText(base)}[${count}]`,
    size: base.size * count,
    align: base.align,
    base,
    count,
  };
}

/** 生成类型展示文本；数组/多级指针按 C 习惯书写 */
function typeText(type: CType): string {
  if (type.kind === 'array') {
    const dims: number[] = [];
    let current: CType = type;
    while (current.kind === 'array' && current.base) {
      dims.push(current.count ?? 0);
      current = current.base;
    }
    return `${typeText(current)}${dims.map((count) => `[${count}]`).join('')}`;
  }
  if (type.kind === 'pointer') {
    let depth = 0;
    let current: CType = type;
    while (current.kind === 'pointer' && current.base) {
      depth += 1;
      current = current.base;
    }
    return `${typeText(current)} ${'*'.repeat(depth)}`;
  }
  return type.name;
}

function isIntegerType(type: CType): boolean {
  return type.kind === 'int' || type.kind === 'char' || type.kind === 'enum';
}

function isFloatType(type: CType): boolean {
  return type.kind === 'float' || type.kind === 'double';
}

function isAggregateType(type: CType): boolean {
  return type.kind === 'array' || type.kind === 'struct' || type.kind === 'union';
}

// ==================================================================
// 运行期值 / 内存单元
// ==================================================================

type ScalarValue =
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'pointer'; target: number | null; pointee: CType; origin?: Cell };

/** 表达式求值结果：标量，或结构体（结构体按值使用时以整体单元格表示，便于复制） */
type RValue = ScalarValue | { kind: 'struct'; cell: Cell };

/** 一个可寻址的内存单元（标量、数组、结构体均单独占一个单元格） */
interface Cell {
  address: number;
  type: CType;
  label: string;
  cellKind: 'variable' | 'field' | 'element' | 'heap' | 'temporary';
  declaredLine?: number;
  /** 字符串字面量等只读内存 */
  readOnly?: boolean;
  /** 标量是否已赋值；聚合单元自身不使用该标记，成员各自维护 */
  initialized: boolean;
  scalar?: ScalarValue;
  /** 结构体成员 */
  fields?: Cell[];
  /** 数组元素 */
  elements?: Cell[];
  /** 所属堆对象 id（用于 free 时整体失效） */
  heapId?: number;
}

/** 左值：可被赋值的内存单元 */
interface LValue {
  cell: Cell;
}

/** 作用域：全局、函数、代码块 */
interface Scope {
  id: string;
  name: string;
  kind: 'global' | 'function' | 'block';
  variables: Map<string, Cell>;
  /** 声明顺序，保证 UI 中变量顺序与源码一致 */
  order: string[];
}

/** 函数调用帧 */
interface Frame {
  functionName: string;
  scope: Scope;
  /** 当前暂停的行号（用于 callStack 展示） */
  currentLine: number;
  returnType: CType;
}

/** 堆对象：malloc 分配的内存或字符串字面量 */
interface HeapObject {
  id: number;
  address: number;
  size: number;
  kind: 'struct' | 'array' | 'memory' | 'string';
  label: string;
  typeText: string;
  storage: Cell;
  structType?: CType;
  freed: boolean;
}

/** #define 常量：只支持字面量形式，复杂宏明确报不支持 */
type MacroConstant =
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'char'; value: number }
  | { kind: 'string'; raw: string }
  | { kind: 'unsupported'; reason: string; line: number };

interface MacroDefinition {
  name: string;
  constant: MacroConstant;
  line: number;
}

/** 循环/switch 控制栈，用于生成准确的中文 break/continue 说明 */
interface ControlContext {
  kind: 'loop' | 'switch';
  label: string;
}

// ==================================================================
// 通用小工具
// ==================================================================

/** 地址格式化为十六进制字符串，如 0x4000 */
function formatAddress(address: number): string {
  return `0x${address.toString(16)}`;
}

function alignUp(value: number, align: number): number {
  const unit = Math.max(align, 1);
  return Math.ceil(value / unit) * unit;
}

/** 浮点/整数统一展示，去掉浮点误差（0.1+0.2 显示为 0.3） */
function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  if (Number.isInteger(value)) return String(value);
  return String(Number.parseFloat(value.toPrecision(12)));
}

/** 字符展示：'A' / '\n' / '\0' */
function charText(code: number): string {
  const ch = String.fromCharCode(code & 0xffff);
  if (code === 0) return "'\\0'";
  if (code === 10) return "'\\n'";
  if (code === 9) return "'\\t'";
  if (code === 13) return "'\\r'";
  if (code < 32) return `'\\x${code.toString(16)}'`;
  return `'${ch}'`;
}

/** 描述输出文本：把换行/制表符转义后再放进中文说明 */
function quoteText(text: string): string {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** 解析 C 整数字面量（支持十进制、0x 十六进制、0 开头八进制、0b 二进制与后缀） */
function parseIntegerLiteral(raw: string): number {
  const text = raw.replace(/[uUlL]+$/, '');
  if (/^0[xX][0-9a-fA-F]+$/.test(text)) return Number.parseInt(text.slice(2), 16);
  if (/^0[bB][01]+$/.test(text)) return Number.parseInt(text.slice(2), 2);
  if (/^0[0-7]+$/.test(text)) return Number.parseInt(text.slice(1), 8);
  return Number.parseInt(text, 10);
}

/** 解析一个转义序列（raw[start] 是反斜杠后的字符），返回字符与下一个位置 */
function decodeEscape(raw: string, start: number): [string, number] {
  const ch = raw[start];
  switch (ch) {
    case undefined:
      return ['', start];
    case 'n':
      return ['\n', start + 1];
    case 't':
      return ['\t', start + 1];
    case 'r':
      return ['\r', start + 1];
    case '0':
      return ['\0', start + 1];
    case 'a':
      return ['\x07', start + 1];
    case 'b':
      return ['\b', start + 1];
    case 'f':
      return ['\f', start + 1];
    case 'v':
      return ['\v', start + 1];
    case '\\':
      return ['\\', start + 1];
    case '"':
      return ['"', start + 1];
    case "'":
      return ["'", start + 1];
    case 'x': {
      let index = start + 1;
      let hex = '';
      while (index < raw.length && hex.length < 2 && /[0-9a-fA-F]/.test(raw[index])) {
        hex += raw[index];
        index += 1;
      }
      return [hex ? String.fromCharCode(Number.parseInt(hex, 16)) : 'x', index];
    }
    default:
      if (/[0-7]/.test(ch)) {
        let index = start;
        let octal = '';
        while (index < raw.length && octal.length < 3 && /[0-7]/.test(raw[index])) {
          octal += raw[index];
          index += 1;
        }
        return [String.fromCharCode(Number.parseInt(octal, 8)), index];
      }
      // 未知转义按原字符处理（C 标准中为实现定义行为）
      return [ch, start + 1];
  }
}

/** 解码 C 字符串字面量（支持相邻字符串拼接），返回真实文本（不含引号） */
function decodeCStringLiteral(raw: string): string {
  const chunks: string[] = [];
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== '"') {
      index += 1;
      continue;
    }
    index += 1;
    while (index < raw.length && raw[index] !== '"') {
      if (raw[index] === '\\') {
        const [text, next] = decodeEscape(raw, index + 1);
        chunks.push(text);
        index = next;
      } else {
        chunks.push(raw[index]);
        index += 1;
      }
    }
    index += 1;
  }
  return chunks.join('');
}

/** 解码字符字面量，返回字符编码 */
function decodeCharLiteral(raw: string): number {
  const start = raw.indexOf("'");
  const end = raw.lastIndexOf("'");
  const inner = start >= 0 && end > start ? raw.slice(start + 1, end) : raw;
  if (inner.startsWith('\\')) {
    const [text] = decodeEscape(inner, 1);
    return text.length ? text.charCodeAt(0) : 0;
  }
  return inner.length ? inner.charCodeAt(0) : 0;
}

/** 把 C 字符串文本写成 UTF-16 码元数组（解释器内部用码元模拟 char） */
function stringToCharCodes(text: string): number[] {
  const codes: number[] = [];
  for (let index = 0; index < text.length; index += 1) codes.push(text.charCodeAt(index));
  return codes;
}

/** 从字符码元数组还原字符串，遇到 NUL 停止 */
function charCodesToString(codes: number[]): string {
  let text = '';
  for (const code of codes) {
    if (code === 0) break;
    text += String.fromCharCode(code & 0xffff);
  }
  return text;
}

// ==================================================================
// 解释器主体
// ==================================================================

class CInterpreter {
  private readonly program: ProgramNode;
  private readonly source: SourceFile;
  private readonly index: CNodeIndex;
  private readonly options: Required<ExecuteOptions>;

  private readonly snapshots: ExecutionSnapshot[] = [];
  private readonly warnings: string[] = [];

  // ---- 作用域与调用栈 ----
  private readonly globalScope: Scope;
  private readonly scopeStack: Scope[] = [];
  private readonly frames: Frame[] = [];
  private scopeCounter = 0;

  // ---- 地址空间 ----
  private readonly cells = new Map<number, Cell>();
  /** 聚合单元（数组/结构体）可能共享同一基地址（如结构体首成员），因此用列表保存 */
  private readonly aggregates = new Map<number, Cell[]>();
  private readonly heapObjects: HeapObject[] = [];
  private readonly freedRanges: { start: number; end: number; label: string }[] = [];
  private heapCounter = 0;
  private heapBytes = 0;
  private nextGlobal = GLOBAL_BASE;
  private nextStack = STACK_BASE;
  private nextHeap = HEAP_BASE;

  // ---- 执行状态 ----
  private stdout = '';
  private stepCount = 0;
  private lastLine = 1;
  /** 上一步的变量值签名：address → signature，用于计算 ValueView.changed */
  private lastSignatures = new Map<number, string>();
  private readonly controlStack: ControlContext[] = [];
  private mainFn: FuncDeclNode | null = null;

  // ---- 类型/函数/宏注册表 ----
  private readonly structNodes = new Map<string, StructDeclNode>();
  private readonly structTypeCache = new Map<string, CType>();
  private readonly structNodeByType = new Map<CType, StructDeclNode>();
  private readonly typedefResolving = new Set<string>();
  private readonly functions = new Map<string, FuncDeclNode>();
  private readonly declaredFunctions = new Map<string, FuncDeclNode>();
  private readonly enumConstants = new Map<string, number>();
  private readonly macros = new Map<string, MacroDefinition>();
  private readonly unsupportedMacros = new Map<string, { reason: string; line: number }>();
  private readonly unsupportedDirectives: { directive: string; line: number; range: SourceRange }[] = [];

  constructor(program: ProgramNode, source: SourceFile, options: ExecuteOptions = {}) {
    this.program = program;
    this.source = source;
    this.index = buildIndex(program);
    this.options = {
      maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
      maxCallDepth: options.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH,
      maxHeapBytes: options.maxHeapBytes ?? DEFAULT_MAX_HEAP_BYTES,
    };
    this.globalScope = {
      id: 'scope-global',
      name: '全局作用域',
      kind: 'global',
      variables: new Map(),
      order: [],
    };
    this.scopeStack.push(this.globalScope);

    this.collectDeclarations();
    this.collectEnumConstants();
    this.collectPreprocessor();
  }

  // ----------------------------------------------------------------
  // 注册表收集
  // ----------------------------------------------------------------

  /** 收集结构体/typedef/函数定义，供类型解析与函数调用使用 */
  private collectDeclarations(): void {
    for (const item of this.program.items) {
      if (item.kind === 'StructDecl') {
        if (item.tag) this.structNodes.set(item.tag.name, item);
        for (const alias of item.typedefNames) this.structNodes.set(alias.name, item);
      }
    }
    for (const [name, declarations] of this.index.functions) {
      const definition = declarations.find((declaration) => declaration.isDefinition && declaration.body);
      if (definition) this.functions.set(name, definition);
      const firstDeclaration = declarations[0];
      if (firstDeclaration) this.declaredFunctions.set(name, firstDeclaration);
    }
  }

  /** 收集 enum 常量（enum 成员在表达式中按整数常量使用） */
  private collectEnumConstants(): void {
    for (const item of this.program.items) {
      if (item.kind !== 'StructDecl' || !item.isEnum) continue;
      let nextValue = 0;
      for (const field of item.fields) {
        const declarator = field.declarators[0];
        if (!declarator) continue;
        if (declarator.initializer) {
          try {
            nextValue = this.evalConstInt(declarator.initializer);
          } catch {
            nextValue = 0;
          }
        }
        this.enumConstants.set(declarator.name.name, nextValue);
        nextValue += 1;
      }
    }
  }

  /** 解析 #define；只支持对象式字面量宏，复杂宏在用到时明确报不支持 */
  private collectPreprocessor(): void {
    for (const item of this.program.items) {
      if (item.kind !== 'Preprocessor') continue;
      const directive = item.directive.toLowerCase();
      const line = item.range.startLine;
      if (directive === 'include') continue;
      if (directive === 'define') {
        this.parseDefine(item.raw, line);
        continue;
      }
      if (directive === 'undef') {
        const match = /^#\s*undef\s+([A-Za-z_]\w*)/.exec(item.raw);
        if (match) this.macros.delete(match[1]);
        continue;
      }
      if (['if', 'ifdef', 'ifndef', 'elif', 'else', 'endif', 'error'].includes(directive)) {
        this.unsupportedDirectives.push({ directive, line, range: item.range });
      }
      // #pragma / #line / #warning 等指令不影响执行，直接忽略
    }
  }

  private parseDefine(raw: string, line: number): void {
    const match = /^#\s*define\s+([A-Za-z_]\w*)(\s*)([\s\S]*)$/.exec(raw);
    if (!match) return;
    const name = match[1];
    const whitespace = match[2];
    const rest = match[3].trim();
    // C 规则：#define NAME(...) 中名字后紧跟 '(' 表示函数式宏
    if (whitespace.length === 0 && rest.startsWith('(')) {
      this.unsupportedMacros.set(name, {
        reason: '带参数的宏（函数式宏）需要展开，暂不支持',
        line,
      });
      return;
    }
    this.macros.set(name, { name, line, constant: this.parseMacroConstant(rest, line) });
  }

  private parseMacroConstant(text: string, line: number): MacroConstant {
    if (!text) return { kind: 'unsupported', reason: '该宏没有定义值', line };
    let value = text;
    // 去掉成对的圆括号，例如 #define MAX (10)
    while (value.startsWith('(') && value.endsWith(')')) {
      const inner = value.slice(1, -1).trim();
      if (!inner) break;
      value = inner;
    }
    if (/^[+-]?(0[xX][0-9a-fA-F]+|0[bB][01]+|0[0-7]+|\d+)[uUlL]*$/.test(value)) {
      const negative = value.startsWith('-');
      const unsigned = value.startsWith('+') || negative ? value.slice(1) : value;
      return { kind: 'int', value: (negative ? -1 : 1) * parseIntegerLiteral(unsigned) };
    }
    if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?[fFlL]?$/.test(value) && /[.eE]/.test(value)) {
      return { kind: 'float', value: Number.parseFloat(value.replace(/[fFlL]$/, '')) };
    }
    if (/^'.*'$/.test(value)) return { kind: 'char', value: decodeCharLiteral(value) };
    if (value.startsWith('"')) return { kind: 'string', raw: value };
    return {
      kind: 'unsupported',
      reason: '只支持整数、浮点数、字符、字符串字面量形式的宏；复杂宏表达式暂不支持',
      line,
    };
  }

  // ----------------------------------------------------------------
  // 类型解析 / 结构体布局
  // ----------------------------------------------------------------

  private structTypeFor(node: StructDeclNode): CType {
    const cached = this.structTypeCache.get(node.id);
    if (cached) return cached;
    const tagName = node.tag?.name ?? node.typedefNames[0]?.name ?? `匿名结构体${node.id}`;
    const keyword = node.isUnion ? 'union' : node.isEnum ? 'enum' : 'struct';
    const type: CType = {
      kind: node.isUnion ? 'union' : node.isEnum ? 'enum' : 'struct',
      name: `${keyword} ${tagName}`,
      size: node.isEnum ? 4 : 0,
      align: node.isEnum ? 4 : 1,
      tag: tagName,
      fields: [],
      layoutReady: node.isEnum,
    };
    this.structTypeCache.set(node.id, type);
    this.structNodeByType.set(type, node);
    return type;
  }

  private ensureStructLayout(type: CType): void {
    if (type.layoutReady || type.kind === 'enum') return;
    const node = this.structNodeByType.get(type);
    if (!node) {
      throw new ExecutionFailure('unsupported', `无法确定类型 ${typeText(type)} 的成员布局。`);
    }
    if (type.layoutComputing) {
      throw new ExecutionFailure(
        'unsupported',
        `结构体 ${type.name} 按值包含自身，内存布局无法确定。`,
        { hint: '如果要在结构体里引用自身，请使用指针，例如 struct Node *next;' },
      );
    }
    type.layoutComputing = true;
    const fields: StructFieldLayout[] = [];
    let offset = 0;
    let maxAlign = 1;
    try {
      for (const fieldNode of node.fields) {
        for (const declarator of fieldNode.declarators) {
          const fieldType = this.resolveFieldType(fieldNode, declarator);
          if (fieldType === type && fieldType.kind !== 'pointer') {
            throw new ExecutionFailure(
              'unsupported',
              `结构体 ${type.name} 的成员 "${declarator.name.name}" 不能按值包含自身。`,
              { hint: '请改用指针成员，例如 struct Node *next;' },
            );
          }
          maxAlign = Math.max(maxAlign, fieldType.align);
          let fieldOffset = offset;
          if (type.kind === 'union') {
            fieldOffset = 0;
            type.size = Math.max(type.size, fieldType.size);
          } else {
            fieldOffset = alignUp(offset, fieldType.align);
          }
          fields.push({ name: declarator.name.name, type: fieldType, offset: fieldOffset });
          if (type.kind !== 'union') offset = fieldOffset + fieldType.size;
        }
      }
      type.fields = fields;
      type.align = maxAlign;
      if (type.kind !== 'union') type.size = alignUp(offset, maxAlign);
      type.layoutReady = true;
    } finally {
      type.layoutComputing = false;
    }
  }

  /** 结构体成员的数组维度需要编译期常量 */
  private resolveFieldType(fieldNode: StructFieldNode, declarator: Declarator): CType {
    let dims: number[] | undefined;
    if (declarator.arrayDims.length > 0) {
      dims = declarator.arrayDims.map((dim) => {
        if (!dim) {
          throw new ExecutionFailure(
            'unsupported',
            `结构体成员 "${declarator.name.name}" 的数组长度不能省略。`,
            { line: fieldNode.range.startLine, range: fieldNode.range, hint: '请写明明确长度，例如 int data[8];' },
          );
        }
        return this.evalConstInt(dim);
      });
    }
    return this.resolveTypeRef(fieldNode.type, declarator.pointerDepth, dims);
  }

  private resolveTypeRef(typeRef: TypeRef, pointerDepth: number, dims?: number[]): CType {
    let type = this.resolveBaseType(typeRef);
    for (let index = 0; index < pointerDepth; index += 1) type = makePointer(type);
    if (dims && dims.length > 0) {
      for (let index = dims.length - 1; index >= 0; index -= 1) {
        type = makeArray(type, dims[index]);
      }
    }
    return type;
  }

  private resolveBaseType(typeRef: TypeRef): CType {
    const rawName = typeRef.name.trim();
    // struct / union / enum 标签
    if (typeRef.isStruct || /^(struct|union)\s/.test(rawName)) {
      const tag = typeRef.structTag ?? rawName.replace(/^(struct|union)\s+/, '').trim();
      return this.resolveTaggedType(tag, rawName);
    }
    if (/^enum\s/.test(rawName)) {
      const tag = typeRef.structTag ?? rawName.replace(/^enum\s+/, '').trim();
      return this.resolveTaggedType(tag, rawName);
    }
    // typedef 别名或已定义的 struct/union/enum 名称
    const node = this.index.structs.get(rawName);
    if (node) return this.structTypeFor(node);
    const typedef = this.index.typedefs.get(rawName);
    if (typedef) {
      if (this.typedefResolving.has(rawName)) {
        throw new ExecutionFailure('unsupported', `typedef 类型 "${rawName}" 存在循环定义，无法解析。`);
      }
      this.typedefResolving.add(rawName);
      try {
        let type = this.resolveBaseType(typedef.target);
        for (let index = 0; index < typedef.pointerDepth; index += 1) type = makePointer(type);
        return type;
      } finally {
        this.typedefResolving.delete(rawName);
      }
    }
    const basic = this.resolveBasicType(rawName, typeRef.isUnsigned);
    if (basic) return basic;
    throw new ExecutionFailure(
      'unsupported',
      `暂不支持类型 "${typeRef.raw || rawName}"。`,
      { hint: '目前支持 int / char / float / double / void 及其指针、数组，以及已定义的 struct/typedef 类型。', line: typeRef.range.startLine, range: typeRef.range },
    );
  }

  private resolveTaggedType(tag: string, rawName: string): CType {
    const node = this.index.structs.get(tag);
    if (!node) {
      throw new ExecutionFailure(
        'unsupported',
        `找不到类型 "${rawName}" 的定义。`,
        { hint: '请先定义结构体（如 struct LNode { ... };）或确认 typedef 拼写。' },
      );
    }
    return this.structTypeFor(node);
  }

  private resolveBasicType(rawName: string, isUnsigned: boolean): CType | null {
    const normalized = rawName.replace(/\s+/g, ' ').trim();
    const unsigned = isUnsigned || /\bunsigned\b/.test(normalized);
    const tokens = normalized.split(' ').filter((token) => token !== 'signed' && token !== 'const' && token !== 'volatile');
    const has = (keyword: string) => tokens.includes(keyword);
    if (tokens.length === 1 && tokens[0] === 'void') return TYPE_VOID;
    if (has('char')) return unsigned ? { kind: 'char', name: 'unsigned char', size: 1, align: 1, isUnsigned: true } : TYPE_CHAR;
    if (has('float')) return TYPE_FLOAT;
    if (has('double')) return TYPE_DOUBLE;
    if (has('bool') || has('_Bool')) return { kind: 'int', name: 'bool', size: 1, align: 1 };
    if (has('long')) return unsigned ? TYPE_ULONG : TYPE_LONG;
    if (has('short')) return unsigned ? { kind: 'int', name: 'unsigned short', size: 2, align: 2, isUnsigned: true } : { kind: 'int', name: 'short', size: 2, align: 2 };
    if (has('int')) return unsigned ? TYPE_UINT : TYPE_INT;
    return null;
  }

  /** 计算编译期整数常量（数组长度、enum、#define 等） */
  private evalConstInt(expr: ExprNode): number {
    switch (expr.kind) {
      case 'Literal': {
        if (expr.literalKind === 'int') return parseIntegerLiteral(expr.raw);
        if (expr.literalKind === 'char') return decodeCharLiteral(expr.raw);
        if (expr.literalKind === 'bool') return expr.raw === 'true' ? 1 : 0;
        if (expr.literalKind === 'null') return 0;
        throw new ExecutionFailure('unsupported', `数组长度 / 常量表达式需要整数，但这里出现了浮点数 ${expr.raw}。`, {
          line: expr.range.startLine,
          range: expr.range,
        });
      }
      case 'Identifier': {
        const macro = this.macros.get(expr.name);
        if (macro) {
          if (macro.constant.kind === 'int' || macro.constant.kind === 'char') return macro.constant.value;
          throw new ExecutionFailure('unsupported', `宏 ${expr.name} 不是整数常量，不能用于常量表达式。`, {
            line: expr.range.startLine,
            range: expr.range,
          });
        }
        const enumValue = this.enumConstants.get(expr.name);
        if (enumValue !== undefined) return enumValue;
        if (expr.name === 'NULL') return 0;
        throw new ExecutionFailure(
          'unsupported',
          `常量表达式中的 "${expr.name}" 不是可计算的常量。`,
          { hint: '数组长度等常量位置目前只支持字面量、#define 整数常量与 enum 常量。', line: expr.range.startLine, range: expr.range },
        );
      }
      case 'Unary': {
        const value = this.evalConstInt(expr.operand);
        if (expr.op === '-') return -value;
        if (expr.op === '+') return value;
        if (expr.op === '~') return ~value;
        if (expr.op === '!') return value === 0 ? 1 : 0;
        throw new ExecutionFailure('unsupported', `常量表达式不支持一元运算符 ${expr.op}。`, {
          line: expr.range.startLine,
          range: expr.range,
        });
      }
      case 'Binary': {
        if (expr.op === '&&') return this.evalConstInt(expr.left) !== 0 && this.evalConstInt(expr.right) !== 0 ? 1 : 0;
        if (expr.op === '||') return this.evalConstInt(expr.left) !== 0 || this.evalConstInt(expr.right) !== 0 ? 1 : 0;
        const left = this.evalConstInt(expr.left);
        const right = this.evalConstInt(expr.right);
        switch (expr.op) {
          case '+':
            return left + right;
          case '-':
            return left - right;
          case '*':
            return left * right;
          case '/':
            if (right === 0) throw new ExecutionFailure('runtime', '常量表达式除以零。', { line: expr.range.startLine, range: expr.range });
            return Math.trunc(left / right);
          case '%':
            if (right === 0) throw new ExecutionFailure('runtime', '常量表达式除以零。', { line: expr.range.startLine, range: expr.range });
            return left % right;
          case '==':
            return left === right ? 1 : 0;
          case '!=':
            return left !== right ? 1 : 0;
          case '<':
            return left < right ? 1 : 0;
          case '<=':
            return left <= right ? 1 : 0;
          case '>':
            return left > right ? 1 : 0;
          case '>=':
            return left >= right ? 1 : 0;
          case '&':
            return left & right;
          case '|':
            return left | right;
          case '^':
            return left ^ right;
          case '<<':
            return left << right;
          case '>>':
            return left >> right;
          default:
            throw new ExecutionFailure('unsupported', `常量表达式不支持运算符 ${expr.op}。`, {
              line: expr.range.startLine,
              range: expr.range,
            });
        }
      }
      case 'Cast':
        return this.evalConstInt(expr.expr);
      case 'Conditional':
        return this.evalConstInt(expr.test) !== 0 ? this.evalConstInt(expr.consequent) : this.evalConstInt(expr.alternate);
      case 'Sizeof': {
        const type = this.sizeofType(expr);
        return type.size;
      }
      default:
        throw new ExecutionFailure('unsupported', '常量表达式过于复杂，暂不支持（数组长度请使用整数常量）。', {
          line: expr.range.startLine,
          range: expr.range,
        });
    }
  }

  // ----------------------------------------------------------------
  // 预检查：入口函数与不支持语法
  // ----------------------------------------------------------------

  private preflight(): void {
    const mainDefinition = this.functions.get('main');
    if (!mainDefinition) {
      const declaration = this.declaredFunctions.get('main');
      if (declaration) {
        throw new ExecutionFailure('unsupported', 'main 函数只有声明、没有函数体，无法作为执行入口。', {
          hint: '请补全 main 的函数体，例如：int main(void) { return 0; }',
          line: declaration.range.startLine,
          range: declaration.range,
        });
      }
      throw new ExecutionFailure(
        'unsupported',
        '没有找到可执行的 main 函数。',
        { hint: 'C 程序从 main 开始执行，请定义 int main(void) 或 int main(int argc, char **argv)。' },
      );
    }
    this.mainFn = mainDefinition;

    // 顶层未知节点：goto/标签、函数指针声明、C++ class 等
    for (const item of this.program.items) {
      if (item.kind !== 'Unknown') continue;
      throw new ExecutionFailure('unsupported', `暂不支持这种 C 语法：${item.note}`, {
        hint: `无法执行的源码片段：${this.snippet(item.range)}`,
        line: item.range.startLine,
        range: item.range,
      });
    }

    // 条件编译会改变实际参与编译的代码，解释器无法可靠模拟
    for (const directive of this.unsupportedDirectives) {
      throw new ExecutionFailure(
        'unsupported',
        `暂不支持预处理条件编译 #${directive.directive}。`,
        {
          hint: '解释器无法根据宏条件裁剪代码，继续执行可能得到与真实编译不一致的结果，因此已停止。',
          line: directive.line,
          range: directive.range,
        },
      );
    }
  }

  /** 取一段源码的简短预览，用于错误提示 */
  private snippet(range: SourceRange, limit = 60): string {
    const text = this.source.slice(range).replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }

  // ----------------------------------------------------------------
  // 错误构造辅助
  // ----------------------------------------------------------------

  private runtime(message: string, node?: { range: SourceRange }, hint?: string): never {
    throw new ExecutionFailure('runtime', message, {
      line: node?.range.startLine,
      range: node?.range,
      hint,
    });
  }

  private unsupported(message: string, node?: { range: SourceRange }, hint?: string): never {
    throw new ExecutionFailure('unsupported', message, {
      line: node?.range.startLine,
      range: node?.range,
      hint,
    });
  }

  private limit(message: string, node?: { range: SourceRange }, hint?: string): never {
    throw new ExecutionFailure('limit', message, {
      line: node?.range.startLine,
      range: node?.range,
      hint,
    });
  }

  // ----------------------------------------------------------------
  // 地址空间与内存分配
  // ----------------------------------------------------------------

  private reserveGlobal(size: number, align: number): number {
    const address = alignUp(this.nextGlobal, align);
    this.nextGlobal = address + Math.max(size, 1);
    return address;
  }

  private reserveStack(size: number, align: number): number {
    const address = alignUp(this.nextStack, align);
    this.nextStack = address + Math.max(size, 1);
    return address;
  }

  private reserveHeap(size: number): number {
    const address = alignUp(this.nextHeap, 8);
    this.nextHeap = address + Math.max(size, 1);
    return address;
  }

  /** 计算结构体布局（数组元素若为结构体也需要先算大小） */
  private ensureTypeSized(type: CType): void {
    if (type.kind === 'array' && type.base) this.ensureTypeSized(type.base);
    if (type.kind === 'struct' || type.kind === 'union') this.ensureStructLayout(type);
    if (type.kind === 'pointer' && type.base && type.base.kind !== 'void' && type.base.kind !== 'pointer') {
      // 指针本身大小固定，无需展开 pointee；但结构体指针在访问时会再确保布局
    }
  }

  /** 分配一个变量单元格（全局区或栈区） */
  private allocateVariable(type: CType, scope: Scope, label: string, declaredLine?: number): Cell {
    this.ensureTypeSized(type);
    const size = Math.max(type.size, 1);
    const address = scope.kind === 'global' ? this.reserveGlobal(size, type.align) : this.reserveStack(size, type.align);
    return this.buildStorage(type, address, label, 'variable', declaredLine);
  }

  /** 在指定地址上构建存储单元（数组/结构体会递归构建成员单元格） */
  private buildStorage(
    type: CType,
    address: number,
    label: string,
    cellKind: Cell['cellKind'],
    declaredLine?: number,
    heapId?: number,
  ): Cell {
    if (type.kind === 'array') {
      const cell: Cell = {
        address,
        type,
        label,
        cellKind,
        declaredLine,
        initialized: false,
        elements: [],
        heapId,
      };
      this.registerAggregate(cell);
      const elementType = type.base ?? TYPE_INT;
      const count = type.count ?? 0;
      for (let index = 0; index < count; index += 1) {
        cell.elements!.push(
          this.buildStorage(elementType, address + index * elementType.size, `${label}[${index}]`, 'element', declaredLine, heapId),
        );
      }
      return cell;
    }
    if (type.kind === 'struct' || type.kind === 'union') {
      this.ensureStructLayout(type);
      const cell: Cell = {
        address,
        type,
        label,
        cellKind,
        declaredLine,
        initialized: false,
        fields: [],
        heapId,
      };
      this.registerAggregate(cell);
      for (const field of type.fields ?? []) {
        cell.fields!.push(
          this.buildStorage(field.type, address + field.offset, `${label}.${field.name}`, 'field', declaredLine, heapId),
        );
      }
      return cell;
    }
    const cell: Cell = {
      address,
      type,
      label,
      cellKind,
      declaredLine,
      initialized: false,
      heapId,
    };
    this.cells.set(address, cell);
    return cell;
  }

  private registerAggregate(cell: Cell): void {
    const list = this.aggregates.get(cell.address);
    if (list) list.push(cell);
    else this.aggregates.set(cell.address, [cell]);
  }

  /** 从地址映射中移除整个存储单元（free 或重新解释内存时使用） */
  private removeStorage(cell: Cell): void {
    if (cell.elements) {
      for (const element of cell.elements) this.removeStorage(element);
    }
    if (cell.fields) {
      for (const field of cell.fields) this.removeStorage(field);
    }
    this.cells.delete(cell.address);
    const list = this.aggregates.get(cell.address);
    if (list) {
      const next = list.filter((candidate) => candidate !== cell);
      if (next.length > 0) this.aggregates.set(cell.address, next);
      else this.aggregates.delete(cell.address);
    }
  }

  /** 查找包含指定地址的堆对象（用于悬空指针检查与目标标签） */
  private findHeapObject(address: number): HeapObject | undefined {
    for (const object of this.heapObjects) {
      if (address >= object.address && address < object.address + Math.max(object.size, 1)) return object;
    }
    return undefined;
  }

  /** malloc：创建原始字节内存对象（未初始化） */
  private createHeapMemory(size: number, node?: { range: SourceRange }): HeapObject {
    if (this.heapBytes + size > this.options.maxHeapBytes) {
      this.addWarning(`malloc(${size}) 超出模拟堆上限 ${this.options.maxHeapBytes} 字节，返回 NULL。`);
      // 用一个 0 地址占位无效对象不便于展示，这里直接返回带 null 语义的特殊对象
      return {
        id: -1,
        address: -1,
        size: 0,
        kind: 'memory',
        label: 'malloc 失败',
        typeText: 'void *',
        storage: {
          address: -1,
          type: TYPE_VOID,
          label: 'malloc 失败',
          cellKind: 'heap',
          initialized: false,
        },
        freed: true,
      };
    }
    this.heapCounter += 1;
    const id = this.heapCounter;
    const label = `堆内存 #${id}`;
    const address = this.reserveHeap(size);
    const storage = this.buildStorage(
      makeArray(TYPE_CHAR, Math.max(size, 1)),
      address,
      label,
      'heap',
      node?.range.startLine,
      id,
    );
    this.heapBytes += size;
    const object: HeapObject = {
      id,
      address,
      size,
      kind: 'memory',
      label,
      typeText: `malloc(${size} 字节)`,
      storage,
      freed: false,
    };
    this.heapObjects.push(object);
    return object;
  }

  /** 创建字符串字面量对象（只读，含结尾 NUL） */
  private createHeapString(text: string, node?: { range: SourceRange }): HeapObject {
    const codes = stringToCharCodes(text);
    const size = codes.length + 1;
    this.heapCounter += 1;
    const id = this.heapCounter;
    const label = `字符串字面量 #${id}`;
    const address = this.reserveHeap(size);
    const storage = this.buildStorage(makeArray(TYPE_CHAR, size), address, label, 'heap', node?.range.startLine, id);
    const elements = storage.elements ?? [];
    for (let index = 0; index < elements.length; index += 1) {
      const code = index < codes.length ? codes[index] : 0;
      elements[index].scalar = { kind: 'int', value: code };
      elements[index].initialized = true;
      elements[index].readOnly = true;
    }
    storage.readOnly = true;
    const object: HeapObject = {
      id,
      address,
      size,
      kind: 'string',
      label,
      typeText: `char[${size}]`,
      storage,
      freed: false,
    };
    this.heapObjects.push(object);
    return object;
  }

  /** 把 malloc 得到的原始内存解释为结构体（由 struct 指针类型驱动） */
  private materializeHeapStruct(object: HeapObject, type: CType): void {
    this.ensureStructLayout(type);
    if (object.kind === 'struct') {
      if (object.structType && object.structType.name === type.name) return;
      throw new ExecutionFailure(
        'unsupported',
        `同一块堆内存被当作不同的结构体类型使用（${object.typeText} / ${type.name}），暂不支持。`,
        { hint: '请对每个 malloc 结果只使用一种结构体指针类型。' },
      );
    }
    if (object.kind !== 'memory') {
      throw new ExecutionFailure(
        'unsupported',
        `不能把${object.kind === 'string' ? '字符串字面量' : '该堆对象'}转换为 ${type.name} 指针。`,
      );
    }
    if (object.address < 0) return;
    this.removeStorage(object.storage);
    const storage = this.buildStorage(type, object.address, object.label, 'heap', undefined, object.id);
    object.storage = storage;
    object.kind = 'struct';
    object.typeText = typeText(type);
    object.structType = type;
  }

  /** free：让堆对象失效并记录悬空区间 */
  private freeHeapObject(object: HeapObject, node?: { range: SourceRange }): void {
    if (object.freed) {
      this.runtime(`重复释放同一块内存（${object.label}）。`, node, '同一块 malloc 内存只能 free 一次。');
    }
    this.removeStorage(object.storage);
    object.freed = true;
    this.heapBytes = Math.max(0, this.heapBytes - object.size);
    this.freedRanges.push({
      start: object.address,
      end: object.address + Math.max(object.size, 1),
      label: object.label,
    });
    const referenced = this.collectPointerTargets().some(
      (target) => target >= object.address && target < object.address + Math.max(object.size, 1),
    );
    if (referenced) {
      this.addWarning(
        `free 之后仍有指针指向 ${object.label}（${formatAddress(object.address)}），这些指针已成为悬空指针。`,
      );
    }
  }

  // ----------------------------------------------------------------
  // 读取 / 写入 / 类型转换
  // ----------------------------------------------------------------

  private derefPointer(pointer: ScalarValue & { kind: 'pointer' }, node?: { range: SourceRange }): LValue {
    if (pointer.target === null) {
      const name = pointer.origin?.label;
      this.runtime(
        `空指针解引用：${name ? `指针 "${name}" ` : '指针'}的值为 NULL，无法访问它指向的内存。`,
        node,
        '解引用之前先判断指针是否为 NULL，例如 if (p != NULL) { ... }。',
      );
    }
    const target = pointer.target;
    // 已释放内存：明确报错而不是返回过期值
    for (const range of this.freedRanges) {
      if (target >= range.start && target < range.end) {
        this.runtime(
          `使用了已经释放的内存（悬空指针）：地址 ${formatAddress(target)} 属于 ${range.label}，该内存已被 free。`,
          node,
          'free 之后不要再通过原来的指针访问内存，可以把指针赋值为 NULL。',
        );
      }
    }
    const pointee = pointer.pointee;
    if (pointee.kind === 'struct' || pointee.kind === 'union') {
      const candidates = this.aggregates.get(target) ?? [];
      const cell = candidates.find((candidate) => candidate.type.kind === pointee.kind);
      if (cell) return { cell };
      this.runtime(
        `指针指向的地址 ${formatAddress(target)} 不是一个 ${typeText(pointee)} 对象，无法访问成员。`,
        node,
        '请确认指针的类型与指向的内存类型一致。',
      );
    }
    if (pointee.kind === 'array') {
      const candidates = this.aggregates.get(target) ?? [];
      const cell = candidates.find((candidate) => candidate.type.kind === 'array');
      if (cell) return { cell };
    }
    const cell = this.cells.get(target);
    if (cell) return { cell };
    this.runtime(
      `指针指向无效内存：地址 ${formatAddress(target)} 不存在对应内存单元（可能越界或指向已失效的栈变量）。`,
      node,
      '检查指针运算是否超出数组范围，或指针是否已经失效。',
    );
  }

  /** 读取单元格内容；数组自动退化为指向首元素的指针 */
  private readCell(cell: Cell, node?: { range: SourceRange }): RValue {
    if (cell.type.kind === 'array') {
      if (!cell.elements || cell.elements.length === 0) {
        this.unsupported(`长度为 0 的数组 ${cell.label} 暂时无法作为指针使用。`, node);
      }
      return {
        kind: 'pointer',
        target: cell.address,
        pointee: cell.type.base ?? TYPE_INT,
        origin: cell,
      };
    }
    if (cell.type.kind === 'struct' || cell.type.kind === 'union') {
      return { kind: 'struct', cell };
    }
    if (!cell.initialized || !cell.scalar) {
      this.runtime(
        `读取了未初始化的${this.cellKindText(cell)} "${cell.label}"（类型 ${typeText(cell.type)}）。`,
        node,
        '在使用变量之前先给它赋值，例如 int x = 0; 或 x = 1;。',
      );
    }
    return { ...cell.scalar };
  }

  private cellKindText(cell: Cell): string {
    if (cell.cellKind === 'field') return '结构体成员';
    if (cell.cellKind === 'element') return '数组元素';
    if (cell.cellKind === 'heap') return '堆内存';
    return '变量';
  }

  /** 写入单元格：负责类型转换与只读检查 */
  private writeCell(cell: Cell, value: RValue, node?: { range: SourceRange }): void {
    if (cell.readOnly) {
      this.runtime(`字符串字面量是只读的，不能修改 "${cell.label}"。`, node, '如需修改字符串，请使用 char 数组。');
    }
    if (cell.type.kind === 'array') {
      this.runtime(`不能给数组 "${cell.label}" 整体赋值，请逐个元素赋值。`, node);
    }
    if (cell.type.kind === 'struct' || cell.type.kind === 'union') {
      if (value.kind !== 'struct') {
        this.runtime(
          `结构体/联合体 "${cell.label}" 只能由同类型结构体赋值（当前值类型不匹配）。`,
          node,
          '结构体初始化请使用 { ... } 形式，或从另一个同类型结构体赋值。',
        );
      }
      this.assignStruct(cell, value.cell, node);
      return;
    }
    cell.scalar = this.coerceScalar(value, cell.type, node);
    cell.initialized = true;
  }

  private assignStruct(destination: Cell, source: Cell, node?: { range: SourceRange }): void {
    if (destination.type.name !== source.type.name) {
      this.runtime(
        `结构体类型不匹配：不能把 ${typeText(source.type)} 赋给 ${typeText(destination.type)}。`,
        node,
      );
    }
    const destinationFields = destination.fields ?? [];
    const sourceFields = source.fields ?? [];
    for (const field of destinationFields) {
      const sourceField = sourceFields.find((candidate) => candidate.label.endsWith(`.${field.label.split('.').pop()}`));
      if (sourceField) this.copyCellInto(field, sourceField);
    }
  }

  /** 深层复制单元格（保留未初始化状态），用于结构体赋值与参数传递 */
  private copyCellInto(destination: Cell, source: Cell): void {
    if (source.elements && destination.elements) {
      for (let index = 0; index < Math.min(source.elements.length, destination.elements.length); index += 1) {
        this.copyCellInto(destination.elements[index], source.elements[index]);
      }
      return;
    }
    if (source.fields && destination.fields) {
      for (const field of destination.fields) {
        const name = field.label.split('.').pop();
        const sourceField = source.fields.find((candidate) => candidate.label.split('.').pop() === name);
        if (sourceField) this.copyCellInto(field, sourceField);
      }
      return;
    }
    destination.initialized = source.initialized;
    destination.scalar = source.scalar ? { ...source.scalar } : undefined;
  }

  private coerceScalar(value: RValue, target: CType, node?: { range: SourceRange }): ScalarValue {
    if (target.kind === 'int' || target.kind === 'enum') {
      if (value.kind === 'int') return { kind: 'int', value: value.value };
      if (value.kind === 'float') return { kind: 'int', value: Math.trunc(value.value) };
      if (value.kind === 'pointer') {
        this.runtime(
          `不能把指针直接赋给整数变量（${typeText(target)}）。`,
          node,
          '如果确实需要地址数值，请使用类型转换，例如 (long)p。',
        );
      }
      this.runtime(`不能把结构体赋给 ${typeText(target)} 变量。`, node);
    }
    if (target.kind === 'char') {
      if (value.kind === 'int') return { kind: 'int', value: value.value & 0xffff };
      if (value.kind === 'float') return { kind: 'int', value: Math.trunc(value.value) & 0xffff };
      if (value.kind === 'pointer') this.runtime(`不能把指针赋给 char 变量。`, node);
      this.runtime(`不能把结构体赋给 char 变量。`, node);
    }
    if (target.kind === 'float' || target.kind === 'double') {
      if (value.kind === 'int') return { kind: 'float', value: value.value };
      if (value.kind === 'float') return { kind: 'float', value: value.value };
      if (value.kind === 'pointer') this.runtime(`不能把指针赋给浮点数变量（${typeText(target)}）。`, node);
      this.runtime(`不能把结构体赋给浮点数变量（${typeText(target)}）。`, node);
    }
    if (target.kind === 'pointer') {
      return this.coercePointer(value, target, node);
    }
    if (target.kind === 'void') {
      this.runtime('void 类型不能存储具体的值。', node);
    }
    this.unsupported(`暂不支持类型 ${typeText(target)} 的赋值。`, node);
  }

  private coercePointer(value: RValue, target: CType, node?: { range: SourceRange }): ScalarValue {
    const pointee = target.base ?? TYPE_VOID;
    if (value.kind === 'pointer') return this.retypePointer(value, pointee, node);
    if (value.kind === 'int') {
      if (value.value === 0) return { kind: 'pointer', target: null, pointee };
      this.runtime(
        `不能把整数 ${value.value} 直接赋给指针变量（${typeText(target)}）。`,
        node,
        '空指针请使用 NULL 或 0；其他地址请显式类型转换，例如 (int *)malloc(sizeof(int))。',
      );
    }
    if (value.kind === 'float') this.runtime(`不能把浮点数赋给指针变量（${typeText(target)}）。`, node);
    this.runtime(`不能把结构体赋给指针变量（${typeText(target)}）。`, node);
  }

  /** 指针重新定型：struct 指针会把 malloc 原始内存解释为结构体 */
  private retypePointer(
    pointer: ScalarValue & { kind: 'pointer' },
    pointee: CType,
    node?: { range: SourceRange },
  ): ScalarValue {
    if (pointer.target === null) return { kind: 'pointer', target: null, pointee };
    const target = pointer.target;
    const object = this.findHeapObject(target);
    if (!object) return { kind: 'pointer', target, pointee };
    if (object.freed) {
      this.runtime(`指针指向了已经 free 的堆内存（${object.label}），不能再使用。`, node);
    }
    if (pointee.kind === 'struct' || pointee.kind === 'union') {
      if (target !== object.address) {
        this.unsupported(
          `暂不支持在堆内存中间地址上使用结构体指针（目标地址 ${formatAddress(target)}，对象起始地址 ${formatAddress(object.address)}）。`,
          node,
        );
      }
      if (object.kind === 'memory') this.materializeHeapStruct(object, pointee);
      else if (object.kind === 'struct') {
        if (object.structType && object.structType.name !== pointee.name) {
          this.unsupported(
            `同一块堆内存不能同时按 ${object.structType.name} 和 ${pointee.name} 两种结构体类型访问。`,
            node,
          );
        }
      } else {
        this.unsupported(`不能把${object.kind === 'string' ? '字符串字面量' : '该堆对象'}转换为 ${pointee.name} 指针。`, node);
      }
      return { kind: 'pointer', target, pointee };
    }
    if (pointee.kind === 'char' || pointee.kind === 'void') {
      if (object.kind === 'struct') {
        this.unsupported(`结构体堆对象暂不支持按 ${typeText(pointee)} 指针访问。`, node);
      }
      return { kind: 'pointer', target, pointee };
    }
    if (object.kind === 'memory' || object.kind === 'string' || object.kind === 'array') {
      this.unsupported(
        `把 malloc 得到的原始内存转换为 ${typeText(pointee)} 指针暂不支持。`,
        node,
        '请使用 char * 或结构体指针访问堆内存。',
      );
    }
    this.unsupported(`暂不支持把堆对象转换为 ${typeText(pointee)} 指针。`, node);
  }

  /** 数值转换：指针除 NULL 外不能参与整数运算 */
  private toInteger(value: RValue, node?: { range: SourceRange }): number {
    if (value.kind === 'int') return value.value;
    if (value.kind === 'float') return Math.trunc(value.value);
    if (value.kind === 'pointer') {
      if (value.target === null) return 0;
      this.runtime('指针不能直接当作整数使用（NULL 除外）。', node, '如确需地址数值，请使用类型转换 (long)p。');
    }
    this.runtime('结构体不能直接当作整数使用。', node);
  }

  private toNumber(value: RValue, node?: { range: SourceRange }): number {
    if (value.kind === 'int') return value.value;
    if (value.kind === 'float') return value.value;
    if (value.kind === 'pointer') this.runtime('指针不能当作数值参与算术运算（NULL 除外）。', node);
    this.runtime('结构体不能当作数值参与运算。', node);
  }

  private truthiness(value: RValue, node?: { range: SourceRange }): boolean {
    if (value.kind === 'int') return value.value !== 0;
    if (value.kind === 'float') return value.value !== 0;
    if (value.kind === 'pointer') return value.target !== null;
    this.runtime('结构体不能直接作为条件。', node);
  }

  // ----------------------------------------------------------------
  // 初始化
  // ----------------------------------------------------------------

  private zeroValueFor(type: CType): ScalarValue {
    if (type.kind === 'pointer') return { kind: 'pointer', target: null, pointee: type.base ?? TYPE_VOID };
    if (type.kind === 'float' || type.kind === 'double') return { kind: 'float', value: 0 };
    return { kind: 'int', value: 0 };
  }

  /** 零初始化（全局变量、初始化列表未覆盖的部分） */
  private zeroInit(cell: Cell): void {
    if (cell.elements) {
      for (const element of cell.elements) this.zeroInit(element);
      return;
    }
    if (cell.fields) {
      for (const field of cell.fields) this.zeroInit(field);
      return;
    }
    cell.scalar = this.zeroValueFor(cell.type);
    cell.initialized = true;
  }

  /** 根据初始化列表推断省略的数组长度 */
  private resolveArrayCounts(declarator: Declarator, initializer: ExprNode | undefined): number[] | undefined {
    const dims = declarator.arrayDims;
    if (dims.length === 0) return undefined;
    const counts: number[] = dims.map((dim) => (dim ? this.evalConstInt(dim) : -1));
    if (counts[0] === -1) {
      if (initializer?.kind === 'InitList') counts[0] = initializer.elements.length;
      else if (initializer?.kind === 'Literal' && initializer.literalKind === 'string') {
        counts[0] = decodeCStringLiteral(initializer.raw).length + 1;
      } else {
        this.unsupported(
          `数组 "${declarator.name.name}" 的长度无法推断。`,
          declarator,
          '请写出明确长度，例如 int a[3];，或提供初始化列表 int a[] = {1, 2, 3};。',
        );
      }
    }
    for (let index = 1; index < counts.length; index += 1) {
      if (counts[index] !== -1) continue;
      let current: ExprNode | undefined = initializer;
      for (let depth = 0; depth < index && current; depth += 1) {
        current = current.kind === 'InitList' ? current.elements[0] : undefined;
      }
      if (current?.kind === 'InitList') counts[index] = current.elements.length;
      else {
        this.unsupported(
          `数组 "${declarator.name.name}" 第 ${index + 1} 维长度无法推断。`,
          declarator,
          '多维数组请至少写出内层长度，例如 int a[][3] = {{1,2,3}};。',
        );
      }
    }
    for (const count of counts) {
      if (count <= 0) {
        this.unsupported(`数组 "${declarator.name.name}" 的长度必须大于 0。`, declarator);
      }
    }
    return counts;
  }

  /** 用初始化器初始化单元格 */
  private initCellFromInitializer(cell: Cell, initializer: ExprNode, scope: Scope): void {
    if (cell.type.kind === 'array') {
      if (initializer.kind === 'Literal' && initializer.literalKind === 'string' && cell.type.base?.kind === 'char') {
        this.initCharArrayFromString(cell, decodeCStringLiteral(initializer.raw));
        return;
      }
      if (initializer.kind === 'InitList') {
        this.fillInitList(cell, initializer, scope);
        return;
      }
      this.unsupported(
        `数组 "${cell.label}" 只能用 { ... } 初始化列表或字符串字面量初始化。`,
        initializer,
        '例如 int a[3] = {1, 2, 3}; 或 char s[] = "hello";',
      );
    }
    if (cell.type.kind === 'struct' || cell.type.kind === 'union') {
      if (initializer.kind === 'InitList') {
        this.fillInitList(cell, initializer, scope);
        return;
      }
      const value = this.evalExpr(initializer, scope);
      this.writeCell(cell, value, initializer);
      return;
    }
    if (initializer.kind === 'InitList') {
      this.unsupported(`标量变量 "${cell.label}" 不能使用 { ... } 初始化列表。`, initializer);
    }
    const value = this.evalExpr(initializer, scope);
    this.writeCell(cell, value, initializer);
  }

  private initCharArrayFromString(cell: Cell, text: string): void {
    const codes = stringToCharCodes(text);
    const elements = cell.elements ?? [];
    const count = elements.length;
    if (codes.length + 1 > count) {
      if (codes.length <= count) {
        this.addWarning(`字符串字面量较长，初始化 ${cell.label} 时没有写入结尾的 '\\0'。`);
      } else {
        this.runtime(
          `字符串字面量过长：无法放入 ${count} 个字符的数组 ${cell.label}。`,
          undefined,
          '请把数组长度写大一些，例如 char s[] = "..." 让编译器自动推断。',
        );
      }
    }
    for (let index = 0; index < count; index += 1) {
      elements[index].scalar = { kind: 'int', value: index < codes.length ? codes[index] : 0 };
      elements[index].initialized = true;
    }
  }

  /** 填充初始化列表：数组按下标、结构体按成员顺序，未覆盖部分零初始化 */
  private fillInitList(cell: Cell, initializer: ExprNode & { kind: 'InitList' }, scope: Scope): void {
    const elements = initializer.elements;
    if (cell.elements) {
      const values = cell.elements;
      for (let index = 0; index < Math.min(elements.length, values.length); index += 1) {
        const elementInitializer = elements[index];
        this.initAggregateOrScalar(values[index], elementInitializer, scope);
      }
      for (let index = elements.length; index < values.length; index += 1) this.zeroInit(values[index]);
      return;
    }
    if (cell.fields) {
      const fields = cell.fields;
      for (let index = 0; index < Math.min(elements.length, fields.length); index += 1) {
        this.initAggregateOrScalar(fields[index], elements[index], scope);
      }
      for (let index = elements.length; index < fields.length; index += 1) this.zeroInit(fields[index]);
      return;
    }
    this.unsupported(`初始化列表不能用于标量 "${cell.label}"。`, initializer);
  }

  private initAggregateOrScalar(cell: Cell, initializer: ExprNode, scope: Scope): void {
    if (isAggregateType(cell.type)) {
      if (initializer.kind === 'InitList') {
        this.fillInitList(cell, initializer, scope);
        return;
      }
      if (cell.type.kind === 'array' && initializer.kind === 'Literal' && initializer.literalKind === 'string' && cell.type.base?.kind === 'char') {
        this.initCharArrayFromString(cell, decodeCStringLiteral(initializer.raw));
        return;
      }
      this.unsupported(
        `聚合类型 "${cell.label}"（${typeText(cell.type)}）需要 { ... } 形式或字符串字面量初始化。`,
        initializer,
      );
    }
    const value = this.evalExpr(initializer, scope);
    this.writeCell(cell, value, initializer);
  }

  // ----------------------------------------------------------------
  // 作用域与查找
  // ----------------------------------------------------------------

  private currentScope(): Scope {
    const scope = this.scopeStack[this.scopeStack.length - 1];
    if (!scope) throw new ExecutionFailure('runtime', '解释器内部错误：作用域栈为空。');
    return scope;
  }

  private currentFrame(): Frame | undefined {
    return this.frames[this.frames.length - 1];
  }

  private pushScope(kind: Scope['kind'], name: string): Scope {
    this.scopeCounter += 1;
    const scope: Scope = {
      id: `scope-${this.scopeCounter}`,
      name,
      kind,
      variables: new Map(),
      order: [],
    };
    this.scopeStack.push(scope);
    return scope;
  }

  private popScope(scope: Scope): void {
    const index = this.scopeStack.lastIndexOf(scope);
    if (index >= 0) this.scopeStack.splice(index, 1);
  }

  private lookupVariable(name: string): Cell | undefined {
    for (let index = this.scopeStack.length - 1; index >= 0; index -= 1) {
      const cell = this.scopeStack[index].variables.get(name);
      if (cell) return cell;
    }
    return undefined;
  }

  private declareVariable(scope: Scope, name: string, cell: Cell, node?: { range: SourceRange }): void {
    if (scope.variables.has(name)) {
      this.runtime(`同一作用域内重复声明变量 "${name}"。`, node, '请修改其中一个变量的名字，或把声明放到不同的代码块中。');
    }
    scope.variables.set(name, cell);
    scope.order.push(name);
  }

  private addWarning(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  // ----------------------------------------------------------------
  // 快照视图构建
  // ----------------------------------------------------------------

  private outputLines(): string[] {
    if (!this.stdout) return [];
    const lines = this.stdout.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  private buildCallStack(): CallFrameView[] {
    return this.frames.map((frame) => ({
      functionName: frame.functionName,
      line: frame.currentLine,
      locals: frame.scope.variables.size,
    }));
  }

  private buildScopeViews(): ScopeView[] {
    const nextSignatures = new Map<number, string>();
    const scopes: ScopeView[] = [];
    for (const scope of this.scopeStack) {
      const variables: VariableView[] = [];
      for (const name of scope.order) {
        const cell = scope.variables.get(name);
        if (!cell) continue;
        const signature = this.cellSignature(cell);
        nextSignatures.set(cell.address, signature);
        const value = this.buildValueView(cell);
        value.changed = this.lastSignatures.get(cell.address) !== signature;
        variables.push({
          name,
          typeText: typeText(cell.type),
          scopeName: scope.name,
          scopeKind: scope.kind,
          value,
          declaredLine: cell.declaredLine,
          address: formatAddress(cell.address),
        });
      }
      scopes.push({ id: scope.id, name: scope.name, kind: scope.kind, variables });
    }
    this.lastSignatures = nextSignatures;
    return scopes;
  }

  private buildValueView(cell: Cell): ValueView {
    if (cell.type.kind === 'array') {
      const elements = cell.elements ?? [];
      const elementViews = elements.map((element, index) => ({
        index,
        text: this.cellValueText(element),
        pointerTarget: this.pointerTargetOf(element),
      }));
      if (cell.type.base?.kind === 'char') {
        const text = charCodesToString(elements.map((element) => (element.initialized && element.scalar?.kind === 'int' ? element.scalar.value : 0)));
        return {
          kind: 'string',
          text: quoteText(text),
          typeText: typeText(cell.type),
          address: formatAddress(cell.address),
          elements: elementViews,
        };
      }
      return {
        kind: 'array',
        text: `[${elementViews.map((element) => element.text).join(', ')}]`,
        typeText: typeText(cell.type),
        address: formatAddress(cell.address),
        elements: elementViews,
      };
    }
    if (cell.type.kind === 'struct' || cell.type.kind === 'union') {
      const fields = (cell.fields ?? []).map((field) => ({
        name: field.label.split('.').pop() ?? field.label,
        typeText: typeText(field.type),
        text: this.cellValueText(field),
        pointerTarget: this.pointerTargetOf(field),
      }));
      const summary = fields.map((field) => `${field.name}: ${field.text}`).join(', ');
      return {
        kind: 'struct',
        text: `{${summary}}`,
        typeText: typeText(cell.type),
        address: formatAddress(cell.address),
        fields,
      };
    }
    if (cell.type.kind === 'pointer') {
      const pointer = cell.initialized ? cell.scalar : undefined;
      const target = pointer?.kind === 'pointer' ? pointer.target : null;
      return {
        kind: 'pointer',
        text: target === null ? 'NULL' : formatAddress(target),
        typeText: typeText(cell.type),
        pointerTarget: target === null ? undefined : formatAddress(target),
        pointerTargetLabel: target === null ? undefined : this.describeAddress(target),
        isNull: target === null,
        address: formatAddress(cell.address),
      };
    }
    if (cell.type.kind === 'void') {
      return { kind: 'unknown', text: 'void', typeText: 'void', address: formatAddress(cell.address) };
    }
    if (!cell.initialized || !cell.scalar) {
      return {
        kind: 'scalar',
        text: '未初始化',
        typeText: typeText(cell.type),
        address: formatAddress(cell.address),
      };
    }
    const scalar = cell.scalar;
    let text: string;
    if (scalar.kind === 'float') {
      text = formatNumber(scalar.value);
    } else if (scalar.kind === 'pointer') {
      text = scalar.target === null ? 'NULL' : formatAddress(scalar.target);
    } else if (cell.type.kind === 'char') {
      text = charText(scalar.value);
    } else {
      text = formatNumber(scalar.value);
    }
    return {
      kind: 'scalar',
      text,
      typeText: typeText(cell.type),
      address: formatAddress(cell.address),
    };
  }

  /** 指针目标地址（用于结构体成员 / 数组元素视图） */
  private pointerTargetOf(cell: Cell): string | undefined {
    if (cell.type.kind !== 'pointer' || !cell.initialized || cell.scalar?.kind !== 'pointer') return undefined;
    return cell.scalar.target === null ? undefined : formatAddress(cell.scalar.target);
  }

  /** 单元格的简短文本（用于说明与成员预览，不抛错） */
  private cellValueText(cell: Cell): string {
    if (cell.elements) {
      return `[${cell.elements.map((element) => this.cellValueText(element)).join(', ')}]`;
    }
    if (cell.fields) {
      const fields = cell.fields.map((field) => `${field.label.split('.').pop()}: ${this.cellValueText(field)}`);
      return `{${fields.join(', ')}}`;
    }
    if (!cell.initialized || !cell.scalar) return '未初始化';
    const scalar = cell.scalar;
    if (scalar.kind === 'float') return formatNumber(scalar.value);
    if (scalar.kind === 'pointer') return scalar.target === null ? 'NULL' : formatAddress(scalar.target);
    if (cell.type.kind === 'char') return charText(scalar.value);
    return formatNumber(scalar.value);
  }

  /** 值签名：用于计算 changed 标记 */
  private cellSignature(cell: Cell): string {
    if (cell.elements) return `[${cell.elements.map((element) => this.cellSignature(element)).join('|')}]`;
    if (cell.fields) return `{${cell.fields.map((field) => this.cellSignature(field)).join('|')}}`;
    if (!cell.initialized || !cell.scalar) return 'uninit';
    const scalar = cell.scalar;
    if (scalar.kind === 'pointer') return `p:${scalar.target === null ? 'null' : scalar.target}:${scalar.pointee.name}`;
    if (scalar.kind === 'float') return `f:${scalar.value}`;
    return `i:${scalar.value}`;
  }

  /** 递归收集所有指针指向的地址（用于堆对象的 referenced 标记） */
  private collectPointerTargets(): number[] {
    const targets: number[] = [];
    const visit = (cell: Cell): void => {
      if (cell.scalar?.kind === 'pointer' && cell.scalar.target !== null) targets.push(cell.scalar.target);
      if (cell.elements) {
        for (const element of cell.elements) visit(element);
      }
      if (cell.fields) {
        for (const field of cell.fields) visit(field);
      }
    };
    for (const scope of this.scopeStack) {
      for (const cell of scope.variables.values()) visit(cell);
    }
    for (const object of this.heapObjects) {
      if (!object.freed) {
        const storage = object.storage;
        visit(storage);
      }
    }
    return targets;
  }

  private buildHeapViews(): HeapObjectView[] {
    const targets = this.collectPointerTargets();
    return this.heapObjects.map((object) => {
      const end = object.address + Math.max(object.size, 1);
      const view: HeapObjectView = {
        address: formatAddress(object.address),
        typeText: object.typeText,
        kind: object.kind,
        label: object.label,
        freed: object.freed,
        referenced: targets.some((target) => target >= object.address && target < end),
      };
      if (object.kind === 'struct') {
        view.fields = (object.storage.fields ?? []).map((field) => ({
          name: field.label.split('.').pop() ?? field.label,
          typeText: typeText(field.type),
          text: this.cellValueText(field),
          pointerTarget: this.pointerTargetOf(field),
        }));
      } else {
        view.elements = (object.storage.elements ?? []).map((element, index) => ({
          index,
          text: this.cellValueText(element),
          pointerTarget: this.pointerTargetOf(element),
        }));
      }
      return view;
    });
  }

  /** 指针目标的可读标签，如「堆对象 #1（struct LNode）」「变量 a」 */
  private describeAddress(address: number): string | undefined {
    const heap = this.findHeapObject(address);
    if (heap) {
      if (address === heap.address) return `${heap.label}（${heap.typeText}）`;
      return `${heap.label}+${address - heap.address}（${heap.typeText}）`;
    }
    const aggregate = this.aggregates.get(address)?.[0];
    if (aggregate) {
      const owner = this.findVariableByAddress(address);
      if (owner) return `变量 ${owner}`;
      return `${this.cellKindText(aggregate)} ${aggregate.label}`;
    }
    const cell = this.cells.get(address);
    if (cell) {
      const owner = this.findVariableByAddress(address);
      if (owner) return `变量 ${owner}`;
      return `${this.cellKindText(cell)} ${cell.label}`;
    }
    return undefined;
  }

  private findVariableByAddress(address: number): string | undefined {
    for (let index = this.scopeStack.length - 1; index >= 0; index -= 1) {
      const scope = this.scopeStack[index];
      for (const name of scope.order) {
        const cell = scope.variables.get(name);
        if (cell && cell.address === address) return name;
      }
    }
    return undefined;
  }

  // ----------------------------------------------------------------
  // 静态类型（sizeof、指针目标类型等）
  // ----------------------------------------------------------------

  private staticType(expr: ExprNode): CType | undefined {
    switch (expr.kind) {
      case 'Literal': {
        switch (expr.literalKind) {
          case 'int':
            return TYPE_INT;
          case 'float':
            return TYPE_DOUBLE;
          case 'char':
            return TYPE_INT;
          case 'bool':
            return TYPE_INT;
          case 'string':
            return makePointer(TYPE_CHAR);
          case 'null':
            return makePointer(TYPE_VOID);
          default:
            return undefined;
        }
      }
      case 'Identifier': {
        const cell = this.lookupVariable(expr.name);
        if (cell) return cell.type;
        const macro = this.macros.get(expr.name);
        if (macro) {
          if (macro.constant.kind === 'int' || macro.constant.kind === 'char') return TYPE_INT;
          if (macro.constant.kind === 'float') return TYPE_DOUBLE;
          if (macro.constant.kind === 'string') return makePointer(TYPE_CHAR);
        }
        if (this.enumConstants.has(expr.name)) return TYPE_INT;
        if (expr.name === 'NULL') return makePointer(TYPE_VOID);
        return undefined;
      }
      case 'Binary': {
        if (['==', '!=', '<', '<=', '>', '>=', '&&', '||'].includes(expr.op)) return TYPE_INT;
        const left = this.staticType(expr.left);
        const right = this.staticType(expr.right);
        if (expr.op === '+' && left?.kind === 'pointer') return left;
        if (expr.op === '+' && right?.kind === 'pointer') return right;
        if (expr.op === '-' && left?.kind === 'pointer') return left;
        if (left?.kind === 'pointer' || right?.kind === 'pointer') return undefined;
        if (left && right && (isFloatType(left) || isFloatType(right))) return TYPE_DOUBLE;
        return TYPE_INT;
      }
      case 'Unary': {
        if (expr.op === '&') {
          const operandType = this.staticType(expr.operand);
          return operandType ? makePointer(operandType) : undefined;
        }
        if (expr.op === '*') {
          const operandType = this.staticType(expr.operand);
          return operandType?.kind === 'pointer' ? operandType.base : undefined;
        }
        if (expr.op === '!') return TYPE_INT;
        return this.staticType(expr.operand);
      }
      case 'Update':
        return this.staticType(expr.operand);
      case 'Assign':
        return this.staticType(expr.target);
      case 'Conditional': {
        const consequent = this.staticType(expr.consequent);
        const alternate = this.staticType(expr.alternate);
        if (consequent && alternate && (isFloatType(consequent) || isFloatType(alternate))) return TYPE_DOUBLE;
        return consequent ?? alternate;
      }
      case 'Cast':
        return this.resolveTypeRef(expr.type, expr.pointerDepth);
      case 'Sizeof':
        return TYPE_ULONG;
      case 'Comma':
        return expr.items.length > 0 ? this.staticType(expr.items[expr.items.length - 1]) : undefined;
      case 'Index': {
        const baseType = this.staticType(expr.base);
        if (!baseType) return undefined;
        if (baseType.kind === 'array' || baseType.kind === 'pointer') return baseType.base;
        return undefined;
      }
      case 'Member': {
        const objectType = this.staticType(expr.object);
        if (!objectType) return undefined;
        const structType = expr.arrow
          ? objectType.kind === 'pointer'
            ? objectType.base
            : undefined
          : objectType;
        if (!structType || (structType.kind !== 'struct' && structType.kind !== 'union')) return undefined;
        const field = this.findStructField(structType, expr.member.name);
        return field?.type;
      }
      case 'Call': {
        if (expr.callee.kind !== 'Identifier') return undefined;
        return this.callReturnType(expr.callee.name);
      }
      default:
        return undefined;
    }
  }

  private findStructField(type: CType, name: string): StructFieldLayout | undefined {
    if (type.kind !== 'struct' && type.kind !== 'union') return undefined;
    this.ensureStructLayout(type);
    return (type.fields ?? []).find((field) => field.name === name);
  }

  private callReturnType(name: string): CType | undefined {
    const functionNode = this.functions.get(name);
    if (functionNode) return this.resolveTypeRef(functionNode.returnType, functionNode.returnPointerDepth);
    if (name === 'printf' || name === 'puts' || name === 'putchar') return TYPE_INT;
    if (name === 'malloc' || name === 'calloc' || name === 'realloc') return makePointer(TYPE_VOID);
    if (name === 'free') return TYPE_VOID;
    return undefined;
  }

  private sizeofType(expr: Extract<ExprNode, { kind: 'Sizeof' }>): CType {
    let type: CType | undefined;
    if (expr.typeName) {
      type = this.resolveTypeRef(expr.typeName, expr.pointerDepth);
    } else if (expr.operand && expr.operand.kind === 'Literal' && expr.operand.literalKind === 'string') {
      // C 中 sizeof("abc") 得到字符数组（含结尾 NUL）的大小 4，而不是指针大小
      type = makeArray(TYPE_CHAR, decodeCStringLiteral(expr.operand.raw).length + 1);
    } else if (expr.operand) {
      type = this.staticType(expr.operand);
      if (!type) {
        this.unsupported(
          `无法确定 sizeof(${this.snippet(expr.operand.range)}) 的类型，暂不支持。`,
          expr,
          '请改写为 sizeof(类型) 形式，或对明确的变量使用 sizeof。',
        );
      }
    }
    if (!type) this.unsupported('sizeof 缺少类型或表达式。', expr);
    this.ensureTypeSized(type);
    if (type.kind === 'void') this.unsupported('sizeof(void) 不是合法的 C 表达式。', expr);
    return type;
  }

  // ----------------------------------------------------------------
  // 快照记录
  // ----------------------------------------------------------------

  private record(
    phase: ExecutionSnapshot['phase'],
    node: { range: SourceRange } | undefined,
    description: string,
    lineOverride?: number,
  ): void {
    this.stepCount += 1;
    if (this.stepCount > this.options.maxSteps) {
      this.limit(
        `执行步数超过上限 ${this.options.maxSteps} 步，已停止执行（可能存在死循环）。`,
        node,
        '可以缩小循环次数，或检查循环条件是否能够结束。',
      );
    }
    const line = lineOverride ?? node?.range.startLine ?? this.lastLine;
    this.lastLine = line;
    const frame = this.currentFrame();
    if (frame) frame.currentLine = line;
    this.snapshots.push(this.buildSnapshot(phase, description, node?.range, line));
  }

  /** 记录错误快照：绕过步数限制，保证错误现场也能展示 */
  private recordRaw(
    phase: ExecutionSnapshot['phase'],
    line: number,
    range: SourceRange | undefined,
    description: string,
  ): void {
    this.snapshots.push(this.buildSnapshot(phase, description, range, line));
  }

  private buildSnapshot(
    phase: ExecutionSnapshot['phase'],
    description: string,
    range: SourceRange | undefined,
    line: number,
  ): ExecutionSnapshot {
    const frame = this.currentFrame();
    return {
      index: this.snapshots.length,
      line: Math.max(line, 1),
      description,
      phase,
      range,
      functionName: frame?.functionName,
      callStack: this.buildCallStack(),
      scopes: this.buildScopeViews(),
      heap: this.buildHeapViews(),
      output: this.outputLines(),
      stdout: this.stdout,
      warnings: [...this.warnings],
    };
  }

  // ----------------------------------------------------------------
  // 表达式求值
  // ----------------------------------------------------------------

  /** 字符串字面量对象缓存：同一处字面量每次求值指向同一块只读内存 */
  private readonly literalObjects = new Map<string, HeapObject>();

  private evalExpr(expr: ExprNode, _scope?: Scope): RValue {
    switch (expr.kind) {
      case 'Identifier':
        return this.evalIdentifier(expr);
      case 'Literal':
        return this.evalLiteral(expr);
      case 'Binary':
        return this.evalBinary(expr);
      case 'Unary':
        return this.evalUnary(expr);
      case 'Update':
        return this.evalUpdate(expr);
      case 'Assign':
        return this.evalAssign(expr);
      case 'Call':
        return this.evalCall(expr);
      case 'Index': {
        const lvalue = this.evalLValue(expr);
        return this.readCell(lvalue.cell, expr);
      }
      case 'Member': {
        const lvalue = this.evalLValue(expr);
        return this.readCell(lvalue.cell, expr);
      }
      case 'Conditional':
        return this.truthiness(this.evalExpr(expr.test), expr.test)
          ? this.evalExpr(expr.consequent)
          : this.evalExpr(expr.alternate);
      case 'Cast':
        return this.evalCast(expr);
      case 'Sizeof':
        return { kind: 'int', value: this.sizeofType(expr).size };
      case 'Comma': {
        let result: RValue = { kind: 'int', value: 0 };
        for (const item of expr.items) result = this.evalExpr(item);
        return result;
      }
      case 'InitList':
        this.unsupported('初始化列表 { ... } 只能出现在变量声明中。', expr);
    }
  }

  private evalIdentifier(expr: ExprNode & { kind: 'Identifier' }): RValue {
    const cell = this.lookupVariable(expr.name);
    if (cell) return this.readCell(cell, expr);
    const macro = this.macros.get(expr.name);
    if (macro) return this.evalMacro(macro, expr);
    const unsupportedMacro = this.unsupportedMacros.get(expr.name);
    if (unsupportedMacro) {
      this.unsupported(
        `暂不支持宏 ${expr.name}：${unsupportedMacro.reason}。`,
        expr,
        '可以把这个宏手工展开成普通代码，或改用 const 变量。',
      );
    }
    const enumValue = this.enumConstants.get(expr.name);
    if (enumValue !== undefined) return { kind: 'int', value: enumValue };
    if (expr.name === 'NULL') return { kind: 'int', value: 0 };
    if (this.functions.has(expr.name)) {
      this.unsupported(`函数名 "${expr.name}" 不能作为值使用。`, expr, '解释器暂不支持函数指针。');
    }
    this.runtime(
      `使用了未定义的变量 "${expr.name}"。`,
      expr,
      '请检查变量名拼写，以及变量是否在使用前已经声明。',
    );
  }

  private evalMacro(macro: MacroDefinition, expr: ExprNode): RValue {
    const constant = macro.constant;
    if (constant.kind === 'int') return { kind: 'int', value: constant.value };
    if (constant.kind === 'char') return { kind: 'int', value: constant.value };
    if (constant.kind === 'float') return { kind: 'float', value: constant.value };
    if (constant.kind === 'string') {
      const key = `macro:${macro.name}`;
      let object = this.literalObjects.get(key);
      if (!object) {
        object = this.createHeapString(decodeCStringLiteral(constant.raw), expr);
        this.literalObjects.set(key, object);
      }
      return { kind: 'pointer', target: object.address, pointee: TYPE_CHAR };
    }
    this.unsupported(
      `暂不支持宏 ${macro.name}：${constant.reason}。`,
      expr,
      '可以把宏展开为普通常量或变量后再执行。',
    );
  }

  private evalLiteral(expr: ExprNode & { kind: 'Literal' }): RValue {
    switch (expr.literalKind) {
      case 'int':
        return { kind: 'int', value: parseIntegerLiteral(expr.raw) };
      case 'float':
        return { kind: 'float', value: Number.parseFloat(expr.raw.replace(/[fFlL]$/, '')) };
      case 'char':
        return { kind: 'int', value: decodeCharLiteral(expr.raw) };
      case 'bool':
        return { kind: 'int', value: expr.raw === 'true' ? 1 : 0 };
      case 'null':
        return { kind: 'int', value: 0 };
      case 'string': {
        let object = this.literalObjects.get(expr.id);
        if (!object) {
          object = this.createHeapString(decodeCStringLiteral(expr.raw), expr);
          this.literalObjects.set(expr.id, object);
        }
        return { kind: 'pointer', target: object.address, pointee: TYPE_CHAR };
      }
      default:
        this.unsupported(`暂不支持这种字面量：${expr.raw}。`, expr);
    }
  }

  private evalUnary(expr: ExprNode & { kind: 'Unary' }): RValue {
    switch (expr.op) {
      case '&': {
        const lvalue = this.evalLValue(expr.operand);
        const cell = lvalue.cell;
        if (cell.type.kind === 'array') {
          return { kind: 'pointer', target: cell.address, pointee: cell.type.base ?? TYPE_INT, origin: cell };
        }
        return { kind: 'pointer', target: cell.address, pointee: cell.type };
      }
      case '*': {
        const value = this.evalExpr(expr.operand);
        if (value.kind !== 'pointer') {
          this.runtime('一元 * 只能作用于指针（当前表达式不是指针）。', expr);
        }
        return this.readCell(this.derefPointer(value, expr).cell, expr);
      }
      case '!':
        return { kind: 'int', value: this.truthiness(this.evalExpr(expr.operand), expr.operand) ? 0 : 1 };
      case '~':
        return { kind: 'int', value: ~this.toInteger(this.evalExpr(expr.operand), expr.operand) };
      case '+': {
        const value = this.evalExpr(expr.operand);
        this.toNumber(value, expr.operand);
        return value;
      }
      case '-': {
        const value = this.evalExpr(expr.operand);
        if (value.kind === 'float') return { kind: 'float', value: -value.value };
        return { kind: 'int', value: -this.toInteger(value, expr.operand) };
      }
      case '++':
      case '--':
        return this.applyIncrement(expr.operand, expr.op, true, expr);
      default:
        this.unsupported(`暂不支持一元运算符 ${expr.op}。`, expr);
    }
  }

  private evalUpdate(expr: ExprNode & { kind: 'Update' }): RValue {
    return this.applyIncrement(expr.operand, expr.op, expr.prefix, expr);
  }

  private applyIncrement(
    operand: ExprNode,
    op: '++' | '--',
    prefix: boolean,
    node: ExprNode,
  ): RValue {
    const lvalue = this.evalLValue(operand);
    const oldValue = this.readCell(lvalue.cell, operand);
    const delta = op === '++' ? 1 : -1;
    let nextValue: RValue;
    if (oldValue.kind === 'pointer') {
      if (oldValue.target === null) this.runtime('对 NULL 指针进行自增/自减没有意义。', node);
      const size = oldValue.pointee.size;
      if (size <= 0) {
        this.unsupported(`不能对指向 ${typeText(oldValue.pointee)} 的指针进行自增/自减。`, node);
      }
      nextValue = { kind: 'pointer', target: oldValue.target + delta * size, pointee: oldValue.pointee };
    } else if (oldValue.kind === 'float') {
      nextValue = { kind: 'float', value: oldValue.value + delta };
    } else if (oldValue.kind === 'struct') {
      this.runtime('结构体不能进行自增 / 自减运算。', node);
    } else {
      nextValue = { kind: 'int', value: oldValue.value + delta };
    }
    this.writeCell(lvalue.cell, nextValue, node);
    return prefix ? this.readCell(lvalue.cell, node) : oldValue;
  }

  private evalAssign(expr: ExprNode & { kind: 'Assign' }): RValue {
    const lvalue = this.evalLValue(expr.target);
    if (expr.op === '=') {
      const value = this.evalExpr(expr.value);
      this.writeCell(lvalue.cell, value, expr);
      return this.readCell(lvalue.cell, expr);
    }
    const oldValue = this.readCell(lvalue.cell, expr.target);
    const rightValue = this.evalExpr(expr.value);
    const binaryOp = expr.op.slice(0, -1) as
      | '+'
      | '-'
      | '*'
      | '/'
      | '%'
      | '&'
      | '|'
      | '^'
      | '<<'
      | '>>';
    const combined = this.applyBinary(binaryOp, oldValue, rightValue, expr);
    this.writeCell(lvalue.cell, combined, expr);
    return this.readCell(lvalue.cell, expr);
  }

  private evalBinary(expr: ExprNode & { kind: 'Binary' }): RValue {
    if (expr.op === '&&') {
      const left = this.evalExpr(expr.left);
      if (!this.truthiness(left, expr.left)) return { kind: 'int', value: 0 };
      return { kind: 'int', value: this.truthiness(this.evalExpr(expr.right), expr.right) ? 1 : 0 };
    }
    if (expr.op === '||') {
      const left = this.evalExpr(expr.left);
      if (this.truthiness(left, expr.left)) return { kind: 'int', value: 1 };
      return { kind: 'int', value: this.truthiness(this.evalExpr(expr.right), expr.right) ? 1 : 0 };
    }
    const left = this.evalExpr(expr.left);
    const right = this.evalExpr(expr.right);
    return this.applyBinary(expr.op, left, right, expr);
  }

  private applyBinary(
    op: BinaryOpLike,
    left: RValue,
    right: RValue,
    node: ExprNode,
  ): RValue {
    // ---- 指针算术 ----
    // 两个指针相减得到相隔的元素个数，必须先于「指针 ± 整数」判断：
    // 否则右操作数会被误当成整数（数组名退化成的指针会报「指针不能直接当作整数使用」）。
    if (op === '-' && left.kind === 'pointer' && right.kind === 'pointer') {
      if (left.target === null || right.target === null) {
        this.runtime('NULL 指针之间不能相减。', node);
      }
      const size = left.pointee.size;
      if (size <= 0) return { kind: 'int', value: left.target - right.target };
      return { kind: 'int', value: Math.trunc((left.target - right.target) / size) };
    }
    if (left.kind === 'pointer' && (op === '+' || op === '-')) {
      const offset = this.toInteger(right, node);
      if (left.target === null) {
        this.runtime('对 NULL 指针进行算术运算无效。', node, '先让指针指向有效内存，再进行指针运算。');
      }
      const size = left.pointee.size;
      if (size <= 0) {
        this.unsupported(`不能对指向 ${typeText(left.pointee)} 的指针做算术运算。`, node);
      }
      return { kind: 'pointer', target: left.target + (op === '+' ? offset : -offset) * size, pointee: left.pointee };
    }
    if (op === '+' && left.kind !== 'pointer' && right.kind === 'pointer') {
      return this.applyBinary('+', right, left, node);
    }
    // ---- 比较运算 ----
    if (['==', '!=', '<', '<=', '>', '>='].includes(op)) {
      return { kind: 'int', value: this.compareValues(op, left, right, node) ? 1 : 0 };
    }
    // ---- 逻辑运算已短路处理，这里只处理其余 ----
    const leftNumber = this.toNumber(left, node);
    const rightNumber = this.toNumber(right, node);
    const floatResult = left.kind === 'float' || right.kind === 'float';
    switch (op) {
      case '+':
        return floatResult ? { kind: 'float', value: leftNumber + rightNumber } : { kind: 'int', value: leftNumber + rightNumber };
      case '-':
        return floatResult ? { kind: 'float', value: leftNumber - rightNumber } : { kind: 'int', value: leftNumber - rightNumber };
      case '*':
        return floatResult ? { kind: 'float', value: leftNumber * rightNumber } : { kind: 'int', value: leftNumber * rightNumber };
      case '/':
        if (rightNumber === 0) {
          if (floatResult) {
            this.addWarning('浮点数除以 0 得到 inf（C 中浮点除零不产生崩溃）。');
            return { kind: 'float', value: leftNumber > 0 ? Number.POSITIVE_INFINITY : leftNumber < 0 ? Number.NEGATIVE_INFINITY : Number.NaN };
          }
          this.runtime('除以零（整数除法）。', node, '在执行除法前检查除数是否为 0。');
        }
        return floatResult ? { kind: 'float', value: leftNumber / rightNumber } : { kind: 'int', value: Math.trunc(leftNumber / rightNumber) };
      case '%':
        if (floatResult) this.unsupported('暂不支持浮点数取模运算 %。', node);
        if (rightNumber === 0) this.runtime('取模运算的除数为零。', node, '先检查除数是否为 0。');
        return { kind: 'int', value: Math.trunc(leftNumber) % Math.trunc(rightNumber) };
      case '&':
        return { kind: 'int', value: Math.trunc(leftNumber) & Math.trunc(rightNumber) };
      case '|':
        return { kind: 'int', value: Math.trunc(leftNumber) | Math.trunc(rightNumber) };
      case '^':
        return { kind: 'int', value: Math.trunc(leftNumber) ^ Math.trunc(rightNumber) };
      case '<<':
        return { kind: 'int', value: Math.trunc(leftNumber) << Math.trunc(rightNumber) };
      case '>>':
        return { kind: 'int', value: Math.trunc(leftNumber) >> Math.trunc(rightNumber) };
      default:
        this.unsupported(`暂不支持运算符 ${op}。`, node);
    }
  }

  private compareValues(op: BinaryOpLike, left: RValue, right: RValue, node: ExprNode): boolean {
    // 指针与 NULL（整数 0）比较：C 的空指针常量规则
    if (left.kind === 'pointer' || right.kind === 'pointer') {
      const pointer = left.kind === 'pointer' ? left : right.kind === 'pointer' ? right : undefined;
      if (!pointer) this.runtime('指针比较出现内部错误。', node);
      const other: RValue = left.kind === 'pointer' ? right : left;
      const reversed = left.kind !== 'pointer';
      if (other.kind === 'pointer') {
        const targetLeft = left.kind === 'pointer' ? left.target : null;
        const targetRight = right.kind === 'pointer' ? right.target : null;
        switch (op) {
          case '==':
            return targetLeft === targetRight;
          case '!=':
            return targetLeft !== targetRight;
          case '<':
            return (targetLeft ?? 0) < (targetRight ?? 0);
          case '<=':
            return (targetLeft ?? 0) <= (targetRight ?? 0);
          case '>':
            return (targetLeft ?? 0) > (targetRight ?? 0);
          case '>=':
            return (targetLeft ?? 0) >= (targetRight ?? 0);
          default:
            this.unsupported(`暂不支持用 ${op} 比较指针。`, node);
        }
      }
      if (other.kind === 'int' && other.value === 0) {
        const isNull = pointer.target === null;
        if (op === '==') return isNull;
        if (op === '!=') return !isNull;
        const pointerNumber = pointer.target ?? 0;
        return this.compareNumbers(op, reversed ? 0 : pointerNumber, reversed ? pointerNumber : 0);
      }
      if (other.kind === 'int') {
        this.addWarning('指针与整数直接比较，结果取决于实现；建议只与 NULL 比较。');
        const pointerNumber = pointer.target ?? 0;
        return this.compareNumbers(op, reversed ? other.value : pointerNumber, reversed ? pointerNumber : other.value);
      }
      this.runtime('指针不能与浮点数比较。', node);
    }
    if (left.kind === 'struct' || right.kind === 'struct') {
      this.runtime('结构体不能直接比较。', node);
    }
    const leftNumber = this.toNumber(left, node);
    const rightNumber = this.toNumber(right, node);
    return this.compareNumbers(op, leftNumber, rightNumber);
  }

  private compareNumbers(op: BinaryOpLike, left: number, right: number): boolean {
    switch (op) {
      case '==':
        return left === right;
      case '!=':
        return left !== right;
      case '<':
        return left < right;
      case '<=':
        return left <= right;
      case '>':
        return left > right;
      case '>=':
        return left >= right;
      default:
        return false;
    }
  }

  private evalCast(expr: ExprNode & { kind: 'Cast' }): RValue {
    const targetType = this.resolveTypeRef(expr.type, expr.pointerDepth);
    const value = this.evalExpr(expr.expr);
    if (targetType.kind === 'void') return { kind: 'int', value: 0 };
    if (targetType.kind === 'pointer') {
      const pointee = targetType.base ?? TYPE_VOID;
      if (value.kind === 'pointer') return this.retypePointer(value, pointee, expr);
      if (value.kind === 'int') {
        if (value.value === 0) return { kind: 'pointer', target: null, pointee };
        this.unsupported(
          `把非零整数 ${value.value} 转换为指针暂不支持。`,
          expr,
          '当前内存模型只支持 NULL（0）与 malloc 返回的指针；请使用真实内存对象的地址。',
        );
      }
      if (value.kind === 'float') this.runtime('不能把浮点数转换为指针。', expr);
      this.runtime('不能把结构体转换为指针。', expr);
    }
    if (isIntegerType(targetType)) {
      if (value.kind === 'struct') this.runtime('不能把结构体转换为整数。', expr);
      if (value.kind === 'pointer') {
        const address = value.target;
        this.addWarning('把指针转换为整数会得到模拟地址数值（仅用于演示）。');
        return { kind: 'int', value: address === null ? 0 : address };
      }
      const number = this.toInteger(value, expr);
      return { kind: 'int', value: targetType.kind === 'char' ? number & 0xffff : number };
    }
    if (isFloatType(targetType)) {
      if (value.kind === 'struct') this.runtime('不能把结构体转换为浮点数。', expr);
      return { kind: 'float', value: this.toNumber(value, expr) };
    }
    this.unsupported(`暂不支持把值转换为 ${typeText(targetType)}。`, expr);
  }

  // ----------------------------------------------------------------
  // 左值解析
  // ----------------------------------------------------------------

  private evalLValue(expr: ExprNode, _scope?: Scope): LValue {
    switch (expr.kind) {
      case 'Identifier': {
        const cell = this.lookupVariable(expr.name);
        if (cell) return { cell };
        if (this.macros.has(expr.name) || this.unsupportedMacros.has(expr.name)) {
          this.runtime(`宏 "${expr.name}" 不是变量，不能被赋值。`, expr);
        }
        if (this.enumConstants.has(expr.name)) {
          this.runtime(`enum 常量 "${expr.name}" 是只读的，不能被赋值。`, expr);
        }
        if (expr.name === 'NULL') this.runtime('NULL 不是可赋值的变量。', expr);
        this.runtime(`使用了未定义的变量 "${expr.name}"。`, expr, '请检查变量名拼写与声明位置。');
      }
      case 'Index': {
        const baseCell = this.indexBaseCell(expr.base);
        if (baseCell && baseCell.type.kind === 'array') {
          return this.indexArrayCell(baseCell, expr);
        }
        if (baseCell && baseCell.type.kind === 'pointer') {
          const pointer = this.readCell(baseCell, expr.base);
          if (pointer.kind !== 'pointer') this.runtime('下标运算需要数组或指针。', expr);
          return this.indexPointer(pointer, expr);
        }
        if (baseCell) {
          this.runtime(`对 ${typeText(baseCell.type)} 类型的 "${baseCell.label}" 使用下标，但它既不是数组也不是指针。`, expr);
        }
        const value = this.evalExpr(expr.base);
        if (value.kind !== 'pointer') this.runtime('下标运算需要数组或指针。', expr);
        return this.indexPointer(value, expr);
      }
      case 'Member': {
        if (expr.arrow) {
          const objectValue = this.evalExpr(expr.object);
          if (objectValue.kind !== 'pointer') {
            this.runtime('-> 的左侧必须是指针（用于访问结构体指针的成员）。', expr);
          }
          const lvalue = this.derefPointer(objectValue, expr);
          return this.memberLValue(lvalue.cell, expr.member.name, expr);
        }
        const object = this.evalLValue(expr.object);
        return this.memberLValue(object.cell, expr.member.name, expr);
      }
      case 'Unary': {
        if (expr.op === '*') {
          const value = this.evalExpr(expr.operand);
          if (value.kind !== 'pointer') this.runtime('一元 * 只能作用于指针。', expr);
          return this.derefPointer(value, expr);
        }
        this.runtime('这个一元表达式不能作为赋值目标。', expr);
      }
      default:
        this.runtime('这个表达式不能作为赋值目标（不是可寻址的左值）。', expr);
    }
  }

  /** 若表达式本身是数组/指针变量（或成员/元素），返回其单元格，用于数组越界检查 */
  private indexBaseCell(expr: ExprNode): Cell | undefined {
    if (expr.kind === 'Identifier') return this.lookupVariable(expr.name);
    if (expr.kind === 'Member' || expr.kind === 'Index') return this.evalLValue(expr).cell;
    if (expr.kind === 'Unary' && expr.op === '*') {
      const value = this.evalExpr(expr.operand);
      if (value.kind === 'pointer') return this.derefPointer(value, expr).cell;
    }
    return undefined;
  }

  private indexArrayCell(cell: Cell, node: ExprNode & { kind: 'Index' }): LValue {
    const index = this.toInteger(this.evalExpr(node.index), node.index);
    const count = cell.elements?.length ?? 0;
    if (index < 0 || index >= count) {
      this.runtime(
        `数组越界：访问 ${cell.label}[${index}]，但 ${cell.label} 的有效下标范围是 0..${count - 1}。`,
        node,
        '检查循环边界，数组下标必须落在 [0, 长度-1] 内。',
      );
    }
    return { cell: cell.elements![index] };
  }

  private indexPointer(pointer: ScalarValue & { kind: 'pointer' }, node: ExprNode & { kind: 'Index' }): LValue {
    if (pointer.target === null) {
      this.runtime('对 NULL 指针使用下标访问会导致空指针解引用。', node);
    }
    const index = this.toInteger(this.evalExpr(node.index), node.index);
    const size = pointer.pointee.size;
    if (size <= 0) this.unsupported(`不能对指向 ${typeText(pointer.pointee)} 的指针使用下标。`, node);
    const target = pointer.target + index * size;
    return this.derefPointer({ kind: 'pointer', target, pointee: pointer.pointee }, node);
  }

  private memberLValue(objectCell: Cell, memberName: string, node: ExprNode): LValue {
    if (objectCell.type.kind !== 'struct' && objectCell.type.kind !== 'union') {
      this.runtime(
        `成员访问（. / ->）的左侧必须是结构体或联合体，当前是 ${typeText(objectCell.type)}。`,
        node,
        '如果左侧是指针，请使用 ->；如果需要先转换指针类型，请使用类型转换。',
      );
    }
    const layoutIndex = (objectCell.type.fields ?? []).findIndex((field) => field.name === memberName);
    if (layoutIndex < 0) {
      this.runtime(`结构体 ${objectCell.type.name} 没有成员 "${memberName}"。`, node, '请检查成员名拼写。');
    }
    const fieldCell = objectCell.fields?.[layoutIndex];
    if (!fieldCell) this.runtime(`结构体 ${objectCell.type.name} 的成员 "${memberName}" 尚未初始化布局。`, node);
    return { cell: fieldCell };
  }

  // ----------------------------------------------------------------
  // 函数调用与内置函数
  // ----------------------------------------------------------------

  private evalCall(expr: ExprNode & { kind: 'Call' }): RValue {
    const callee = expr.callee;
    if (callee.kind !== 'Identifier') {
      this.unsupported(
        '暂不支持函数指针调用（被调用者不是函数名）。',
        expr,
        '解释器只支持直接按函数名调用；可以把函数指针改成普通函数调用。',
      );
    }
    const name = callee.name;
    const args = expr.args.map((argument) => this.evalExpr(argument));

    if (this.unsupportedMacros.has(name)) {
      const macro = this.unsupportedMacros.get(name)!;
      this.unsupported(`暂不支持宏 ${name}：${macro.reason}。`, expr, '函数式宏需要预处理器展开，请手工改写为普通代码。');
    }

    const userFunction = this.functions.get(name);
    if (userFunction) {
      if (name === 'main') {
        this.unsupported('不支持在代码中递归调用 main 函数。', expr, '请把逻辑拆分成独立函数。');
      }
      return this.invokeFunction(userFunction, args, expr, false);
    }

    switch (name) {
      case 'printf':
        return this.evalPrintf(expr, args);
      case 'puts':
        return this.evalPuts(expr, args);
      case 'putchar':
        return this.evalPutchar(expr, args);
      case 'malloc':
        return this.evalMalloc(expr, args);
      case 'free':
        return this.evalFree(expr, args);
      default:
        break;
    }

    const unsupportedReason = UNSUPPORTED_C_FUNCTIONS[name];
    if (unsupportedReason) {
      this.unsupported(`暂不支持函数 ${name}：${unsupportedReason}`, expr, UNSUPPORTED_FUNCTION_HINT);
    }
    if (this.declaredFunctions.has(name)) {
      this.unsupported(`函数 ${name} 只有声明、没有函数体，解释器无法执行。`, expr, '请补全函数定义，或把实现代码写进示例中。');
    }
    this.runtime(`未定义的函数 "${name}"。`, expr, '请检查函数名拼写，或确认函数是否在示例代码中定义。');
  }

  private evalMalloc(node: ExprNode, args: RValue[]): RValue {
    if (args.length !== 1) this.runtime('malloc 需要 1 个参数（字节数）。', node);
    const size = this.toInteger(args[0], node);
    if (size < 0) this.runtime(`malloc 的字节数不能为负数（当前为 ${size}）。`, node);
    const object = this.createHeapMemory(size, node);
    if (object.address < 0) return { kind: 'pointer', target: null, pointee: TYPE_VOID };
    return { kind: 'pointer', target: object.address, pointee: TYPE_VOID };
  }

  private evalFree(node: ExprNode, args: RValue[]): RValue {
    if (args.length !== 1) this.runtime('free 需要 1 个参数（malloc 返回的指针）。', node);
    const value = args[0];
    if (value.kind !== 'pointer') this.runtime('free 的参数必须是指针。', node);
    if (value.target === null) return { kind: 'int', value: 0 };
    const object = this.findHeapObject(value.target);
    if (!object || object.address !== value.target) {
      this.runtime('free 的参数不是 malloc 返回的堆内存起始地址。', node, '只能 free 由 malloc 分配、且尚未释放的指针。');
    }
    this.freeHeapObject(object, node);
    return { kind: 'int', value: 0 };
  }

  private evalPuts(node: ExprNode, args: RValue[]): RValue {
    if (args.length !== 1) this.runtime('puts 需要 1 个参数（字符串）。', node);
    const { text } = this.readStringFromValue(args[0], node);
    this.stdout += `${text}\n`;
    return { kind: 'int', value: text.length + 1 };
  }

  private evalPutchar(node: ExprNode, args: RValue[]): RValue {
    if (args.length !== 1) this.runtime('putchar 需要 1 个参数（字符编码）。', node);
    const code = this.toInteger(args[0], node) & 0xffff;
    this.stdout += String.fromCharCode(code);
    return { kind: 'int', value: code };
  }

  /** 从指针读取 C 字符串（遇到 NUL 结束） */
  private readStringFromValue(value: RValue, node: ExprNode): { text: string; codes: number[] } {
    if (value.kind !== 'pointer') this.runtime('这里需要一个字符串（char * 指针）。', node);
    if (value.target === null) this.runtime('字符串指针为 NULL，无法读取字符串。', node);
    // 数组退化得到的指针优先使用数组元素
    if (value.origin?.elements) {
      return this.readStringFromElements(value.origin.elements, node);
    }
    const object = this.findHeapObject(value.target);
    if (object && object.address === value.target && object.storage.elements) {
      return this.readStringFromElements(object.storage.elements, node);
    }
    const codes: number[] = [];
    let address = value.target;
    for (let guard = 0; guard < 4096; guard += 1) {
      const cell = this.cells.get(address);
      if (!cell) {
        this.runtime(
          `读取字符串时指针越界：地址 ${formatAddress(address)} 没有对应的内存单元（字符串缺少结尾的 '\\0'？）。`,
          node,
        );
      }
      if (!cell.initialized || cell.scalar?.kind !== 'int') {
        this.runtime(`读取字符串时遇到未初始化的字符（地址 ${formatAddress(address)}）。`, node);
      }
      const code = cell.scalar.value;
      if (code === 0) return { text: charCodesToString(codes), codes };
      codes.push(code);
      address += 1;
    }
    this.runtime('读取字符串时没有找到结尾的 \'\\0\'（超过 4096 个字符），已停止。', node);
  }

  private readStringFromElements(elements: Cell[], node: ExprNode): { text: string; codes: number[] } {
    const codes: number[] = [];
    for (const element of elements) {
      if (!element.initialized || element.scalar?.kind !== 'int') {
        this.runtime(`读取字符串时遇到未初始化的字符（${element.label}）。`, node, '字符串数组需要以 \'\\0\' 结尾并完成初始化。');
      }
      const code = element.scalar.value;
      if (code === 0) return { text: charCodesToString(codes), codes };
      codes.push(code);
    }
    this.runtime('读取字符串时没有找到结尾的 \'\\0\'。', node, '请确保 char 数组足够大且包含结尾的 NUL 字符。');
  }

  // ----------------------------------------------------------------
  // printf 格式化
  // ----------------------------------------------------------------

  private evalPrintf(node: ExprNode & { kind: 'Call' }, args: RValue[]): RValue {
    if (args.length < 1) this.runtime('printf 至少需要 1 个参数（格式字符串）。', node);
    const format = this.readStringFromValue(args[0], node).text;
    const text = this.formatPrintf(format, args.slice(1), node);
    this.stdout += text;
    return { kind: 'int', value: text.length };
  }

  private formatPrintf(format: string, args: RValue[], node: ExprNode): string {
    let result = '';
    let argIndex = 0;
    let index = 0;
    const nextArgument = (conversion: string): RValue => {
      if (argIndex >= args.length) {
        this.runtime(`printf 的格式串需要更多参数（缺少 %${conversion} 对应的参数）。`, node);
      }
      const value = args[argIndex];
      argIndex += 1;
      return value;
    };
    while (index < format.length) {
      const ch = format[index];
      if (ch !== '%') {
        result += ch;
        index += 1;
        continue;
      }
      index += 1;
      if (format[index] === '%') {
        result += '%';
        index += 1;
        continue;
      }
      // 解析标志、宽度、精度、长度修饰符
      let flags = '';
      while (index < format.length && /[-+0# ]/.test(format[index])) {
        flags += format[index];
        index += 1;
      }
      let widthText = '';
      while (index < format.length && /\d/.test(format[index])) {
        widthText += format[index];
        index += 1;
      }
      let precision: number | undefined;
      if (format[index] === '.') {
        index += 1;
        let precisionText = '';
        while (index < format.length && /\d/.test(format[index])) {
          precisionText += format[index];
          index += 1;
        }
        precision = precisionText ? Number.parseInt(precisionText, 10) : 0;
      }
      // 跳过长度修饰符（%ld、%lld、%zu 等，数值统一按 JS number 处理）
      while (index < format.length && /[hlLqjzt]/.test(format[index])) index += 1;
      const conversion = format[index] ?? '';
      index += 1;
      const width = widthText ? Number.parseInt(widthText, 10) : undefined;
      const spec: FormatSpec = { flags, width, precision };
      switch (conversion) {
        case 'd':
        case 'i': {
          const value = Math.trunc(this.numericArgument(nextArgument(conversion), conversion, node));
          result += padNumber(Math.abs(value).toString(), value < 0 ? '-' : '', '', spec);
          break;
        }
        case 'u': {
          const value = this.numericArgument(nextArgument(conversion), conversion, node) >>> 0;
          result += padNumber(String(value), '', '', spec);
          break;
        }
        case 'o': {
          const value = this.numericArgument(nextArgument(conversion), conversion, node) >>> 0;
          const prefix = flags.includes('#') && value !== 0 ? '0' : '';
          result += padNumber(value.toString(8), '', prefix, spec);
          break;
        }
        case 'x':
        case 'X': {
          const value = this.numericArgument(nextArgument(conversion), conversion, node) >>> 0;
          let digits = value.toString(16);
          if (conversion === 'X') digits = digits.toUpperCase();
          const prefix = flags.includes('#') && value !== 0 ? (conversion === 'X' ? '0X' : '0x') : '';
          result += padNumber(digits, '', prefix, spec);
          break;
        }
        case 'f':
        case 'F': {
          const value = this.numericArgument(nextArgument(conversion), conversion, node);
          result += formatFloatWithSpec(formatFixed(value, precision ?? 6), spec);
          break;
        }
        case 'e':
        case 'E': {
          const value = this.numericArgument(nextArgument(conversion), conversion, node);
          let text = formatExponential(value, precision ?? 6);
          if (conversion === 'E') text = text.toUpperCase();
          result += formatFloatWithSpec(text, spec);
          break;
        }
        case 'g':
        case 'G': {
          const value = this.numericArgument(nextArgument(conversion), conversion, node);
          let text = formatGeneral(value, precision ?? 6);
          if (conversion === 'G') text = text.toUpperCase();
          result += formatFloatWithSpec(text, spec);
          break;
        }
        case 'c': {
          const value = this.numericArgument(nextArgument(conversion), conversion, node);
          result += applyWidth(String.fromCharCode(value & 0xffff), width, flags);
          break;
        }
        case 's': {
          const value = nextArgument(conversion);
          let text = this.readStringFromValue(value, node).text;
          if (precision !== undefined) text = text.slice(0, precision);
          result += applyWidth(text, width, flags);
          break;
        }
        case 'p': {
          const value = nextArgument(conversion);
          let text: string;
          if (value.kind === 'pointer') {
            text = value.target === null ? '(nil)' : formatAddress(value.target);
          } else if (value.kind === 'int' && value.value === 0) {
            text = '(nil)';
          } else {
            this.runtime('%p 需要一个指针参数。', node);
          }
          result += applyWidth(text, width, flags);
          break;
        }
        case 'n':
          this.unsupported('printf 的 %n 格式符会写回内存，出于安全考虑暂不支持。', node);
          break;
        default:
          this.unsupported(
            `printf 的格式符 "%${conversion}" 暂不支持。`,
            node,
            '支持的格式符：%d %i %u %o %x %X %f %e %g %c %s %p %%',
          );
      }
    }
    if (argIndex < args.length) {
      this.addWarning(`printf 的格式串只使用了 ${argIndex} 个参数，多出的 ${args.length - argIndex} 个参数被忽略。`);
    }
    return result;
  }

  private numericArgument(value: RValue, conversion: string, node: ExprNode): number {
    if (value.kind === 'int') return value.value;
    if (value.kind === 'float') return value.value;
    this.runtime(`printf 的 %${conversion} 需要数值参数，但传入的是指针或结构体。`, node);
  }

  // ----------------------------------------------------------------
  // 语句执行
  // ----------------------------------------------------------------

  private execStatement(statement: StmtNode): void {
    switch (statement.kind) {
      case 'Block':
        this.execBlock(statement);
        return;
      case 'VarDecl':
        this.execVarDecl(statement, this.currentScope(), {});
        return;
      case 'ExprStmt':
        this.execExpressionStatement(statement);
        return;
      case 'EmptyStmt':
        return;
      case 'If':
        this.execIf(statement);
        return;
      case 'For':
        this.execFor(statement);
        return;
      case 'While':
        this.execWhile(statement);
        return;
      case 'DoWhile':
        this.execDoWhile(statement);
        return;
      case 'Switch':
        this.execSwitch(statement);
        return;
      case 'Return':
        this.execReturn(statement);
        return;
      case 'Break':
        this.execBreak(statement);
        return;
      case 'Continue':
        this.execContinue(statement);
        return;
      case 'Unknown':
        this.unsupported(
          `暂不支持执行这段代码：${statement.note}`,
          statement,
          `源码片段：${this.snippet(statement.range)}`,
        );
        return;
      default:
        return;
    }
  }

  private execBlock(statement: Extract<StmtNode, { kind: 'Block' }>): void {
    const scope = this.pushScope('block', `代码块（第 ${statement.range.startLine} 行）`);
    try {
      for (const child of statement.statements) this.execStatement(child);
    } finally {
      this.popScope(scope);
    }
  }

  private execExpressionStatement(statement: Extract<StmtNode, { kind: 'ExprStmt' }>): void {
    const before = this.stdout.length;
    const value = this.evalExpr(statement.expression);
    const delta = this.stdout.slice(before);
    if (delta.length > 0) {
      const callName = this.outputCallName(statement.expression);
      const prefix = callName ? `${callName} ` : '';
      this.record('output', statement, `${prefix}输出：${quoteText(delta)}`);
      return;
    }
    this.record('statement', statement, this.describeExpressionStatement(statement.expression, value));
  }

  private outputCallName(expr: ExprNode): string | undefined {
    if (expr.kind !== 'Call' || expr.callee.kind !== 'Identifier') return undefined;
    if (expr.callee.name === 'printf' || expr.callee.name === 'puts' || expr.callee.name === 'putchar') {
      return expr.callee.name;
    }
    return undefined;
  }

  private describeExpressionStatement(expr: ExprNode, value: RValue): string {
    if (expr.kind === 'Assign') {
      const target = this.snippet(expr.target.range);
      if (expr.op === '=') {
        return `执行赋值 ${target} = ${this.describeRValue(value)}`;
      }
      return `执行复合赋值 ${this.snippet(expr.range)}，结果为 ${this.describeRValue(value)}`;
    }
    if (expr.kind === 'Update') {
      // 后缀 ++/-- 的表达式结果是旧值，但界面上的变量已经变成新值；
      // 描述里优先使用单元格当前值，避免「快照说变为 3、面板显示 2」的不一致。
      const cell = expr.operand.kind === 'Identifier' ? this.lookupVariable(expr.operand.name) : undefined;
      const nextText = cell ? this.cellValueText(cell) : this.describeRValue(value);
      return `执行 ${this.snippet(expr.range)}（${this.snippet(expr.operand.range)} 变为 ${nextText}）`;
    }
    if (expr.kind === 'Call' && expr.callee.kind === 'Identifier') {
      const name = expr.callee.name;
      const functionNode = this.functions.get(name);
      const argsText = expr.args.map((argument) => this.snippet(argument.range)).join(', ');
      if (functionNode) {
        const returnType = this.resolveTypeRef(functionNode.returnType, functionNode.returnPointerDepth);
        if (returnType.kind === 'void') return `调用函数 ${name}(${argsText})`;
        return `调用函数 ${name}(${argsText})，返回 ${this.describeRValue(value, returnType)}`;
      }
      if (name === 'malloc' || name === 'free') {
        return `调用内置函数 ${name}(${argsText})，结果 ${this.describeRValue(value)}`;
      }
    }
    return `执行表达式 ${this.snippet(expr.range)}`;
  }

  private execVarDecl(
    node: VarDeclNode,
    scope: Scope,
    options: { suppressRecord?: boolean },
  ): Cell[] {
    const beforeOutput = this.stdout.length;
    const cells: Cell[] = [];
    for (const declarator of node.declarators) {
      const counts = this.resolveArrayCounts(declarator, declarator.initializer);
      const type = this.resolveTypeRef(node.type, declarator.pointerDepth, counts);
      this.ensureTypeSized(type);
      const cell = this.allocateVariable(type, scope, declarator.name.name, declarator.name.range.startLine);
      this.declareVariable(scope, declarator.name.name, cell, declarator.name);
      if (declarator.initializer) {
        this.initCellFromInitializer(cell, declarator.initializer, scope);
      } else if (scope.kind === 'global' || node.storage === 'static') {
        // 全局变量和 static 局部变量默认零初始化（static 不模拟跨调用持久化，仅按普通变量处理）
        this.zeroInit(cell);
      }
      cells.push(cell);
    }
    if (!options.suppressRecord) {
      const delta = this.stdout.slice(beforeOutput);
      let description = `声明 ${this.describeDeclarations(cells)}`;
      if (delta.length > 0) description += `，输出 ${quoteText(delta)}`;
      this.record('statement', node, description);
    }
    return cells;
  }

  private cellHasValue(cell: Cell): boolean {
    if (cell.elements) return cell.elements.some((element) => this.cellHasValue(element));
    if (cell.fields) return cell.fields.some((field) => this.cellHasValue(field));
    return cell.initialized;
  }

  private describeDeclarations(cells: Cell[]): string {
    return cells
      .map((cell) => {
        const head = `${typeText(cell.type)} ${cell.label}`;
        if (!this.cellHasValue(cell)) return `${head}（未初始化）`;
        return `${head} = ${this.cellValueText(cell)}`;
      })
      .join('、');
  }

  private execIf(statement: Extract<StmtNode, { kind: 'If' }>): void {
    const value = this.evalExpr(statement.test);
    const condition = this.truthiness(value, statement.test);
    const testText = this.snippet(statement.test.range);
    let description = `判断条件 ${testText} → ${condition ? '真' : '假'}`;
    if (condition) description += '，进入 if 分支';
    else if (statement.alternate) description += '，进入 else 分支';
    else description += '，跳过 if 语句';
    this.record('condition', statement.test, description);
    if (condition) {
      this.execStatement(statement.consequent);
    } else if (statement.alternate) {
      this.execStatement(statement.alternate);
    }
  }

  private execWhile(statement: Extract<StmtNode, { kind: 'While' }>): void {
    this.controlStack.push({ kind: 'loop', label: 'while 循环' });
    try {
      let round = 1;
      for (;;) {
        const value = this.evalExpr(statement.test);
        const testText = this.snippet(statement.test.range);
        if (!this.truthiness(value, statement.test)) {
          this.record('condition', statement.test, `判断 while 条件 ${testText} → 假，结束 while 循环`);
          return;
        }
        this.record('condition', statement.test, `判断 while 条件 ${testText} → 真，进入第 ${round} 轮循环`);
        try {
          this.execStatement(statement.body);
        } catch (signal) {
          if (signal instanceof ContinueSignal) {
            round += 1;
            continue;
          }
          if (signal instanceof BreakSignal) return;
          throw signal;
        }
        round += 1;
      }
    } finally {
      this.controlStack.pop();
    }
  }

  private execDoWhile(statement: Extract<StmtNode, { kind: 'DoWhile' }>): void {
    this.controlStack.push({ kind: 'loop', label: 'do-while 循环' });
    try {
      let round = 1;
      for (;;) {
        try {
          this.execStatement(statement.body);
        } catch (signal) {
          if (!(signal instanceof ContinueSignal)) {
            if (signal instanceof BreakSignal) return;
            throw signal;
          }
        }
        const value = this.evalExpr(statement.test);
        const testText = this.snippet(statement.test.range);
        if (!this.truthiness(value, statement.test)) {
          this.record('condition', statement.test, `判断 do-while 条件 ${testText} → 假，结束 do-while 循环`);
          return;
        }
        this.record('condition', statement.test, `判断 do-while 条件 ${testText} → 真，进入第 ${round + 1} 轮循环`);
        round += 1;
      }
    } finally {
      this.controlStack.pop();
    }
  }

  private execFor(statement: Extract<StmtNode, { kind: 'For' }>): void {
    const loopScope = this.pushScope('block', `for 循环（第 ${statement.range.startLine} 行）`);
    this.controlStack.push({ kind: 'loop', label: 'for 循环' });
    try {
      if (statement.init) {
        if (statement.init.kind === 'VarDecl') {
          const cells = this.execVarDecl(statement.init, loopScope, { suppressRecord: true });
          this.record('loop', statement.init, `for 循环初始化：声明 ${this.describeDeclarations(cells)}`);
        } else if (statement.init.kind === 'ExprStmt') {
          this.evalExpr(statement.init.expression);
          this.record('loop', statement.init, `for 循环初始化：执行 ${this.snippet(statement.init.expression.range)}`);
        }
      }
      let round = 1;
      for (;;) {
        if (statement.test) {
          const value = this.evalExpr(statement.test);
          const testText = this.snippet(statement.test.range);
          if (!this.truthiness(value, statement.test)) {
            this.record('condition', statement.test, `判断 for 条件 ${testText} → 假，结束 for 循环`);
            return;
          }
          this.record('condition', statement.test, `判断 for 条件 ${testText} → 真，进入第 ${round} 轮循环`);
        } else {
          this.record('condition', statement, `for 循环没有条件（视为永远为真），进入第 ${round} 轮循环`);
        }
        let stopped = false;
        try {
          this.execStatement(statement.body);
        } catch (signal) {
          if (signal instanceof BreakSignal) {
            stopped = true;
          } else if (!(signal instanceof ContinueSignal)) {
            throw signal;
          }
        }
        if (stopped) return;
        if (statement.update) {
          const value = this.evalExpr(statement.update);
          this.record(
            'loop',
            statement.update,
            `执行 for 更新表达式 ${this.snippet(statement.update.range)}（结果：${this.describeRValue(value)}）`,
          );
        }
        round += 1;
      }
    } finally {
      this.controlStack.pop();
      this.popScope(loopScope);
    }
  }

  private execSwitch(statement: Extract<StmtNode, { kind: 'Switch' }>): void {
    const discriminantValue = this.evalExpr(statement.discriminant);
    const discriminantNumber = this.toNumber(discriminantValue, statement.discriminant);
    const discriminantText = this.snippet(statement.discriminant.range);
    let matchedIndex = -1;
    let matchedLabel = '';
    let defaultIndex = -1;
    for (let index = 0; index < statement.clauses.length; index += 1) {
      const clause = statement.clauses[index];
      if (clause.isDefault) {
        if (defaultIndex < 0) defaultIndex = index;
        continue;
      }
      if (!clause.test) continue;
      const caseValue = this.evalExpr(clause.test);
      const caseNumber = this.toNumber(caseValue, clause.test);
      if (caseNumber === discriminantNumber) {
        matchedIndex = index;
        matchedLabel = `case ${this.snippet(clause.test.range)}`;
        break;
      }
    }
    if (matchedIndex < 0 && defaultIndex >= 0) {
      matchedIndex = defaultIndex;
      matchedLabel = 'default 分支';
    }
    if (matchedIndex < 0) {
      this.record(
        'condition',
        statement.discriminant,
        `switch 判断 ${discriminantText} = ${this.describeRValue(discriminantValue)}，没有匹配的 case，跳过 switch`,
      );
      return;
    }
    this.record(
      'condition',
      statement.discriminant,
      `switch 判断 ${discriminantText} = ${this.describeRValue(discriminantValue)}，进入 ${matchedLabel}`,
    );
    const switchScope = this.pushScope('block', `switch（第 ${statement.range.startLine} 行）`);
    this.controlStack.push({ kind: 'switch', label: 'switch' });
    try {
      for (let index = matchedIndex; index < statement.clauses.length; index += 1) {
        const clause = statement.clauses[index];
        if (index > matchedIndex && clause.statements.length > 0) {
          const label = clause.isDefault
            ? 'default'
            : clause.test
              ? `case ${this.snippet(clause.test.range)}`
              : '下一个 case';
          this.record('statement', clause.test ?? clause, `switch 贯穿：继续执行 ${label} 的语句`);
        }
        for (const child of clause.statements) this.execStatement(child);
      }
    } catch (signal) {
      if (!(signal instanceof BreakSignal)) throw signal;
    } finally {
      this.controlStack.pop();
      this.popScope(switchScope);
    }
  }

  private execReturn(statement: Extract<StmtNode, { kind: 'Return' }>): void {
    const frame = this.currentFrame();
    if (!frame) this.runtime('return 语句只能出现在函数内部。', statement);
    const value = statement.argument ? this.evalExpr(statement.argument) : undefined;
    const converted = this.coerceReturnValue(value, frame.returnType, statement);
    const returnText = converted ? this.describeRValue(converted, frame.returnType) : '（无返回值）';
    this.record('return', statement, `函数 ${frame.functionName} 返回 ${returnText}`);
    throw new ReturnSignal(converted);
  }

  private execBreak(statement: Extract<StmtNode, { kind: 'Break' }>): void {
    const context = this.controlStack[this.controlStack.length - 1];
    if (!context) {
      this.runtime('break 只能出现在循环或 switch 语句中。', statement, '请检查 break 的位置。');
    }
    const description =
      context.kind === 'switch' ? '执行 break，跳出 switch 语句' : `执行 break，跳出 ${context.label}`;
    this.record('statement', statement, description);
    throw new BreakSignal();
  }

  private execContinue(statement: Extract<StmtNode, { kind: 'Continue' }>): void {
    let loopLabel: string | undefined;
    for (let index = this.controlStack.length - 1; index >= 0; index -= 1) {
      if (this.controlStack[index].kind === 'loop') {
        loopLabel = this.controlStack[index].label;
        break;
      }
    }
    if (!loopLabel) {
      this.runtime('continue 只能出现在循环语句中。', statement, '请检查 continue 是否放在了循环内部。');
    }
    this.record('statement', statement, `执行 continue，跳过本轮剩余语句，进入下一轮 ${loopLabel}`);
    throw new ContinueSignal();
  }

  private describeRValue(value: RValue, type?: CType): string {
    if (value.kind === 'struct') return this.cellValueText(value.cell);
    if (value.kind === 'float') return formatNumber(value.value);
    if (value.kind === 'pointer') return value.target === null ? 'NULL' : formatAddress(value.target);
    if (type?.kind === 'char') return charText(value.value);
    return formatNumber(value.value);
  }

  private coerceReturnValue(
    value: RValue | undefined,
    returnType: CType,
    node: { range: SourceRange },
  ): RValue | undefined {
    if (returnType.kind === 'void') {
      if (value) this.addWarning('void 函数中出现带返回值的 return，返回值已被忽略。');
      return undefined;
    }
    if (!value) {
      this.runtime(
        `函数需要返回 ${typeText(returnType)} 类型的值，但 return 后面没有表达式。`,
        node,
        '请在 return 后面写返回值，例如 return 0;。',
      );
    }
    if (returnType.kind === 'struct' || returnType.kind === 'union') {
      if (value.kind !== 'struct') {
        this.runtime(`函数返回结构体类型 ${typeText(returnType)}，但返回值不是结构体。`, node);
      }
      return value;
    }
    return this.coerceScalar(value, returnType, node);
  }

  private defaultReturnValue(type: CType): RValue {
    if (type.kind === 'struct' || type.kind === 'union') {
      this.ensureTypeSized(type);
      const address = this.reserveStack(Math.max(type.size, 1), type.align);
      return { kind: 'struct', cell: this.buildStorage(type, address, '临时返回值', 'temporary') };
    }
    return this.zeroValueFor(type);
  }

  // ----------------------------------------------------------------
  // 函数调用
  // ----------------------------------------------------------------

  private resolveParamType(param: ParamNode): CType {
    let type = this.resolveTypeRef(param.type, param.pointerDepth);
    // 数组参数在 C 中退化为指向首元素的指针
    if (param.arrayDims.length > 0) type = makePointer(type);
    return type;
  }

  private invokeFunction(
    fn: FuncDeclNode,
    args: RValue[] | undefined,
    callNode: ExprNode | undefined,
    isMain: boolean,
  ): RValue {
    if (this.frames.length >= this.options.maxCallDepth) {
      this.runtime(
        `递归调用过深：函数 "${fn.name.name}" 的调用层数超过 ${this.options.maxCallDepth} 层。`,
        callNode ?? fn,
        '请检查递归函数是否有终止条件，或减小递归深度。',
      );
    }
    const body = fn.body;
    if (!body) {
      this.unsupported(`函数 ${fn.name.name} 没有函数体，无法执行。`, fn);
    }
    const returnType = this.resolveTypeRef(fn.returnType, fn.returnPointerDepth);
    this.ensureTypeSized(returnType);
    const scope = this.pushScope('function', `函数 ${fn.name.name}()`);
    const frame: Frame = {
      functionName: fn.name.name,
      scope,
      currentLine: fn.range.startLine,
      returnType,
    };
    let framePushed = false;
    try {
      const values = args ?? [];
      if (isMain) {
        this.bindMainParameters(fn, scope);
      } else {
        if (values.length !== fn.params.length) {
          this.runtime(
            `函数 ${fn.name.name} 需要 ${fn.params.length} 个参数，但调用时提供了 ${values.length} 个。`,
            callNode ?? fn,
            '请检查函数调用时参数个数是否与定义一致。',
          );
        }
        for (let index = 0; index < fn.params.length; index += 1) {
          this.bindParameter(fn.params[index], values[index], scope, callNode ?? fn);
        }
      }
      this.frames.push(frame);
      framePushed = true;
      const parameterText = isMain
        ? ''
        : fn.params
            .map((param, index) => `${param.name?.name ?? `arg${index + 1}`} = ${this.describeRValue(values[index])}`)
            .join('、');
      const description = isMain
        ? '进入入口函数 main()'
        : `进入函数 ${fn.name.name}(${values.map((value) => this.describeRValue(value)).join(', ')})${parameterText ? `，参数 ${parameterText}` : ''}`;
      this.record('call', fn, description);
      let returnValue: RValue | undefined;
      try {
        // 函数体顶层语句直接在函数作用域中执行，参数与局部变量会显示在同一个作用域里
        for (const child of body.statements) this.execStatement(child);
      } catch (signal) {
        if (signal instanceof ReturnSignal) returnValue = signal.value;
        else throw signal;
      }
      if (returnValue === undefined && returnType.kind !== 'void') {
        this.addWarning(`函数 ${fn.name.name} 没有执行 return 语句，返回值按类型默认值处理。`);
        returnValue = this.defaultReturnValue(returnType);
      }
      return returnValue ?? { kind: 'int', value: 0 };
    } finally {
      if (framePushed) this.frames.pop();
      this.popScope(scope);
    }
  }

  private bindParameter(
    param: ParamNode,
    value: RValue | undefined,
    scope: Scope,
    callNode: { range: SourceRange },
  ): void {
    const name = param.name?.name ?? `arg${scope.order.length + 1}`;
    const type = this.resolveParamType(param);
    this.ensureTypeSized(type);
    const cell = this.allocateVariable(type, scope, name, param.range.startLine);
    this.declareVariable(scope, name, cell, param);
    if (value === undefined) this.zeroInit(cell);
    else this.writeCell(cell, value, callNode);
  }

  /** main 的参数简化处理：argc = 1、argv = NULL（任务允许忽略命令行参数） */
  private bindMainParameters(fn: FuncDeclNode, scope: Scope): void {
    if (fn.params.length > 2) {
      this.addWarning('main 函数的参数个数不是标准的 0 或 2 个，已忽略多余参数。');
    }
    if (fn.params.length >= 2) {
      this.addWarning('main 的命令行参数已简化处理（argc = 1，argv = NULL）。');
    }
    for (let index = 0; index < fn.params.length; index += 1) {
      const param = fn.params[index];
      const name = param.name?.name ?? `arg${index + 1}`;
      const type = this.resolveParamType(param);
      this.ensureTypeSized(type);
      const cell = this.allocateVariable(type, scope, name, param.range.startLine);
      this.declareVariable(scope, name, cell, param);
      if (index === 0 && isIntegerType(type)) {
        this.writeCell(cell, { kind: 'int', value: 1 }, param);
      } else if (index === 1 && type.kind === 'pointer') {
        this.writeCell(cell, { kind: 'pointer', target: null, pointee: type.base ?? TYPE_VOID }, param);
      } else {
        this.zeroInit(cell);
      }
    }
  }

  // ----------------------------------------------------------------
  // 主流程
  // ----------------------------------------------------------------

  private initGlobals(): void {
    for (const item of this.program.items) {
      if (item.kind === 'VarDecl' && item.isGlobal) {
        this.execVarDecl(item, this.globalScope, { suppressRecord: true });
      }
    }
  }

  run(): ExecutionResult {
    const startedAt = Date.now();
    let errorInfo: ExecutionErrorInfo | undefined;
    let truncated = false;
    let status: ExecutionResult['status'] = 'ok';
    try {
      this.preflight();
      this.initGlobals();
      const mainFn = this.mainFn;
      if (!mainFn) throw new ExecutionFailure('runtime', '解释器内部错误：main 函数未找到。');
      const mainReturnType = this.resolveTypeRef(mainFn.returnType, mainFn.returnPointerDepth);
      this.record('start', mainFn, `开始执行程序，入口函数 main（第 ${mainFn.range.startLine} 行）`);
      const returnValue = this.invokeFunction(mainFn, undefined, undefined, true);
      const body = mainFn.body;
      let description = '程序执行结束';
      if (body && returnValue && mainReturnType.kind !== 'void') {
        description = `程序执行结束，main 返回 ${this.describeRValue(returnValue, mainReturnType)}`;
      }
      if (body) this.record('end', body, description, body.range.endLine);
    } catch (thrown) {
      const failure =
        thrown instanceof ExecutionFailure
          ? thrown
          : new ExecutionFailure(
              'runtime',
              `解释器内部错误：${thrown instanceof Error ? thrown.message : String(thrown)}`,
            );
      status = 'error';
      if (failure.kind === 'limit') truncated = true;
      const line = failure.line ?? this.lastLine;
      errorInfo = {
        message: failure.message,
        hint: failure.hint,
        line,
        range: failure.range,
        kind: failure.kind,
      };
      const description =
        failure.kind === 'limit'
          ? `执行中止：${failure.message}`
          : failure.kind === 'unsupported'
            ? `无法执行：${failure.message}`
            : `执行出错：${failure.message}`;
      try {
        this.recordRaw('error', line, failure.range, description);
      } catch {
        // 错误现场快照构建失败时忽略，不影响错误报告本身
      }
    }
    return {
      status,
      engine: ENGINE,
      reason: errorInfo?.kind === 'unsupported' ? errorInfo.message : undefined,
      snapshots: this.snapshots,
      stdout: this.stdout,
      error: errorInfo,
      truncated,
      entryFunction: this.mainFn ? 'main' : undefined,
      warnings: [...this.warnings],
      durationMs: Date.now() - startedAt,
    };
  }
}

// ==================================================================
// printf 格式化辅助（顶层函数，便于独立测试与复用）
// ==================================================================

type BinaryOpLike =
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

interface FormatSpec {
  flags: string;
  width?: number;
  precision?: number;
}

/** 数字格式化：处理符号、精度补零、宽度与对齐 */
function padNumber(digits: string, sign: string, prefix: string, spec: FormatSpec): string {
  let body = digits;
  if (spec.precision !== undefined) {
    if (spec.precision === 0 && body === '0') body = '';
    else body = body.padStart(spec.precision, '0');
  }
  let effectiveSign = sign;
  if (!effectiveSign && spec.flags.includes('+')) effectiveSign = '+';
  else if (!effectiveSign && spec.flags.includes(' ')) effectiveSign = ' ';
  const head = effectiveSign + prefix;
  const width = spec.width ?? 0;
  const total = head.length + body.length;
  if (total >= width) return head + body;
  const padding = width - total;
  if (spec.flags.includes('-')) return head + body + ' '.repeat(padding);
  if (spec.flags.includes('0')) return head + '0'.repeat(padding) + body;
  return ' '.repeat(padding) + head + body;
}

/** 字符串/字符宽度对齐（不做零填充） */
function applyWidth(text: string, width: number | undefined, flags: string): string {
  if (!width || text.length >= width) return text;
  return flags.includes('-') ? text.padEnd(width, ' ') : text.padStart(width, ' ');
}

/** 浮点数已带小数部分，宽度填充时不能再按整数补齐 */
function formatFloatWithSpec(text: string, spec: FormatSpec): string {
  const negative = text.startsWith('-');
  const explicitPlus = text.startsWith('+');
  const sign = negative ? '-' : explicitPlus ? '+' : '';
  const digits = negative || explicitPlus ? text.slice(1) : text;
  return padNumber(digits, sign, '', { flags: spec.flags, width: spec.width });
}

function formatFixed(value: number, precision: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  return value.toFixed(precision);
}

function formatExponential(value: number, precision: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  return value
    .toExponential(precision)
    .replace(/e([+-])(\d+)$/, (_match, sign: string, digits: string) => `e${sign}${digits.padStart(2, '0')}`);
}

function formatGeneral(value: number, precision: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  if (value === 0) return '0';
  const text = value.toPrecision(precision);
  if (/e/i.test(text)) {
    return text.replace(/e([+-])(\d+)$/, (_match, sign: string, digits: string) => `e${sign}${digits.padStart(2, '0')}`);
  }
  if (!text.includes('.')) return text;
  return text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

// ==================================================================
// 明确不支持的 C 标准库函数：调用时给出中文原因，不伪造结果
// ==================================================================

const UNSUPPORTED_FUNCTION_HINT =
  'CodeLens 解释器只支持 printf/puts/putchar、malloc/free 以及示例中自己定义的函数；其余标准库函数暂不支持。';

const UNSUPPORTED_C_FUNCTIONS: Record<string, string> = {
  scanf: '解释器没有标准输入，无法读取输入数据。可以把输入部分改成常量或直接给变量赋值。',
  fscanf: '解释器没有标准输入 / 文件，无法读取输入数据。',
  sscanf: '解释器暂不支持从字符串解析数据。',
  getchar: '解释器没有标准输入，无法读取字符。',
  getc: '解释器没有标准输入，无法读取字符。',
  gets: '解释器没有标准输入，无法读取字符串（且 gets 本身也不安全）。',
  fgets: '解释器没有文件 / 标准输入访问能力。',
  getline: '解释器没有标准输入访问能力。',
  fopen: '解释器没有文件系统访问能力，无法打开文件。',
  fclose: '解释器没有文件系统访问能力，无法关闭文件。',
  fread: '解释器没有文件系统访问能力，无法读取文件。',
  fwrite: '解释器没有文件系统访问能力，无法写入文件。',
  fprintf: '解释器没有文件系统访问能力，无法向文件输出。',
  sprintf: '解释器暂不支持 sprintf 字符串格式化，可以改用 printf 直接输出。',
  snprintf: '解释器暂不支持 snprintf 字符串格式化，可以改用 printf 直接输出。',
  fputs: '解释器没有文件系统访问能力，无法向文件输出。',
  fputc: '解释器没有文件系统访问能力，无法向文件输出。',
  fseek: '解释器没有文件系统访问能力。',
  ftell: '解释器没有文件系统访问能力。',
  fflush: '解释器没有文件系统访问能力。',
  remove: '解释器没有文件系统访问能力。',
  rename: '解释器没有文件系统访问能力。',
  perror: '解释器没有错误码 / 文件系统访问能力。',
  strcpy: '字符串库函数需要 C 标准库实现，暂不支持；可以改用字符数组逐字符赋值。',
  strncpy: '字符串库函数需要 C 标准库实现，暂不支持；可以改用字符数组逐字符赋值。',
  strcat: '字符串库函数需要 C 标准库实现，暂不支持；可以改用字符数组逐字符操作。',
  strncat: '字符串库函数需要 C 标准库实现，暂不支持。',
  strcmp: '字符串库函数需要 C 标准库实现，暂不支持；可以逐字符比较。',
  strncmp: '字符串库函数需要 C 标准库实现，暂不支持。',
  strlen: '字符串库函数需要 C 标准库实现，暂不支持；可以用循环统计字符数直到 \'\\0\'。',
  strchr: '字符串库函数需要 C 标准库实现，暂不支持。',
  strrchr: '字符串库函数需要 C 标准库实现，暂不支持。',
  strstr: '字符串库函数需要 C 标准库实现，暂不支持。',
  strtok: '字符串库函数需要 C 标准库实现，暂不支持。',
  strdup: '字符串库函数需要 C 标准库实现，暂不支持。',
  memcpy: '内存操作库函数暂不支持；可以改用循环逐个元素复制。',
  memmove: '内存操作库函数暂不支持；可以改用循环逐个元素复制。',
  memset: '内存操作库函数暂不支持；可以改用循环逐个元素赋值。',
  memcmp: '内存比较库函数暂不支持。',
  memchr: '内存查找库函数暂不支持。',
  atoi: '字符串转数字库函数暂不支持；可以手工解析字符。',
  atof: '字符串转数字库函数暂不支持；可以手工解析字符。',
  atol: '字符串转数字库函数暂不支持；可以手工解析字符。',
  itoa: '数字转字符串库函数暂不支持。',
  exit: 'exit 会终止程序，解释器暂不支持在示例中调用 exit。',
  abort: 'abort 会异常终止程序，解释器暂不支持。',
  system: '解释器不提供操作系统命令执行能力。',
  assert: 'assert 宏暂不支持；可以改写为 if 判断并输出错误。',
  rand: '随机数库函数暂不支持；可以使用固定数值让执行结果可复现。',
  srand: '随机数库函数暂不支持。',
  time: '时间库函数暂不支持。',
  clock: '时钟库函数暂不支持。',
  pow: '数学库函数暂不支持；可以改用乘方循环计算。',
  sqrt: '数学库函数暂不支持；当前示例可以改用其他算法。',
  sin: '数学库函数暂不支持。',
  cos: '数学库函数暂不支持。',
  tan: '数学库函数暂不支持。',
  floor: '数学库函数暂不支持。',
  ceil: '数学库函数暂不支持。',
  fabs: '数学库函数暂不支持。',
  abs: '数学库函数暂不支持；可以手写 if 判断。',
  qsort: '排序库函数暂不支持；可以手写排序算法。',
  bsearch: '查找库函数暂不支持；可以手写查找算法。',
  calloc: '暂不支持 calloc；可以使用 malloc 后再逐个初始化。',
  realloc: '暂不支持 realloc；可以重新 malloc 并复制数据。',
};

// ==================================================================
// 公共入口
// ==================================================================

/**
 * 执行一个已解析的 C 程序，返回逐行快照与最终结果。
 *
 * @param program parseC 产出的 AST（必须来自真实解析，不能手工伪造）
 * @param source  与 program 对应的 SourceFile，用于行号与源码片段
 * @param options 执行限制（步数、调用深度、堆大小）
 *
 * 约定：解释器绝不伪造执行结果；遇到不支持的语法/能力或运行期错误时，
 * status = 'error'，并在 error 中给出中文原因、行号与提示。
 */
export function executeC(
  program: ProgramNode,
  source: SourceFile,
  options: ExecuteOptions = {},
): ExecutionResult {
  const interpreter = new CInterpreter(program, source, options);
  return interpreter.run();
}
