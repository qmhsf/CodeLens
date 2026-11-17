/**
 * C / C++ 代码释义生成器（规则驱动，不依赖 AI）
 * ------------------------------------------------------------------
 * 根据 AST 节点、符号表与源码，生成面向初学者的中文解释：
 * 组成拆解、整体释义、实际用途、关联代码、常见误解、生活类比、进阶原理。
 * 三种解释深度（beginner / intermediate / advanced）在文案上有不同侧重。
 */
import {
  buildIndex,
  findDeepestNodeAt,
  getChildren,
  type CNode,
  type CNodeIndex,
  type Declarator,
  type FuncDeclNode,
  type IdentifierNode,
  type ParamNode,
  type ProgramNode,
  type StructDeclNode,
  type StructFieldNode,
  type TypeRef,
  type TypedefNode,
  type VarDeclNode,
} from '../ast';
import type { AnalysisResult, SymbolInfo } from '../analysisTypes';
import { SourceFile, type SourceRange } from '../source';
import { buildCSymbols, type CSymbolTable, type InferredType } from '../symbols';
import type { ExplainLevel, ExplainPart, ExplainRelationGroup, Explanation, HoverInfo } from './types';

interface CContext {
  analysis: AnalysisResult;
  program: ProgramNode;
  index: CNodeIndex;
  symbols: CSymbolTable;
  source: SourceFile;
  level: ExplainLevel;
}

// 释义模块内部缓存符号表：同一份分析结果多次点击时无需重复构建
let cachedAnalysisId = '';
let cachedSymbols: CSymbolTable | undefined;
let cachedIndex: CNodeIndex | undefined;

function getContext(analysis: AnalysisResult, level: ExplainLevel): CContext | null {
  if (!analysis.program || !analysis.cIndex) return null;
  const source = new SourceFile(analysis.source);
  if (cachedAnalysisId !== analysis.id || !cachedSymbols) {
    cachedSymbols = buildCSymbols(analysis.program, analysis.cIndex, source);
    cachedAnalysisId = analysis.id;
    cachedIndex = analysis.cIndex;
  }
  return {
    analysis,
    program: analysis.program,
    index: cachedIndex ?? buildIndex(analysis.program),
    symbols: cachedSymbols,
    source,
    level,
  };
}

/**
 * 根据点击位置找到"最适合解释"的 AST 节点。
 * 点击声明中的变量名时，会上升到整个声明节点（例如 LNode *p;），
 * 从而展示完整的声明拆解。
 */
export function pickCExplainableNode(analysis: AnalysisResult, offset: number): CNode | undefined {
  const context = getContext(analysis, 'beginner');
  if (!context) return undefined;
  const deepest = findDeepestNodeAt(context.program, offset);
  if (!deepest) return undefined;

  if (deepest.kind === 'Identifier') {
    const role = context.symbols.identifierRoles.get(deepest.id);
    if (role === 'declaration') {
      const declaration = findDeclarationAncestor(context.index, deepest);
      if (declaration) return declaration;
    }
    // 点击函数调用的被调用者时，展示整个调用表达式（包含实参与返回说明）
    const parent = context.index.parent.get(deepest.id);
    if (role === 'call' && parent?.kind === 'Call' && parent.callee.id === deepest.id) {
      return parent;
    }
  }
  return deepest;
}

/** 向上查找标识符所属的声明节点 */
function findDeclarationAncestor(index: CNodeIndex, node: CNode): CNode | undefined {
  let current: CNode | undefined = index.parent.get(node.id);
  while (current) {
    switch (current.kind) {
      case 'VarDecl':
      case 'Param':
      case 'FuncDecl':
      case 'StructDecl':
      case 'Typedef':
      case 'StructField':
        return current;
      case 'Program':
        return undefined;
      default:
        current = index.parent.get(current.id);
    }
  }
  return undefined;
}

/** 从点击位置生成完整释义 */
export function explainCAt(analysis: AnalysisResult, offset: number, level: ExplainLevel): Explanation | null {
  const node = pickCExplainableNode(analysis, offset);
  if (!node) return null;
  return explainCNode(analysis, node, level);
}

/** 根据节点 id 生成完整释义（结构树点击使用） */
export function explainCNodeById(analysis: AnalysisResult, nodeId: string, level: ExplainLevel): Explanation | null {
  const context = getContext(analysis, level);
  if (!context) return null;
  const node = analysis.cIndex?.byId.get(nodeId);
  if (!node) return null;
  return buildExplanation(context, node);
}

/** 根据节点对象生成完整释义 */
export function explainCNode(analysis: AnalysisResult, node: CNode, level: ExplainLevel): Explanation | null {
  const context = getContext(analysis, level);
  if (!context) return null;
  return buildExplanation(context, node);
}

/** 生成悬停提示（轻量，不构建完整面板内容） */
export function hoverCAt(analysis: AnalysisResult, offset: number): HoverInfo | null {
  const context = getContext(analysis, 'beginner');
  if (!context) return null;
  const node = pickCExplainableNode(analysis, offset);
  if (!node) return null;

  if (node.kind === 'Identifier') {
    const symbol = context.symbols.getSymbolForNode(node.id);
    if (symbol) {
      const kindLabel = symbolKindLabel(symbol);
      const typeInfo = context.symbols.getSymbolType(symbol.id);
      const badge = symbol.typeText ?? (typeInfo ? formatInferredType(typeInfo) : undefined);
      return {
        title: `${kindLabel}「${symbol.name}」`,
        badge,
        summary: hoverSummaryForSymbol(symbol, context),
        hint: '点击查看完整释义与关联代码',
        symbolKind: kindLabel,
      };
    }
  }

  const meta = nodeTitleMeta(node, context);
  return {
    title: meta.title,
    badge: meta.badge,
    summary: meta.summary,
    hint: '点击查看完整释义',
  };
}

function hoverSummaryForSymbol(symbol: SymbolInfo, context: CContext): string {
  const typeInfo = context.symbols.getSymbolType(symbol.id);
  const occurrences = symbol.occurrences.length;
  if (symbol.kind === 'function') return `${symbol.detail ?? '函数'}，${occurrences} 处出现`;
  if (symbol.kind === 'unknown') return symbol.detail ?? '未在本段代码中找到声明';
  if (symbol.kind === 'field') {
    const typeText = symbol.typeText ?? '成员';
    return `${typeText} 类型的结构体成员，共 ${occurrences} 处出现`;
  }
  const inferred = typeInfo ? formatInferredType(typeInfo) : symbol.typeText ?? '';
  return `${inferred}${inferred ? ' 类型的' : ''}${symbolDetailLabel(symbol)}，共 ${occurrences} 处出现`;
}

function nodeTitleMeta(node: CNode, context: CContext): { title: string; badge?: string; summary: string } {
  const snippet = snippetOf(context.source, node.range, 80);
  switch (node.kind) {
    case 'VarDecl':
      return { title: '变量声明', badge: '声明', summary: `${variableTitle(node, context)}：${snippet}` };
    case 'FuncDecl':
      return {
        title: node.isDefinition ? `函数定义「${node.name.name}」` : `函数声明「${node.name.name}」`,
        badge: node.isDefinition ? '函数' : '原型',
        summary: node.isDefinition ? '一段可以被重复调用的代码，包含参数、函数体和返回值' : '提前告诉编译器函数的参数与返回值类型',
      };
    case 'StructDecl':
      return { title: `${node.isEnum ? '枚举' : node.isUnion ? '联合体' : '结构体'}定义`, badge: '自定义类型', summary: snippet };
    case 'If':
      return { title: '条件判断 if', badge: '控制结构', summary: '根据条件是否成立，选择执行不同的代码分支' };
    case 'For':
      return { title: 'for 循环', badge: '循环', summary: snippet };
    case 'While':
      return { title: 'while 循环', badge: '循环', summary: snippet };
    case 'DoWhile':
      return { title: 'do-while 循环', badge: '循环', summary: '先执行一次循环体，再判断是否继续' };
    case 'Switch':
      return { title: 'switch 多分支', badge: '控制结构', summary: snippet };
    case 'Return':
      return { title: 'return 返回语句', badge: '函数控制', summary: snippet };
    case 'Call':
      return { title: '函数调用', badge: '函数', summary: snippet };
    case 'Assign':
      return { title: '赋值语句', badge: '运算', summary: snippet };
    case 'Binary':
      return { title: '二元运算表达式', badge: '表达式', summary: snippet };
    case 'Unary':
      return {
        title: node.op === '*' ? '指针解引用' : node.op === '&' ? '取地址运算' : '一元运算',
        badge: '表达式',
        summary: snippet,
      };
    case 'Member':
      return { title: node.arrow ? '指针成员访问 p->x' : '结构体成员访问 s.x', badge: '成员访问', summary: snippet };
    case 'Index':
      return { title: '数组下标访问', badge: '数组', summary: snippet };
    case 'Identifier':
      return { title: '标识符', badge: '名称', summary: snippet };
    case 'Literal':
      return { title: literalTitle(node.literalKind), badge: '字面量', summary: snippet };
    case 'Block':
      return { title: '代码块', badge: '作用域', summary: `包含 ${node.statements.length} 条语句` };
    case 'Program':
      return { title: '程序', badge: '整体', summary: '整个代码文件，由若干顶层声明组成' };
    case 'Preprocessor':
      return { title: `预处理指令 #${node.directive}`, badge: '预处理', summary: snippet };
    case 'Comment':
      return { title: '注释', badge: '说明', summary: snippet };
    case 'ExprStmt':
      return { title: '表达式语句', badge: '语句', summary: snippet };
    case 'Update':
      return { title: node.op === '++' ? '自增运算 ++' : '自减运算 --', badge: '运算', summary: snippet };
    case 'Conditional':
      return { title: '三元表达式 ?:', badge: '表达式', summary: snippet };
    case 'Cast':
      return { title: '类型转换', badge: '类型', summary: snippet };
    case 'Sizeof':
      return { title: 'sizeof 内存大小运算', badge: '内存', summary: snippet };
    case 'StructField':
      return { title: '结构体成员声明', badge: '成员', summary: snippet };
    case 'Param':
      return { title: '函数参数', badge: '参数', summary: snippet };
    case 'Typedef':
      return { title: '类型别名 typedef', badge: '类型', summary: snippet };
    default:
      return { title: '代码片段', badge: '片段', summary: snippet };
  }
}

// -------------------------------------------------------------------
// 主分发
// -------------------------------------------------------------------

function buildExplanation(context: CContext, node: CNode): Explanation {
  const explanation = buildExplanationInner(context, node);
  // 跨多行的结构（函数、循环、结构体等）保留换行，阅读更接近源码
  if (explanation.range && explanation.range.endLine > explanation.range.startLine) {
    explanation.snippet = multilineSnippet(context.source, explanation.range);
  }
  return explanation;
}

function buildExplanationInner(context: CContext, node: CNode): Explanation {
  switch (node.kind) {
    case 'Program':
      return explainProgram(context, node);
    case 'VarDecl':
      return explainVarDecl(context, node);
    case 'FuncDecl':
      return explainFunction(context, node);
    case 'Param':
      return explainParam(context, node);
    case 'StructDecl':
      return explainStruct(context, node);
    case 'StructField':
      return explainStructField(context, node);
    case 'Typedef':
      return explainTypedef(context, node);
    case 'Preprocessor':
      return explainPreprocessor(context, node);
    case 'Comment':
      return explainComment(context, node);
    case 'Block':
      return explainBlock(context, node);
    case 'ExprStmt':
      return explainExprStmt(context, node);
    case 'If':
      return explainIf(context, node);
    case 'For':
      return explainFor(context, node);
    case 'While':
      return explainWhile(context, node);
    case 'DoWhile':
      return explainDoWhile(context, node);
    case 'Switch':
      return explainSwitch(context, node);
    case 'CaseClause':
      return explainCaseClause(context, node);
    case 'Return':
      return explainReturn(context, node);
    case 'Break':
      return explainBreak(context, node);
    case 'Continue':
      return explainContinue(context, node);
    case 'Identifier':
      return explainIdentifier(context, node);
    case 'Literal':
      return explainLiteral(context, node);
    case 'Binary':
      return explainBinary(context, node);
    case 'Unary':
      return explainUnary(context, node);
    case 'Update':
      return explainUpdate(context, node);
    case 'Assign':
      return explainAssign(context, node);
    case 'Call':
      return explainCall(context, node);
    case 'Index':
      return explainIndex(context, node);
    case 'Member':
      return explainMember(context, node);
    case 'Conditional':
      return explainConditional(context, node);
    case 'Cast':
      return explainCast(context, node);
    case 'Sizeof':
      return explainSizeof(context, node);
    case 'Comma':
      return explainComma(context, node);
    case 'InitList':
      return explainInitList(context, node);
    case 'EmptyStmt':
      return explainEmptyStatement(context, node);
    case 'Unknown':
      return explainUnknown(context, node);
    default:
      return explainFallback(context, node);
  }
}

// -------------------------------------------------------------------
// 顶层结构
// -------------------------------------------------------------------

function explainProgram(context: CContext, node: ProgramNode): Explanation {
  const items = node.items.filter((item) => item.kind !== 'Comment');
  const functions = items.filter((item): item is FuncDeclNode => item.kind === 'FuncDecl');
  const main = functions.find((fn) => fn.name.name === 'main' && fn.isDefinition);
  const composition: ExplainPart[] = items.slice(0, 12).map((item) => ({
    text: snippetOf(context.source, item.range, 70),
    role: topLevelRole(item),
    category: 'control',
    detail: undefined,
  }));
  if (items.length > 12) {
    composition.push({ text: `……还有 ${items.length - 12} 个顶层结构`, role: '省略' });
  }
  return {
    title: '整个程序',
    codeType: '程序结构',
    snippet: items.length ? `共 ${items.length} 个顶层结构，${functions.filter((fn) => fn.isDefinition).length} 个函数定义` : '空代码',
    range: node.range,
    nodeId: node.id,
    composition,
    meaning:
      context.level === 'beginner'
        ? '这一整段代码就是一个程序。程序会从 main 函数开始，一行一行按顺序执行里面的语句。'
        : '程序由预处理指令、类型定义、全局变量与函数组成。C 程序从 main 函数入口开始执行，函数之间通过参数、返回值和全局变量协作。',
    purpose: '把解决一个问题的步骤，用计算机能执行的语句组织起来。',
    why: '源代码需要被编译器翻译成机器能执行的指令；结构化地组织声明与函数，能让程序更容易阅读、测试和修改。',
    relations: [
      {
        title: '顶层结构',
        items: items.map((item) => ({
          label: `${topLevelRole(item)}：${snippetOf(context.source, item.range, 70)}`,
          line: item.range.startLine,
          range: item.range,
        })),
      },
      ...(main
        ? [
            {
              title: '程序入口',
              items: [{ label: `main 函数定义在第 ${main.range.startLine} 行`, line: main.range.startLine, range: main.range }],
            },
          ]
        : []),
    ],
    pitfalls: [
      main ? '程序从 main 开始执行，其他函数只有在被调用时才会运行。' : '这个文件里没有 main 函数，它可能是被其他文件调用的库代码，或者只是练习片段。',
      '函数、变量需要先声明后使用（或者先写函数原型），否则编译器会报错。',
    ],
    analogy: '整个程序就像一本菜谱：main 是"今天要做哪道菜"的入口，其他函数是一道道可复用的步骤。',
    advanced:
      context.level === 'advanced'
        ? '编译过程分为预处理、编译、汇编、链接几个阶段；源文件最终由链接器与库函数合并成可执行文件。运行时，main 由 C 运行时启动代码调用，函数调用会使用调用栈保存返回地址与局部变量。'
        : undefined,
    level: context.level,
    tags: ['程序结构', 'C 语言'],
  };
}

function topLevelRole(item: CNode): string {
  switch (item.kind) {
    case 'Preprocessor':
      return `预处理 #${item.directive}`;
    case 'StructDecl':
      return item.isEnum ? '枚举定义' : '结构体定义';
    case 'Typedef':
      return '类型别名';
    case 'FuncDecl':
      return item.isDefinition ? `函数定义 ${item.name.name}` : `函数声明 ${item.name.name}`;
    case 'VarDecl':
      return '全局变量声明';
    case 'Unknown':
      return '未解析片段';
    default:
      return '结构';
  }
}

// -------------------------------------------------------------------
// 声明相关
// -------------------------------------------------------------------

function explainVarDecl(context: CContext, node: VarDeclNode): Explanation {
  const { source, symbols, level } = context;
  const declarator = node.declarators[0];
  const name = declarator.name.name;
  const pointerDepth = declarator.pointerDepth;
  const isArray = declarator.arrayDims.length > 0;
  const isPointer = pointerDepth > 0;
  const typeText = formatType(node.type, declarator);
  const isStruct = node.type.isStruct || Boolean(symbols.getStruct(node.type.name));

  const title = isPointer
    ? pointerDepth >= 2
      ? '多级指针变量声明'
      : '指针变量声明'
    : isArray
      ? '数组变量声明'
      : isStruct
        ? '结构体变量声明'
        : '变量声明';

  const composition: ExplainPart[] = [];
  composition.push({
    text: node.type.raw.trim(),
    role: '数据类型',
    category: 'type',
    detail: isStruct
      ? '这是一个结构体/自定义类型，代表一组字段的集合'
      : '规定变量可以保存什么种类的数据',
  });
  node.declarators.forEach((decl, index) => {
    if (node.declarators.length > 1) {
      composition.push({ text: `第 ${index + 1} 个变量`, role: '声明项', category: 'data' });
    }
    for (const star of decl.pointerStars) {
      composition.push({
        text: source.slice(star),
        role: '指针声明符',
        category: 'pointer',
        detail: '这里的 * 表示变量保存的是地址，不是普通的值；它不是乘法运算符',
      });
    }
    if (decl.isReference) {
      composition.push({ text: '&', role: '引用声明符', category: 'pointer', detail: 'C++ 引用，相当于变量的别名' });
    }
    composition.push({ text: decl.name.name, role: '变量名', category: 'data', detail: '程序员给这块数据起的名字' });
    for (const dim of decl.arrayDims) {
      composition.push({
        text: dim ? `[${source.slice(dim.range)}]` : '[]',
        role: '数组维度',
        category: 'data',
        detail: dim ? '表示数组可以容纳的元素数量' : '长度由初始化内容自动推断',
      });
    }
    if (decl.initializer) {
      composition.push({
        text: source.slice(decl.initializer.range),
        role: '初始值',
        category: 'operator',
        detail: '变量创建时先赋的值；没有初始化时，局部变量的内容是未定义的',
      });
    }
    if (node.declarators.length > 1 && index < node.declarators.length - 1) {
      composition.push({ text: ',', role: '分隔符', category: 'punctuation' });
    }
  });
  composition.push({ text: ';', role: '语句结束符', category: 'punctuation', detail: 'C 语言中声明必须以分号结束' });

  const baseMeaning = isPointer
    ? `声明一个名为 ${name} 的指针变量，类型是 ${typeText}。它专门用来保存某个 ${node.type.name} 类型数据的内存地址。`
    : isArray
      ? `声明一个名为 ${name} 的数组，类型是 ${typeText}，可以连续存放 ${declarator.arrayDims.length} 维数据。`
      : `声明一个名为 ${name} 的变量，类型是 ${typeText}，用来保存 ${node.type.name} 类型的数据。`;

  const meaning =
    level === 'beginner'
      ? baseMeaning
      : level === 'intermediate'
        ? `${baseMeaning} 声明语句会让编译器在内存中分配空间，并把名字 ${name} 与这块空间绑定。${isPointer ? '指针的值是一个地址，必须指向有效对象后才能通过 * 或 -> 访问。' : ''}${isArray ? '数组名在多数表达式中会退化为指向首元素的指针。' : ''}`
        : `${baseMeaning} 声明只决定类型与作用域，不保证初始化。${isPointer ? '在 64 位平台上指针通常占 8 字节，存放的是虚拟地址；未初始化的指针是野指针，解引用属于未定义行为。' : ''}${isArray ? '数组元素在栈或静态存储区连续排列，数组名不能重新赋值，但可以参与指针运算。' : ''}`;

  const purpose = isPointer
    ? `让 ${name} 保存对象地址，从而可以间接访问/修改目标数据；在函数传参时也常用指针来避免复制大对象，或让函数修改调用者的数据。`
    : isArray
      ? '把多个同类型数据连续存起来，通过下标快速访问，适合存放一组有顺序关系的数据。'
      : isStruct
        ? '把多个相关字段打包成一个整体，便于用一个变量管理一条完整的数据（例如一个链表节点、一名学生）。'
        : '保存程序运行过程中需要记住的数据，例如计数、临时结果、用户输入等。';

  const why = isPointer
    ? '指针是 C 语言的核心能力：它让程序能够共享、链接和动态管理数据。链表的 next、函数的输出参数、malloc 分配的节点都依赖指针。'
    : isArray
      ? '很多问题天然是"一组数据"而不是单个值；数组让这些数据有统一的访问方式，也便于配合循环处理。'
      : '变量是程序记忆数据的基本单位。没有变量，计算结果只能在表达式里一闪而过，无法参与后续逻辑。';

  const pitfalls: string[] = [];
  if (isPointer) {
    pitfalls.push(
      `${name} 本身不是 ${node.type.name} 对象，而是一个保存地址的变量。`,
      '未初始化的指针不能直接使用；使用前要让它指向有效对象（`p = &x;` 或 `p = malloc(...);`）。',
      '声明中的 `*` 与表达式里的 `*` 含义不同：`int *p;` 的 * 表示"指针类型"，`*p` 的 * 表示"取出地址里的值"。',
    );
    if (node.declarators.length > 1) {
      pitfalls.push('`int *a, b;` 中只有 a 是指针，b 是普通 int。多个变量混写时容易出现这种误读。');
    }
  } else if (isArray) {
    pitfalls.push(
      'C 数组下标从 0 开始，最后一个元素是 `长度 - 1`，越界访问不会自动检查。',
      '数组名不是普通变量，不能被整体赋值；它的值在表达式中通常等价于首元素地址。',
    );
  } else {
    pitfalls.push('声明但未初始化的局部变量内容是随机的，使用前应先赋值。', 'C 语言要求变量先声明后使用，名字区分大小写。');
    if (node.declarators.length > 1) {
      pitfalls.push('一条语句声明多个变量时，要确认每个变量各自的初始化是否正确。');
    }
  }

  const analogy = isPointer
    ? '变量像一个房间，指针像写着房间号的门牌。`p` 保存的是"门牌号"，`*p` 才是顺着门牌号找到房间里的东西。'
    : isArray
      ? '数组像一排连续的储物柜，编号从 0 开始；`a[2]` 表示打开第 2 号柜子（实际是第三个）。'
      : isStruct
        ? '结构体像一张表格模板，结构体变量就是按模板填好的一张表。'
        : '变量像一个贴了标签的盒子，可以反复放入新东西，但盒子的类型决定了能放什么。';

  const relations: ExplainRelationGroup[] = [];
  for (const decl of node.declarators) {
    const symbol = symbols.getSymbolForNode(decl.name.id);
    if (symbol) relations.push(...symbolRelations(context, symbol));
  }
  const struct = symbols.getStruct(node.type.name);
  if (struct) relations.push(structFieldsRelation(context, struct));
  const firstSymbol = symbols.getSymbolForNode(node.declarators[0]?.name.id ?? '');
  if (struct && isPointer) {
    relations.push({
      title: '链表关键点',
      items: struct.fields
        .filter((field) => field.declarators.some(() => Boolean(symbols.getStruct(field.type.name))))
        .map((field) => ({
          label: `成员 ${field.declarators[0]?.name.name} 是指向同类型结构体的指针，常用于把节点串起来`,
          line: field.range.startLine,
          range: field.range,
        })),
    });
  }

  return {
    title,
    codeType: '变量声明',
    snippet: snippetOf(source, node.range, 180),
    range: node.range,
    nodeId: node.id,
    composition,
    meaning,
    purpose,
    why,
    relations,
    pitfalls,
    analogy,
    advanced:
      level === 'advanced'
        ? isPointer
          ? `指针对象本身有地址（用 &${name} 获取），它的值是目标对象的地址。` +
            `通过 p->data 访问时，编译器按结构体字段偏移从地址处读取数据。指针的类型决定了编译器一次读取多少字节，以及如何解释这些字节。` +
            `野指针、悬空指针（free 后仍被使用）和越界写入都是 C 中常见的严重错误。`
          : isArray
            ? '数组在内存中连续存放，元素地址可以通过首地址 + 下标 × 元素大小计算。数组名参与表达式时退化为指向首元素的指针，因此可以作为参数传给指针类型的形参。'
            : isStruct
              ? `结构体变量通常存放在栈或静态存储区；成员之间可能因对齐规则插入填充字节，所以 sizeof(struct) 不一定等于各成员大小之和。`
              : '局部变量通常分配在调用栈上，函数返回后空间自动回收；全局变量在程序启动时分配，生命周期贯穿整个程序。'
        : undefined,
    level,
    tags: ['变量声明', isPointer ? '指针' : isArray ? '数组' : isStruct ? '结构体' : '基础语法'],
    symbol: firstSymbol,
  };
}

function explainParam(context: CContext, node: ParamNode): Explanation {
  const { source, symbols, level } = context;
  const name = node.name?.name ?? '（匿名参数）';
  const typeText = `${node.type.name}${' *'.repeat(node.pointerDepth)}`;
  const isPointer = node.pointerDepth > 0;
  const isArray = node.arrayDims.length > 0;
  const functionNode = context.index.parent.get(node.id);
  const functionName = functionNode?.kind === 'FuncDecl' ? functionNode.name.name : '函数';

  const composition: ExplainPart[] = [
    { text: node.type.raw.trim(), role: '参数类型', category: 'type' },
    ...node.pointerStars.map((star) => ({
      text: source.slice(star),
      role: '指针声明符',
      category: 'pointer' as const,
      detail: '表示函数接收的是一个地址，而不是值本身',
    })),
    { text: name, role: '参数名', category: 'data' },
  ];

  const symbol = node.name ? symbols.getSymbolForNode(node.name.id) : undefined;

  return {
    title: '函数参数',
    codeType: '参数声明',
    snippet: snippetOf(source, node.range, 120),
    range: node.range,
    nodeId: node.id,
    composition,
    meaning:
      level === 'beginner'
        ? `这是函数 ${functionName} 的入口之一：调用函数时，外面传进来的值会交给参数 ${name} 使用。`
        : level === 'intermediate'
          ? `声明函数 ${functionName} 的形式参数 ${name}，类型为 ${typeText}。C 语言默认按值传递：调用时会复制实参的值给形参；${isPointer || isArray ? '由于是指针/数组，复制的是地址，因此函数可以通过它修改调用者的数据。' : '函数内部修改形参不会影响调用者的变量。'}`
          : `形参 ${name} 的类型是 ${typeText}，在函数调用时由实参初始化，生命周期从进入函数开始到函数返回结束。${isPointer ? '指针形参传递的是地址值，函数内部通过解引用可以访问调用者栈帧或堆上的数据。' : ''}`,
    purpose: `让函数能够接收外部数据，从而对不同的输入做相同的处理，提高代码复用性。`,
    why: '如果把所有数据都写在函数内部，函数就只能处理一种情况。参数让函数变成"可配置的步骤"。',
    relations: symbol ? symbolRelations(context, symbol) : [],
    pitfalls: [
      isPointer || isArray
        ? '指针/数组参数传递的是地址，函数内部修改会影响调用者；要确认这是不是你想要的。'
        : 'C 语言按值传递。函数内部修改形参，不会改变调用者传入的变量。',
      isArray ? '数组作为参数时会退化为指针，函数内部无法直接通过 sizeof 得到数组长度。' : '实参的类型、数量和顺序必须与形参匹配。',
    ],
    analogy: '参数就像函数这台机器的投币口和进料口：不同的人投入不同的材料，机器就会给出不同的结果。',
    advanced:
      level === 'advanced'
        ? '函数调用时，实参会按调用约定压入寄存器/栈；进入函数后形参通常位于栈帧中。指针形参复制的是地址值，但指向的目标对象与调用者共享。'
        : undefined,
    level,
    tags: ['函数', '参数'],
    symbol,
  };
}

function explainFunction(context: CContext, node: FuncDeclNode): Explanation {
  const { source, symbols, level } = context;
  const params = node.params;
  const returnText = `${node.returnType.name}${' *'.repeat(node.returnPointerDepth)}`;
  const composition: ExplainPart[] = [
    { text: node.returnType.raw.trim(), role: '返回类型', category: 'type', detail: '函数执行完成后交给调用者的数据类型' },
    ...node.returnPointerStars.map((star) => ({
      text: source.slice(star),
      role: '返回指针声明符',
      category: 'pointer' as const,
    })),
    { text: node.name.name, role: '函数名', category: 'function' },
    { text: '(', role: '参数列表开始', category: 'punctuation' },
  ];
  params.forEach((param, index) => {
    composition.push({
      text: formatParamType(param),
      role: `参数 ${index + 1}`,
      category: 'data',
      detail: param.name ? undefined : '只有类型没有名字，表示该参数在函数体内不使用',
    });
    if (index < params.length - 1) composition.push({ text: ',', role: '参数分隔符', category: 'punctuation' });
  });
  composition.push({ text: ')', role: '参数列表结束', category: 'punctuation' });
  if (node.body) composition.push({ text: '{ ... }', role: '函数体', category: 'control', detail: '函数真正执行的语句都在这里' });
  else composition.push({ text: ';', role: '结束符', category: 'punctuation', detail: '只有声明没有函数体，属于函数原型' });

  const symbol = symbols.getSymbolForNode(node.name.id);
  const definitionNote = node.isDefinition ? '函数定义' : '函数声明（原型）';

  return {
    title: `${definitionNote}：${node.name.name}`,
    codeType: '函数定义',
    snippet: snippetOf(source, node.range, 220),
    range: node.range,
    nodeId: node.id,
    composition,
    meaning:
      level === 'beginner'
        ? `定义了一个叫 ${node.name.name} 的函数。它接收 ${params.length} 个参数，完成任务后返回一个 ${returnText} 类型的结果。函数体里的语句只有在函数被调用时才会执行。`
        : level === 'intermediate'
          ? `${definitionNote}：函数 ${node.name.name} 的返回类型为 ${returnText}，参数为 ${params.map((param) => `${param.type.name}${' *'.repeat(param.pointerDepth)} ${param.name?.name ?? ''}`.trim()).join(', ') || 'void'}。调用函数时，实参按顺序传给形参，执行完函数体后通过 return 把结果交回调用处。`
          : `函数 ${node.name.name} 是程序中的可复用代码单元，具有独立的栈帧与作用域。返回类型为 ${returnText}；参数值按调用约定传递。${node.body ? `函数体包含 ${countStatements(node.body)} 条顶层语句。` : '没有函数体，仅向编译器声明原型。'}`,
    purpose: `把一段可复用的逻辑封装起来，通过函数名和参数对外提供能力；同时让主流程更清晰，每个函数只负责一件事。`,
    why: '函数可以避免重复代码、降低出错概率，也方便分而治之：先想清楚每个函数做什么，再分别实现和测试。',
    relations: [
      ...(symbol ? symbolRelations(context, symbol) : []),
      {
        title: '函数结构',
        items: [
          ...(node.body
            ? [{ label: `函数体位于第 ${node.body.range.startLine}–${node.body.range.endLine} 行`, line: node.body.range.startLine, range: node.body.range }]
            : []),
          ...params
            .filter((param) => param.name)
            .map((param) => ({
              label: `参数 ${param.name!.name}：${formatParamType(param)}`,
              line: param.range.startLine,
              range: param.range,
            })),
        ],
      },
    ],
    pitfalls: [
      node.isDefinition ? '函数体必须在调用前被声明或定义，否则编译器不知道函数的参数与返回值。' : '函数原型末尾必须有分号，否则会被误认为函数定义的开始。',
      `返回类型是 ${returnText}：如果函数要返回结果，必须用 return 返回对应类型的值；main 函数返回 0 通常表示程序正常结束。`,
      'C 语言默认按值传参；想在函数里修改调用者的变量，需要传指针。',
    ],
    analogy: '函数就像一台可复用的料理机：投入原料（参数），按固定流程加工（函数体），最后得到成品（返回值）。',
    advanced:
      level === 'advanced'
        ? '调用函数时，CPU 会保存返回地址并跳转到函数代码；每次调用都有自己的栈帧，用于保存参数、局部变量和返回地址。递归调用会形成调用栈，层级过深会导致栈溢出。'
        : undefined,
    level,
    tags: ['函数', '复用'],
    symbol,
  };
}

function explainStruct(context: CContext, node: StructDeclNode): Explanation {
  const { symbols, source, level } = context;
  const typeName = node.tag?.name ?? node.typedefNames[0]?.name ?? '匿名类型';
  const fieldCount = node.fields.reduce((sum, field) => sum + field.declarators.length, 0);
  const title = node.isEnum ? `枚举定义 ${typeName}` : `${node.isUnion ? '联合体' : '结构体'}定义 ${typeName}`;
  const composition: ExplainPart[] = [
    { text: node.isUnion ? 'union' : node.isEnum ? 'enum' : 'struct', role: '类型关键字', category: 'type' },
    ...(node.tag ? [{ text: node.tag.name, role: '类型标签名', category: 'type' as const }] : []),
    { text: '{ ... }', role: '成员列表', category: 'control', detail: `定义了 ${fieldCount} 个成员` },
    ...node.typedefNames.map((alias) => ({
      text: alias.name,
      role: 'typedef 别名',
      category: 'type' as const,
      detail: '以后可以直接用这个别名声明变量，不必写 struct 关键字',
    })),
    { text: ';', role: '结束符', category: 'punctuation' },
  ];

  const fieldNames = node.fields
    .flatMap((field) => field.declarators.map((decl) => `${field.type.name}${' *'.repeat(decl.pointerDepth)} ${decl.name.name}`))
    .slice(0, 8);
  const structSymbol = node.tag
    ? symbols.getSymbolForNode(node.tag.id)
    : node.typedefNames[0]
      ? symbols.getSymbolForNode(node.typedefNames[0].id)
      : undefined;

  return {
    title,
    codeType: node.isEnum ? '枚举定义' : '自定义类型',
    snippet: snippetOf(source, node.range, 220),
    range: node.range,
    nodeId: node.id,
    composition,
    meaning:
      level === 'beginner'
        ? `定义了一个新的"数据类型"${typeName}，它把 ${fieldCount} 样相关的数据打包在一起。之后就可以像使用 int 一样，用它来声明变量。`
        : level === 'intermediate'
          ? `定义一个${node.isEnum ? '枚举' : node.isUnion ? '联合体' : '结构体'}类型 ${typeName}，包含成员：${fieldNames.join('；') || '（无）'}。结构体类型本身不占变量空间，只有用它声明变量时才会分配内存。`
          : `${node.isUnion ? '联合体' : '结构体'} ${typeName} 描述了一块复合内存布局，成员按声明顺序存放（可能插入对齐填充）。字段偏移由编译器计算，sizeof(${typeName}) 可能大于成员大小之和。`,
    purpose: `把逻辑上相关的一组数据组织成一个整体，例如一个链表节点包含数据和指向下一个节点的指针，便于统一传递和访问。`,
    why: '现实中的数据往往是"多项属性"的组合。结构体让代码能够描述这种复合关系，而不是用一堆零散变量手动维护。',
    relations: [
      ...(node.tag
        ? (() => {
            const symbol = symbols.getSymbolForNode(node.tag!.id);
            return symbol ? symbolRelations(context, symbol) : [];
          })()
        : []),
      structFieldsRelation(context, node),
    ],
    pitfalls: [
      '定义结构体类型后，末尾的 `;` 不能漏掉。',
      `结构体内的成员不能直接初始化（C 语言限制），需要先声明变量再逐个赋值，或使用初始化列表。`,
      '结构体如果想引用"自身的指针"（如 next），必须使用指针 `struct Node *next;`；直接放自身对象会导致大小无限递归。',
    ],
    analogy: '结构体像一份表格模板：它规定一张表要有哪些栏目；用这个模板填出来的每一张表，就是一个结构体变量。',
    advanced:
      level === 'advanced'
        ? '结构体成员通常按声明顺序排列，但编译器会按对齐要求插入填充字节。指针成员让结构体可以互相引用，从而构成链表、树、图等动态数据结构。'
        : undefined,
    level,
    tags: ['结构体', '自定义类型'],
    symbol: structSymbol,
  };
}

function explainStructField(context: CContext, node: StructFieldNode): Explanation {
  const { source, symbols, level } = context;
  const declarator = node.declarators[0];
  const name = declarator?.name.name ?? '成员';
  const isPointer = (declarator?.pointerDepth ?? 0) > 0;
  const structNode = context.index.parent.get(node.id);
  const structName = structNode?.kind === 'StructDecl' ? structNode.tag?.name ?? structNode.typedefNames[0]?.name ?? '结构体' : '结构体';
  const symbol = declarator ? symbols.getSymbolForNode(declarator.name.id) : undefined;

  return {
    title: `结构体成员：${name}`,
    codeType: '成员声明',
    snippet: snippetOf(source, node.range, 120),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: node.type.raw.trim(), role: '成员类型', category: 'type' },
      ...(declarator?.pointerStars ?? []).map((star) => ({
        text: source.slice(star),
        role: '指针声明符',
        category: 'pointer' as const,
        detail: '表示该成员保存地址，常用于把节点串起来',
      })),
      { text: name, role: '成员名', category: 'data' },
      { text: ';', role: '结束符', category: 'punctuation' },
    ],
    meaning:
      level === 'beginner'
        ? `这是 ${structName} 的一个成员，名字叫 ${name}，用来存放 ${node.type.name} 类型的数据。`
        : `在 ${structName} 中声明成员 ${name}，类型为 ${node.type.name}${' *'.repeat(declarator?.pointerDepth ?? 0)}。访问时，普通变量用 ${name}，结构体变量用 obj.${name}，结构体指针用 p->${name}。`,
    purpose: isPointer
      ? '保存另一个对象的地址，用于把多个结构体连接起来，或在成员间共享数据。'
      : '保存这条数据的一个属性，使结构体能够完整描述一个对象。',
    why: '一个对象往往有多个属性。成员就是结构体内部划分出的各个存储格。',
    relations: [
      ...(symbol ? symbolRelations(context, symbol) : []),
      ...(structNode?.kind === 'StructDecl' ? [structFieldsRelation(context, structNode)] : []),
    ],
    pitfalls: [
      isPointer
        ? `访问指针成员前后关系时要分清：p->${name} 是成员的地址值；要访问它指向的对象，还需要继续用 -> 或 *。`
        : `访问成员要使用 . 或 ->，不能像普通变量一样直接写 ${name}（除非在同一个结构体内部）。`,
      '结构体成员的顺序会影响内存布局，但初学阶段不需要刻意记忆偏移量。',
    ],
    analogy: '结构体是表格，成员就是表格的一列：所有行都有这一列，但每行填的内容可以不同。',
    advanced:
      level === 'advanced'
        ? isPointer
          ? '指针成员让堆上的节点可以互相链接。遍历链表时，从 head 指针开始，不断通过 next 指针读取下一个节点地址，直到 NULL。'
          : '成员地址 = 结构体首地址 + 成员偏移量。偏移量由编译器根据类型与对齐规则决定。'
        : undefined,
    level,
    tags: ['结构体', '成员'],
    symbol,
  };
}

function explainTypedef(context: CContext, node: TypedefNode): Explanation {
  const { source, symbols, level } = context;
  const symbol = symbols.getSymbolForNode(node.alias.id);
  return {
    title: `类型别名：${node.alias.name}`,
    codeType: 'typedef 定义',
    snippet: snippetOf(source, node.range, 160),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: 'typedef', role: '关键字', category: 'type', detail: '告诉编译器：接下来是在给已有类型起别名' },
      { text: node.target.raw.trim(), role: '原类型', category: 'type' },
      ...node.pointerStars.map((star) => ({ text: source.slice(star), role: '指针声明符', category: 'pointer' as const })),
      { text: node.alias.name, role: '新类型名', category: 'type' },
      { text: ';', role: '结束符', category: 'punctuation' },
    ],
    meaning:
      level === 'beginner'
        ? `给 ${node.target.name} 起了一个更好记的新名字：${node.alias.name}。以后写 ${node.alias.name} 就等于写原来的类型。`
        : `typedef 为已有类型定义别名 ${node.alias.name}（等价于 ${node.target.name}${' *'.repeat(node.pointerDepth)}）。它不会创建新的数据类型，只是让类型名更简洁、语义更清晰。`,
    purpose: '缩短复杂类型名、提高可读性，并让代码与平台相关的类型更容易替换。',
    why: '结构体在 C 中经常需要写 `struct 名字`，用 typedef 起别名后可以像普通类型一样使用，让声明更简洁。',
    relations: symbol ? symbolRelations(context, symbol) : [],
    pitfalls: [
      'typedef 只是别名，不会产生新的类型检查，也不会分配内存。',
      '`typedef int *IntPtr;` 中 IntPtr 是"指向 int 的指针"整体，`IntPtr a, b;` 会让 a、b 都是指针。',
    ],
    analogy: 'typedef 像给人起外号：身份证上的还是同一个人，只是叫法变短了。',
    advanced: level === 'advanced' ? 'typedef 在编译期被解析，不产生运行时代码。用 typedef 定义的回调函数指针类型在 C 中很常见。' : undefined,
    level,
    tags: ['typedef', '类型'],
    symbol,
  };
}

function explainPreprocessor(context: CContext, node: Extract<CNode, { kind: 'Preprocessor' }>): Explanation {
  const { source, level } = context;
  const directive = node.directive;
  const summaries: Record<string, string> = {
    include: '把另一个头文件的内容包含进来，相当于在编译前把文件拼接在这里',
    define: '定义一个宏；编译器会在预处理阶段做文本替换',
    ifdef: '条件编译：如果某个宏已定义，才编译下面的代码',
    ifndef: '条件编译：如果某个宏未定义，才编译下面的代码',
    if: '条件编译：根据宏的值决定是否编译下面的代码',
    else: '条件编译的否则分支',
    endif: '结束条件编译块',
    pragma: '给编译器的特殊指示，如 #pragma once 防止头文件重复包含',
    undef: '取消一个宏定义',
  };
  return {
    title: `预处理指令 #${directive}`,
    codeType: '预处理指令',
    snippet: snippetOf(source, node.range, 200),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: '#', role: '预处理标记', category: 'preprocessor', detail: '编译器在正式编译前先处理这类指令' },
      { text: directive, role: '指令名', category: 'preprocessor' },
      { text: node.raw.replace(/^#\s*\w+/, '').trim() || '（无参数）', role: '参数', category: 'preprocessor' },
    ],
    meaning: `${summaries[directive] ?? '一条预处理指令'}。预处理发生在正式编译之前，它不会生成可以直接执行的指令，而是改变源代码本身的形态。`,
    purpose:
      directive === 'include'
        ? '引入标准库或项目头文件中的声明，例如 printf 的原型就在 stdio.h 中。'
        : directive === 'define'
          ? '定义常量或宏，让代码中反复出现的值/表达式有一个可读的名字。'
          : '控制哪些代码参与编译，或给编译器传递额外信息。',
    why: 'C 语言把"预处理"和"编译"分开：预处理负责文本层面的准备，编译负责语法与机器指令。',
    relations: [],
    pitfalls: [
      '`#define` 是文本替换，不是变量，没有类型和作用域，也不会自动加分号。',
      '`#include <stdio.h>` 使用的是尖括号（系统头文件），包含自己项目的头文件通常用双引号。',
      directive === 'define' ? '宏定义容易产生优先级问题，例如 `#define SQUARE(x) x * x` 在 `SQUARE(a+1)` 时会出错，应加括号。' : '预处理指令必须以 # 开头，且通常写在一行的最前面。',
    ],
    analogy: '预处理像做菜前的备菜：还没开火，先把需要的食材拿过来、把调料提前配好。',
    advanced: level === 'advanced' ? '预处理阶段会展开 #include、宏替换并处理条件编译，输出纯 C 源文件；随后才进入词法、语法分析与代码生成。' : undefined,
    level,
    tags: ['预处理', '编译'],
  };
}

function explainComment(context: CContext, node: Extract<CNode, { kind: 'Comment' }>): Explanation {
  const { source, level } = context;
  return {
    title: node.isBlock ? '块注释 /* ... */' : '行注释 // ...',
    codeType: '注释',
    snippet: snippetOf(source, node.range, 160),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: node.isBlock ? '/*' : '//', role: '注释开始标记', category: 'comment' },
      { text: node.text.replace(/^(\/\/|\/\*|\*\/)/g, '').replace(/\*\/$/, '').trim(), role: '注释内容', category: 'comment' },
      ...(node.isBlock ? [{ text: '*/', role: '注释结束标记', category: 'comment' as const }] : []),
    ],
    meaning: '这是写给程序员看的说明文字。编译器会忽略注释内容，它不会变成任何可执行指令。',
    purpose: '解释代码的意图、记录假设、标记待办事项，让其他人（以及未来的自己）更快理解代码。',
    why: '代码回答"怎么做"，注释回答"为什么这样做"。好的注释能显著降低维护成本。',
    relations: [],
    pitfalls: [
      '注释不是文档：如果代码已经清晰，不要用注释重复描述代码字面意思。',
      '修改代码后忘记更新注释，会让注释变成错误信息。',
      '块注释不能嵌套，`/* /* */` 只会到第一个 */ 结束。',
    ],
    analogy: '注释像说明书上的便签：机器不会读，但人看了会少走弯路。',
    level,
    tags: ['注释', '可读性'],
  };
}

// -------------------------------------------------------------------
// 语句相关
// -------------------------------------------------------------------

function explainBlock(context: CContext, node: Extract<CNode, { kind: 'Block' }>): Explanation {
  const { source, level } = context;
  return {
    title: '代码块 { ... }',
    codeType: '语句块',
    snippet: snippetOf(source, node.range, 200),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: '{', role: '块开始', category: 'punctuation' },
      ...node.statements.slice(0, 8).map((statement) => ({
        text: `${statement.range.startLine} 行：${snippetOf(source, statement.range, 50)}`,
        role: '语句',
        category: 'data' as const,
      })),
      ...(node.statements.length > 8 ? [{ text: `……共 ${node.statements.length} 条语句`, role: '省略' }] : []),
      { text: '}', role: '块结束', category: 'punctuation' },
    ],
    meaning:
      level === 'beginner'
        ? '一对花括号把多条语句打包成一个整体，按从上到下的顺序依次执行。'
        : '花括号构成复合语句（代码块），它同时创建一个新的块作用域：在块内声明的局部变量只在块内可见，离开块后生命周期结束。',
    purpose: '把多条语句组合成一个逻辑单元，供 if/for/while/函数等结构使用；同时限定变量的作用域。',
    why: '没有代码块，控制结构就只能作用于一条语句；代码块让分支和循环可以包含任意多条语句。',
    relations: [
      {
        title: '块内语句（按执行顺序）',
        items: node.statements.map((statement) => ({
          label: snippetOf(source, statement.range, 70),
          line: statement.range.startLine,
          range: statement.range,
        })),
      },
    ],
    pitfalls: ['花括号必须成对出现；缩进不是语法要求，但混乱的缩进会让代码难读。', '代码块中的局部变量离开块后不能再使用。'],
    analogy: '代码块像一个步骤包：外面看是一步，打开后里面有很多小步骤。',
    level,
    tags: ['代码块', '作用域'],
  };
}

function explainExprStmt(context: CContext, node: Extract<CNode, { kind: 'ExprStmt' }>): Explanation {
  const { source, level } = context;
  const inner = node.expression;
  return {
    title: '表达式语句',
    codeType: '语句',
    snippet: snippetOf(source, node.range, 160),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: snippetOf(source, inner.range, 140), role: inner.kind === 'Call' ? '函数调用' : inner.kind === 'Assign' ? '赋值表达式' : '表达式', category: inner.kind === 'Call' ? 'function' : 'operator' },
      { text: ';', role: '语句结束符', category: 'punctuation' },
    ],
    meaning:
      level === 'beginner'
        ? '先计算这一行的表达式，然后把结果丢弃（或者产生副作用，例如赋值、函数调用、自增）。'
        : '表达式语句会求值表达式并丢弃返回值；它的意义通常在于副作用：修改变量、调用函数、输出内容等。',
    purpose: '让表达式产生实际动作，例如赋值、自增、函数调用。',
    why: 'C 语言是表达式语言：赋值、函数调用本身都是表达式，加上分号才成为一条语句。',
    relations: [],
    pitfalls: ['如果表达式没有任何副作用，这条语句通常没有意义，编译器也可能给出警告。', '赋值号 = 与比较号 == 不要写错。'],
    analogy: '表达式像一道计算题，表达式语句像"算出答案并写在本子上，或者顺手把某个盒子改了"这样的动作。',
    level,
    tags: ['语句', '表达式'],
  };
}

function explainIf(context: CContext, node: Extract<CNode, { kind: 'If' }>): Explanation {
  const { source, level } = context;
  const condition = snippetOf(source, node.test.range, 120);
  return {
    title: '条件判断 if',
    codeType: '控制结构',
    snippet: snippetOf(source, node.range, 220),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: 'if', role: '条件关键字', category: 'control', detail: '表示"如果……就……"' },
      { text: '(', role: '条件开始', category: 'punctuation' },
      { text: condition, role: '判断条件', category: 'operator', detail: '条件会计算出一个值：0 表示假，非 0 表示真' },
      { text: ')', role: '条件结束', category: 'punctuation' },
      { text: '{ ... }', role: '条件成立时执行', category: 'control', detail: '条件为真时执行这部分' },
      ...(node.alternate ? [{ text: 'else { ... }', role: '条件不成立时执行', category: 'control' as const }] : []),
    ],
    meaning:
      level === 'beginner'
        ? `如果"${condition}"成立，就执行 if 后面的代码；${node.alternate ? '否则执行 else 后面的代码。' : '否则什么都不做。'}`
        : `计算条件表达式 ${condition}，根据结果选择分支：非 0 走 if 分支，0 走 else 分支（存在时）。同一时刻只会执行其中一个分支。`,
    purpose: '让程序根据输入或运行状态做出不同选择，而不是永远执行同一条路线。',
    why: '真实问题几乎都包含"如果……那么……"的判断；没有分支，程序只能机械地顺序执行。',
    relations: [
      {
        title: '条件相关代码',
        items: [
          { label: `判断条件：${condition}`, line: node.test.range.startLine, range: node.test.range },
          { label: `条件成立分支在第 ${node.consequent.range.startLine} 行`, line: node.consequent.range.startLine, range: node.consequent.range },
          ...(node.alternate
            ? [{ label: `else 分支在第 ${node.alternate.range.startLine} 行`, line: node.alternate.range.startLine, range: node.alternate.range }]
            : []),
        ],
      },
    ],
    pitfalls: [
      '比较两个值是否相等要用 `==`，单个 `=` 是赋值。',
      '条件表达式的结果按"0 为假、非 0 为真"处理，不是只有 1 才为真。',
      node.alternate ? '注意"悬空 else"问题：else 会与最近的未配对 if 结合，必要时加花括号。' : '如果 if 后面只有一条语句，可以省略花括号，但建议初学阶段始终写花括号。',
    ],
    analogy: 'if 像路口的岔路：到了路口先看指示牌（条件），然后选择其中一条路走。',
    advanced: level === 'advanced' ? '条件编译后在机器指令层面通常体现为比较指令 + 条件跳转指令，未选择的分支不会执行。' : undefined,
    level,
    tags: ['if', '分支'],
  };
}

function explainFor(context: CContext, node: Extract<CNode, { kind: 'For' }>): Explanation {
  const { source, level } = context;
  const initText = node.init ? snippetOf(source, node.init.range, 80).replace(/;$/, '') : '';
  const testText = node.test ? snippetOf(source, node.test.range, 100) : '（无条件）';
  const updateText = node.update ? snippetOf(source, node.update.range, 80) : '（无更新）';
  return {
    title: 'for 循环',
    codeType: '循环结构',
    snippet: snippetOf(source, node.range, 220),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: 'for', role: '循环关键字', category: 'control' },
      { text: '(', role: '循环头开始', category: 'punctuation' },
      { text: initText || ';', role: '初始化', category: 'data', detail: '循环开始前执行一次' },
      { text: testText, role: '循环条件', category: 'operator', detail: '每轮开始前判断，为真才继续' },
      { text: updateText, role: '更新表达式', category: 'operator', detail: '每轮循环体执行完后执行' },
      { text: ')', role: '循环头结束', category: 'punctuation' },
      { text: '{ ... }', role: '循环体', category: 'control', detail: '被重复执行的语句' },
    ],
    meaning:
      level === 'beginner'
        ? `只要"${testText}"成立，就重复执行循环体。每次开始时先执行初始化（${initText}），每轮结束后执行 ${updateText}。`
        : `for 循环执行流程：1) 执行初始化 ${initText}；2) 判断条件 ${testText}，为假则结束循环；3) 执行循环体；4) 执行更新 ${updateText}，回到第 2 步。适合已知循环次数的场景。`,
    purpose: '把需要重复执行的代码写一次，让计算机自动重复，例如遍历数组、累加、打印图形。',
    why: '重复是计算机最擅长的事。循环让代码从"写死每一步"变成"描述重复规律"。',
    relations: [
      {
        title: '循环结构与相关代码',
        items: [
          ...(node.init
            ? [{ label: `初始化：${snippetOf(source, node.init.range, 60)}`, line: node.init.range.startLine, range: node.init.range }]
            : []),
          ...(node.test
            ? [{ label: `条件：${testText}`, line: node.test.range.startLine, range: node.test.range }]
            : []),
          ...(node.update
            ? [{ label: `更新：${updateText}`, line: node.update.range.startLine, range: node.update.range }]
            : []),
          { label: `循环体在第 ${node.body.range.startLine} 行`, line: node.body.range.startLine, range: node.body.range },
        ],
      },
    ],
    pitfalls: [
      '循环条件如果永远为真，就会变成死循环；要确保更新表达式会让条件最终变为假。',
      '注意边界：`i < n` 会执行 n 次，`i <= n` 会执行 n+1 次，这是初学者最常见的差一错误。',
      '循环体内声明局部变量时，每一轮都会重新创建；循环变量的作用域通常只在 for 语句内。',
    ],
    analogy: 'for 循环像跑步机上的圈数设定：先设定起始（初始化），每圈检查是否到数（条件），跑完一圈计数加一（更新）。',
    advanced: level === 'advanced' ? 'for 循环的三个部分都可以为空。编译器会把循环转换成条件判断与跳转指令；循环变量的值在每轮迭代中位于栈帧或寄存器中。' : undefined,
    level,
    tags: ['for', '循环'],
  };
}

function explainWhile(context: CContext, node: Extract<CNode, { kind: 'While' }>): Explanation {
  const { source, level } = context;
  const testText = snippetOf(source, node.test.range, 120);
  return {
    title: 'while 循环',
    codeType: '循环结构',
    snippet: snippetOf(source, node.range, 220),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: 'while', role: '循环关键字', category: 'control' },
      { text: `(${testText})`, role: '循环条件', category: 'operator', detail: '每轮开始前判断，非 0 才继续' },
      { text: '{ ... }', role: '循环体', category: 'control' },
    ],
    meaning:
      level === 'beginner'
        ? `只要"${testText}"成立，就一遍又一遍执行循环体。先判断，后执行；如果一开始条件就不成立，循环体一次都不执行。`
        : `while 循环每轮开始前计算条件 ${testText}：为真则执行循环体，然后回到条件判断；为假则退出。适合循环次数不确定、只知道继续条件的场景。`,
    purpose: '处理"只要还没完成就继续"的任务，例如读取直到结束、遍历到链表末尾、等待条件成立。',
    why: '很多重复没有固定次数，只由某个条件决定是否继续，while 比 for 更自然。',
    relations: [
      {
        title: '循环结构与相关代码',
        items: [
          { label: `循环条件：${testText}`, line: node.test.range.startLine, range: node.test.range },
          { label: `循环体在第 ${node.body.range.startLine} 行`, line: node.body.range.startLine, range: node.body.range },
        ],
      },
    ],
    pitfalls: [
      '循环体中必须让条件有机会变为假，否则会死循环。',
      'while 是先判断后执行；如果条件一开始就为假，循环体一次都不会执行。',
      '循环条件中不要误写 `=`（赋值），应为 `==`（比较）。',
    ],
    analogy: 'while 像"只要锅里还有水就继续煮"：每次先检查，条件满足才继续。',
    level,
    tags: ['while', '循环'],
  };
}

function explainDoWhile(context: CContext, node: Extract<CNode, { kind: 'DoWhile' }>): Explanation {
  const { source, level } = context;
  const testText = snippetOf(source, node.test.range, 100);
  return {
    title: 'do-while 循环',
    codeType: '循环结构',
    snippet: snippetOf(source, node.range, 220),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: 'do', role: '循环关键字', category: 'control' },
      { text: '{ ... }', role: '循环体', category: 'control', detail: '至少执行一次' },
      { text: `while (${testText});`, role: '循环条件', category: 'operator', detail: '每轮结束后判断是否继续' },
    ],
    meaning:
      level === 'beginner'
        ? `先执行一次循环体，然后判断"${testText}"；成立就再来一遍，不成立才结束。`
        : `do-while 是"先执行、后判断"的循环：循环体至少执行一次，然后检查条件 ${testText}，为真继续下一轮。适合"至少要做一次"的场景，例如输入校验、菜单循环。`,
    purpose: '保证循环体至少执行一次，例如先显示菜单、再根据用户选择决定是否继续。',
    why: '有些任务天然需要先做一次，再判断要不要继续；用 while 需要额外复制一份初始化逻辑。',
    relations: [],
    pitfalls: ['do-while 的条件判断在末尾，注意 while(...) 后面必须有分号。', '虽然至少执行一次，但条件仍要能被改变，否则会死循环。'],
    analogy: 'do-while 像试吃：先尝一口，再决定要不要继续吃。',
    level,
    tags: ['do-while', '循环'],
  };
}

function explainSwitch(context: CContext, node: Extract<CNode, { kind: 'Switch' }>): Explanation {
  const { source, level } = context;
  const expression = snippetOf(source, node.discriminant.range, 100);
  const caseCount = node.clauses.filter((clause) => !clause.isDefault).length;
  return {
    title: 'switch 多分支',
    codeType: '分支结构',
    snippet: snippetOf(source, node.range, 240),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: 'switch', role: '分支关键字', category: 'control' },
      { text: `(${expression})`, role: '判断表达式', category: 'operator', detail: '通常是一个整数或字符表达式' },
      { text: '{ ... }', role: '分支列表', category: 'control', detail: `包含 ${caseCount} 个 case 分支` },
    ],
    meaning:
      level === 'beginner'
        ? `根据"${expression}"的值，跳到对应的 case 标签处开始执行。如果没有匹配的 case 且有 default，就执行 default。`
        : `计算表达式 ${expression}，与各个 case 常量比较；匹配后从该 case 处开始执行，直到遇到 break 或 switch 结束。若都没有匹配则进入 default（存在时）。`,
    purpose: '把"一个值对应多种情况"的选择写得更清晰，替代一长串 if-else if。',
    why: '当判断依据是同一个整数/字符值、分支较多时，switch 比连续 if 更易读。',
    relations: [
      {
        title: '分支结构',
        items: node.clauses.map((clause) => ({
          label: clause.isDefault
            ? `default 分支（第 ${clause.range.startLine} 行）`
            : `case ${snippetOf(source, clause.test?.range ?? clause.range, 30)}（第 ${clause.range.startLine} 行）`,
          line: clause.range.startLine,
          range: clause.range,
        })),
      },
    ],
    pitfalls: [
      '忘记写 break 会发生"贯穿（fallthrough）"：继续执行下一个 case 的代码。',
      'case 后面必须是编译期常量，不能使用变量。',
      'switch 只能用于整数类型或字符类型，不能直接用于浮点数或字符串。',
    ],
    analogy: 'switch 像一个多路分拣机：把同一个包裹按标签值送到不同通道。',
    advanced: level === 'advanced' ? '编译器可能把密集的 case 优化成跳转表（jump table），使分支选择接近 O(1)；稀疏 case 仍可能生成比较跳转。' : undefined,
    level,
    tags: ['switch', '分支'],
  };
}

function explainCaseClause(context: CContext, node: Extract<CNode, { kind: 'CaseClause' }>): Explanation {
  const { source, level } = context;
  const label = node.isDefault ? 'default' : `case ${snippetOf(source, node.test?.range ?? node.range, 40)}`;
  return {
    title: `${label} 分支`,
    codeType: '分支标签',
    snippet: snippetOf(source, node.range, 180),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: node.isDefault ? 'default' : 'case', role: '分支标签', category: 'control' },
      ...(node.test ? [{ text: snippetOf(source, node.test.range, 40), role: '匹配常量', category: 'data' as const }] : []),
      { text: ':', role: '标签结束', category: 'punctuation' },
      ...node.statements.slice(0, 5).map((statement) => ({
        text: snippetOf(source, statement.range, 50),
        role: '分支语句',
        category: 'data' as const,
      })),
    ],
    meaning: `当 switch 的值匹配 ${node.isDefault ? 'default（其他都不匹配时）' : '这个 case'} 时，从这里开始执行。`,
    purpose: '标记一条具体的分支入口。',
    why: 'switch 需要知道每个值从哪一行开始执行，case/default 标签提供了这个入口。',
    relations: [],
    pitfalls: ['case 标签只是入口，不会自动限定执行范围；不写 break 会继续执行后续分支。', '多个 case 连续写在一起可以共享同一段代码，这是常见技巧。'],
    analogy: 'case 像分拣机上的投递口标签：包裹从对应口掉下去，但如果没有挡板（break），会继续滚到下一个口。',
    level,
    tags: ['case', 'switch'],
  };
}

function explainReturn(context: CContext, node: Extract<CNode, { kind: 'Return' }>): Explanation {
  const { source, level } = context;
  const argument = node.argument ? snippetOf(source, node.argument.range, 120) : '（无）';
  return {
    title: 'return 返回语句',
    codeType: '函数控制',
    snippet: snippetOf(source, node.range, 160),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: 'return', role: '返回关键字', category: 'control' },
      ...(node.argument ? [{ text: argument, role: '返回值表达式', category: 'operator' as const }] : []),
      { text: ';', role: '语句结束符', category: 'punctuation' },
    ],
    meaning:
      level === 'beginner'
        ? node.argument
          ? `立即结束当前函数，并把"${argument}"的计算结果交给调用这个函数的地方。`
          : '立即结束当前函数，不返回具体结果（返回类型应为 void）。'
        : node.argument
          ? `计算表达式 ${argument}，把结果转换为函数返回类型后返回给调用者，同时立即结束函数执行。return 之后的语句不会运行。`
          : '结束函数执行，void 函数使用不带值的 return（也可以省略）。',
    purpose: '把函数的计算结果交给调用者；提前结束函数（例如发现错误时直接返回）。',
    why: '函数需要一种机制把结果输出到"函数外面"，return 就是函数与调用者之间的出口。',
    relations: [
      {
        title: '所属函数',
        items: (() => {
          const fn = findAncestorKind(context, node, 'FuncDecl');
          return fn ? [{ label: `返回给函数 ${(fn as FuncDeclNode).name.name} 的调用者`, line: fn.range.startLine, range: fn.range }] : [];
        })(),
      },
    ],
    pitfalls: [
      'return 之后的代码永远不会执行，出现时通常意味着逻辑写错了。',
      '返回值的类型应与函数声明的返回类型兼容；把局部数组的地址返回出去会导致悬空指针。',
      'main 函数 return 0 表示程序正常结束，非 0 通常表示出错。',
    ],
    analogy: 'return 像答题结束交卷：把答案交给老师（调用者），然后立刻离开考场（函数）。',
    advanced: level === 'advanced' ? 'return 会清理当前栈帧并跳回调用点，返回值通常通过寄存器传递；对于较大结构体，可能由调用者提供返回空间。' : undefined,
    level,
    tags: ['return', '函数'],
  };
}

function explainBreak(context: CContext, node: Extract<CNode, { kind: 'Break' }>): Explanation {
  const { source, level } = context;
  return {
    title: 'break 跳出',
    codeType: '循环/分支控制',
    snippet: snippetOf(source, node.range, 80),
    range: node.range,
    nodeId: node.id,
    composition: [{ text: 'break', role: '跳出关键字', category: 'control' }, { text: ';', role: '语句结束符', category: 'punctuation' }],
    meaning:
      level === 'beginner'
        ? '立刻跳出当前所在的循环（或 switch 分支），继续执行循环后面的代码。'
        : '终止最近的循环或 switch 语句，控制流跳到该结构之后的语句。嵌套时只跳出最内层。',
    purpose: '在满足条件时提前结束循环（例如找到了目标），避免无意义的继续执行。',
    why: '很多搜索任务一旦找到结果就可以停止；break 提供了提前退出的手段。',
    relations: [],
    pitfalls: ['break 只跳出最内层循环/switch；如果用在内层循环，外层循环还会继续。', '在 switch 中，break 用于阻止 case 贯穿。'],
    analogy: 'break 像考试时提前交卷离场：后面的题不做了，直接进入下一个环节。',
    level,
    tags: ['break', '循环'],
  };
}

function explainContinue(context: CContext, node: Extract<CNode, { kind: 'Continue' }>): Explanation {
  const { source, level } = context;
  return {
    title: 'continue 继续下一轮',
    codeType: '循环控制',
    snippet: snippetOf(source, node.range, 80),
    range: node.range,
    nodeId: node.id,
    composition: [{ text: 'continue', role: '继续关键字', category: 'control' }, { text: ';', role: '语句结束符', category: 'punctuation' }],
    meaning:
      level === 'beginner'
        ? '跳过本轮循环剩下的语句，直接进入下一轮循环。'
        : '结束当前这一轮循环体的剩余语句，跳到循环的更新/条件部分，开始下一轮判断。',
    purpose: '在循环中跳过不需要处理的特殊情况，让主逻辑保持清晰。',
    why: '当某些数据需要忽略时，continue 可以避免把主逻辑包在一层 if 里。',
    relations: [],
    pitfalls: ['在 for 循环中，continue 仍会执行更新表达式；在 while 循环中，要确保 continue 之前条件变量会变化，否则可能死循环。'],
    analogy: 'continue 像广播体操时跳过当前这一节，直接做下一节。',
    level,
    tags: ['continue', '循环'],
  };
}

// -------------------------------------------------------------------
// 标识符 / 字面量
// -------------------------------------------------------------------

function explainIdentifier(context: CContext, node: IdentifierNode): Explanation {
  const { symbols, index, source, level } = context;
  const symbol = symbols.getSymbolForNode(node.id);
  const role = symbols.identifierRoles.get(node.id);
  const parent = index.parent.get(node.id);
  const typeInfo = symbol ? symbols.getSymbolType(symbol.id) : undefined;
  const name = node.name;
  const relations = symbol ? symbolRelations(context, symbol) : [];

  if (!symbol) {
    return {
      title: `标识符「${name}」`,
      codeType: '标识符',
      snippet: snippetOf(source, node.range, 60),
      range: node.range,
      nodeId: node.id,
      composition: [{ text: name, role: '标识符', category: 'data' }],
      meaning: '这是一个名字，但 CodeLens 无法在当前代码中确定它指向什么。',
      purpose: '',
      why: '',
      relations: [],
      pitfalls: ['如果这是变量/函数，请检查是否漏写声明或拼写是否一致。'],
      analogy: '就像一个没有对应房间的门牌号，无法确定它指向哪里。',
      level,
      tags: ['标识符'],
    };
  }

  const isDeclaration = role === 'declaration';
  const isCall = role === 'call' || (parent?.kind === 'Call' && parent.callee.id === node.id);
  const isMember = role === 'member';
  const kindLabel = symbolKindLabel(symbol);
  const scopeSnippet = symbol.declaration
    ? `声明在第 ${symbol.declaration.line} 行：${symbol.declaration.snippet}`
    : '未找到明确声明';

  const composition: ExplainPart[] = [{ text: name, role: isDeclaration ? '被声明的名字' : isMember ? '成员名' : '标识符', category: isCall ? 'function' : 'data' }];
  if (isCall && parent?.kind === 'Call') {
    composition.push({ text: '(' , role: '调用开始', category: 'punctuation' });
    composition.push({ text: parent.args.map((arg) => snippetOf(source, arg.range, 30)).join(', ') || '无参数', role: '实参', category: 'data' });
    composition.push({ text: ')', role: '调用结束', category: 'punctuation' });
  }

  const contextDescription = describeIdentifierContext(context, node, parent);

  const meaning =
    symbol.kind === 'function'
      ? isCall
        ? `调用函数 ${name}。程序会暂停当前流程，把控制权交给 ${name} 的函数体，执行完后回到这里继续。`
        : isDeclaration
          ? `声明一个函数 ${name}，让编译器知道它的参数与返回值类型。`
          : `引用函数 ${name}（例如作为函数名出现）。`
      : symbol.kind === 'unknown'
        ? `标识符「${name}」没有在当前代码中找到声明。${symbol.detail ?? ''}`
        : symbol.kind === 'struct' || symbol.kind === 'typedef' || symbol.kind === 'enum'
          ? `类型名 ${name}，表示 ${symbol.typeText ?? symbol.detail ?? '一种自定义类型'}。它描述数据的结构，本身不保存运行时数据。`
          : isMember
            ? `访问结构体成员 ${name}（类型 ${symbol.typeText ?? '未知'}）。${contextDescription}`
            : `变量 ${name}（类型 ${symbol.typeText ?? '未知'}）被使用。${contextDescription}`;

  const pitfalls: string[] = [];
  if (symbol.kind === 'variable' || symbol.kind === 'parameter') {
    const inferred = typeInfo;
    if (inferred && inferred.pointerDepth > 0) {
      pitfalls.push(`${name} 保存的是地址，不是值本身；访问目标数据需要 * 或 ->。`);
    }
    if (isDeclaration) pitfalls.push('变量名要和后续使用的名字完全一致，C 语言区分大小写。');
    pitfalls.push('注意变量的作用域：在块内声明的变量离开块后不能再访问。');
  } else if (symbol.kind === 'function') {
    pitfalls.push('函数调用时参数的类型与顺序要与定义一致。', '函数声明必须在调用之前，否则编译器无法检查参数。');
  } else if (isMember) {
    pitfalls.push('结构体变量访问成员用 `.`，结构体指针访问成员用 `->`，不要混用。');
  } else if (symbol.kind === 'unknown') {
    pitfalls.push('可能是标准库函数但缺少 #include，也可能是拼写错误；CodeLens 不会替它编造含义。');
  }

  const title = isDeclaration
    ? `${kindLabel}：${name}`
    : isCall
      ? `函数调用：${name}`
      : isMember
        ? `成员访问：${name}`
        : `${kindLabel}：${name}`;

  return {
    title,
    codeType: isCall ? '函数调用' : isMember ? '成员访问' : isDeclaration ? '声明' : '标识符使用',
    snippet: snippetOf(source, node.range, 80),
    range: node.range,
    nodeId: node.id,
    composition,
    meaning,
    purpose: isCall
      ? '调用封装好的函数来完成一项任务，避免重复实现。'
      : symbol.kind === 'unknown'
        ? 'CodeLens 无法确定它的作用，请先确认声明是否存在。'
        : '在表达式中使用这个名称所代表的数据或类型，参与计算、比较或访问。',
    why: symbol.kind === 'unknown' ? 'C 语言要求标识符先声明后使用；缺少声明通常意味着代码不完整或拼写错误。' : '标识符把"固定的名字"和"变化的数据/逻辑"连接起来，让代码可读、可维护。',
    relations: relations.length
      ? relations
      : [
          {
            title: '声明位置',
            items: symbol.declaration
              ? [{ label: `${scopeSnippet}`, line: symbol.declaration.line, range: symbol.declaration.range }]
              : [],
          },
        ],
    pitfalls,
    analogy:
      symbol.kind === 'function'
        ? '函数名像外卖店名：说出店名并报上需求（参数），就能得到一份结果。'
        : symbol.kind === 'unknown'
          ? '像一个还没登记的名字：大家看到它，但不知道它到底指谁。'
          : isMember
            ? '像从一个档案袋里抽出一份材料：袋子上写着结构体变量，抽取的那一项就是成员。'
            : '变量名像贴了标签的储物格：每次叫到这个名字，就打开对应的格子读写数据。',
    advanced:
      level === 'advanced'
        ? symbol.kind === 'variable' && typeInfo?.pointerDepth
          ? `指针变量 ${name} 的值是地址；如果它指向堆对象，需要确保对象在使用期间没有被 free。`
          : symbol.kind === 'function'
            ? '函数调用会产生新的栈帧；递归调用时同名变量在不同栈帧中互不影响。'
            : '编译器会把标识符解析为符号表条目，再根据作用域与类型生成访问指令（栈偏移、全局地址或寄存器）。'
        : undefined,
    level,
    tags: [kindLabel, isDeclaration ? '声明' : '使用'],
    symbol,
  };
}

function explainLiteral(context: CContext, node: Extract<CNode, { kind: 'Literal' }>): Explanation {
  const { level } = context;
  const raw = node.raw;
  const meta: Record<string, { title: string; meaning: string; pitfall: string; analogy: string }> = {
    int: {
      title: '整数字面量',
      meaning: `数字 ${raw} 是一个整数常量，程序直接把它当作 int 类型的值使用。`,
      pitfall: '不要把数字 0 和字符 "0" / 字符串 "0" 混淆，它们的含义和内存表示完全不同。',
      analogy: '像写在纸上的固定数字，本身不会变化。',
    },
    float: {
      title: '浮点数字面量',
      meaning: `数字 ${raw} 是浮点数（带小数或指数），默认按 double 处理。`,
      pitfall: '浮点数存在精度误差，不要直接用 == 比较两个浮点数，应判断差的绝对值是否足够小。',
      analogy: '像带刻度的尺子，只能量到有限精度。',
    },
    char: {
      title: '字符字面量',
      meaning: `字符 ${raw} 在 C 中实际上是它的 ASCII 编码对应的整数。`,
      pitfall: '单引号表示字符（如 "a"），双引号表示字符串（如 "a" 末尾还带结束符 \\0）。',
      analogy: '字符像键盘上的一个按键，计算机记住的是它的编码。',
    },
    string: {
      title: '字符串字面量',
      meaning: `字符串 ${raw} 在内存中是一段以 \\0 结尾的字符数组；printf 的 %s 会从首地址一直输出到 \\0。`,
      pitfall: '字符串常量不能直接修改；双引号必不可少，单引号只能表示一个字符。',
      analogy: '像一句话被写在一排连续的小格子里，最后放一个"句号"（\\0）表示结束。',
    },
    bool: {
      title: level === 'beginner' ? '布尔值' : '布尔字面量',
      meaning: `${raw} 表示真/假。C 语言中条件判断以 0 为假、非 0 为真。`,
      pitfall: 'C 语言传统上使用 0/1 表示真假；stdbool.h 提供了 bool/true/false。',
      analogy: '像开关的"开/关"两个状态。',
    },
    null: {
      title: '空指针字面量',
      meaning: '表示"不指向任何对象"的特殊指针值。',
      pitfall: 'NULL/nullptr 不能解引用；使用指针前应检查它是否为 NULL。',
      analogy: '像一张写着"暂无可住房间"的门牌，不能凭它去找房间。',
    },
  };
  const info = meta[node.literalKind] ?? meta.int;
  return {
    title: info.title,
    codeType: '字面量',
    snippet: raw,
    range: node.range,
    nodeId: node.id,
    composition: [
      {
        text: raw,
        role: node.literalKind === 'string' ? '字符串常量' : '字面量',
        category: 'data',
        detail: `类型：${literalTypeName(node.literalKind)}`,
      },
    ],
    meaning: info.meaning,
    purpose: '为变量、函数参数或条件表达式提供具体的值。',
    why: '程序需要真实数据才能运行；字面量是最直接的数据来源。',
    relations: [],
    pitfalls: [info.pitfall],
    analogy: info.analogy,
    advanced:
      level === 'advanced'
        ? node.literalKind === 'string'
          ? '字符串字面量通常存放在只读数据段，试图修改它会导致未定义行为；相邻字符串字面量会在编译期拼接。'
          : node.literalKind === 'int'
            ? '整数字面量可以带后缀（如 10L、10U）改变类型；超出 int 范围的字面量需要使用 long long。'
            : undefined
        : undefined,
    level,
    tags: ['字面量', literalTypeName(node.literalKind)],
  };
}

function literalTypeName(kind: string): string {
  switch (kind) {
    case 'int':
      return 'int 整数';
    case 'float':
      return 'double 浮点数';
    case 'char':
      return 'char 字符';
    case 'string':
      return 'char[] 字符串';
    case 'bool':
      return 'bool 布尔值';
    case 'null':
      return '空指针';
    default:
      return '字面量';
  }
}

function literalTitle(kind: string): string {
  switch (kind) {
    case 'int':
      return '整数字面量';
    case 'float':
      return '浮点数字面量';
    case 'char':
      return '字符字面量';
    case 'string':
      return '字符串字面量';
    case 'bool':
      return '布尔值';
    case 'null':
      return '空指针';
    default:
      return '字面量';
  }
}

// -------------------------------------------------------------------
// 表达式相关
// -------------------------------------------------------------------

function explainBinary(context: CContext, node: Extract<CNode, { kind: 'Binary' }>): Explanation {
  const { source, level } = context;
  const left = snippetOf(source, node.left.range, 80);
  const right = snippetOf(source, node.right.range, 80);
  const op = node.op;
  const group = operatorGroup(op);
  const meaning = binaryMeaning(op, left, right, level);
  const pitfalls = binaryPitfalls(op);
  return {
    title: `二元运算 ${op}`,
    codeType: '表达式',
    snippet: snippetOf(source, node.range, 140),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: left, role: '左操作数', category: 'data' },
      { text: op, role: group, category: 'operator', detail: binaryOperatorDetail(op) },
      { text: right, role: '右操作数', category: 'data' },
    ],
    meaning,
    purpose: '对两个数据做计算或比较，产生一个新的值，供赋值、条件判断或函数调用使用。',
    why: '计算机程序的核心就是不断对数据做运算；运算符是把简单数据组合成复杂逻辑的积木。',
    relations: [],
    pitfalls,
    analogy:
      group === '比较运算符'
        ? '比较运算像考试对答案：结果只有"对/不对"两种，分别用 1/0 表示。'
        : group === '逻辑运算符'
          ? '逻辑运算像门卫检查两个条件：并且要全满足，或者只要一个满足。'
          : '算术运算像用计算器算一道题，先按运算优先级算，再得到结果。',
    advanced:
      level === 'advanced'
        ? `${op} 的运算结果由操作数类型决定。整数除法会截断小数部分；有符号整数溢出属于未定义行为；&& 与 || 具有短路求值特性，右侧可能不会被执行。`
        : undefined,
    level,
    tags: [group, op],
  };
}

function operatorGroup(op: string): string {
  if (['==', '!=', '<', '<=', '>', '>='].includes(op)) return '比较运算符';
  if (['&&', '||'].includes(op)) return '逻辑运算符';
  if (['&', '|', '^', '<<', '>>'].includes(op)) return '位运算符';
  return '算术运算符';
}

function binaryOperatorDetail(op: string): string {
  const details: Record<string, string> = {
    '+': '加法或指针偏移',
    '-': '减法或指针距离',
    '*': '乘法（不是指针声明）',
    '/': '除法；两个整数相除会截断小数部分',
    '%': '取余数，只能用于整数',
    '==': '判断是否相等，结果是 1（真）或 0（假）',
    '!=': '判断是否不相等',
    '<': '小于比较',
    '<=': '小于等于比较',
    '>': '大于比较',
    '>=': '大于等于比较',
    '&&': '逻辑与：两边都为真才为真，具有短路特性',
    '||': '逻辑或：任意一边为真就为真，具有短路特性',
    '&': '按位与',
    '|': '按位或',
    '^': '按位异或',
    '<<': '左移',
    '>>': '右移',
  };
  return details[op] ?? '运算符';
}

function binaryMeaning(op: string, left: string, right: string, level: ExplainLevel): string {
  const group = operatorGroup(op);
  if (group === '比较运算符') {
    return level === 'beginner'
      ? `比较左边 ${left} 和右边 ${right}，判断 ${op === '==' ? '是否相等' : op === '!=' ? '是否不相等' : `大小关系（${op}）`}。结果是一个整数：1 表示成立，0 表示不成立。`
      : `计算比较表达式 ${left} ${op} ${right}，结果为 int 类型的 1（真）或 0（假），常直接作为 if/while 的条件。`;
  }
  if (group === '逻辑运算符') {
    return level === 'beginner'
      ? `把左右两边都当作"条件"来看：${op === '&&' ? '两个都成立，整体才成立' : '只要有一个成立，整体就成立'}。`
      : `计算逻辑表达式 ${left} ${op} ${right}：${op === '&&' ? '左边为假时直接得到假，不再计算右边（短路）' : '左边为真时直接得到真，不再计算右边（短路）'}；结果非 0 为真。`;
  }
  if (group === '位运算符') {
    return `对 ${left} 和 ${right} 的二进制位做 ${op} 运算。这类运算通常用于底层位操作、标志位组合或性能优化。`;
  }
  if (op === '/' && level !== 'beginner') {
    return `计算 ${left} / ${right}。注意：如果两边都是整数，结果会向零截断（例如 5/2 得到 2）；要得到小数需要至少一边是浮点数。`;
  }
  if (op === '%') return `计算 ${left} 除以 ${right} 的余数，只能用于整数类型。`;
  return level === 'beginner'
    ? `用 ${left} 和 ${right} 计算出一个新值（${op}）。`
    : `按运算符优先级计算表达式 ${left} ${op} ${right}，结果继续参与外层表达式。C 语言有明确的优先级与结合性规则，必要时用括号明确意图。`;
}

function binaryPitfalls(op: string): string[] {
  const group = operatorGroup(op);
  if (group === '比较运算符') {
    return ['判断相等用 `==`，不要误写成赋值 `=`。', '比较结果 1/0 是整数，不是布尔类型。'];
  }
  if (group === '逻辑运算符') {
    return ['`&&`/`||` 有短路特性：右侧表达式可能不会执行，利用这一点要小心副作用。', '按位 `&`/`|` 与逻辑 `&&`/`||` 含义不同，不要混用。'];
  }
  if (group === '位运算符') return ['位运算只适用于整数类型，结果按二进制位计算，初学阶段容易看错。'];
  if (op === '/') return ['整数除法会丢弃小数部分；除数为 0 会导致运行时错误。'];
  if (op === '%') return ['取余运算符 % 不能用于浮点数。'];
  return ['注意运算符优先级，复杂表达式建议加括号。', '整数溢出会得到意外结果，注意数据范围。'];
}

function explainUnary(context: CContext, node: Extract<CNode, { kind: 'Unary' }>): Explanation {
  const { source, symbols, level } = context;
  const operand = snippetOf(source, node.operand.range, 80);
  const pointerOp = node.op === '*' || node.op === '&';
  const meta: Record<string, { title: string; meaning: string; pitfall: string; analogy: string }> = {
    '*': {
      title: '指针解引用 *',
      meaning: `顺着指针 ${operand} 保存的地址，访问它指向的那个对象。`,
      pitfall: '解引用前必须确保指针指向有效内存；对 NULL 或野指针使用 * 会导致程序崩溃或未定义行为。',
      analogy: '知道门牌号（指针）以后，打开对应的房间并取出里面的东西。',
    },
    '&': {
      title: '取地址运算 &',
      meaning: `取得变量 ${operand} 在内存中的地址。地址可以保存到指针变量里。`,
      pitfall: '不要混淆 &（取地址）与 &&（逻辑与）；`&` 的结果类型是"指向操作数类型的指针"。',
      analogy: '找到某个房间后，把它的门牌号抄下来。',
    },
    '!': {
      title: '逻辑非 !',
      meaning: `把 ${operand} 的真假取反：成立变不成立，不成立变成立。`,
      pitfall: '! 只产生 0/1，可连续写 !! 转成标准布尔值，但通常没必要。',
      analogy: '像开关的反向：原来的开关状态翻转。',
    },
    '-': {
      title: '一元负号 -',
      meaning: `把 ${operand} 的值取相反数。`,
      pitfall: '对无符号数使用一元负号可能得到意外的大正数。',
      analogy: '像温度从零上变零下。',
    },
    '+': {
      title: '一元正号 +',
      meaning: '正号，通常不改变值，主要用来强调或提升类型。',
      pitfall: '一元 + 和二元加号含义不同。',
      analogy: '像数字前的"+"，表示正数。',
    },
    '~': {
      title: '按位取反 ~',
      meaning: `把 ${operand} 的二进制每一位取反（0 变 1，1 变 0）。`,
      pitfall: '按位取反与逻辑非 ! 完全不同。',
      analogy: '像把一排开关全部翻转。',
    },
  };
  const info = meta[node.op] ?? meta['!'];
  const operandType = symbols.inferType(node.operand);
  const pointerDepth = operandType?.pointerDepth ?? 0;

  return {
    title: info.title,
    codeType: pointerOp ? '指针操作' : '一元运算',
    snippet: snippetOf(source, node.range, 120),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: source.text.slice(node.range.start, node.operand.range.start).trim() || node.op, role: node.op === '*' && pointerDepth > 0 ? '解引用运算符' : node.op === '&' ? '取地址运算符' : '一元运算符', category: pointerOp ? 'pointer' : 'operator', detail: info.meaning },
      { text: operand, role: '操作数', category: 'data' },
    ],
    meaning: level === 'beginner' ? info.meaning : `${info.meaning} 操作数 ${operand} 的类型推断为 ${operandType ? formatInferredType(operandType) : '未知'}。`,
    purpose:
      node.op === '*'
        ? '通过地址间接访问目标对象，从而读取或修改它，是链表、动态内存操作的基础。'
        : node.op === '&'
          ? '获得变量的地址，交给指针变量保存，或者作为函数参数输出数据。'
          : '对值进行取反、取负等一元计算。',
    why: 'C 语言把"地址"也当作一种可以操作的值；* 与 & 是连接"值"和"地址"两个世界的桥梁。',
    relations: [],
    pitfalls: [info.pitfall],
    analogy: info.analogy,
    advanced:
      level === 'advanced'
        ? pointerOp
          ? '指针解引用生成的机器指令会从地址处按类型宽度读取；取地址运算符作用于左值，得到其存储地址。数组名也可能直接当作地址使用，但它不能被赋值。'
          : undefined
        : undefined,
    level,
    tags: [pointerOp ? '指针' : '一元运算', node.op],
  };
}

function explainUpdate(context: CContext, node: Extract<CNode, { kind: 'Update' }>): Explanation {
  const { source, level } = context;
  const operand = snippetOf(source, node.operand.range, 60);
  const isIncrement = node.op === '++';
  return {
    title: isIncrement ? '自增运算 ++' : '自减运算 --',
    codeType: '运算',
    snippet: snippetOf(source, node.range, 80),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: node.op, role: node.prefix ? '前置' : '后置', category: 'operator', detail: node.prefix ? '先加/减，再使用新值' : '先使用当前值，再加/减' },
      { text: operand, role: '操作数', category: 'data' },
    ],
    meaning:
      level === 'beginner'
        ? `把 ${operand} 的值${isIncrement ? '加 1' : '减 1'}。`
        : `${node.prefix ? '前置' : '后置'}${isIncrement ? '自增' : '自减'}：先计算 ${operand} ${node.prefix ? `${node.op} 后再使用它的新值` : `当前值参与表达式，然后${node.op}`}。在单独成句时两者效果相同，嵌入表达式时结果不同。`,
    purpose: '让计数器前进一格，常用于循环变量更新、统计次数。',
    why: '循环需要让条件逐渐变化；自增/自减是最简洁的"前进一格"写法。',
    relations: [],
    pitfalls: [
      node.prefix ? '前置与后置在表达式内部结果不同，初学阶段建议单独成句使用。' : '后置自增/自减返回的是旧值，不要在同一个表达式中对同一变量多次自增。',
      '对指针自增会移动指针指向下一个元素，而不是把地址数值加 1。',
    ],
    analogy: '自增像计步器加一：前置是"先加一再报数"，后置是"先报旧数再加一"。',
    level,
    tags: ['自增自减', '循环'],
  };
}

function explainAssign(context: CContext, node: Extract<CNode, { kind: 'Assign' }>): Explanation {
  const { source, symbols, level } = context;
  const target = snippetOf(source, node.target.range, 80);
  const value = snippetOf(source, node.value.range, 80);
  const targetSymbol = node.target.kind === 'Identifier' ? symbols.getSymbolForNode(node.target.id) : undefined;
  const operatorDetail =
    node.op === '='
      ? '把右边的值保存到左边变量对应的内存中'
      : `先计算左边 ${target} ${node.op.slice(0, -1)} 右边，再把结果存回左边`;
  return {
    title: node.op === '=' ? '赋值运算 =' : '复合赋值运算',
    codeType: '赋值',
    snippet: snippetOf(source, node.range, 140),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: target, role: '赋值目标', category: 'data', detail: targetSymbol ? `变量 ${targetSymbol.name}（${targetSymbol.typeText ?? '类型未知'}）` : '一个可以被修改的存储位置' },
      { text: node.op, role: '赋值运算符', category: 'operator', detail: operatorDetail },
      { text: value, role: '要保存的值', category: 'data' },
    ],
    meaning:
      level === 'beginner'
        ? `计算右边的 ${value}，然后把它放进左边的 ${target} 里。赋值完成后，${target} 就保存了新值。`
        : `${operatorDetail}。赋值表达式的值就是赋进去的值，因此可以连续赋值（如 a = b = 1），但初学阶段建议拆开写更清晰。`,
    purpose: '更新变量的内容，让程序状态随着执行不断变化；这是循环、累加、链表修改的基础。',
    why: '变量之所以有用，是因为它的值可以被更新；赋值就是把计算结果写回变量的动作。',
    relations: targetSymbol
      ? symbolRelations(context, targetSymbol)
      : [],
    pitfalls: [
      '赋值 `=` 与比较 `==` 完全不同：if 条件里误写 `=` 会改变变量值并几乎总是成立。',
      '赋值方向是"从右到左"，左边必须是可以被修改的变量/数组元素/成员。',
      node.op === '+=' ? '复合赋值 `+=` 等价于 `x = x + ...`，注意整数除法截断与溢出。' : '赋值会覆盖变量原来的值，需要保留旧值时先另存一份。',
    ],
    analogy: `赋值像把新内容写进贴了标签的盒子（${target}）；写进去以后旧内容就被覆盖了。`,
    advanced: level === 'advanced' ? '赋值操作保存的是值（指针变量保存地址值）。数组名、函数名等不可修改的左值不能放在赋值号左边。' : undefined,
    level,
    tags: ['赋值', '变量'],
  };
}

function explainCall(context: CContext, node: Extract<CNode, { kind: 'Call' }>): Explanation {
  const { source, symbols, level } = context;
  const calleeName =
    node.callee.kind === 'Identifier' ? node.callee.name : snippetOf(source, node.callee.range, 60);
  const args = node.args.map((arg) => snippetOf(source, arg.range, 50));
  const functionSymbol =
    node.callee.kind === 'Identifier' ? symbols.getSymbolForNode(node.callee.id) : undefined;
  const isPrintf = calleeName === 'printf';
  const isMalloc = calleeName === 'malloc' || calleeName === 'calloc' || calleeName === 'realloc';

  const composition: ExplainPart[] = [
    { text: calleeName, role: '被调用函数', category: 'function', detail: functionSymbol?.detail ?? '函数名' },
    { text: '(', role: '参数列表开始', category: 'punctuation' },
  ];
  args.forEach((arg, index) => {
    composition.push({ text: arg, role: `实参 ${index + 1}`, category: 'data' });
    if (index < args.length - 1) composition.push({ text: ',', role: '分隔符', category: 'punctuation' });
  });
  composition.push({ text: ')', role: '参数列表结束', category: 'punctuation' });

  let meaning = `调用 ${calleeName} 函数，把 ${args.length} 个实参按顺序传给它。程序会进入该函数执行，完成后把返回值带回这里继续执行。`;
  if (level === 'beginner') {
    meaning = `使用 ${calleeName} 这个函数：把括号里的 ${args.join('、') || '（无参数）'} 交给它，让它执行内部的工作。`;
  }
  if (isPrintf) {
    meaning = `调用标准输出函数 printf，把格式字符串和后面的变量按格式打印到屏幕上。格式字符串中的 %d、%f、%s 等占位符会被后面的实参依次替换。`;
  }
  if (isMalloc) {
    meaning = `调用 ${calleeName} 向堆申请内存，返回申请到的内存首地址。申请失败时返回 NULL，使用前应检查。`;
  }

  const pitfalls: string[] = [
    '实参的类型、数量、顺序应与函数声明一致。',
    '调用函数要写在语句中并加分号（或作为表达式的一部分使用）。',
  ];
  if (isPrintf) pitfalls.push('printf 的格式占位符必须与参数类型匹配，否则可能输出乱码甚至崩溃。');
  if (isMalloc) {
    pitfalls.push('malloc 返回的是通用指针，通常需要类型转换并检查是否为 NULL。', '使用完 malloc 申请的内存后要 free，否则会造成内存泄漏。');
  }
  if (functionSymbol?.kind === 'unknown') pitfalls.push(`没有找到 ${calleeName} 的声明；请检查是否包含对应头文件或拼写是否正确。`);

  return {
    title: `函数调用 ${calleeName}()`,
    codeType: '函数调用',
    snippet: snippetOf(source, node.range, 160),
    range: node.range,
    nodeId: node.id,
    composition,
    meaning,
    purpose: isPrintf
      ? '把程序内部的值展示给用户，便于观察程序运行结果和调试。'
      : isMalloc
        ? '在程序运行期间动态申请内存，用于创建链表节点等无法预先确定数量的数据。'
        : '复用已经写好的函数逻辑，把复杂任务拆成多个可管理的步骤。',
    why: isPrintf
      ? '程序需要与用户交流；没有输出，运行结果就无法被观察。'
      : isMalloc
        ? '栈上的局部变量在函数返回后失效；堆内存允许数据在函数调用之间长期存在。'
        : '函数调用让代码从"一条直线"变成"可组合的积木"。',
    relations: [
      ...(functionSymbol ? symbolRelations(context, functionSymbol) : []),
      ...(functionSymbol?.kind === 'unknown'
        ? [
            {
              title: '未解析的调用',
              items: [{ label: `${calleeName} 没有在当前代码中声明，可能来自系统头文件`, line: node.range.startLine, range: node.range }],
            },
          ]
        : []),
    ],
    pitfalls,
    analogy: isPrintf
      ? 'printf 像打印机：给它模板（格式字符串）和材料（变量），它按模板印出内容。'
      : isMalloc
        ? 'malloc 像向仓库申请一块空地：仓库给你一个编号（地址），用完后要归还（free）。'
        : '函数调用像点外卖：报出店名和需求，等待完成，然后拿到结果。',
    advanced:
      level === 'advanced'
        ? `调用时实参求值后按调用约定传递；被调函数创建新栈帧。${isPrintf ? 'printf 是变参函数，依赖格式字符串解释后续参数。' : ''}${isMalloc ? 'malloc 返回的地址由堆管理器分配，之后的 free 会把它归还给堆。' : ''}`
        : undefined,
    level,
    tags: ['函数调用', calleeName],
    symbol: functionSymbol,
  };
}

function explainIndex(context: CContext, node: Extract<CNode, { kind: 'Index' }>): Explanation {
  const { source, symbols, level } = context;
  const base = snippetOf(source, node.base.range, 60);
  const index = snippetOf(source, node.index.range, 50);
  const baseType = symbols.inferType(node.base);
  const isArray = (baseType?.arrayDims ?? 0) > 0;
  return {
    title: '数组下标访问',
    codeType: '数组/指针访问',
    snippet: snippetOf(source, node.range, 120),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: base, role: '数组 / 指针', category: 'data', detail: baseType ? `类型：${formatInferredType(baseType)}` : undefined },
      { text: '[', role: '下标开始', category: 'punctuation' },
      { text: index, role: '下标', category: 'data', detail: '从 0 开始计数' },
      { text: ']', role: '下标结束', category: 'punctuation' },
    ],
    meaning:
      level === 'beginner'
        ? `取出 ${base} 中编号为 ${index} 的那个元素。编号从 0 开始，所以第一个元素的编号是 0。`
        : `${base}[${index}] 先计算下标 ${index}，再访问 ${isArray ? '数组' : '指针指向的内存'} 中对应位置的元素。a[i] 等价于 *(a + i)，数组与指针在这一层是统一的。`,
    purpose: '通过编号快速访问一组连续数据中的某一项，配合循环可以处理整个数组。',
    why: '数组元素在内存中连续排列，下标运算本质上是指针偏移，因此访问任意元素的时间相同。',
    relations: [],
    pitfalls: [
      '下标从 0 开始，长度为 n 的数组合法下标是 0..n-1，访问 a[n] 属于越界。',
      'C 语言不会自动检查数组越界，越界读写可能悄悄破坏其他数据。',
      '下标必须是整数表达式；指针虽然也能用 []，但作用类似。',
    ],
    analogy: '像一排连续编号的储物柜：`a[0]` 是第一个柜子，`a[i]` 是从第一个柜子往后数 i 个。',
    advanced: level === 'advanced' ? 'a[i] 在编译时转换为 *(a + i)：先按元素大小缩放偏移量，再解引用。越界访问属于未定义行为，可能读写到相邻变量、返回地址或堆元数据。' : undefined,
    level,
    tags: ['数组', '下标'],
  };
}

function explainMember(context: CContext, node: Extract<CNode, { kind: 'Member' }>): Explanation {
  const { source, symbols, level } = context;
  const object = snippetOf(source, node.object.range, 50);
  const memberName = node.member.name;
  const objectType = symbols.inferType(node.object);
  const fieldInfo = objectType ? symbols.getField(objectType.name, memberName) : undefined;
  const fieldType = fieldInfo ? formatInferredType(fieldInfo.type) : '未知类型';
  const fieldSymbol = fieldInfo ? symbols.symbols[fieldInfo.symbolId] : undefined;
  const struct = objectType ? symbols.getStruct(objectType.name) : undefined;
  return {
    title: node.arrow ? '指针成员访问 p->x' : '结构体成员访问 s.x',
    codeType: '成员访问',
    snippet: snippetOf(source, node.range, 120),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: object, role: node.arrow ? '结构体指针' : '结构体变量', category: 'data', detail: objectType ? `类型：${formatInferredType(objectType)}` : undefined },
      { text: node.arrow ? '->' : '.', role: node.arrow ? '指针成员运算符' : '成员运算符', category: node.arrow ? 'pointer' : 'punctuation', detail: node.arrow ? '先解引用指针，再访问成员；等价于 (*p).x' : '直接访问结构体变量中的成员' },
      { text: memberName, role: '成员名', category: 'data', detail: fieldInfo ? `类型：${fieldType}` : undefined },
    ],
    meaning:
      level === 'beginner'
        ? `打开 ${object} 这个结构体里的 ${memberName} 成员，读取或修改它的值。${node.arrow ? `因为 ${object} 是指针，所以要用箭头 ->。` : `因为 ${object} 是结构体变量，所以用点号 .。`}`
        : `访问 ${formatInferredType(objectType ?? { name: '未知', pointerDepth: 0 })} 的成员 ${memberName}（类型 ${fieldType}）。${node.arrow ? `p->${memberName} 等价于 (*p).${memberName}。` : ''}${struct ? `该成员声明在结构体 ${struct.tag?.name ?? '匿名结构体'} 中。` : ''}`,
    purpose: `读取或修改复合数据中的某个字段；指针成员还常用于把多个结构体链接起来（如链表的 next）。`,
    why: '结构体的意义在于把多个字段组织在一起；成员访问就是从这个组合中取出指定字段的方式。',
    relations: [
      ...(fieldInfo
        ? (() => {
            const fieldSymbol = symbols.symbols[fieldInfo.symbolId];
            return fieldSymbol ? symbolRelations(context, fieldSymbol) : [];
          })()
        : []),
      ...(struct ? [structFieldsRelation(context, struct)] : []),
    ],
    pitfalls: [
      node.arrow
        ? '`->` 用于结构体指针，`.` 用于结构体变量；写反了会编译报错。'
        : '`.` 只能用于结构体变量/联合体变量，不能用于未解引用的结构体指针。',
      `访问指针成员时要先确保指针不是 NULL，否则程序会崩溃。`,
    ],
    analogy: '结构体是一份档案，`.` 是直接打开档案袋取材料，`->` 是先拿到档案袋的位置再打开。',
    advanced:
      level === 'advanced'
        ? `成员访问在机器层面是"基址 + 偏移量"：编译器根据结构体布局计算出成员偏移，生成一次内存读取。指针成员（如 next）保存的是另一个对象的地址，从而把独立分配的对象连接成链式结构。`
        : undefined,
    level,
    tags: ['成员访问', node.arrow ? '指针' : '结构体'],
    symbol: fieldSymbol,
  };
}

function explainConditional(context: CContext, node: Extract<CNode, { kind: 'Conditional' }>): Explanation {
  const { source, level } = context;
  return {
    title: '三元条件表达式 ?:',
    codeType: '表达式',
    snippet: snippetOf(source, node.range, 160),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: snippetOf(source, node.test.range, 60), role: '判断条件', category: 'operator' },
      { text: '?', role: '条件成立时', category: 'operator' },
      { text: snippetOf(source, node.consequent.range, 50), role: '结果 A', category: 'data' },
      { text: ':', role: '条件不成立时', category: 'operator' },
      { text: snippetOf(source, node.alternate.range, 50), role: '结果 B', category: 'data' },
    ],
    meaning:
      level === 'beginner'
        ? `先看条件成不成立：成立就得到 ${'结果 A'}，不成立就得到 ${'结果 B'}，两个结果二选一。`
        : `计算条件表达式，成立时求值并返回冒号前的表达式，否则返回冒号后的表达式。它是一个表达式，可以直接用在赋值或函数参数里。`,
    purpose: '用一行代码完成简单的二选一，让赋值语句或函数调用更紧凑。',
    why: '有些选择非常简单，写成完整 if 语句太啰嗦；三元表达式提供了紧凑写法。',
    relations: [],
    pitfalls: ['三元表达式嵌套过多会严重降低可读性，复杂逻辑应改用 if/else。', '注意 ? 与 : 的配对，以及与 if/else 的区别：三元表达式会产生一个值。'],
    analogy: '三元表达式像一个二选一开关：按下条件，得到两个结果中的一个。',
    level,
    tags: ['三元表达式', '条件'],
  };
}

function explainCast(context: CContext, node: Extract<CNode, { kind: 'Cast' }>): Explanation {
  const { source, level } = context;
  const typeText = `${node.type.name}${' *'.repeat(node.pointerDepth)}`;
  return {
    title: '显式类型转换',
    codeType: '类型转换',
    snippet: snippetOf(source, node.range, 140),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: `(${typeText})`, role: '目标类型', category: 'type', detail: '把右边表达式的结果转换成这个类型' },
      { text: snippetOf(source, node.expr.range, 100), role: '被转换的表达式', category: 'data' },
    ],
    meaning:
      level === 'beginner'
        ? `把后面表达式的结果"改造成" ${typeText} 类型再使用。比如把整数结果变成小数，或把通用指针变成具体类型的指针。`
        : `显式类型转换（cast）把表达式 ${snippetOf(source, node.expr.range, 60)} 的值转换为 ${typeText}。整数之间转换可能截断；指针转换只是改变编译器对该地址的解释方式，不会移动数据。`,
    purpose: '让类型匹配、表达意图；在 malloc 返回值转换、整数除法转浮点等场景很常见。',
    why: 'C 语言的类型检查需要明确的一致性；有时程序确实需要跨类型表示数据，显式转换让意图清楚。',
    relations: [],
    pitfalls: [
      '把大范围类型转换成小范围类型可能丢失数据（例如 double 转 int 会截断小数）。',
      'malloc 的返回值转换不会"创建"对象，只是告诉编译器如何解释这块内存。',
      '指针类型转换后访问错类型会导致未定义行为。',
    ],
    analogy: '类型转换像把同一份内容换成另一种格式：数字 3.7 变成整数 3，信息会丢失一部分。',
    advanced: level === 'advanced' ? '类型转换在多数情况下不产生额外机器指令：整数提升/截断按目标宽度处理；指针转换只改变类型系统对同一地址的解释，解引用时按目标类型宽度读取。' : undefined,
    level,
    tags: ['类型转换', '类型'],
  };
}

function explainSizeof(context: CContext, node: Extract<CNode, { kind: 'Sizeof' }>): Explanation {
  const { source, level } = context;
  const target = node.typeName
    ? `类型 ${node.typeName.name}${' *'.repeat(node.pointerDepth)}`
    : `表达式 ${node.operand ? snippetOf(source, node.operand.range, 60) : ''}`;
  return {
    title: 'sizeof 内存大小',
    codeType: '内存运算',
    snippet: snippetOf(source, node.range, 100),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: 'sizeof', role: '运算符关键字', category: 'pointer', detail: '注意：它是运算符，不是函数' },
      { text: node.typeName ? `(${node.typeName.name}${' *'.repeat(node.pointerDepth)})` : `(${snippetOf(source, node.operand?.range ?? node.range, 60)})`, role: node.typeName ? '目标类型' : '目标表达式', category: 'data' },
    ],
    meaning:
      level === 'beginner'
        ? `计算出 ${target} 在内存中占多少个字节。结果是一个整数。`
        : `sizeof 计算 ${target} 所占的字节数，结果是 size_t 类型，并且在编译期就能确定（变长数组除外）。它不执行操作数内部的代码（例如 sizeof(i++) 不会真的自增）。`,
    purpose: '申请内存、遍历数组时确定元素大小；sizeof 常用于计算 malloc 需要分配多少字节。',
    why: '不同平台/类型占用的字节数可能不同；直接写死数字会降低可移植性，sizeof 让代码自动适配。',
    relations: [],
    pitfalls: [
      '`sizeof(int)` 括号里是类型；`sizeof x` 括号里是表达式，两者写法都合法但含义不同。',
      '不要把 sizeof 当函数；它不会对表达式求值。',
      '数组作为函数参数退化为指针后，`sizeof(arr)` 得到的是指针大小，而不是数组总大小。',
    ],
    analogy: 'sizeof 像量尺寸的尺子：它不搬东西（不执行表达式），只告诉你这件东西占多大空间。',
    advanced:
      level === 'advanced'
        ? `结构体大小包含对齐填充；指针大小取决于平台（32 位 4 字节，64 位 8 字节）。malloc(sizeof(${node.typeName?.name ?? '类型'}) * n) 是动态分配数组的常见写法。`
        : undefined,
    level,
    tags: ['sizeof', '内存'],
  };
}

function explainComma(context: CContext, node: Extract<CNode, { kind: 'Comma' }>): Explanation {
  const { source, level } = context;
  return {
    title: '逗号表达式',
    codeType: '表达式',
    snippet: snippetOf(source, node.range, 120),
    range: node.range,
    nodeId: node.id,
    composition: node.items.map((item, index) => ({
      text: snippetOf(source, item.range, 50),
      role: `第 ${index + 1} 个表达式`,
      category: 'data' as const,
    })),
    meaning: '逗号表达式从左到右依次计算每个子表达式，整个表达式的值是最后一个子表达式的值。',
    purpose: '在 for 循环等只能放一个表达式的位置，塞入多个操作（如 i++, j--）。',
    why: 'C 语法中某些位置只接受单个表达式；逗号表达式提供了合并多个操作的语法空间。',
    relations: [],
    pitfalls: ['逗号表达式容易与函数参数、变量声明中的逗号混淆；不要为了炫技滥用，可读性通常更重要。'],
    analogy: '逗号表达式像一次性完成几件小事，最后一件的结果代表整个动作的结果。',
    level,
    tags: ['逗号表达式'],
  };
}

function explainInitList(context: CContext, node: Extract<CNode, { kind: 'InitList' }>): Explanation {
  const { source, level } = context;
  return {
    title: '初始化列表 { ... }',
    codeType: '初始化',
    snippet: snippetOf(source, node.range, 140),
    range: node.range,
    nodeId: node.id,
    composition: [
      { text: '{', role: '列表开始', category: 'punctuation' },
      ...node.elements.map((element, index) => ({
        text: snippetOf(source, element.range, 40),
        role: index === 0 ? '第 1 个元素' : `第 ${index + 1} 个元素`,
        category: 'data' as const,
      })),
      { text: '}', role: '列表结束', category: 'punctuation' },
    ],
    meaning:
      level === 'beginner'
        ? '用花括号一次性给数组或结构体的多个元素/成员设定初始值，按顺序依次填入。'
        : '初始化列表按声明顺序为数组元素或结构体成员提供初始值；未列出的元素会被自动初始化为 0。',
    purpose: '让变量创建时就带有完整数据，减少逐个赋值的代码。',
    why: '很多数据在创建时就能确定初始内容；初始化列表让代码更简洁，也避免"未初始化"问题。',
    relations: [],
    pitfalls: ['元素数量和顺序要与数组/结构体的定义匹配。', '只有声明变量时才能用初始化列表；赋值时不能直接写 `arr = {1,2,3};`。'],
    analogy: '初始化列表像给一排盒子同时贴好初始内容标签。',
    level,
    tags: ['初始化', '数组'],
  };
}

function explainEmptyStatement(context: CContext, node: Extract<CNode, { kind: 'EmptyStmt' }>): Explanation {
  const { source, level } = context;
  return {
    title: '空语句 ;',
    codeType: '语句',
    snippet: snippetOf(source, node.range, 30),
    range: node.range,
    nodeId: node.id,
    composition: [{ text: ';', role: '空语句', category: 'punctuation' }],
    meaning: '一个只有分号的语句，什么也不做。',
    purpose: '在语法上需要一个语句但逻辑上不需要动作时占位，例如 for 循环的空初始化或空循环体。',
    why: 'C 语法要求某些位置必须有语句；空语句满足语法但不产生动作。',
    relations: [],
    pitfalls: ['不小心多写分号可能让 if/for 的作用范围变成空语句，例如 `if (x);` 后面的代码总会执行。'],
    analogy: '像表单里的"无"选项：必须填，但表示没有内容。',
    level,
    tags: ['空语句'],
  };
}

function explainUnknown(context: CContext, node: Extract<CNode, { kind: 'Unknown' }>): Explanation {
  const { source, level } = context;
  return {
    title: '暂不支持的语法片段',
    codeType: '未解析',
    snippet: snippetOf(source, node.range, 160),
    range: node.range,
    nodeId: node.id,
    composition: [{ text: snippetOf(source, node.range, 160), role: '原始代码', category: 'punctuation' }],
    meaning: `CodeLens 当前的 C 语法分析器无法完整解析这一段代码：${node.note}`,
    purpose: '保留原始代码位置，提醒用户这里没有参与语义分析。',
    why: '为了保证可靠性与可解释性，CodeLens 选择明确标记不支持的语法，而不是猜测它的含义。',
    relations: [],
    pitfalls: [
      '当前阶段不支持的语法包括：函数指针、位域、goto/标签、K&R 风格函数、C++ 模板/STL/继承等。',
      '如果你需要分析这段代码，可以先把它改写为 CodeLens 支持的 C 子集写法，或在后续版本中等待支持。',
    ],
    analogy: '像地图上标注"此处未测绘"的区域：明确告诉你边界在哪里，而不是随便画一条路。',
    level,
    tags: ['不支持', '能力边界'],
  };
}

function explainFallback(context: CContext, node: CNode): Explanation {
  const { source, level } = context;
  return {
    title: '代码片段',
    codeType: '片段',
    snippet: snippetOf(source, node.range, 160),
    range: node.range,
    nodeId: node.id,
    composition: getChildren(node).map((child) => ({
      text: snippetOf(source, child.range, 60),
      role: '子结构',
      category: 'data' as const,
    })),
    meaning: '这是代码中的一个结构片段。',
    purpose: '',
    why: '',
    relations: [],
    pitfalls: [],
    analogy: '',
    level,
    tags: [],
  };
}

// -------------------------------------------------------------------
// 关系与格式化辅助
// -------------------------------------------------------------------

function symbolRelations(_context: CContext, symbol: SymbolInfo): ExplainRelationGroup[] {
  const groups: ExplainRelationGroup[] = [];
  const declarations = symbol.occurrences.filter((occurrence) => occurrence.role === 'declaration');
  const references = symbol.occurrences.filter((occurrence) => occurrence.role === 'reference');
  const calls = symbol.occurrences.filter((occurrence) => occurrence.role === 'call');
  const members = symbol.occurrences.filter((occurrence) => occurrence.role === 'member');
  const types = symbol.occurrences.filter((occurrence) => occurrence.role === 'type');

  const toItems = (occurrences: typeof symbol.occurrences) =>
    occurrences.slice(0, 40).map((occurrence) => ({
      label: `第 ${occurrence.line} 行：${occurrence.snippet}`,
      line: occurrence.line,
      range: occurrence.range,
      role: occurrence.role,
    }));

  if (declarations.length) groups.push({ title: `声明位置（${declarations.length}）`, items: toItems(declarations) });
  if (references.length) groups.push({ title: `使用位置（${references.length}）`, items: toItems(references) });
  if (calls.length) groups.push({ title: `调用位置（${calls.length}）`, items: toItems(calls) });
  if (members.length) groups.push({ title: `成员使用位置（${members.length}）`, items: toItems(members) });
  if (types.length) groups.push({ title: `类型使用位置（${types.length}）`, items: toItems(types) });
  return groups;
}

function structFieldsRelation(_context: CContext, struct: StructDeclNode): ExplainRelationGroup {
  const items = struct.fields.flatMap((field) =>
    field.declarators.map((declarator) => ({
      label: `${field.type.name}${' *'.repeat(declarator.pointerDepth)} ${declarator.name.name}`,
      line: declarator.range.startLine,
      range: declarator.range,
    })),
  );
  return {
    title: `结构体 ${struct.tag?.name ?? struct.typedefNames[0]?.name ?? '匿名'} 的成员声明`,
    items: items.slice(0, 30),
  };
}

function describeIdentifierContext(_context: CContext, node: IdentifierNode, parent: CNode | undefined): string {
  if (!parent) return '在表达式中被使用。';
  if (parent.kind === 'Call' && parent.callee.id === node.id) return '作为函数调用的被调用者。';
  if (parent.kind === 'Assign' && parent.target.id === node.id) return '作为赋值目标，它的值会被更新。';
  if (parent.kind === 'Assign') return '出现在赋值表达式右侧，它的当前值会被读取。';
  if (parent.kind === 'If' || parent.kind === 'While' || parent.kind === 'For' || parent.kind === 'DoWhile') {
    return '出现在条件判断中，与其他值比较或参与逻辑组合。';
  }
  if (parent.kind === 'Return') return '作为返回值的一部分被读取。';
  if (parent.kind === 'Member') return '作为成员访问的对象。';
  if (parent.kind === 'Index') return '作为数组/指针下标运算的一部分。';
  if (parent.kind === 'Unary' && parent.op === '&') return '它的地址被取出。';
  if (parent.kind === 'Unary' && parent.op === '*') return '它作为指针被解引用。';
  return '在表达式中参与计算。';
}

function symbolKindLabel(symbol: SymbolInfo): string {
  switch (symbol.kind) {
    case 'function':
      return '函数';
    case 'variable':
      return '变量';
    case 'parameter':
      return '参数';
    case 'field':
      return '成员';
    case 'struct':
      return '结构体类型';
    case 'typedef':
      return '类型别名';
    case 'enum':
      return '枚举类型';
    case 'class':
      return '类';
    default:
      return '未解析标识符';
  }
}

function symbolDetailLabel(symbol: SymbolInfo): string {
  switch (symbol.kind) {
    case 'variable':
      return '变量';
    case 'parameter':
      return '函数参数';
    case 'field':
      return '结构体成员';
    case 'function':
      return '函数';
    case 'typedef':
      return '类型别名';
    default:
      return '标识符';
  }
}

function formatInferredType(type: InferredType): string {
  return `${type.name}${' *'.repeat(type.pointerDepth)}${type.arrayDims ? '[]'.repeat(type.arrayDims) : ''}`;
}

function formatParamType(param: ParamNode): string {
  const stars = ' *'.repeat(param.pointerDepth);
  const name = param.name ? ` ${param.name.name}` : '';
  const dims = param.arrayDims.map(() => '[]').join('');
  return `${param.type.name}${stars}${name}${dims}`;
}

function formatType(type: TypeRef, declarator: Pick<Declarator, 'pointerDepth' | 'arrayDims'>): string {
  const stars = ' *'.repeat(declarator.pointerDepth);
  const dims = declarator.arrayDims.map(() => '[]').join('');
  return `${type.name}${stars}${dims}`;
}

function snippetOf(source: SourceFile, range: SourceRange, maxLength: number): string {
  const text = source.text.slice(range.start, range.end).replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** 保留换行与相对缩进的片段展示（用于函数体等多行结构） */
function multilineSnippet(source: SourceFile, range: SourceRange): string {
  const rawLines = source.text.slice(range.start, range.end).split('\n').slice(0, 18);
  // 去掉首尾空行
  while (rawLines.length && !rawLines[0].trim()) rawLines.shift();
  while (rawLines.length && !rawLines[rawLines.length - 1].trim()) rawLines.pop();
  const nonEmpty = rawLines.filter((line) => line.trim());
  const minIndent = nonEmpty.length
    ? Math.min(...nonEmpty.map((line) => line.length - line.trimStart().length))
    : 0;
  const dedented = rawLines.map((line) => line.slice(minIndent).trimEnd());
  let text = dedented.join('\n');
  if (text.length > 900) {
    text = text.slice(0, 900).trimEnd();
    return `${text}\n…`;
  }
  const totalLines = source.text.slice(range.start, range.end).split('\n').length;
  if (totalLines > 18) text += '\n…';
  return text;
}

function countStatements(block: import('../ast').BlockNode): number {
  return block.statements.length;
}

function findAncestorKind(context: CContext, node: CNode, kind: string): CNode | undefined {
  let current: CNode | undefined = context.index.parent.get(node.id);
  while (current) {
    if (current.kind === kind) return current;
    current = context.index.parent.get(current.id);
  }
  return undefined;
}

function variableTitle(node: VarDeclNode, context: CContext): string {
  const declarator = node.declarators[0];
  const pointerDepth = declarator?.pointerDepth ?? 0;
  if (pointerDepth > 0) return pointerDepth >= 2 ? '多级指针声明' : '指针变量声明';
  if (declarator?.arrayDims.length) return '数组声明';
  if (context.symbols.getStruct(node.type.name)) return '结构体变量声明';
  return '变量声明';
}

/** 从子节点生成"相关代码"关系组（供未来扩展使用） */
export function explainChildRelations(context: { source: SourceFile; level: ExplainLevel }, node: CNode): ExplainRelationGroup[] {
  const children = getChildren(node).filter((child) => child.kind !== 'Comment');
  if (!children.length) return [];
  return [
    {
      title: '相关代码',
      items: children.map((child) => ({
        label: snippetOf(context.source, child.range, 70),
        line: child.range.startLine,
        range: child.range,
      })),
    },
  ];
}
