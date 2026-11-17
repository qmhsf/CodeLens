/**
 * C 符号表与关联分析
 * ------------------------------------------------------------------
 * 作用：
 * 1. 为变量、参数、函数、结构体、typedef、成员建立符号，记录声明与所有使用位置；
 * 2. 做作用域解析（支持块级作用域与变量遮蔽）；
 * 3. 推断表达式类型，用于解析 `p->next` 这类成员访问，从而关联到结构体成员声明；
 * 4. 为语义高亮提供「标识符 → 符号 → 类别」的映射；
 * 5. 为右侧「关联代码」面板提供声明/使用位置列表。
 *
 * 这是纯静态分析，不执行代码；未声明的标识符不会被丢弃，而是归入
 * "未解析符号"，在界面上明确提示可能来自系统头文件或拼写错误。
 */
import {
  type CNodeIndex,
  type Declarator,
  type ExprNode,
  type FuncDeclNode,
  type IdentifierNode,
  type ParamNode,
  type ProgramNode,
  type StmtNode,
  type StructDeclNode,
  type StructFieldNode,
  type TypeRef,
  type TypedefNode,
  type VarDeclNode,
} from './ast';
import type { OccurrenceRole, SymbolInfo, SymbolKind, SymbolOccurrence } from './analysisTypes';
import type { SourceFile, SourceRange } from './source';

/** 推断出的表达式类型 */
export interface InferredType {
  /** 类型名，如 int、double、LNode、struct Node */
  name: string;
  /** 指针层数 */
  pointerDepth: number;
  /** 数组维度数量（>0 表示数组） */
  arrayDims?: number;
  /** 是否为 struct/union 类型 */
  isStruct?: boolean;
  /** 函数返回类型 */
  isFunction?: boolean;
}
interface Scope {
  id: string;
  name: string;
  kind: 'global' | 'function' | 'block';
  parent?: Scope;
  symbols: Map<string, string>;
}

export interface FieldLookupResult {
  symbolId: string;
  field: StructFieldNode;
  declarator: Declarator;
  type: InferredType;
}

export interface CSymbolTable {
  symbols: Record<string, SymbolInfo>;
  symbolList: SymbolInfo[];
  /** AST 标识符节点 id → 符号 id */
  identifierSymbols: Map<string, string>;
  /** AST 标识符节点 id → 使用角色 */
  identifierRoles: Map<string, OccurrenceRole>;
  /** 类型引用（用于高亮与关联面板） */
  typeReferences: { range: SourceRange; symbolId: string }[];
  /** 结构体节点 id → 成员名 → 字段符号 id */
  fieldSymbolsByStruct: Map<string, Map<string, string>>;
  /** 函数名 → 函数符号 id */
  functionSymbols: Map<string, string>;
  /** 结构体名 / typedef 别名 → 符号 id */
  structSymbols: Map<string, string>;
  /** 符号 id → 推断类型（变量、参数、函数返回值、成员） */
  symbolTypes: Map<string, InferredType>;
  /** 结构体节点 id + 成员名 → 推断类型 */
  fieldTypes: Map<string, InferredType>;
  inferType(expression: ExprNode | undefined): InferredType | undefined;
  getStruct(name: string | undefined): StructDeclNode | undefined;
  getField(structName: string | undefined, fieldName: string): FieldLookupResult | undefined;
  getSymbolForNode(nodeId: string): SymbolInfo | undefined;
  resolveAtOffset(offset: number): { symbolId: string; occurrence: SymbolOccurrence } | undefined;
  getSymbolType(symbolId: string | undefined): InferredType | undefined;
}

/** 常见系统类型：不在本段代码中定义，也不产生"未解析类型"噪音 */
const EXTERNAL_TYPE_NAMES = new Set([
  'FILE',
  'size_t',
  'ssize_t',
  'time_t',
  'clock_t',
  'uint8_t',
  'uint16_t',
  'uint32_t',
  'uint64_t',
  'int8_t',
  'int16_t',
  'int32_t',
  'int64_t',
  'va_list',
]);

/** 标注为"系统函数"的常见名称，用于解释未解析的调用 */
const COMMON_LIBRARY_FUNCTIONS = new Set([
  'printf',
  'scanf',
  'puts',
  'putchar',
  'getchar',
  'malloc',
  'calloc',
  'realloc',
  'free',
  'memset',
  'memcpy',
  'strlen',
  'strcpy',
  'strcmp',
  'strcat',
  'fopen',
  'fclose',
  'fprintf',
  'sprintf',
  'exit',
  'abs',
  'sqrt',
  'pow',
]);

/**
 * 构建 C 符号表。
 * @param program 语法树根节点
 * @param index AST 索引（提供结构体/typedef/函数索引）
 * @param source 源码对象（用于行列、片段）
 */
export function buildCSymbols(program: ProgramNode, index: CNodeIndex, source: SourceFile): CSymbolTable {
  return new CSymbolBuilder(program, index, source).build();
}

class CSymbolBuilder {
  private readonly program: ProgramNode;
  private readonly index: CNodeIndex;
  private readonly source: SourceFile;

  private symbols = new Map<string, SymbolInfo>();
  private symbolTypes = new Map<string, InferredType>();
  private identifierSymbols = new Map<string, string>();
  private identifierRoles = new Map<string, OccurrenceRole>();
  private typeReferences: { range: SourceRange; symbolId: string }[] = [];
  private fieldSymbolsByStruct = new Map<string, Map<string, string>>();
  private fieldTypes = new Map<string, InferredType>();
  private functionSymbols = new Map<string, string>();
  private structSymbols = new Map<string, string>();
  /** 类型名 → 符号 id（typedef 别名与 struct 标签） */
  private typeNames = new Map<string, string>();
  private occurrenceSeen = new Set<string>();
  private globalScope: Scope;
  private scopeCounter = 0;
  private symbolCounter = 0;
  /** 未解析符号：name → symbolId */
  private unresolvedNames = new Map<string, string>();

  constructor(program: ProgramNode, index: CNodeIndex, source: SourceFile) {
    this.program = program;
    this.index = index;
    this.source = source;
    this.globalScope = {
      id: 'scope-global',
      name: '全局作用域',
      kind: 'global',
      symbols: new Map(),
    };
  }

  build(): CSymbolTable {
    this.collectDeclarations();
    this.visitGlobalsAndFunctions();

    const symbolList = [...this.symbols.values()];
    // 排序：先按声明位置，再按名称，便于 UI 展示
    symbolList.sort((a, b) => {
      const aStart = a.declaration?.range.start ?? Number.MAX_SAFE_INTEGER;
      const bStart = b.declaration?.range.start ?? Number.MAX_SAFE_INTEGER;
      if (aStart !== bStart) return aStart - bStart;
      return a.name.localeCompare(b.name);
    });

    const table: CSymbolTable = {
      symbols: Object.fromEntries(symbolList.map((symbol) => [symbol.id, symbol])),
      symbolList,
      identifierSymbols: this.identifierSymbols,
      identifierRoles: this.identifierRoles,
      typeReferences: this.typeReferences,
      fieldSymbolsByStruct: this.fieldSymbolsByStruct,
      functionSymbols: this.functionSymbols,
      structSymbols: this.structSymbols,
      symbolTypes: this.symbolTypes,
      fieldTypes: this.fieldTypes,
      inferType: (expression) => this.inferType(expression),
      getStruct: (name) => this.getStruct(name),
      getField: (structName, fieldName) => this.getField(structName, fieldName),
      getSymbolForNode: (nodeId) => {
        const symbolId = this.identifierSymbols.get(nodeId);
        return symbolId ? this.symbols.get(symbolId) : undefined;
      },
      resolveAtOffset: (offset) => this.resolveAtOffset(offset),
      getSymbolType: (symbolId) => (symbolId ? this.symbolTypes.get(symbolId) : undefined),
    };
    return table;
  }

  // ---------------------------------------------------------------
  // 第一阶段：收集所有声明（类型、函数、全局变量）
  // ---------------------------------------------------------------

  private collectDeclarations(): void {
    for (const item of this.program.items) {
      switch (item.kind) {
        case 'StructDecl':
          this.declareStruct(item);
          break;
        case 'Typedef':
          this.declareTypedef(item);
          break;
        case 'FuncDecl':
          this.declareFunction(item);
          break;
        case 'VarDecl':
          this.declareVarDecl(item, this.globalScope, true);
          break;
        case 'Unknown':
          break;
        default:
          break;
      }
    }
  }

  private declareStruct(node: StructDeclNode): void {
    const displayName = node.tag?.name ?? node.typedefNames[0]?.name ?? `匿名${node.isEnum ? '枚举' : '结构体'}`;
    const kind: SymbolKind = node.isEnum ? 'enum' : 'struct';
    const symbolId = this.createSymbol({
      name: displayName,
      kind,
      typeText: node.isEnum ? `enum ${displayName}` : `${node.isUnion ? 'union' : 'struct'} ${displayName}`,
      detail: this.structDetail(node),
      isPointer: false,
      scopeName: '全局作用域',
    });

    if (node.tag) {
      this.addDeclarationOccurrence(symbolId, node.tag);
      this.structSymbols.set(node.tag.name, symbolId);
      this.typeNames.set(node.tag.name, symbolId);
    }

    for (const alias of node.typedefNames) {
      if (alias.name === displayName) {
        this.addDeclarationOccurrence(symbolId, alias, 'typedef 别名');
        this.typeNames.set(alias.name, symbolId);
        continue;
      }
      const aliasSymbolId = this.createSymbol({
        name: alias.name,
        kind: 'typedef',
        typeText: node.isEnum ? `enum ${displayName}` : `${node.isUnion ? 'union' : 'struct'} ${displayName}`,
        detail: `typedef 别名，指向${node.isEnum ? '枚举' : '结构体'} ${displayName}`,
        scopeName: '全局作用域',
      });
      this.addDeclarationOccurrence(aliasSymbolId, alias);
      this.typeNames.set(alias.name, aliasSymbolId);
      this.structSymbols.set(alias.name, aliasSymbolId);
    }

    // 结构体成员
    const fieldMap = new Map<string, string>();
    for (const field of node.fields) {
      for (const declarator of field.declarators) {
        const fieldName = declarator.name.name;
        const type = this.typeOfTypeRef(field.type, declarator);
        const fieldSymbolId = this.createSymbol({
          name: fieldName,
          kind: 'field',
          typeText: this.formatTypeText(field.type, declarator),
          detail: node.isEnum
            ? `枚举 ${displayName} 的成员`
            : `${node.isUnion ? '联合体' : '结构体'} ${displayName} 的成员`,
          isPointer: declarator.pointerDepth > 0,
          scopeName: displayName,
        });
        this.addDeclarationOccurrence(fieldSymbolId, declarator.name);
        fieldMap.set(fieldName, fieldSymbolId);
        this.fieldTypes.set(`${node.id}.${fieldName}`, type);
        // 成员类型里的结构体引用也要建立关联
        this.addTypeUse(field.type);
      }
    }
    this.fieldSymbolsByStruct.set(node.id, fieldMap);
  }

  private declareTypedef(node: TypedefNode): void {
    const alias = node.alias;
    // 若别名与已有 struct 名相同，则复用结构体符号（typedef struct Node {...} Node;）
    const structSymbol = node.target.isStruct && node.target.structTag ? this.structSymbols.get(node.target.structTag) : undefined;
    if (structSymbol && alias.name === node.target.structTag) {
      this.addDeclarationOccurrence(structSymbol, alias, 'typedef 别名');
      this.typeNames.set(alias.name, structSymbol);
      return;
    }
    const existing = this.typeNames.get(alias.name);
    const symbolId =
      existing ??
      this.createSymbol({
        name: alias.name,
        kind: 'typedef',
        typeText: `${node.target.name}${' *'.repeat(node.pointerDepth)}`,
        detail: 'typedef 定义的类型别名',
        isPointer: node.pointerDepth > 0,
        scopeName: '全局作用域',
      });
    if (!existing) this.addDeclarationOccurrence(symbolId, alias);
    this.typeNames.set(alias.name, symbolId);
    this.addTypeUse(node.target);
  }

  private declareFunction(node: FuncDeclNode): void {
    const signature = this.functionSignature(node);
    const symbolId = this.createSymbol({
      name: node.name.name,
      kind: 'function',
      typeText: signature,
      detail: node.isDefinition ? '函数定义' : '函数声明（原型）',
      isPointer: false,
      scopeName: '全局作用域',
    });
    this.addDeclarationOccurrence(symbolId, node.name);
    this.functionSymbols.set(node.name.name, symbolId);
    this.globalScope.symbols.set(node.name.name, symbolId);
    this.symbolTypes.set(symbolId, {
      name: node.returnType.name,
      pointerDepth: node.returnPointerDepth,
      isStruct: node.returnType.isStruct,
      isFunction: true,
    });
    this.addTypeUse(node.returnType);
    for (const param of node.params) {
      this.addTypeUse(param.type);
    }
  }

  private declareVarDecl(node: VarDeclNode, scope: Scope, isGlobal: boolean): void {
    this.addTypeUse(node.type);
    for (const declarator of node.declarators) {
      const symbolId = this.createSymbol({
        name: declarator.name.name,
        kind: 'variable',
        typeText: this.formatTypeText(node.type, declarator),
        detail: isGlobal ? '全局变量' : '局部变量',
        isPointer: declarator.pointerDepth > 0 || declarator.arrayDims.length > 0,
        scopeName: scope.name,
      });
      this.addDeclarationOccurrence(symbolId, declarator.name);
      scope.symbols.set(declarator.name.name, symbolId);
      this.symbolTypes.set(symbolId, this.typeOfTypeRef(node.type, declarator));
    }
  }

  // ---------------------------------------------------------------
  // 第二阶段：遍历函数体与初始化表达式，解析引用
  // ---------------------------------------------------------------

  private visitGlobalsAndFunctions(): void {
    // 全局变量初始化表达式
    for (const item of this.program.items) {
      if (item.kind === 'VarDecl') {
        for (const declarator of item.declarators) {
          if (declarator.initializer) this.visitExpression(declarator.initializer, this.globalScope);
        }
      }
      if (item.kind === 'FuncDecl') {
        this.visitFunction(item);
      }
    }
  }

  private visitFunction(node: FuncDeclNode): void {
    if (!node.body) return;
    const functionScope: Scope = {
      id: this.nextScopeId('function'),
      name: `函数 ${node.name.name}`,
      kind: 'function',
      parent: this.globalScope,
      symbols: new Map(),
    };
    // 参数
    for (const param of node.params) {
      if (!param.name) continue;
      const symbolId = this.createSymbol({
        name: param.name.name,
        kind: 'parameter',
        typeText: this.formatParamType(param),
        detail: `函数 ${node.name.name} 的参数`,
        isPointer: param.pointerDepth > 0,
        scopeName: functionScope.name,
      });
      this.addDeclarationOccurrence(symbolId, param.name);
      functionScope.symbols.set(param.name.name, symbolId);
      this.symbolTypes.set(symbolId, {
        name: param.type.name,
        pointerDepth: param.pointerDepth,
        arrayDims: param.arrayDims.length || undefined,
        isStruct: param.type.isStruct,
      });
      this.addTypeUse(param.type);
    }
    // 函数体（Block 会再创建一个块作用域，参数仍能通过作用域链访问）
    this.visitStatement(node.body, functionScope);
  }

  private visitStatement(statement: StmtNode, scope: Scope): void {
    switch (statement.kind) {
      case 'Block': {
        const blockScope: Scope = {
          id: this.nextScopeId('block'),
          name: '代码块',
          kind: 'block',
          parent: scope,
          symbols: new Map(),
        };
        for (const child of statement.statements) this.visitStatement(child, blockScope);
        return;
      }
      case 'VarDecl':
        this.declareVarDecl(statement, scope, false);
        for (const declarator of statement.declarators) {
          if (declarator.initializer) this.visitExpression(declarator.initializer, scope);
        }
        return;
      case 'ExprStmt':
        this.visitExpression(statement.expression, scope);
        return;
      case 'If':
        this.visitExpression(statement.test, scope);
        this.visitStatement(statement.consequent, scope);
        if (statement.alternate) this.visitStatement(statement.alternate, scope);
        return;
      case 'For': {
        const loopScope: Scope = {
          id: this.nextScopeId('for'),
          name: 'for 循环',
          kind: 'block',
          parent: scope,
          symbols: new Map(),
        };
        if (statement.init) this.visitStatement(statement.init, loopScope);
        if (statement.test) this.visitExpression(statement.test, loopScope);
        if (statement.update) this.visitExpression(statement.update, loopScope);
        this.visitStatement(statement.body, loopScope);
        return;
      }
      case 'While':
        this.visitExpression(statement.test, scope);
        this.visitStatement(statement.body, scope);
        return;
      case 'DoWhile':
        this.visitStatement(statement.body, scope);
        this.visitExpression(statement.test, scope);
        return;
      case 'Switch': {
        const switchScope: Scope = {
          id: this.nextScopeId('switch'),
          name: 'switch 分支',
          kind: 'block',
          parent: scope,
          symbols: new Map(),
        };
        this.visitExpression(statement.discriminant, scope);
        for (const clause of statement.clauses) {
          if (clause.test) this.visitExpression(clause.test, switchScope);
          for (const child of clause.statements) this.visitStatement(child, switchScope);
        }
        return;
      }
      case 'Return':
        if (statement.argument) this.visitExpression(statement.argument, scope);
        return;
      case 'Unknown':
        return;
      default:
        return;
    }
  }

  private visitExpression(expression: ExprNode, scope: Scope): InferredType | undefined {
    switch (expression.kind) {
      case 'Identifier': {
        const role: OccurrenceRole = 'reference';
        this.resolveIdentifier(expression, scope, role);
        return this.inferType(expression);
      }
      case 'Literal':
        return this.inferType(expression);
      case 'Binary':
        this.visitExpression(expression.left, scope);
        this.visitExpression(expression.right, scope);
        return this.inferType(expression);
      case 'Unary':
        this.visitExpression(expression.operand, scope);
        return this.inferType(expression);
      case 'Update':
        this.visitExpression(expression.operand, scope);
        return this.inferType(expression.operand);
      case 'Assign':
        this.visitExpression(expression.target, scope);
        this.visitExpression(expression.value, scope);
        return this.inferType(expression.target);
      case 'Call': {
        // 函数调用：被调用标识符使用 call 角色
        if (expression.callee.kind === 'Identifier') {
          this.resolveIdentifier(expression.callee, scope, 'call');
        } else {
          this.visitExpression(expression.callee, scope);
        }
        for (const argument of expression.args) this.visitExpression(argument, scope);
        return this.inferType(expression);
      }
      case 'Index':
        this.visitExpression(expression.base, scope);
        this.visitExpression(expression.index, scope);
        return this.inferType(expression);
      case 'Member': {
        this.visitExpression(expression.object, scope);
        this.resolveMember(expression);
        return this.inferType(expression);
      }
      case 'Conditional':
        this.visitExpression(expression.test, scope);
        this.visitExpression(expression.consequent, scope);
        this.visitExpression(expression.alternate, scope);
        return this.inferType(expression);
      case 'Cast':
        this.addTypeUse(expression.type);
        this.visitExpression(expression.expr, scope);
        return this.inferType(expression);
      case 'Sizeof':
        if (expression.typeName) this.addTypeUse(expression.typeName);
        if (expression.operand) this.visitExpression(expression.operand, scope);
        return this.inferType(expression);
      case 'Comma':
        for (const item of expression.items) this.visitExpression(item, scope);
        return this.inferType(expression);
      case 'InitList':
        for (const element of expression.elements) this.visitExpression(element, scope);
        return undefined;
      default:
        return undefined;
    }
  }

  /** 解析标识符：优先当前作用域链，找不到则归入未解析符号 */
  private resolveIdentifier(node: IdentifierNode, scope: Scope, role: OccurrenceRole): string {
    let cursor: Scope | undefined = scope;
    let symbolId: string | undefined;
    while (cursor) {
      const found = cursor.symbols.get(node.name);
      if (found) {
        symbolId = found;
        break;
      }
      cursor = cursor.parent;
    }

    if (!symbolId) {
      symbolId = this.getUnresolvedSymbol(node.name, role);
    }

    this.identifierSymbols.set(node.id, symbolId);
    this.identifierRoles.set(node.id, role);
    this.addOccurrence(symbolId, {
      range: node.range,
      nodeId: node.id,
      role,
    });
    return symbolId;
  }

  /** 解析结构体成员访问（. 或 ->），把成员名关联到结构体字段声明 */
  private resolveMember(expression: Extract<ExprNode, { kind: 'Member' }>): void {
    const objectType = this.inferType(expression.object);
    const structName = objectType?.name;
    if (!structName) return;
    const lookup = this.getField(structName, expression.member.name);
    if (lookup) {
      this.identifierSymbols.set(expression.member.id, lookup.symbolId);
      this.identifierRoles.set(expression.member.id, 'member');
      this.addOccurrence(lookup.symbolId, {
        range: expression.member.range,
        nodeId: expression.member.id,
        role: 'member',
      });
    } else {
      // 找不到成员：作为未解析符号提示，不伪造字段类型
      const symbolId = this.getUnresolvedSymbol(`${structName}.${expression.member.name}`, 'member');
      this.identifierSymbols.set(expression.member.id, symbolId);
      this.identifierRoles.set(expression.member.id, 'member');
      this.addOccurrence(symbolId, {
        range: expression.member.range,
        nodeId: expression.member.id,
        role: 'member',
      });
    }
  }

  // ---------------------------------------------------------------
  // 类型推断
  // ---------------------------------------------------------------

  private inferType(expression: ExprNode | undefined): InferredType | undefined {
    if (!expression) return undefined;
    switch (expression.kind) {
      case 'Identifier': {
        const symbolId = this.identifierSymbols.get(expression.id);
        return symbolId ? this.symbolTypes.get(symbolId) : undefined;
      }
      case 'Literal': {
        if (expression.literalKind === 'string') return { name: 'char', pointerDepth: 1 };
        if (expression.literalKind === 'char') return { name: 'char', pointerDepth: 0 };
        if (expression.literalKind === 'float') return { name: 'double', pointerDepth: 0 };
        if (expression.literalKind === 'bool') return { name: 'int', pointerDepth: 0 };
        if (expression.literalKind === 'null') return { name: 'void', pointerDepth: 1 };
        return { name: 'int', pointerDepth: 0 };
      }
      case 'Assign':
        return this.inferType(expression.target);
      case 'Unary': {
        const operand = this.inferType(expression.operand);
        if (!operand) return undefined;
        if (expression.op === '&') {
          return { ...operand, pointerDepth: operand.pointerDepth + 1 };
        }
        if (expression.op === '*') {
          if (operand.pointerDepth > 0) {
            return { ...operand, pointerDepth: operand.pointerDepth - 1 };
          }
          if (operand.arrayDims && operand.arrayDims > 0) {
            return { ...operand, arrayDims: operand.arrayDims - 1 };
          }
          return undefined;
        }
        return { name: 'int', pointerDepth: 0 };
      }
      case 'Update':
        return this.inferType(expression.operand);
      case 'Index': {
        const base = this.inferType(expression.base);
        if (!base) return undefined;
        if (base.arrayDims && base.arrayDims > 0) {
          return { ...base, arrayDims: base.arrayDims - 1 };
        }
        if (base.pointerDepth > 0) {
          return { ...base, pointerDepth: base.pointerDepth - 1 };
        }
        return undefined;
      }
      case 'Member': {
        const objectType = this.inferType(expression.object);
        if (!objectType) return undefined;
        const lookup = this.getField(objectType.name, expression.member.name);
        return lookup?.type;
      }
      case 'Call': {
        if (expression.callee.kind === 'Identifier') {
          const symbolId = this.identifierSymbols.get(expression.callee.id);
          if (symbolId) return this.symbolTypes.get(symbolId);
        }
        return undefined;
      }
      case 'Cast':
        return { name: expression.type.name, pointerDepth: expression.pointerDepth, isStruct: expression.type.isStruct };
      case 'Conditional':
        return this.inferType(expression.consequent) ?? this.inferType(expression.alternate);
      case 'Binary': {
        const left = this.inferType(expression.left);
        const right = this.inferType(expression.right);
        const numeric = ['==', '!=', '<', '<=', '>', '>=', '&&', '||'].includes(expression.op);
        if (numeric) return { name: 'int', pointerDepth: 0 };
        if (left?.name === 'double' || right?.name === 'double' || left?.name === 'float' || right?.name === 'float') {
          return { name: 'double', pointerDepth: 0 };
        }
        if (left && left.pointerDepth > 0 && (expression.op === '+' || expression.op === '-')) {
          return left;
        }
        return { name: 'int', pointerDepth: 0 };
      }
      case 'Sizeof':
        // sizeof 结果是 size_t，这里按 int 展示更贴近初学者理解
        return { name: 'int', pointerDepth: 0 };
      case 'Comma':
        return this.inferType(expression.items[expression.items.length - 1]);
      default:
        return undefined;
    }
  }

  private typeOfTypeRef(type: TypeRef, declarator: Declarator): InferredType {
    return {
      name: type.name,
      pointerDepth: declarator.pointerDepth,
      arrayDims: declarator.arrayDims.length || undefined,
      isStruct: type.isStruct,
    };
  }

  // ---------------------------------------------------------------
  // 结构体 / 类型查找
  // ---------------------------------------------------------------

  getStruct(name: string | undefined): StructDeclNode | undefined {
    if (!name) return undefined;
    const candidates = [name, name.replace(/^(struct|union|enum)\s+/, '')];
    for (const candidate of candidates) {
      const direct = this.index.structs.get(candidate);
      if (direct) return direct;
      const typedef = this.index.typedefs.get(candidate);
      if (typedef?.target.isStruct && typedef.target.structTag) {
        const viaTypedef = this.index.structs.get(typedef.target.structTag);
        if (viaTypedef) return viaTypedef;
      }
    }
    return undefined;
  }

  getField(structName: string | undefined, fieldName: string): FieldLookupResult | undefined {
    const struct = this.getStruct(structName);
    if (!struct) return undefined;
    const fieldMap = this.fieldSymbolsByStruct.get(struct.id);
    const symbolId = fieldMap?.get(fieldName);
    if (!symbolId) return undefined;
    for (const field of struct.fields) {
      for (const declarator of field.declarators) {
        if (declarator.name.name === fieldName) {
          return {
            symbolId,
            field,
            declarator,
            type: this.fieldTypes.get(`${struct.id}.${fieldName}`) ?? {
              name: field.type.name,
              pointerDepth: declarator.pointerDepth,
              arrayDims: declarator.arrayDims.length || undefined,
              isStruct: field.type.isStruct,
            },
          };
        }
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------
  // 符号与使用位置的底层操作
  // ---------------------------------------------------------------

  private createSymbol(input: {
    name: string;
    kind: SymbolKind;
    typeText?: string;
    detail?: string;
    isPointer?: boolean;
    scopeName?: string;
  }): string {
    this.symbolCounter += 1;
    const id = `sym${this.symbolCounter}_${input.name}`;
    const symbol: SymbolInfo = {
      id,
      name: input.name,
      kind: input.kind,
      occurrences: [],
      typeText: input.typeText,
      detail: input.detail,
      isPointer: input.isPointer,
      scopeName: input.scopeName,
    };
    this.symbols.set(id, symbol);
    return id;
  }

  private addDeclarationOccurrence(symbolId: string, node: IdentifierNode, note?: string): void {
    this.identifierSymbols.set(node.id, symbolId);
    this.identifierRoles.set(node.id, 'declaration');
    this.addOccurrence(symbolId, {
      range: node.range,
      nodeId: node.id,
      role: 'declaration',
    });
    if (note) {
      const symbol = this.symbols.get(symbolId);
      if (symbol && !symbol.detail) symbol.detail = note;
    }
    const symbol = this.symbols.get(symbolId);
    if (symbol && !symbol.declaration) {
      symbol.declaration = {
        range: node.range,
        nodeId: node.id,
        line: node.range.startLine,
        snippet: this.snippet(node.range),
      };
    }
  }

  private addOccurrence(
    symbolId: string,
    input: { range: SourceRange; nodeId?: string; role: OccurrenceRole },
  ): void {
    const symbol = this.symbols.get(symbolId);
    if (!symbol) return;
    const key = `${symbolId}:${input.range.start}:${input.range.end}:${input.role}`;
    if (this.occurrenceSeen.has(key)) return;
    this.occurrenceSeen.add(key);
    symbol.occurrences.push({
      range: input.range,
      nodeId: input.nodeId,
      role: input.role,
      line: input.range.startLine,
      snippet: this.snippet(input.range),
    });
    if (symbol.occurrences.length > 1) {
      symbol.occurrences.sort((a, b) => a.range.start - b.range.start);
    }
  }

  private getUnresolvedSymbol(name: string, role: OccurrenceRole): string {
    const key = `${name}@${COMMON_LIBRARY_FUNCTIONS.has(name) ? 'lib' : role === 'call' ? 'call' : 'unknown'}`;
    const existing = this.unresolvedNames.get(key);
    if (existing) return existing;
    const isLibrary = COMMON_LIBRARY_FUNCTIONS.has(name);
    const symbolId = this.createSymbol({
      name,
      kind: 'unknown',
      detail: isLibrary
        ? '未在本段代码中声明，可能是标准库函数（需要包含对应头文件）'
        : role === 'call'
          ? '调用了未在本段代码中声明的函数'
          : '未在本段代码中找到声明（可能来自系统头文件，或存在拼写错误）',
      scopeName: '未解析',
    });
    this.unresolvedNames.set(key, symbolId);
    return symbolId;
  }

  /** 记录类型名使用位置（用于关联面板与蓝色高亮） */
  private addTypeUse(type: TypeRef): void {
    if (!type || !type.isCustom) return;
    const lookupName = type.isStruct && type.structTag ? type.structTag : type.name;
    if (!lookupName) return;
    const symbolId = this.typeNames.get(lookupName);
    if (symbolId) {
      this.addTypeUseRange(type.range, symbolId);
      return;
    }
    if (EXTERNAL_TYPE_NAMES.has(lookupName)) return;
    // 未解析类型：建立提示性符号
    const unresolved = this.getUnresolvedSymbol(`类型 ${lookupName}`, 'reference');
    const symbol = this.symbols.get(unresolved);
    if (symbol && !symbol.typeText) symbol.typeText = '未解析的类型名';
    this.addTypeUseRange(type.range, unresolved);
  }

  private addTypeUseRange(range: SourceRange, symbolId: string): void {
    const key = `${symbolId}:${range.start}:${range.end}:type`;
    if (this.occurrenceSeen.has(key)) return;
    this.occurrenceSeen.add(key);
    this.typeReferences.push({ range, symbolId });
    const symbol = this.symbols.get(symbolId);
    if (symbol) {
      symbol.occurrences.push({
        range,
        role: 'type',
        line: range.startLine,
        snippet: this.snippet(range),
      });
      symbol.occurrences.sort((a, b) => a.range.start - b.range.start);
    }
  }

  /** 根据源码偏移查找符号（点击关联面板跳转后定位） */
  private resolveAtOffset(offset: number): { symbolId: string; occurrence: SymbolOccurrence } | undefined {
    for (const symbol of this.symbols.values()) {
      for (const occurrence of symbol.occurrences) {
        if (offset >= occurrence.range.start && offset <= occurrence.range.end) {
          return { symbolId: symbol.id, occurrence };
        }
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------
  // 格式化辅助
  // ---------------------------------------------------------------

  private structDetail(node: StructDeclNode): string {
    const base = node.isEnum ? '枚举定义' : node.isUnion ? '联合体定义' : '结构体定义';
    const fields = node.fields.reduce((sum, field) => sum + field.declarators.length, 0);
    return `${base}，包含 ${fields} 个成员`;
  }

  private formatTypeText(type: TypeRef, declarator: Declarator): string {
    const dims = declarator.arrayDims.map((dim) => (dim ? `[${this.source.slice(dim.range)}]` : '[]')).join('');
    return `${type.name}${' *'.repeat(declarator.pointerDepth)}${dims}`;
  }

  private formatParamType(param: ParamNode): string {
    const dims = param.arrayDims.map((dim) => (dim ? `[${this.source.slice(dim.range)}]` : '[]')).join('');
    return `${param.type.name}${' *'.repeat(param.pointerDepth)}${dims}`;
  }

  private functionSignature(node: FuncDeclNode): string {
    const params = node.params
      .map((param) => {
        const name = param.name ? ` ${param.name.name}` : '';
        const dims = param.arrayDims.map(() => '[]').join('');
        return `${param.type.name}${' *'.repeat(param.pointerDepth)}${name}${dims}`;
      })
      .join(', ');
    const returnType = `${node.returnType.name}${' *'.repeat(node.returnPointerDepth)}`;
    return `${returnType} ${node.name.name}(${params || 'void'})`;
  }

  private snippet(range: SourceRange): string {
    const line = this.source.lineText(range.startLine).trim();
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
  }

  private nextScopeId(kind: string): string {
    this.scopeCounter += 1;
    return `scope-${kind}-${this.scopeCounter}`;
  }
}
