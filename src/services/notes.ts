/**
 * 学习笔记生成（本地规则驱动）
 * ------------------------------------------------------------------
 * 不依赖 AI，直接从分析结果（结构树、符号表、问题列表、语义 token）中
 * 提炼出可复习的 Markdown 笔记。内容全部来自真实分析结果：
 * 识别出的函数、结构体、控制结构、指针/内存使用、解析限制与自测问题。
 */
import type { AnalysisResult } from '../core/analysisTypes';
import { flattenStructure } from '../core/analysisTypes';

export interface LearningNotes {
  title: string;
  markdown: string;
  generatedAt: string;
}

export function generateLearningNotes(analysis: AnalysisResult): LearningNotes {
  const generatedAt = new Date().toLocaleString('zh-CN');
  const structures = flattenStructure(analysis.tree);
  const functions = analysis.symbolList.filter((symbol) => symbol.kind === 'function');
  const structs = analysis.symbolList.filter((symbol) => symbol.kind === 'struct');
  const variables = analysis.symbolList.filter((symbol) => symbol.kind === 'variable' || symbol.kind === 'parameter');
  const fields = analysis.symbolList.filter((symbol) => symbol.kind === 'field');
  const loops = structures.filter((node) => ['for', 'while', 'do-while', 'loop', 'pseudo-loop'].includes(node.kind));
  const conditions = structures.filter((node) => ['if', 'condition'].includes(node.kind) || node.kind === 'if-stat');
  const calls = structures.filter((node) => node.kind === 'call' || node.kind === 'function');

  const lines: string[] = [];
  lines.push(`# ${analysis.languageLabel} 学习笔记`);
  lines.push('');
  lines.push(`> 生成时间：${generatedAt}　分析引擎：${analysis.analyzer}　支持级别：${analysis.supportLevel === 'full' ? '完整分析' : analysis.supportLevel === 'structural' ? '结构级分析' : '有限文本分析'}`);
  lines.push('');
  lines.push('## 一、代码概览');
  lines.push('');
  lines.push(`- 代码行数：${analysis.stats.lines}`);
  lines.push(`- 语义 token：${analysis.stats.tokens}`);
  lines.push(`- 识别出的结构：${analysis.stats.structures}`);
  lines.push(`- 符号（函数/变量/类型等）：${analysis.stats.symbols}`);
  lines.push(`- 解析问题：错误 ${analysis.stats.errors}，警告 ${analysis.stats.warnings}`);
  lines.push('');

  lines.push('## 二、识别出的程式结构');
  lines.push('');
  const topLevel = analysis.tree[0]?.children ?? [];
  if (!topLevel.length) {
    lines.push('_没有识别出明确结构。_');
  } else {
    for (const node of topLevel.slice(0, 20)) {
      lines.push(`- **${node.label}**${node.secondary ? `：${node.secondary}` : ''}`);
      for (const child of node.children.slice(0, 6)) {
        lines.push(`  - ${child.label}${child.secondary ? `：${child.secondary}` : ''}`);
      }
    }
  }
  lines.push('');

  lines.push('## 三、函数与类型');
  lines.push('');
  if (functions.length) {
    lines.push('### 函数');
    for (const fn of functions) {
      lines.push(`- \`${fn.typeText ?? fn.name}\`　声明位置：第 ${fn.declaration?.line ?? '?'} 行`);
    }
    lines.push('');
  }
  if (structs.length) {
    lines.push('### 自定义类型');
    for (const struct of structs) {
      lines.push(`- **${struct.name}**（${struct.detail ?? '结构体'}）`);
      const relatedFields = fields.filter((field) => field.scopeName === struct.name);
      for (const field of relatedFields) {
        lines.push(`  - 成员 \`${field.typeText ?? field.name} ${field.name}\``);
      }
    }
    lines.push('');
  }
  if (!functions.length && !structs.length) {
    lines.push('_未识别到函数或自定义类型。_');
    lines.push('');
  }

  lines.push('## 四、变量与数据');
  lines.push('');
  if (variables.length) {
    for (const variable of variables.slice(0, 25)) {
      lines.push(`- \`${variable.typeText ?? '?'} ${variable.name}\`（${variable.detail ?? '变量'}，作用域：${variable.scopeName ?? '未知'}）`);
    }
  } else {
    lines.push('_未识别到变量声明。_');
  }
  lines.push('');

  lines.push('## 五、控制流程');
  lines.push('');
  lines.push(`- 循环结构：${loops.length} 处${loops.length ? `（${loops.map((node) => node.label).join('、')}）` : ''}`);
  lines.push(`- 条件结构：${conditions.length} 处${conditions.length ? `（${conditions.map((node) => node.label).join('、')}）` : ''}`);
  lines.push(`- 函数/调用结构：${calls.length} 处`);
  lines.push('');

  const concepts = detectConcepts(analysis);
  lines.push('## 六、关键知识点');
  lines.push('');
  if (concepts.length) {
    for (const concept of concepts) {
      lines.push(`### ${concept.title}`);
      lines.push('');
      lines.push(concept.detail);
      lines.push('');
    }
  } else {
    lines.push('_当前代码没有触发额外的重点知识提示。_');
    lines.push('');
  }

  lines.push('## 七、解析问题与能力边界');
  lines.push('');
  if (analysis.issues.length) {
    for (const issue of analysis.issues.slice(0, 15)) {
      lines.push(`- [${issueSeverityLabel(issue.severity)}]${issue.line ? `第 ${issue.line} 行：` : ''}${issue.message}`);
    }
  } else {
    lines.push('_没有发现解析问题。_');
  }
  lines.push('');
  for (const note of analysis.supportNotes) {
    lines.push(`- ${note}`);
  }
  lines.push('');

  lines.push('## 八、自测问题');
  lines.push('');
  const questions = buildQuestions(analysis, loops, conditions, functions, structs);
  for (const question of questions) {
    lines.push(`- [ ] ${question}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('> 本笔记由 CodeLens 根据语法分析结果自动生成，不是 AI 编造内容；如需更深入的讲解，可在配置 AI 服务后生成 AI 笔记。');

  return {
    title: `${analysis.languageLabel} 学习笔记`,
    markdown: lines.join('\n'),
    generatedAt,
  };
}

function issueSeverityLabel(severity: string): string {
  return severity === 'error' ? '错误' : severity === 'warning' ? '警告' : '提示';
}

interface Concept {
  title: string;
  detail: string;
}

function detectConcepts(analysis: AnalysisResult): Concept[] {
  const concepts: Concept[] = [];
  const code = analysis.source;
  const hasPointerDecl = /(?:\*|->|\b(?:malloc|calloc|free)\b)/.test(code);
  const hasStruct = analysis.symbolList.some((symbol) => symbol.kind === 'struct');
  const hasArray = analysis.symbolList.some((symbol) => symbol.typeText?.includes('['));
  const hasLoop = analysis.tree.some((node) => node.kind === 'for' || node.kind === 'while' || node.kind === 'do-while');
  const hasRecursion = code.includes('factorial') ? /factorial\s*\(\s*n\s*-\s*1\s*\)/.test(code) : false;
  const hasMalloc = /\bmalloc\s*\(/.test(code);
  const hasFree = /\bfree\s*\(/.test(code);

  if (hasPointerDecl) {
    concepts.push({
      title: '指针与内存',
      detail:
        '代码中出现了指针相关操作（*、->、malloc/free）。注意：指针保存的是地址；`int *p` 声明指针，`*p` 解引用取值，`&x` 取变量地址。使用指针前必须让它指向有效对象，malloc 分配的内存使用后要 free。',
    });
  }
  if (hasStruct) {
    concepts.push({
      title: '结构体与成员访问',
      detail:
        '结构体把多个相关数据打包成一个整体。结构体变量用 `.` 访问成员，结构体指针用 `->` 访问成员；`typedef struct` 可以省去重复写 struct 关键字。',
    });
  }
  if (hasArray) {
    concepts.push({
      title: '数组与下标',
      detail: '数组元素在内存中连续存放，下标从 0 开始；C 语言不会自动检查越界，访问时要注意下标范围。',
    });
  }
  if (hasMalloc && !hasFree) {
    concepts.push({
      title: '动态内存管理',
      detail: '代码使用 malloc 申请了堆内存，但没有发现对应的 free 调用。对初学者而言，先记住：申请的内存最终要归还，否则会造成内存泄漏。',
    });
  }
  if (hasLoop) {
    concepts.push({
      title: '循环与边界',
      detail: '循环的关键是三个部分：初始化、继续条件、更新。特别注意边界（`<` 与 `<=` 的区别）以及循环变量是否会被更新。',
    });
  }
  if (hasRecursion) {
    concepts.push({
      title: '递归与调用栈',
      detail: '递归函数通过调用自身把问题规模缩小，必须有终止条件（基准情形）。每次递归调用都会在调用栈上新增一层栈帧。',
    });
  }
  return concepts;
}

function buildQuestions(
  analysis: AnalysisResult,
  loops: { label: string }[],
  conditions: { label: string }[],
  functions: { name: string }[],
  structs: { name: string }[],
): string[] {
  const questions: string[] = [];
  if (loops.length) questions.push('把代码中的 for 循环改写为 while 循环，执行结果会变化吗？为什么？');
  if (conditions.length) questions.push('如果条件表达式取反，程序行为会怎样变化？');
  if (functions.length) questions.push(`函数 ${functions[0].name} 的输入、输出分别是什么？去掉它的返回值调用会发生什么？`);
  if (structs.length) questions.push(`结构体 ${structs[0].name} 的每个成员分别存储什么数据？`);
  if (analysis.symbolList.some((symbol) => symbol.isPointer)) {
    questions.push('找到代码中的所有指针变量：它们保存的是谁的地地址？使用前是否一定被初始化？');
  }
  const badLoop = analysis.issues.find((issue) => issue.line);
  if (badLoop) questions.push(`第 ${badLoop.line} 行存在解析提示，尝试理解它为什么会被标记，并思考如何修改。`);
  questions.push('用自己的话向同学解释这段代码的整体执行流程（从入口开始）。');
  return questions.slice(0, 8);
}
