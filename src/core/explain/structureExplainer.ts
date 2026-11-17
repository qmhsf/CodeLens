/**
 * 结构级释义生成器
 * ------------------------------------------------------------------
 * 用于 JS/TS/Python/纯文本等"结构分析"能力级别的语言，以及中文伪代码。
 * 这些语言目前没有 C 那样的完整语义模型，因此释义聚焦于：
 * - 这个结构是什么、在程序中起什么作用；
 * - 它的子结构有哪些；
 * - 当前语言能力边界（明确告知用户）。
 */
import type { AnalysisResult, StructureNode } from '../analysisTypes';
import type { PseudoStatement } from '../pseudo/types';
import { SourceFile, type SourceRange } from '../source';
import type { ExplainLevel, ExplainPart, ExplainRelationGroup, Explanation, HoverInfo } from './types';

interface KindMeta {
  title: string;
  codeType: string;
  meaning: string;
  purpose: string;
  why: string;
  pitfalls: string[];
  analogy: string;
  tags: string[];
}

const KIND_META: Record<string, KindMeta> = {
  program: {
    title: '程序结构',
    codeType: '整体',
    meaning: '整个文件由若干顶层结构组成，程序按语言规则从入口开始执行。',
    purpose: '把解决问题的步骤组织成可读、可维护的代码。',
    why: '结构清晰的程序更容易理解、调试和修改。',
    pitfalls: ['不同语言都有明确的入口与执行顺序，阅读代码时先找到程序入口。'],
    analogy: '整份文件像一本书的目录：先看有哪些章节，再深入具体段落。',
    tags: ['程序结构'],
  },
  function: {
    title: '函数定义',
    codeType: '函数',
    meaning: '函数是一段可以被重复调用的逻辑，接收参数并返回结果。',
    purpose: '封装可复用的步骤，让主流程更清晰。',
    why: '函数能减少重复代码，让复杂问题可以拆成小问题分别解决。',
    pitfalls: ['调用函数时参数的数量和类型要匹配。', '函数内的局部变量通常在函数返回后失效。'],
    analogy: '函数像一台可复用的机器：投入原料（参数），产出结果（返回值）。',
    tags: ['函数', '复用'],
  },
  parameter: {
    title: '函数参数',
    codeType: '参数',
    meaning: '参数是函数接收外部数据的入口，调用时由实参赋值。',
    purpose: '让同一段逻辑可以处理不同的输入。',
    why: '参数把"固定逻辑"变成"可配置的能力"。',
    pitfalls: ['参数名称只在函数内部可见。'],
    analogy: '参数像机器的进料口，不同的材料进入会得到不同的结果。',
    tags: ['参数'],
  },
  struct: {
    title: '结构体/类定义',
    codeType: '自定义类型',
    meaning: '把多个相关数据（可能还有行为）组织成一个整体。',
    purpose: '用一个类型描述一类对象的完整信息。',
    why: '现实数据通常是多项属性的组合，而不是孤立的单个值。',
    pitfalls: ['类型定义不会创建实例，只有声明变量/对象时才会分配数据。'],
    analogy: '像一份表格模板：规定栏目，每一行填写一条实际记录。',
    tags: ['自定义类型'],
  },
  field: {
    title: '成员声明',
    codeType: '成员',
    meaning: '成员是复合类型内部的一个数据项或行为。',
    purpose: '组织对象内部的数据结构。',
    why: '通过成员可以把相关数据放在一起、统一管理。',
    pitfalls: ['访问成员时注意对象与成员访问运算符的使用方式。'],
    analogy: '成员像表格中的一列，每一条记录都包含这一列。',
    tags: ['成员'],
  },
  'enum-member': {
    title: '枚举成员',
    codeType: '常量',
    meaning: '枚举成员是一组有名字的常量，用来表示有限的几种状态。',
    purpose: '让代码用可读的名字代替难以记忆的数字。',
    why: '直接写魔数会降低可读性，枚举让取值含义一目了然。',
    pitfalls: ['枚举成员本质上是整数常量。'],
    analogy: '枚举像菜单上的固定选项：只能从这些名字里选。',
    tags: ['枚举'],
  },
  typedef: {
    title: '类型别名',
    codeType: '类型',
    meaning: '给已有类型起一个别名，让类型名更简洁、更符合语义。',
    purpose: '提高可读性，简化复杂类型声明。',
    why: '好的类型名能让数据用途不言自明。',
    pitfalls: ['别名不会创建新类型，也不会分配存储空间。'],
    analogy: '给一个人起外号：还是同一个人，只是称呼短了。',
    tags: ['类型别名'],
  },
  variable: {
    title: '变量声明',
    codeType: '数据',
    meaning: '创建一个有名字的存储位置，用来保存程序运行中的数据。',
    purpose: '记住计算结果，供后续逻辑使用。',
    why: '程序需要记忆状态，变量是基本单位。',
    pitfalls: ['变量使用前要先声明并初始化。'],
    analogy: '变量像贴了名字的盒子，可以反复放入新数据。',
    tags: ['变量'],
  },
  'global-declaration': {
    title: '全局变量声明',
    codeType: '数据',
    meaning: '在函数外部声明变量，整个文件的函数都可以访问它。',
    purpose: '在多个函数之间共享数据。',
    why: '有些状态需要被多个函数共同使用。',
    pitfalls: ['全局变量让数据关系变得复杂，初学阶段应尽量用参数和返回值传递数据。'],
    analogy: '全局变量像公共储物柜：所有人都能打开，但容易互相影响。',
    tags: ['全局变量'],
  },
  'local-declaration': {
    title: '局部变量声明',
    codeType: '数据',
    meaning: '在函数或代码块内部声明变量，只在这个范围内有效。',
    purpose: '临时保存计算过程，避免与其他函数互相干扰。',
    why: '局部作用域降低了变量重名与误修改的风险。',
    pitfalls: ['离开作用域后变量就不能再访问。'],
    analogy: '局部变量像临时便签：只在本次工作中有效，做完就丢。',
    tags: ['局部变量'],
  },
  if: {
    title: '条件判断 if',
    codeType: '控制结构',
    meaning: '根据条件是否成立选择执行不同的分支。',
    purpose: '让程序能够做选择，而不是永远执行同一条路。',
    why: '现实逻辑几乎都包含"如果……就……否则……"。',
    pitfalls: ['比较相等要用 == 或 ===，不要误写成赋值。', '复杂判断建议加括号明确优先级。'],
    analogy: 'if 像岔路口：看条件，选择其中一条路。',
    tags: ['条件', '控制结构'],
  },
  condition: {
    title: '判断条件',
    codeType: '表达式',
    meaning: '条件表达式会产生真/假结果，决定分支或循环是否继续。',
    purpose: '控制程序流程的方向。',
    why: '条件是把数据状态转化为执行选择的桥梁。',
    pitfalls: ['不同语言对"真值"的定义不同：有些语言有 truthy/falsy 概念。'],
    analogy: '条件像安检门：满足条件才放行。',
    tags: ['条件'],
  },
  for: {
    title: 'for 循环',
    codeType: '循环',
    meaning: '按固定规则重复执行代码块，通常用于已知次数的遍历。',
    purpose: '自动处理重复任务，例如遍历数组。',
    why: '重复是计算机擅长的工作，循环让代码从重复书写中解放出来。',
    pitfalls: ['注意边界条件与循环变量的更新，避免死循环或差一错误。'],
    analogy: '像跑步机设定圈数：每完成一圈继续下一圈，直到达到目标。',
    tags: ['循环'],
  },
  while: {
    title: 'while 循环',
    codeType: '循环',
    meaning: '只要条件成立就重复执行循环体。',
    purpose: '处理次数不确定、只知道继续条件的重复任务。',
    why: '很多任务无法预知次数，只能根据状态决定是否继续。',
    pitfalls: ['循环体中要更新条件相关变量，否则可能死循环。'],
    analogy: '像"只要水还没开就继续加热"。',
    tags: ['循环'],
  },
  'do-while': {
    title: 'do-while 循环',
    codeType: '循环',
    meaning: '先执行一次循环体，再判断是否继续。',
    purpose: '保证至少执行一次，例如菜单、输入校验。',
    why: '有些任务必须先做一次才能判断是否继续。',
    pitfalls: ['条件判断在末尾，注意语法与终止条件。'],
    analogy: '像试吃：先尝一口，再决定要不要继续。',
    tags: ['循环'],
  },
  switch: {
    title: 'switch 多分支',
    codeType: '分支',
    meaning: '根据同一个表达式的不同取值选择不同分支。',
    purpose: '替代冗长的 if-else 链，让多情况选择更清晰。',
    why: '当一个值可能对应多种情况时，switch 更易读。',
    pitfalls: ['注意各分支是否需要 break，避免意外贯穿。'],
    analogy: '像分拣机：按标签值把包裹送到不同通道。',
    tags: ['分支'],
  },
  return: {
    title: '返回语句',
    codeType: '函数控制',
    meaning: '结束当前函数，把结果交给调用者。',
    purpose: '输出函数计算结果，或提前结束函数。',
    why: '函数需要一个把结果传出函数体的出口。',
    pitfalls: ['return 后的语句不会执行。'],
    analogy: '像交卷离场：把答案交给老师后立刻离开。',
    tags: ['返回'],
  },
  break: {
    title: 'break 跳出',
    codeType: '控制',
    meaning: '立即结束当前循环或 switch。',
    purpose: '在满足条件时提前退出重复结构。',
    why: '找到目标后继续循环是浪费，break 提供了提前结束的手段。',
    pitfalls: ['只跳出最内层循环。'],
    analogy: '像提前交卷离场。',
    tags: ['循环控制'],
  },
  continue: {
    title: 'continue 继续',
    codeType: '控制',
    meaning: '跳过本轮剩余语句，直接进入下一轮。',
    purpose: '过滤掉不需要处理的数据。',
    why: '可以避免把主逻辑包在多层 if 中。',
    pitfalls: ['while 循环中使用时要注意条件变量是否会被更新。'],
    analogy: '像广播体操跳过当前一节。',
    tags: ['循环控制'],
  },
  call: {
    title: '函数调用',
    codeType: '函数',
    meaning: '调用一个已定义的函数，把参数交给它并接收返回值。',
    purpose: '复用封装好的逻辑。',
    why: '函数调用让程序可以组合出复杂行为。',
    pitfalls: ['参数类型、数量和顺序应与函数定义匹配。'],
    analogy: '像点外卖：报需求，等结果。',
    tags: ['函数调用'],
  },
  assignment: {
    title: '赋值语句',
    codeType: '运算',
    meaning: '计算右边的值，保存到左边的变量中。',
    purpose: '更新程序状态。',
    why: '变量需要能被更新，程序才能随运行过程变化。',
    pitfalls: ['赋值 = 与比较 ==/=== 不同。'],
    analogy: '把新内容写进贴了标签的盒子。',
    tags: ['赋值'],
  },
  expression: {
    title: '表达式',
    codeType: '表达式',
    meaning: '由数据与运算符组成的计算过程，会产生一个值。',
    purpose: '计算数据、比较条件或调用函数。',
    why: '表达式是程序进行计算的基本方式。',
    pitfalls: ['注意运算符优先级，必要时加括号。'],
    analogy: '表达式像一道计算题。',
    tags: ['表达式'],
  },
  block: {
    title: '代码块',
    codeType: '作用域',
    meaning: '一组按顺序执行的语句，同时形成新的作用域。',
    purpose: '把多条语句组合成一个整体。',
    why: '控制结构需要把多条语句当作一个单元处理。',
    pitfalls: ['注意作用域范围与花括号配对。'],
    analogy: '像步骤包：外面是一步，里面包含很多小步骤。',
    tags: ['代码块'],
  },
  'function-body': {
    title: '函数体',
    codeType: '作用域',
    meaning: '函数被调用时真正执行的语句集合。',
    purpose: '实现函数的具体逻辑。',
    why: '函数声明描述"做什么"，函数体实现"怎么做"。',
    pitfalls: ['函数体中的局部变量生命周期随函数调用结束而结束。'],
    analogy: '函数体是机器的内部运作流程。',
    tags: ['函数体'],
  },
  preprocessor: {
    title: '预处理/导入语句',
    codeType: '模块',
    meaning: '在正式编译/执行前引入其他代码或声明。',
    purpose: '使用标准库或其他模块提供的能力。',
    why: '代码复用与模块化需要引入外部声明。',
    pitfalls: ['不同语言的导入语法与作用范围不同。'],
    analogy: '像做菜前先把食材和工具准备好。',
    tags: ['导入', '模块'],
  },
  unknown: {
    title: '未解析片段',
    codeType: '未解析',
    meaning: '当前分析器无法完整理解这段代码，CodeLens 不会猜测其含义。',
    purpose: '保留原始位置，提示能力边界。',
    why: '明确边界比给出错误解释更负责任。',
    pitfalls: ['请查看右侧或底部的能力说明，了解当前语言支持范围。'],
    analogy: '像地图上未测绘的区域，明确标注而不是乱画。',
    tags: ['能力边界'],
  },
};

const LANGUAGE_EXPLANATION_NOTE: Record<string, string> = {
  javascript: 'JavaScript 当前提供 AST 结构分析、语义高亮与基础释义；暂未接入执行引擎。',
  typescript: 'TypeScript 当前提供 AST 结构分析、语义高亮与基础释义；暂未接入执行引擎。',
  python: 'Python 当前提供基于缩进的结构解析、语义高亮与基础释义；暂未接入执行引擎。',
  plaintext: '当前内容按结构化文本做有限分析，可能无法准确识别语义。',
};

function metaFor(kind: string): KindMeta {
  return KIND_META[kind] ?? {
    title: '代码结构',
    codeType: '结构',
    meaning: '这是代码中的一个结构片段。',
    purpose: '组织代码逻辑。',
    why: '清晰的结构有助于理解程序。',
    pitfalls: [],
    analogy: '',
    tags: [],
  };
}

function snippetOf(source: SourceFile, range: SourceRange | undefined, maxLength = 140): string {
  if (!range) return '';
  const text = source.text.slice(range.start, range.end).replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** 生成结构树节点的释义 */
export function explainStructureNode(
  analysis: AnalysisResult,
  node: StructureNode,
  level: ExplainLevel,
): Explanation {
  const source = new SourceFile(analysis.source);
  const meta = metaFor(node.kind);
  const snippet = node.range ? snippetOf(source, node.range) : node.secondary ?? node.label;
  const composition: ExplainPart[] = [];
  if (node.range) {
    const lineText = source.lineText(node.range.startLine).trim();
    composition.push({
      text: lineText.length > 160 ? `${lineText.slice(0, 159)}…` : lineText,
      role: '所在代码行',
      category: 'data',
    });
  }
  for (const child of node.children.slice(0, 10)) {
    composition.push({
      text: `${child.label}${child.secondary ? ` · ${child.secondary}` : ''}`,
      role: '子结构',
      category: 'data',
    });
  }

  const relations: ExplainRelationGroup[] = [];
  if (node.children.length) {
    relations.push({
      title: `子结构（${node.children.length}）`,
      items: node.children.map((child) => ({
        label: `${child.label}${child.secondary ? `：${child.secondary}` : ''}`,
        line: child.range?.startLine,
        range: child.range,
      })),
    });
  }
  if (node.range) {
    relations.push({
      title: '源码位置',
      items: [{ label: `第 ${node.range.startLine}–${node.range.endLine} 行`, line: node.range.startLine, range: node.range }],
    });
  }

  const levelNote =
    level === 'advanced'
      ? `分析引擎：${analysis.analyzer}。${LANGUAGE_EXPLANATION_NOTE[analysis.language] ?? ''}`
      : undefined;

  return {
    title: node.secondary ? `${node.label}（${node.secondary}）` : node.label,
    codeType: meta.codeType,
    snippet,
    range: node.range,
    nodeId: node.nodeId,
    composition,
    meaning:
      level === 'beginner'
        ? meta.meaning
        : level === 'intermediate'
          ? `${meta.meaning} 从结构树上看，它位于第 ${node.range?.startLine ?? '?'} 行，包含 ${node.children.length} 个子结构。`
          : `${meta.meaning} ${levelNote ?? ''}`,
    purpose: meta.purpose,
    why: meta.why,
    relations,
    pitfalls: meta.pitfalls,
    analogy: meta.analogy,
    advanced: level === 'advanced' ? levelNote : undefined,
    level,
    tags: meta.tags,
    limitations: analysis.supportNotes.filter((note) => note.includes('暂不') || note.includes('不支持') || note.includes('有限')),
  };
}

/** 生成伪代码某一行的释义（区分原文 / 推断 / 生成代码） */
export function explainPseudoLine(analysis: AnalysisResult, line: number, level: ExplainLevel): Explanation | null {
  const pseudo = analysis.pseudo;
  if (!pseudo) return null;
  const source = new SourceFile(analysis.source);
  const lineInfo = pseudo.lines.find((item) => item.line === line);
  const statement = lineInfo?.statementId ? findPseudoStatement(pseudo.statements, lineInfo.statementId) : undefined;
  if (statement) return explainPseudoStatement(analysis, statement, level);

  const original = lineInfo?.original ?? source.lineText(line);
  const empty = original.trim().length === 0;
  return {
    title: empty ? '空行' : '未能推断的行',
    codeType: '伪代码',
    snippet: original.trim() || '（空行）',
    range: source.range(source.lineStartOffset(line), source.lineEndOffset(line)),
    composition: [{ text: original.trim() || '（空行）', role: '用户原文', category: 'comment' }],
    meaning: empty ? '这一行是空行，用来分隔代码块、提高可读性。' : '这一行没有被伪代码分析器识别成明确的结构。CodeLens 不会假装理解它。',
    purpose: '',
    why: '',
    relations: [],
    pitfalls: empty
      ? []
      : ['可以尝试把这一行改写为更完整的描述，例如"创建一个整数变量 a，赋值为 10"。', '未识别的行不会被悄悄丢弃，而是会出现在分析警告中。'],
    analogy: '',
    level,
    tags: ['伪代码', '未识别'],
    limitations: pseudo.warnings,
  };
}

function findPseudoStatement(statements: PseudoStatement[], id: string): PseudoStatement | undefined {
  for (const statement of statements) {
    if (statement.id === id) return statement;
    const found = findPseudoStatement(statement.children, id);
    if (found) return found;
  }
  return undefined;
}

function findPseudoStatementAtLine(statements: PseudoStatement[], line: number): PseudoStatement | undefined {
  let found: PseudoStatement | undefined;
  for (const statement of statements) {
    if (line >= statement.line && line <= statement.endLine) {
      found = statement;
      const child = findPseudoStatementAtLine(statement.children, line);
      if (child) return child;
    }
  }
  return found;
}

export function explainPseudoStatement(
  analysis: AnalysisResult,
  statement: PseudoStatement,
  level: ExplainLevel,
): Explanation {
  const pseudo = analysis.pseudo!;
  const generatedLines =
    statement.generatedStartLine && statement.generatedEndLine
      ? pseudo.generatedCode
          .split('\n')
          .slice(statement.generatedStartLine - 1, statement.generatedEndLine)
          .join('\n')
      : undefined;

  const composition: ExplainPart[] = [
    { text: statement.original.trim(), role: '用户原文', category: 'comment', detail: '这是你写的原始描述，系统没有改写它' },
  ];
  const inference = statement.inference;
  const inferenceEntries: [string, string | undefined][] = [
    ['结构类型', pseudoKindLabel(statement.kind)],
    ['推断摘要', inference.summary],
    ['变量', inference.declaredName ?? inference.assignmentTarget],
    ['类型', inference.declaredType],
    ['值', inference.declaredValue ?? inference.assignmentValue],
    ['条件', inference.condition],
    ['循环变量', inference.loopVariable],
    ['循环范围', inference.loopFrom && inference.loopTo ? `${inference.loopFrom} → ${inference.loopTo}` : undefined],
    ['输出内容', inference.printExpression],
    ['函数', inference.functionName ?? inference.callName],
  ];
  for (const [role, value] of inferenceEntries) {
    if (value) composition.push({ text: String(value), role: role, category: role === '结构类型' ? 'control' : 'data', detail: '系统推断内容（非用户原文）' });
  }

  const relations: ExplainRelationGroup[] = [];
  if (generatedLines) {
    relations.push({
      title: '生成的 C 代码（仅供参考）',
      items: [{ label: generatedLines.split('\n')[0] ?? '', line: statement.generatedStartLine }],
    });
  }
  if (statement.children.length) {
    relations.push({
      title: `子结构（${statement.children.length}）`,
      items: statement.children.map((child) => ({ label: `第 ${child.line} 行：${child.inference.summary}`, line: child.line })),
    });
  }
  relations.push({
    title: '源码位置',
    items: [{ label: `第 ${statement.line}–${statement.endLine} 行`, line: statement.line }],
  });

  const confidenceText =
    statement.confidence === 'high' ? '高（结构明确）' : statement.confidence === 'medium' ? '中（合理推断，建议核对）' : '低（仅猜测，请谨慎）';

  return {
    title: `伪代码：${pseudoKindLabel(statement.kind)}`,
    codeType: '伪代码推断',
    snippet: statement.original.trim(),
    composition,
    meaning:
      level === 'beginner'
        ? `你写的是："${statement.original.trim()}"。系统把它理解为：${inference.summary}。`
        : `原始伪代码："${statement.original.trim()}"。系统推断为 ${pseudoKindLabel(statement.kind)}：${inference.summary}。推断置信度：${confidenceText}。${
            generatedLines ? '对应生成的 C 代码见下方（生成结果不是你的原文）。' : ''
          }`,
    purpose: '把自然语言描述转换成可分析、可执行的结构，帮助初学者观察"人话"和"代码"之间的对应关系。',
    why: '伪代码适合梳理思路，但计算机只认识严格语法；转换过程能暴露描述中的歧义和遗漏。',
    relations,
    pitfalls: [
      '系统推断不等于你的原文；如果理解有偏差，请修改伪代码表达得更明确。',
      ...(statement.confidence === 'low' ? ['当前行置信度低，生成代码可能不符合你的本意。'] : []),
      ...statement.notes,
    ],
    analogy: '伪代码像做菜前的口头描述，生成的 C 代码像把描述整理成标准菜谱；前者灵活，后者严格。',
    advanced:
      level === 'advanced'
        ? `当前语句由规则推断生成，不等于语义解析的最终结果。生成代码行范围：${generatedLines ? `生成的 C 代码第 ${statement.generatedStartLine}–${statement.generatedEndLine} 行。` : '无可靠生成结果。'}`
        : undefined,
    level,
    tags: ['伪代码', pseudoKindLabel(statement.kind)],
    comparisons: [
      {
        original: statement.original.trim(),
        inferred: inference.summary,
        generated: generatedLines,
        confidence: confidenceText,
      },
    ],
    limitations: pseudo.warnings,
  };
}

function pseudoKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    declare: '变量声明',
    assign: '赋值',
    print: '输出',
    input: '输入',
    if: '条件判断',
    elseif: '否则如果',
    else: '否则分支',
    loop: '循环',
    function: '函数',
    return: '返回',
    break: 'break',
    continue: 'continue',
    call: '函数调用',
    comment: '注释',
    unknown: '未识别',
  };
  return labels[kind] ?? kind;
}

/** 在伪代码中根据偏移量生成释义 */
export function explainPseudoAt(analysis: AnalysisResult, offset: number, level: ExplainLevel): Explanation | null {
  const pseudo = analysis.pseudo;
  if (!pseudo) return null;
  const source = new SourceFile(analysis.source);
  const line = source.positionAt(offset).line;
  const statement = findPseudoStatementAtLine(pseudo.statements, line);
  if (statement) return explainPseudoStatement(analysis, statement, level);
  const lineInfo = pseudo.lines.find((item) => item.line === line);
  if (lineInfo?.kind === 'comment') {
    return {
      title: '伪代码注释',
      codeType: '注释',
      snippet: lineInfo.original.trim(),
      range: source.range(source.lineStartOffset(line), source.lineEndOffset(line)),
      composition: [{ text: lineInfo.original.trim(), role: '注释', category: 'comment' }],
      meaning: '这是一行注释，系统会忽略它的内容。',
      purpose: '给自己的伪代码补充说明。',
      why: '注释不会被推断成程序结构。',
      relations: [],
      pitfalls: [],
      analogy: '',
      level,
      tags: ['注释'],
    };
  }
  return explainPseudoLine(analysis, line, level);
}

/** 非 C 语言：根据点击位置返回悬停信息 */
export function hoverStructureAt(analysis: AnalysisResult, offset: number): HoverInfo | null {
  const source = new SourceFile(analysis.source);
  if (analysis.pseudo) {
    const line = source.positionAt(offset).line;
    const statement = findPseudoStatementAtLine(analysis.pseudo.statements, line);
    if (statement) {
      return {
        title: `伪代码：${pseudoKindLabel(statement.kind)}`,
        badge: statement.confidence === 'high' ? '高置信度' : statement.confidence === 'medium' ? '中置信度' : '低置信度',
        summary: statement.inference.summary,
        hint: '点击查看原文、推断与生成代码的对照',
      };
    }
  }
  const structure = findStructureAtOffset(analysis.tree, offset);
  if (!structure) return null;
  const meta = metaFor(structure.kind);
  return {
    title: structure.label,
    badge: structure.secondary,
    summary: meta.meaning,
    hint: '点击查看结构释义',
  };
}

/** 根据偏移量在结构树中查找最深节点 */
export function findStructureAtOffset(nodes: StructureNode[], offset: number): StructureNode | undefined {
  let found: StructureNode | undefined;
  const visit = (list: StructureNode[]) => {
    for (const node of list) {
      if (!node.range) continue;
      if (offset < node.range.start || offset > node.range.end) continue;
      found = node;
      visit(node.children);
    }
  };
  visit(nodes);
  return found;
}

/** 根据结构树自身的 id 或关联的 AST 节点 id 查找结构节点 */
export function findStructureByAnyId(analysis: AnalysisResult, id: string | undefined): StructureNode | undefined {
  if (!id) return undefined;
  let found: StructureNode | undefined;
  const visit = (list: StructureNode[]) => {
    for (const node of list) {
      if (node.id === id || node.nodeId === id) found = node;
      if (!found) visit(node.children);
    }
  };
  visit(analysis.tree);
  return found;
}
