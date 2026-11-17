/**
 * 分析管线统一入口
 * ------------------------------------------------------------------
 * 根据语言把源码交给对应的分析器，并包装成 UI 可直接消费的 AnalysisResult：
 * - C / C++：手写 AST + 符号表 + 语义高亮 + 结构树（完整能力）
 * - 中文伪代码：规则推断 + 结构树 + 生成 C 代码（明确标注推断）
 * - JS / TS / Python：结构级分析（语义高亮、结构树、基础关联与释义）
 * - 未知文本：有限结构分析（明确提示能力边界）
 *
 * 分析过程中出现的语法错误、不支持语法都会记录为 issues，由 UI 明确展示，
 * 绝不静默丢弃，也不伪造分析或执行结果。
 */
import type {
  AnalysisResult,
  LanguageAnalysis,
  LanguageId,
  SemanticToken,
  StructureNode,
} from './analysisTypes';
import { LANGUAGE_OPTIONS } from './analysisTypes';
import { buildIndex, type CNodeIndex, type ProgramNode } from './ast';
import { parseC } from './cParser';
import { analyzeJavaScript, analyzePython } from './languages';
import { tokenizeC } from './lexer';
import { analyzePseudo } from './pseudo/analyzer';
import type { PseudoAnalysis, PseudoStatement } from './pseudo/types';
import { buildSemanticTokens } from './semantic';
import { SourceFile } from './source';
import { buildCStructureTree } from './structureTree';
import { buildCSymbols } from './symbols';
import { analyzePlainText } from './textFallback';

export interface AnalyzeOptions {
  /** 文件名（用于按扩展名识别语言） */
  fileName?: string;
  /** 显式指定语言；不传则自动识别 */
  language?: LanguageId;
}

export interface DetectionResult {
  language: LanguageId;
  reason: string;
}

const EXTENSION_MAP: Record<string, LanguageId> = {
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  py: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  pseudo: 'pseudo',
  txt: 'plaintext',
  md: 'plaintext',
};

/** 根据扩展名与内容特征自动识别语言 */
export function detectLanguage(code: string, fileName?: string): DetectionResult {
  const extension = fileName?.split('.').pop()?.toLowerCase();
  if (extension && EXTENSION_MAP[extension]) {
    return { language: EXTENSION_MAP[extension], reason: `根据文件扩展名 .${extension} 识别` };
  }

  const trimmed = code.trim();
  if (!trimmed) return { language: 'c', reason: '默认使用 C 语言' };

  // 中文内容优先考虑伪代码（但包含明显 C 结构时仍按 C 处理）
  const chineseCount = (code.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const hasCInclude = /#\s*(include|define|ifndef|pragma)\b/.test(code);
  const hasCMain = /\b(int|void|char|float|double|long|short|unsigned)\s+\w*\s*\w+\s*\([^)]*\)\s*\{/.test(code);
  const hasCStatement = /\b(printf|scanf|malloc|free|sizeof)\s*\(/.test(code) && /;\s*(\/\/.*)?$/m.test(code);
  const hasCppMarker = /\b(class|namespace|template|std::|cout|cin|new|delete)\b/.test(code);

  if (hasCppMarker) return { language: 'cpp', reason: '检测到 C++ 特征关键字（class/std::/cout 等）' };
  if (hasCInclude || hasCMain) return { language: 'c', reason: '检测到 #include 或 C 函数定义特征' };
  if (hasCStatement) return { language: 'c', reason: '检测到 printf/malloc 等 C 库函数调用特征' };

  if (/^\s*(def|class)\s+\w+/m.test(code) && /:\s*$/m.test(code)) {
    return { language: 'python', reason: '检测到 Python 的 def/class 与缩进冒号特征' };
  }
  if (/^\s*(import|from)\s+\w+/m.test(code) && !/;\s*$/m.test(code)) {
    return { language: 'python', reason: '检测到 Python 的 import 语句特征' };
  }
  if (/\b(interface|type)\s+\w+\s*[=:]/.test(code) || /:\s*(string|number|boolean|void)\b/.test(code) || /<\w+>/.test(code) && /:\s*\w+/.test(code)) {
    if (/\b(function|const|let|var|class|interface|type)\b/.test(code)) {
      return { language: 'typescript', reason: '检测到 TypeScript 类型标注特征' };
    }
  }
  if (/\b(function|const|let|var|class)\b/.test(code) || /=>/.test(code) || /console\.(log|error)/.test(code)) {
    return { language: 'javascript', reason: '检测到 JavaScript 声明/箭头函数特征' };
  }

  if (chineseCount >= 3) {
    return { language: 'pseudo', reason: '检测到中文自然语言描述，按伪代码分析' };
  }
  return { language: 'plaintext', reason: '未识别出明确语言，按结构化文本有限分析' };
}

function languageLabel(language: LanguageId): string {
  return LANGUAGE_OPTIONS.find((option) => option.id === language)?.label ?? language;
}

let analysisCounter = 0;

/**
 * 分析源码。
 * @param code 源码文本
 * @param options 语言与文件名（可选）
 */
export function analyzeCode(code: string, options: AnalyzeOptions = {}): AnalysisResult {
  const startedAt = performance.now();
  const language = options.language ?? detectLanguage(code, options.fileName).language;
  const source = new SourceFile(code);

  try {
    switch (language) {
      case 'c':
      case 'cpp':
        return finalize(source, analyzeC(source, language), startedAt);
      case 'pseudo':
        return finalize(source, analyzePseudoLanguage(source), startedAt);
      case 'javascript':
      case 'typescript':
        return finalize(source, analyzeJavaScript(source, language), startedAt);
      case 'python':
        return finalize(source, analyzePython(source), startedAt);
      default:
        return finalize(source, analyzePlainText(source), startedAt);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure: LanguageAnalysis = {
      language,
      languageLabel: languageLabel(language),
      supportLevel: 'limited',
      supportNotes: ['分析过程中出现未预期错误，已停止本次分析并保留源码。'],
      tree: [],
      tokens: [],
      symbols: {},
      issues: [
        {
          severity: 'error',
          message: `分析失败：${message}`,
          hint: '这可能是 CodeLens 暂不支持的语法。请尝试简化代码，或检查是否有输入损坏。',
        },
      ],
      execution: { supported: false, reason: '分析失败，无法执行。' },
      capabilities: {
        semanticHighlight: false,
        structureTree: false,
        explanations: 'limited',
        crossReference: false,
        execution: false,
        realParser: false,
      },
      analyzer: 'text-structural',
    };
    return finalize(source, failure, startedAt);
  }
}

/** 分析 C / C++（C 子集） */
function analyzeC(source: SourceFile, language: 'c' | 'cpp'): LanguageAnalysis {
  const parseResult = parseC(source, { language });
  const program: ProgramNode = parseResult.program;
  const index: CNodeIndex = buildIndex(program);
  const symbolsTable = buildCSymbols(program, index, source);
  const lex = tokenizeC(source);
  const tokens = buildSemanticTokens({
    program,
    source,
    tokens: lex.tokens,
    comments: lex.comments,
    symbols: symbolsTable,
  });
  const tree = buildCStructureTree(program, index, source);
  const issues = [...lex.issues, ...parseResult.issues];

  if (!source.text.trim()) {
    issues.push({ severity: 'info', message: '还没有代码。输入或粘贴 C 代码后，这里会显示程序结构。' });
  }

  const supportNotes =
    language === 'cpp'
      ? [
          '使用手写词法分析与递归下降语法解析生成真实 AST；C++ 目前按 C 子集解析。',
          '支持：变量、指针、数组、结构体、枚举、typedef、函数、控制流、常用表达式、printf、malloc/free。',
          '不支持：C++ 模板、STL、类继承、函数指针、位域、goto/标签、K&R 风格函数定义；遇到会明确提示。',
          '逐行执行使用内置 C 子集解释器（模拟内存）；C++ 的 new/delete、std::cout 等不能执行。',
        ]
      : [
          '使用手写词法分析与递归下降语法解析生成真实 AST；语义高亮、结构树、释义、执行共享同一份语法结构。',
          '支持：变量、指针、数组、结构体、枚举、typedef、函数、控制流、常用表达式、printf、malloc/free、链表场景。',
          '不支持：函数指针、位域、goto/标签、K&R 风格函数定义、复杂宏、文件 IO；遇到会明确提示并跳过。',
          '逐行执行使用内置 C 子集解释器（模拟内存），仅支持 printf 输出；scanf/文件 IO 等会明确报告不支持。',
        ];

  return {
    language,
    languageLabel: languageLabel(language),
    supportLevel: 'full',
    supportNotes,
    tree,
    tokens,
    symbols: symbolsTable.symbols,
    issues,
    execution: {
      supported: true,
      engine: 'CodeLens C 子集解释器 v1',
      limitations: language === 'cpp'
        ? ['C++ 类、模板、STL、new/delete 等不能执行；仅支持 C 子集。']
        : ['不支持 scanf/文件 IO 等输入式语句；遇到会明确报错。'],
    },
    capabilities: {
      semanticHighlight: true,
      structureTree: true,
      explanations: 'full',
      crossReference: true,
      execution: true,
      realParser: true,
    },
    analyzer: 'c-parser',
    program,
    cIndex: index,
  };
}

/** 分析中文伪代码 */
function analyzePseudoLanguage(source: SourceFile): LanguageAnalysis {
  const pseudo: PseudoAnalysis = analyzePseudo(source);
  const tree = buildPseudoTree(pseudo, source);
  const tokens = buildPseudoTokens(pseudo, source);
  const issues = buildPseudoIssues(pseudo, source);

  const supportNotes = [
    ...pseudo.notes,
    '分析结果严格区分：用户原文（original）→ 系统推断（inference）→ 生成的 C 代码（generatedCode），三者不会混为一谈。',
    '伪代码分析基于规则推断，不是完整语义解析；低置信度语句会在结构树与释义中标注，不会静默丢弃。',
    ...(pseudo.supportedExecutable
      ? ['当前生成代码满足执行条件：可以交给内置 C 解释器执行（执行的是生成代码，不是原始伪代码）。']
      : ['当前生成代码不满足执行条件（存在输入/未识别/低置信度语句），CodeLens 不会伪造执行结果。']),
  ];

  return {
    language: 'pseudo',
    languageLabel: '中文伪代码',
    supportLevel: 'structural',
    supportNotes,
    tree,
    tokens,
    symbols: {},
    issues,
    execution: pseudo.supportedExecutable
      ? {
          supported: true,
          engine: '伪代码生成 C + CodeLens C 子集解释器',
          limitations: ['实际执行的是系统生成的 C 代码，不是伪代码原文；生成结果可能存在偏差。'],
        }
      : {
          supported: false,
          reason:
            pseudo.warnings[0] ??
            '伪代码中存在无法可靠转换的语句（如输入、未识别内容或低置信度推断），因此不提供执行，避免伪造运行结果。',
        },
    capabilities: {
      semanticHighlight: true,
      structureTree: true,
      explanations: 'basic',
      crossReference: false,
      execution: pseudo.supportedExecutable,
      realParser: false,
    },
    analyzer: 'pseudo-parser',
    pseudo,
  };
}

/** JS/TS/Python 分析结果补齐（分析器已按统一契约返回 LanguageAnalysis） */

/** 包装为最终 AnalysisResult，补充源码、行索引与统计信息 */
function finalize(source: SourceFile, analysis: LanguageAnalysis, startedAt: number): AnalysisResult {
  analysisCounter += 1;
  const symbolList = Object.values(analysis.symbols).sort((a, b) => {
    const aLine = a.declaration?.line ?? Number.MAX_SAFE_INTEGER;
    const bLine = b.declaration?.line ?? Number.MAX_SAFE_INTEGER;
    if (aLine !== bLine) return aLine - bLine;
    return a.name.localeCompare(b.name);
  });
  const parseMs = Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
  const flattenCount = (nodes: StructureNode[]): number =>
    nodes.reduce((sum, node) => sum + 1 + flattenCount(node.children), 0);
  const errors = analysis.issues.filter((issue) => issue.severity === 'error').length;
  const warnings = analysis.issues.filter((issue) => issue.severity === 'warning').length;

  return {
    ...analysis,
    id: `analysis-${Date.now()}-${analysisCounter}`,
    source: source.text,
    lines: source.lines(),
    symbolList,
    stats: {
      lines: source.lineCount,
      tokens: analysis.tokens.length,
      symbols: symbolList.length,
      structures: Math.max(0, flattenCount(analysis.tree) - 1),
      errors,
      warnings,
      parseMs,
    },
  };
}

/** 伪代码结构树：与 C 结构树使用同一套 StructureNode 契约 */
function buildPseudoTree(pseudo: PseudoAnalysis, source: SourceFile): StructureNode[] {
  const convert = (statement: PseudoStatement): StructureNode => {
    const range = source.range(
      source.lineStartOffset(statement.line),
      source.lineEndOffset(statement.endLine),
    );
    return {
      id: `pst_${statement.id}`,
      label: `${pseudoStatementLabel(statement.kind)}（第 ${statement.line} 行）`,
      kind: `pseudo-${statement.kind}`,
      secondary: statement.inference.summary,
      range,
      nodeId: statement.id,
      badges: [
        statement.confidence === 'high' ? '高置信度' : statement.confidence === 'medium' ? '中置信度' : '低置信度',
        ...(statement.kind === 'unknown' ? ['未识别'] : []),
        ...(statement.generatedStartLine ? [`生成代码 L${statement.generatedStartLine}`] : []),
      ],
      children: statement.children.map(convert),
    };
  };
  return [
    {
      id: 'pst-root',
      label: '伪代码程序',
      kind: 'program',
      secondary: `${pseudo.lines.filter((line) => line.kind !== 'blank').length} 行有效描述，共识别 ${pseudo.statements.length} 条顶层结构`,
      range: source.range(0, source.text.length),
      badges: [pseudo.confidence === 'high' ? '整体高置信度' : pseudo.confidence === 'medium' ? '整体中置信度' : '整体低置信度'],
      children: pseudo.statements.map(convert),
    },
  ];
}

function pseudoStatementLabel(kind: string): string {
  const labels: Record<string, string> = {
    declare: '变量声明',
    assign: '赋值',
    print: '输出',
    input: '输入',
    if: '条件判断',
    elseif: '否则如果',
    else: '否则',
    loop: '循环',
    function: '函数',
    return: '返回',
    break: 'break',
    continue: 'continue',
    call: '函数调用',
    comment: '注释',
    unknown: '未识别语句',
  };
  return labels[kind] ?? '伪代码语句';
}

/** 伪代码文本高亮：只对推断出的关键词/变量做提示，低置信度不硬猜 */
function buildPseudoTokens(pseudo: PseudoAnalysis, source: SourceFile): SemanticToken[] {
  const CONTROL_WORDS = ['如果', '否则', '循环', '重复', '直到', '当', '跳出', '继续', '返回'];
  const FUNCTION_WORDS = ['输出', '打印', '显示', '输入', '读取', '调用', '函数'];
  const DATA_WORDS = ['创建', '定义', '声明', '变量', '数组', '指针', '结构体', '赋值', '设为', '赋值为', '初始值'];
  const OPERATOR_WORDS = ['不等于', '大于等于', '小于等于', '大于', '小于', '等于', '并且', '而且', '或者', '非'];

  const tokens: SemanticToken[] = [];
  const seen = new Set<string>();
  const add = (start: number, end: number, category: SemanticToken['category'], subkind?: string) => {
    if (end <= start) return;
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    // 避免与已添加 token 重叠
    for (const token of tokens) {
      if (start < token.end && end > token.start) return;
    }
    seen.add(key);
    tokens.push({ start, end, category, subkind });
  };

  for (const statement of flattenPseudoStatements(pseudo.statements)) {
    if (statement.kind === 'comment' || statement.kind === 'unknown') continue;
    const line = source.lineText(statement.line);
    const lineStart = source.lineStartOffset(statement.line);
    for (const word of OPERATOR_WORDS) findWord(line, word, (index) => add(lineStart + index, lineStart + index + word.length, 'operator'));
    for (const word of CONTROL_WORDS) findWord(line, word, (index) => add(lineStart + index, lineStart + index + word.length, 'control'));
    for (const word of FUNCTION_WORDS) findWord(line, word, (index) => add(lineStart + index, lineStart + index + word.length, 'function'));
    for (const word of DATA_WORDS) findWord(line, word, (index) => add(lineStart + index, lineStart + index + word.length, 'data'));

    // 推断出的变量名/函数名：只在原始行中真实出现时高亮
    const names = [
      statement.inference.declaredName,
      statement.inference.assignmentTarget,
      statement.inference.callName,
      statement.inference.functionName,
      statement.inference.loopVariable,
    ].filter((name): name is string => Boolean(name) && /^[A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]*$/.test(name!));
    for (const name of names) {
      let index = line.indexOf(name);
      while (index !== -1) {
        // 避免把关键词内部的部分高亮成变量
        const before = line[index - 1] ?? '';
        const after = line[index + name.length] ?? '';
        if (!/[\w\u4e00-\u9fff]/.test(before) && !/[\w\u4e00-\u9fff]/.test(after)) {
          add(lineStart + index, lineStart + index + name.length, 'data', 'pseudo-variable');
        }
        index = line.indexOf(name, index + name.length);
      }
    }
  }

  // 注释行整行灰色
  for (const line of pseudo.lines) {
    if (line.kind !== 'comment') continue;
    const text = source.lineText(line.line);
    const start = source.lineStartOffset(line.line);
    tokens.push({ start, end: start + text.length, category: 'comment', subkind: 'pseudo-comment' });
  }

  tokens.sort((a, b) => a.start - b.start);
  return tokens;
}

function findWord(line: string, word: string, callback: (index: number) => void): void {
  let index = line.indexOf(word);
  while (index !== -1) {
    callback(index);
    index = line.indexOf(word, index + word.length);
  }
}

function flattenPseudoStatements(statements: PseudoStatement[]): PseudoStatement[] {
  const result: PseudoStatement[] = [];
  const visit = (list: PseudoStatement[]) => {
    for (const statement of list) {
      result.push(statement);
      visit(statement.children);
    }
  };
  visit(statements);
  return result;
}

/** 把伪代码警告/低置信度语句转换为 UI 可展示的 issues */
function buildPseudoIssues(pseudo: PseudoAnalysis, source: SourceFile): LanguageAnalysis['issues'] {
  const issues: LanguageAnalysis['issues'] = [];
  for (const warning of pseudo.warnings.slice(0, 12)) {
    issues.push({ severity: 'warning', message: warning, hint: '伪代码是推断结果，请核对原文与生成代码。' });
  }
  for (const statement of flattenPseudoStatements(pseudo.statements)) {
    if (statement.kind === 'unknown' || statement.confidence === 'low') {
      const range = source.range(source.lineStartOffset(statement.line), source.lineEndOffset(statement.endLine));
      issues.push({
        severity: statement.kind === 'unknown' ? 'warning' : 'info',
        message:
          statement.kind === 'unknown'
            ? `第 ${statement.line} 行未能识别为结构化语句：${statement.original.trim()}`
            : `第 ${statement.line} 行的推断置信度较低：${statement.inference.summary}`,
        hint: '可以换一种更明确的表述，例如「创建一个整数变量 a，赋值为 10」。',
        range,
        line: statement.line,
      });
    }
  }
  return issues;
}

/**
 * 获取执行目标：C 直接执行源码；伪代码执行"生成的 C 代码"；
 * 其他语言明确返回不支持原因。
 */
export interface ExecutionTargetInfo {
  supported: boolean;
  code: string;
  label: string;
  note?: string;
  reason?: string;
}

export function getExecutionTarget(analysis: AnalysisResult): ExecutionTargetInfo {
  if (analysis.language === 'c' || analysis.language === 'cpp') {
    return {
      supported: true,
      code: analysis.source,
      label: analysis.language === 'cpp' ? 'C++ 源码（按 C 子集执行）' : 'C 源码',
      note: analysis.language === 'cpp' ? 'C++ 高级特性无法执行；遇到解释器不支持的结构会明确报错。' : undefined,
    };
  }
  if (analysis.pseudo) {
    const generated = analysis.pseudo.generatedCode;
    if (!analysis.pseudo.supportedExecutable) {
      return {
        supported: false,
        code: generated,
        label: '生成的 C 代码',
        reason:
          analysis.execution.reason ??
          '伪代码生成的 C 代码置信度不足或包含输入语句，CodeLens 不提供执行以避免伪造结果。',
      };
    }
    return {
      supported: true,
      code: generated,
      label: '由伪代码生成的 C 代码',
      note: '注意：执行的是系统根据推断生成的 C 代码，不是你的伪代码原文。生成结果可能存在偏差。',
    };
  }
  return {
    supported: false,
    code: '',
    label: analysis.languageLabel,
    reason: analysis.execution.reason ?? '当前语言暂未接入可靠的执行引擎，CodeLens 不会伪造执行结果。',
  };
}

/** 判断当前语言/文件是否有可执行目标（UI 快速显示） */
export function canExecute(analysis: AnalysisResult): boolean {
  return getExecutionTarget(analysis).supported;
}

/** 供 UI 显示支持信息 */
export function getLanguageOption(language: LanguageId) {
  return LANGUAGE_OPTIONS.find((option) => option.id === language) ?? LANGUAGE_OPTIONS[0];
}

export type { PseudoAnalysis };
