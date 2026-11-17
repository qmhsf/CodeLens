/**
 * 中文伪代码分析器
 * ------------------------------------------------------------------
 * 输入是用户写的中文/自然语言伪代码，输出 PseudoAnalysis：
 * - 逐行结果（与源码行数严格对齐，空行保留）；
 * - 结构化语句树（推断结果，明确区别于原文）；
 * - 生成的 C 代码（只是建议）；
 * - 置信度与风险提示（无法识别的行绝不静默丢弃）。
 *
 * 设计原则：
 * 1. 所有 `inference` 字段都是系统推断，不是用户原文；
 * 2. 拿不准就降低 confidence 并在 notes 里解释，绝不假装理解；
 * 3. 语句树同时支持「缩进嵌套」和「结束如果/结束循环/结束函数」等显式结束标记；
 * 4. 需求示例中的无缩进单行句式（如果…，就输出…。/ 否则…）可直接识别。
 */

import { SourceFile } from '../source';
import type {
  PseudoAnalysis,
  PseudoConfidence,
  PseudoInference,
  PseudoLineResult,
  PseudoStatement,
  PseudoStatementKind,
} from './types';
import {
  IdentifierMapper,
  generateCCode,
  mapPseudoType,
  translateExpressionToC,
  unquoteString,
  type CType,
} from './codegen';

// ---------------------------------------------------------------------------
// 正则片段与基础工具
// ---------------------------------------------------------------------------

/** 可识别的中文/英文类型词（长词在前，避免「浮点数」被「浮点」抢先匹配） */
const TYPE_WORD_SOURCE =
  '双精度小数|无返回值|字符串|浮点数|双精度|长整数|长整型|整数|整型|小数|浮点|实数|字符|布尔|逻辑|文本|int|double|float|char|bool|boolean|string|void';
const TYPE_RE_SOURCE = `(?:${TYPE_WORD_SOURCE})`;
/** 变量/函数名：ASCII 标识符或中文标识符 */
const NAME_RE_SOURCE = '[A-Za-z_][A-Za-z0-9_]*|[\\u4e00-\\u9fff][\\u4e00-\\u9fffA-Za-z0-9_]*';
const NAME_RE = `(?:${NAME_RE_SOURCE})`;

const CONFIDENCE_ORDER: Record<PseudoConfidence, number> = { high: 2, medium: 1, low: 0 };

/** 取最低置信度 */
function minConfidence(values: PseudoConfidence[]): PseudoConfidence {
  let result: PseudoConfidence = 'high';
  for (const value of values) {
    if (CONFIDENCE_ORDER[value] < CONFIDENCE_ORDER[result]) result = value;
  }
  return result;
}

/** 置信度降一级（high → medium，medium/low → low） */
function downgradeConfidence(value: PseudoConfidence): PseudoConfidence {
  if (value === 'high') return 'medium';
  return 'low';
}

/** 全角 ASCII 标点 → 半角；中文引号统一成英文引号；空白压缩 */
function normalizeSentence(raw: string): string {
  let text = raw.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  text = text.replace(/\u3000/g, ' ');
  text = text.replace(/[“”「」『』]/g, '"').replace(/[‘’]/g, "'");
  text = text.replace(/\u2026/g, '...');
  return text.replace(/\s+/g, ' ').trim();
}

/** 统计行首缩进（tab 记 4 个空格） */
function countIndent(raw: string): number {
  let count = 0;
  for (const ch of raw) {
    if (ch === ' ') count += 1;
    else if (ch === '\t') count += 4;
    else break;
  }
  return count;
}

/** 判断整行是否是注释行，返回去掉注释符号后的内容 */
function detectCommentLine(trimmed: string): string | undefined {
  if (trimmed.startsWith('#')) return trimmed.replace(/^#+\s*/, '');
  if (trimmed.startsWith('//')) return trimmed.replace(/^\/\/\s*/, '');
  return undefined;
}

/** 去掉行内注释（保留行内代码部分），支持 `//` 与空白后的 `#` */
function stripInlineComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote && raw[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '“' || ch === '「' || ch === '『') {
      quote = ch === '“' ? '”' : ch === '「' ? '」' : ch === '『' ? '』' : ch;
      continue;
    }
    if (ch === '/' && raw[i + 1] === '/') return raw.slice(0, i);
    if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i);
  }
  return raw;
}

/**
 * 按句号/分号切分一行（支持中文、英文标点）。
 * 数字中间的小数点（3.14）不会被切断。
 */
function splitSentences(raw: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      current += ch;
      if (ch === quote && raw[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '“' || ch === '「' || ch === '『') {
      quote = ch === '“' ? '”' : ch === '「' ? '」' : ch === '『' ? '』' : ch;
      current += ch;
      continue;
    }
    const fullWidthEnd = ch === '。' || ch === '；' || ch === '．' || ch === '！' || ch === '？';
    const asciiSemicolon = ch === ';';
    let asciiPeriod = false;
    if (ch === '.') {
      const previous = raw[i - 1] ?? '';
      const next = raw[i + 1] ?? '';
      asciiPeriod = !(/\d/.test(previous) && /\d/.test(next));
    }
    if (fullWidthEnd || asciiSemicolon || asciiPeriod) {
      const piece = current.trim();
      if (piece) result.push(piece);
      current = '';
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) result.push(tail);
  return result;
}

/** 找到「否则 / else」在本句中的位置，用于把「否则…」拆成独立分句 */
function findElseIndex(text: string): number {
  const index = text.indexOf('否则');
  if (index >= 0) return index;
  const match = /(?:^|\s)else\b/i.exec(text);
  if (!match) return -1;
  return match.index + match[0].length - 4;
}

/** 把一句话拆成「主句 + 否则…」多个分句 */
function splitElseClauses(text: string): string[] {
  const parts: string[] = [];
  let remaining = text.trim();
  let guard = 0;
  while (remaining && guard < 20) {
    guard += 1;
    const index = findElseIndex(remaining);
    if (index <= 0) break;
    const head = remaining.slice(0, index).replace(/[,;、]+$/, '').trim();
    if (head) parts.push(head);
    remaining = remaining.slice(index).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

// ---------------------------------------------------------------------------
// 内部数据结构
// ---------------------------------------------------------------------------

type FrameKind = 'if' | 'elseif' | 'else' | 'loop' | 'function';

interface Frame {
  statement: PseudoStatement;
  kind: FrameKind;
  /** 打开该块的语句所在行的缩进 */
  openerIndent: number;
  /** 冒号块允许「同级缩进」的语句进入块内（无缩进但用结束标记的写法） */
  allowSameIndentBody: boolean;
  /** 函数作用域内声明的名字（关闭函数时清理） */
  scopeNames: string[];
}

interface Clause {
  line: number;
  /** 该语句对应的完整原始行（用户原文） */
  raw: string;
  /** 归一化后的分句文本（不含句末标点） */
  text: string;
  indent: number;
  /** 分句以冒号结尾（引出块） */
  colon: boolean;
}

/** 解析单个分句得到的中间结果 */
interface ParsedStatement {
  kind: PseudoStatementKind;
  inference: PseudoInference;
  confidence: PseudoConfidence;
  notes: string[];
  /** 是否为需要后续行的块结构（if/else/loop/function） */
  block: boolean;
  /** 同一行内联的语句体（如「如果 a 大于 5，就输出 Hello」中的「输出 Hello」） */
  inlineBodies: string[];
  /** 需要写入全局 warnings 的提示 */
  stateWarnings: string[];
  /** 函数参数等需要临时注册的变量 */
  scopeVariables?: { name: string; type: CType }[];
}

interface FunctionInfo {
  params: { name: string; type: string }[];
  returnType?: string;
  line: number;
}

interface AnalyzerState {
  source: SourceFile;
  lines: PseudoLineResult[];
  assigned: boolean[];
  root: PseudoStatement[];
  stack: Frame[];
  /** 已声明变量：原始名字 → C 类型（用于判断引用是否已声明） */
  variables: Map<string, CType>;
  /** 已解析的函数定义 */
  functions: Map<string, FunctionInfo>;
  /** 预扫描到的函数名（用于跨行调用的置信度判断） */
  knownFunctionNames: Set<string>;
  mapper: IdentifierMapper;
  warnings: string[];
  notes: string[];
  counter: number;
}

// ---------------------------------------------------------------------------
// 语句树辅助
// ---------------------------------------------------------------------------

/** 递归收集语句（深度优先，包含子语句） */
function collectStatements(statements: PseudoStatement[]): PseudoStatement[] {
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

/** 语句覆盖的最后一行 */
function lastLineOf(statement: PseudoStatement): number {
  let last = statement.endLine;
  for (const child of statement.children) last = Math.max(last, lastLineOf(child));
  return last;
}

function blockLabel(kind: FrameKind): string {
  if (kind === 'loop') return '循环';
  if (kind === 'function') return '函数';
  return '条件';
}

function frameStatementKind(kind: FrameKind): PseudoStatementKind {
  if (kind === 'loop') return 'loop';
  if (kind === 'function') return 'function';
  return 'if';
}

function currentContainer(state: AnalyzerState): PseudoStatement[] {
  const top = state.stack[state.stack.length - 1];
  return top ? top.statement.children : state.root;
}

function appendStatement(state: AnalyzerState, statement: PseudoStatement): void {
  const top = state.stack[state.stack.length - 1];
  if (top) statement.parentId = top.statement.id;
  currentContainer(state).push(statement);
}

function findFunctionFrame(state: AnalyzerState): Frame | undefined {
  for (let i = state.stack.length - 1; i >= 0; i -= 1) {
    if (state.stack[i].kind === 'function') return state.stack[i];
  }
  return undefined;
}

function isKnownIdentifier(state: AnalyzerState, name: string): boolean {
  return state.variables.has(name) || state.functions.has(name) || state.knownFunctionNames.has(name);
}

/** 注册变量，并记录到当前函数作用域，供函数关闭时清理 */
function registerVariable(state: AnalyzerState, name: string, type: CType): void {
  state.variables.set(name, type);
  const functionFrame = findFunctionFrame(state);
  if (functionFrame) functionFrame.scopeNames.push(name);
}

/** 把解析提示转成整体告警 */
function pushParsedWarnings(state: AnalyzerState, parsedStatement: ParsedStatement): void {
  state.warnings.push(...parsedStatement.stateWarnings);
}

/** 构造 ParsedStatement 的辅助函数 */
function parsedStatement(
  data: Pick<ParsedStatement, 'kind' | 'inference' | 'confidence'> & Partial<ParsedStatement>,
): ParsedStatement {
  return {
    kind: data.kind,
    inference: data.inference,
    confidence: data.confidence,
    notes: data.notes ?? [],
    block: data.block ?? false,
    inlineBodies: data.inlineBodies ?? [],
    stateWarnings: data.stateWarnings ?? [],
    scopeVariables: data.scopeVariables,
  };
}

/** 无法识别的语句：不做猜测，低置信度 */
function unknownParsed(text: string): ParsedStatement {
  return parsedStatement({
    kind: 'unknown',
    inference: { summary: `未识别：${text}` },
    confidence: 'low',
    notes: ['该行未能匹配任何已支持的中文伪代码结构，系统没有做猜测，生成代码中保留为注释'],
  });
}

// ---------------------------------------------------------------------------
// 表达式 / 条件翻译（基于 codegen 的 C 表达式工具）
// ---------------------------------------------------------------------------

interface TranslatedValueInfo {
  text: string;
  confidence: PseudoConfidence;
  notes: string[];
  ok: boolean;
}

/** 把自然语言表达式翻译成 C 表达式，并检查标识符是否已声明 */
function translateValueForState(
  state: AnalyzerState,
  raw: string,
  excludeIdentifiers: string[] = [],
): TranslatedValueInfo {
  const translated = translateExpressionToC(raw, state.mapper);
  const notes = [...translated.notes];
  let confidence: PseudoConfidence = translated.ok ? 'high' : 'medium';
  if (!translated.ok) notes.push(`表达式「${raw}」未能完整转换为 C 表达式`);
  const unknown = translated.identifiers.filter(
    (name) => !excludeIdentifiers.includes(name) && !isKnownIdentifier(state, name),
  );
  if (unknown.length > 0) {
    confidence = minConfidence([confidence, 'medium']);
    notes.push(`表达式引用了未声明的名字：${unknown.join('、')}，生成的 C 代码可能无法通过编译`);
  }
  return { text: translated.text, confidence, notes: notes.length ? notes : [], ok: translated.ok };
}

// ---------------------------------------------------------------------------
// 树构建：行结果、帧栈
// ---------------------------------------------------------------------------

function assignLineResult(state: AnalyzerState, lineResult: PseudoLineResult, statement: PseudoStatement): void {
  const lineIndex = statement.line - 1;
  if (state.assigned[lineIndex]) return;
  state.assigned[lineIndex] = true;
  lineResult.kind = statement.kind;
  lineResult.statementId = statement.id;
  lineResult.inferredSummary = statement.inference.summary;
  lineResult.confidence = statement.confidence;
}

/** 关闭栈顶块；explicit 表示由「结束如果/结束循环/结束函数」触发 */
function closeFrame(state: AnalyzerState, explicit: boolean, endLineOverride?: number): Frame | undefined {
  const frame = state.stack.pop();
  if (!frame) return undefined;
  const statement = frame.statement;
  statement.endLine = endLineOverride ?? lastLineOf(statement);

  if (!explicit && frame.kind !== 'function') {
    statement.notes.push('未找到显式结束标记，已根据缩进或文件结尾推断该块的结束位置');
  }

  if (frame.kind === 'function') {
    finalizeFunctionStatement(state, statement);
    for (const name of frame.scopeNames) state.variables.delete(name);
    return frame;
  }

  if (statement.children.length === 0) {
    statement.confidence = downgradeConfidence(statement.confidence);
    statement.notes.push('未在该块内找到任何语句，可能是缩进或结束标记缺失，已按空块推断');
    state.warnings.push(`第 ${statement.line} 行的${blockLabel(frame.kind)}块内没有语句，请检查缩进或结束标记`);
  }

  if (statement.kind === 'loop' && statement.inference.loopKind === 'dowhile' && !statement.inference.loopWhile) {
    statement.confidence = minConfidence([statement.confidence, 'medium']);
    statement.notes.push('「重复…直到…」循环缺少终止条件，生成代码按默认条件处理');
  }

  return frame;
}

/** 根据缩进关闭块（缩进回退时） */
function popFramesForIndent(state: AnalyzerState, indent: number): void {
  while (state.stack.length > 0) {
    const top = state.stack[state.stack.length - 1];
    if (indent > top.openerIndent) break;
    if (indent === top.openerIndent && top.allowSameIndentBody) break;
    closeFrame(state, false);
  }
}

function pushFrame(
  state: AnalyzerState,
  statement: PseudoStatement,
  clause: Clause,
  parsedData: ParsedStatement,
): Frame {
  const kind: FrameKind =
    statement.kind === 'if'
      ? 'if'
      : statement.kind === 'elseif'
        ? 'elseif'
        : statement.kind === 'else'
          ? 'else'
          : statement.kind === 'loop'
            ? 'loop'
            : 'function';
  const frame: Frame = {
    statement,
    kind,
    openerIndent: clause.indent,
    allowSameIndentBody: clause.colon,
    scopeNames: parsedData.scopeVariables ? parsedData.scopeVariables.map((item) => item.name) : [],
  };
  if (parsedData.scopeVariables) {
    for (const item of parsedData.scopeVariables) state.variables.set(item.name, item.type);
  }
  state.stack.push(frame);
  return frame;
}

/** 函数块关闭：推断返回类型、检查返回值 */
function finalizeFunctionStatement(state: AnalyzerState, statement: PseudoStatement): void {
  const inference = statement.inference;
  const returns = collectStatements(statement.children).filter((child) => child.kind === 'return');
  const hasValueReturn = returns.some((child) => (child.inference.returnValue ?? '') !== '');
  if (!inference.functionReturnType) {
    if (hasValueReturn) {
      inference.functionReturnType = 'int';
      statement.notes.push('函数未声明返回类型，根据返回语句推断为 int（系统推断）');
    } else {
      inference.functionReturnType = 'void';
    }
  } else if (inference.functionReturnType !== 'void' && returns.length === 0) {
    statement.confidence = downgradeConfidence(statement.confidence);
    statement.notes.push('函数声明了返回类型但未找到返回语句，生成代码会补充默认返回值，请人工确认');
    state.warnings.push(`第 ${statement.line} 行的函数声明了返回类型却没有返回语句，请确认`);
  }
  const name = inference.functionName;
  if (name) {
    const info = state.functions.get(name);
    if (info) info.returnType = inference.functionReturnType;
  }
}

// ---------------------------------------------------------------------------
// 句法解析：单个普通分句 → ParsedStatement
// ---------------------------------------------------------------------------

/** 从「条件 + 就/则/那么」句式中拆出条件与行内语句体 */
function extractConditionAndBody(restRaw: string): { condition: string; body?: string } {
  const rest = restRaw.trim().replace(/\s*的话$/, '');
  let condition = rest;
  let body: string | undefined;

  const colonIndex = rest.indexOf(':');
  if (colonIndex >= 0) {
    condition = rest.slice(0, colonIndex).trim();
    body = rest.slice(colonIndex + 1).trim() || undefined;
  } else {
    const thenMatch = rest.match(/^(.*?)\s*,?\s*(?:就|则|那么)\s*(.*)$/);
    if (thenMatch && thenMatch[1].trim()) {
      condition = thenMatch[1].trim();
      body = thenMatch[2].trim() || undefined;
    } else {
      const commaVerb = rest.match(
        /^(.*?)\s*,\s*((?:输出|打印|显示|说|把|输入|读取|返回|调用|创建|定义|令|设).*)$/,
      );
      if (commaVerb && commaVerb[1].trim()) {
        condition = commaVerb[1].trim();
        body = commaVerb[2].trim();
      }
    }
  }

  condition = condition
    .replace(/^的话/, '')
    .replace(/\s*的话$/, '')
    .replace(/[,]+$/, '')
    .trim();
  return { condition, body };
}

/** 解析 if 语句（含「如果…，就…」单行句式） */
function parseIfStatement(text: string, state: AnalyzerState): ParsedStatement | undefined {
  const match = text.match(/^(如果|若|假如|假设|当)\s*(.+)$/);
  if (!match) return undefined;
  const keyword = match[1];
  const rest = match[2].trim();
  if (!rest) return undefined;

  const extracted = extractConditionAndBody(rest);
  if (!extracted.condition) {
    return parsedStatement({
      kind: 'unknown',
      inference: { summary: `条件判断缺少条件：${text}` },
      confidence: 'low',
      notes: ['条件判断没有可识别的条件表达式，未做猜测'],
    });
  }

  const conditionInfo = translateValueForState(state, extracted.condition);
  const notes = [...conditionInfo.notes];
  let confidence = conditionInfo.confidence;

  if (!extracted.body) {
    notes.push('未使用「就/则」引出条件体，按块结构（缩进或结束标记）推断');
  }
  if (keyword === '当' && !extracted.body && !/时/.test(rest)) {
    confidence = minConfidence([confidence, 'medium']);
    notes.push('「当」既可能表示条件也可能表示循环，这里按条件判断处理（系统推断）');
  }

  const inference: PseudoInference = {
    summary: extracted.body
      ? `如果条件「${extracted.condition}」成立（C 条件：${conditionInfo.text}），执行同一行的语句`
      : `如果条件「${extracted.condition}」成立（C 条件：${conditionInfo.text}），执行条件块`,
    condition: conditionInfo.text,
  };

  return parsedStatement({
    kind: 'if',
    inference,
    confidence,
    notes,
    block: !extracted.body,
    inlineBodies: extracted.body ? [extracted.body] : [],
  });
}

/** 把 for 循环头部与行内语句体拆开 */
function splitInlineBodyFromHeader(text: string): { header: string; body?: string } {
  const colonIndex = text.indexOf(':');
  if (colonIndex >= 0) {
    return {
      header: text.slice(0, colonIndex).trim(),
      body: text.slice(colonIndex + 1).trim() || undefined,
    };
  }
  const commaVerb = text.match(
    /^(.+?)\s*,\s*((?:输出|打印|显示|把|输入|读取|返回|调用|如果|若|循环|重复).*)$/,
  );
  if (commaVerb) {
    if (!/^每次/.test(commaVerb[2])) {
      return { header: commaVerb[1].trim(), body: commaVerb[2].trim() };
    }
  }
  return { header: text };
}

const FOR_HEADER_PATTERNS: { pattern: RegExp; hasVariable: boolean }[] = [
  {
    pattern: new RegExp(
      `^(?:对于|遍历)\\s*(${NAME_RE})\\s*(?:从|=|等于)\\s*(.+?)\\s*(?:到|至|一直到)\\s*(.+)$`,
      'i',
    ),
    hasVariable: true,
  },
  {
    pattern: new RegExp(
      `^(?:循环变量|计数器)\\s*(${NAME_RE})\\s*(?:从|=|等于)\\s*(.+?)\\s*(?:到|至|一直到)\\s*(.+)$`,
      'i',
    ),
    hasVariable: true,
  },
  {
    pattern: new RegExp(
      `^(${NAME_RE})\\s*(?:从|=|等于)\\s*(.+?)\\s*(?:到|至|一直到)\\s*(.+)$`,
      'i',
    ),
    hasVariable: true,
  },
  {
    pattern: new RegExp(
      `^(?:循环|重复|反复)\\s*(${NAME_RE})\\s*(?:从|=|等于)\\s*(.+?)\\s*(?:到|至|一直到)\\s*(.+)$`,
      'i',
    ),
    hasVariable: true,
  },
  {
    pattern: new RegExp(
      `^(?:(?:循环|重复|反复)(?:执行|运行|进行)?\\s*)?从\\s*(.+?)\\s*(?:到|至|一直到)\\s*(.+)$`,
      'i',
    ),
    hasVariable: false,
  },
];

/** 解析 for 循环 */
function parseForLoop(text: string, state: AnalyzerState): ParsedStatement | undefined {
  const { header: headerRaw, body } = splitInlineBodyFromHeader(text);
  let header = headerRaw.trim();
  let stepRaw: string | undefined;

  const stepMatch = header.match(
    /^(.*?)\s*(?:[,，]\s*)?(?:每次(?:加|增加|累加|递增)|步长(?:为|是)?|每步(?:加|增加|递增)?)\s*([^,，:]+)$/,
  );
  if (stepMatch) {
    header = stepMatch[1].trim();
    stepRaw = stepMatch[2].trim();
  }

  for (const candidate of FOR_HEADER_PATTERNS) {
    const match = header.match(candidate.pattern);
    if (!match) continue;
    const loopVariableRaw = candidate.hasVariable ? match[1] : undefined;
    const fromRaw = candidate.hasVariable ? match[2] : match[1];
    const toRaw = candidate.hasVariable ? match[3] : match[2];
    if (!fromRaw || !toRaw) return undefined;

    const fromInfo = translateValueForState(state, fromRaw);
    const toInfo = translateValueForState(state, toRaw);
    const stepInfo = stepRaw ? translateValueForState(state, stepRaw) : undefined;
    const notes = [...fromInfo.notes, ...toInfo.notes, ...(stepInfo?.notes ?? []), '按 for 循环生成'];
    let confidence = minConfidence([
      fromInfo.confidence,
      toInfo.confidence,
      stepInfo?.confidence ?? 'high',
    ]);

    const loopVariable = loopVariableRaw ?? 'i';
    if (!loopVariableRaw) {
      confidence = minConfidence([confidence, 'medium']);
      notes.push('未指定循环变量，系统自动使用计数器变量 i（起止值按原文取值）');
      state.variables.set('i', 'int');
    } else {
      registerVariable(state, loopVariable, 'int');
    }

    const inference: PseudoInference = {
      summary: loopVariableRaw
        ? `for 循环：变量「${loopVariable}」从 ${fromRaw} 到 ${toRaw}（步长 ${stepRaw ?? '1'}）`
        : `for 循环：从 ${fromRaw} 到 ${toRaw}（系统推断计数器为 ${loopVariable}，步长 ${stepRaw ?? '1'}）`,
      loopKind: 'for',
      loopVariable,
      loopFrom: fromInfo.text,
      loopTo: toInfo.text,
      loopStep: stepInfo?.text ?? '1',
    };

    return parsedStatement({
      kind: 'loop',
      inference,
      confidence,
      notes,
      block: !body,
      inlineBodies: body ? [body] : [],
    });
  }
  return undefined;
}

/** 解析循环语句（for / while / do-while / 计数循环） */
function parseLoopStatement(text: string, state: AnalyzerState): ParsedStatement | undefined {
  // 当/只要 … 时 → while
  let match = text.match(/^(?:当|只要)\s*(.+?)\s*(?:的时候|时)(?:\s*[,:]\s*(.+))?$/);
  if (match) {
    const conditionRaw = match[1].trim();
    const body = match[2]?.trim();
    const conditionInfo = translateValueForState(state, conditionRaw);
    const conditionText = conditionInfo.text || conditionRaw;
    return parsedStatement({
      kind: 'loop',
      inference: {
        summary: `while 循环：当条件「${conditionRaw}」成立时重复执行（C 条件：${conditionText}）`,
        loopKind: 'while',
        loopWhile: conditionText,
      },
      confidence: conditionInfo.confidence,
      notes: [...conditionInfo.notes, '按 while 循环生成'],
      block: !body,
      inlineBodies: body ? [body] : [],
    });
  }

  // 只要 条件（省略「时」）→ while
  match = text.match(/^只要\s*(.+)$/);
  if (match) {
    const conditionRaw = match[1].trim();
    const conditionInfo = translateValueForState(state, conditionRaw);
    const conditionText = conditionInfo.text || conditionRaw;
    return parsedStatement({
      kind: 'loop',
      inference: {
        summary: `while 循环：只要条件「${conditionRaw}」成立就重复执行（C 条件：${conditionText}）`,
        loopKind: 'while',
        loopWhile: conditionText,
      },
      confidence: conditionInfo.confidence,
      notes: [...conditionInfo.notes, '按 while 循环生成'],
      block: true,
    });
  }

  // 重复 … 直到 … → do-while
  match = text.match(/^(?:重复|反复|循环)(?:执行|运行|进行)?\s*(.*?)\s*(?:[,:]\s*)?直到\s*(.+)$/);
  if (match) {
    const body = match[1].trim();
    const conditionRaw = match[2].trim();
    const conditionInfo = translateValueForState(state, conditionRaw);
    const conditionText = conditionInfo.text || conditionRaw;
    return parsedStatement({
      kind: 'loop',
      inference: {
        summary: `do-while 循环：重复执行${body ? `「${body}」` : '循环体'}，直到条件「${conditionRaw}」成立（C 条件：${conditionText}）`,
        loopKind: 'dowhile',
        loopWhile: conditionText,
      },
      confidence: conditionInfo.confidence,
      notes: [...conditionInfo.notes, '按「重复…直到…」生成 do-while 循环'],
      block: !body,
      inlineBodies: body ? [body] : [],
    });
  }

  // 重复/循环 N 次 → 计数 for 循环
  match = text.match(/^(?:重复|反复|循环)(?:执行|运行|进行)?\s*(\d+)\s*次(?:\s*[,:]\s*(.*))?$/);
  if (match) {
    const count = Number(match[1]);
    const body = match[2]?.trim();
    state.variables.set('i', 'int');
    return parsedStatement({
      kind: 'loop',
      inference: {
        summary: `计数循环：重复执行 ${match[1]} 次（系统推断计数器为 i，从 0 到 ${Math.max(count - 1, 0)}）`,
        loopKind: 'for',
        loopVariable: 'i',
        loopFrom: '0',
        loopTo: String(Math.max(count - 1, 0)),
        loopStep: '1',
      },
      confidence: 'medium',
      notes: ['根据「N 次」推断为计数循环，系统自动使用计数器变量 i，请人工确认循环范围'],
      block: !body,
      inlineBodies: body ? [body] : [],
    });
  }

  // for：从…到…
  const forLoop = parseForLoop(text, state);
  if (forLoop) return forLoop;

  // 「重复」单独出现：大概率是「重复…直到…」块，先按 do-while 开块，等待「直到」行补条件
  if (/^(?:重复|反复)(?:执行|运行|进行)?$/.test(text)) {
    return parsedStatement({
      kind: 'loop',
      inference: {
        summary: '重复执行循环体（系统推断为「重复…直到…」的 do-while 结构，等待「直到」条件）',
        loopKind: 'dowhile',
      },
      confidence: 'medium',
      notes: ['原文只有「重复」没有给出终止条件，按「重复…直到…」结构推断，终止条件会从后续「直到」行读取'],
      block: true,
    });
  }

  // 没有任何条件的无限循环
  if (/^(?:循环|一直重复|无限循环|死循环)(?:执行|运行|进行)?$/.test(text)) {
    return parsedStatement({
      kind: 'loop',
      inference: {
        summary: '无法确定循环条件，推断为无限循环 while (1)',
        loopKind: 'while',
        loopWhile: '1',
      },
      confidence: 'low',
      notes: ['原文没有给出循环条件或范围，系统只能按无限循环推断，请人工确认'],
    });
  }

  return undefined;
}

/** 解析函数参数列表 */
function parseFunctionParams(rawArgs: string): {
  params: { name: string; type: string }[];
  notes: string[];
  allTyped: boolean;
} {
  const trimmed = rawArgs.trim();
  if (!trimmed || /^(?:无|没有|空|void|无参数)$/i.test(trimmed)) {
    return { params: [], notes: [], allTyped: true };
  }
  const items = trimmed.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  const params: { name: string; type: string }[] = [];
  const notes: string[] = [];
  let allTyped = true;

  for (const item of items) {
    const typed = item.match(new RegExp(`^(${TYPE_RE_SOURCE})\\s*(?:类型|型)?\\s*(?:的)?\\s*(${NAME_RE})$`, 'i'));
    if (typed) {
      params.push({ name: typed[2], type: mapPseudoType(typed[1]) ?? 'int' });
      continue;
    }
    const typedAfter = item.match(new RegExp(`^(${NAME_RE})\\s*:\\s*(${TYPE_RE_SOURCE})$`, 'i'));
    if (typedAfter) {
      params.push({ name: typedAfter[1], type: mapPseudoType(typedAfter[2]) ?? 'int' });
      continue;
    }
    const onlyName = item.match(new RegExp(`^(${NAME_RE})$`, 'i'));
    if (onlyName) {
      allTyped = false;
      params.push({ name: onlyName[1], type: 'int' });
      continue;
    }
    // 兜底：去掉明显不是名字的字符后作为参数名
    const cleaned = item.replace(/[^\w\u4e00-\u9fff]/g, '');
    allTyped = false;
    if (cleaned) params.push({ name: cleaned, type: 'int' });
    notes.push(`函数参数「${item}」无法完全识别，已按 int 类型处理`);
  }

  if (!allTyped) notes.push('部分函数参数没有标注类型，系统按 C 的 int 类型生成');
  return { params, notes, allTyped };
}

const RETURN_TYPE_ONLY_RE = new RegExp(`^返回(?:值)?\\s*(?:类型)?\\s*(?:为|是)?\\s*(${TYPE_RE_SOURCE})$`, 'i');

/** 解析函数定义 */
function parseFunctionStatement(text: string, state: AnalyzerState): ParsedStatement | undefined {
  if (!/函数/.test(text) && !new RegExp(`^${NAME_RE}\\s*\\(`).test(text)) return undefined;

  let match = text.match(
    new RegExp(
      `^(?:定义|声明|创建)\\s*(?:一个|一名)?\\s*(?:返回(?:值)?(?:类型)?\\s*(?:为|是)?\\s*)?(${TYPE_RE_SOURCE})?\\s*(?:的)?\\s*函数\\s*(?:名(?:为|叫|字)?\\s*)?(?:返回(?:值)?(?:类型)?\\s*(?:为|是)?\\s*)?(${TYPE_RE_SOURCE})?\\s*(${NAME_RE})\\s*\\((.*?)\\)\\s*(?:[,:，：]\\s*)?(.*)$`,
      'i',
    ),
  );
  let usedKeyword = true;
  if (!match) {
    match = text.match(
      new RegExp(
        `^函数\\s*(?:名(?:为|叫|字)?\\s*)?(?:返回(?:值)?(?:类型)?\\s*(?:为|是)?\\s*)*(${TYPE_RE_SOURCE})?\\s*(${NAME_RE})\\s*\\((.*?)\\)\\s*(?:[,:，：]\\s*)?(.*)$`,
        'i',
      ),
    );
  }
  if (!match) {
    // 形如 `add(整数 a, 小数 b)` 的裸函数定义（参数带类型才能和函数调用区分）
    const bare = text.match(new RegExp(`^(${NAME_RE})\\s*\\((.*)\\)\\s*$`, 'i'));
    const statementKeywords = new Set([
      '输出', '打印', '显示', '说', '输入', '读入', '读取', '返回', '调用', '如果', '若',
      '循环', '重复', '当', '把', '设', '令', '创建', '定义', '声明', '结束', '直到',
    ]);
    if (bare && !statementKeywords.has(bare[1]) && new RegExp(TYPE_RE_SOURCE, 'i').test(bare[2])) {
      match = [bare[0], undefined, undefined, bare[1], bare[2], ''] as unknown as RegExpMatchArray;
      usedKeyword = false;
    }
  }
  if (!match) return undefined;

  const returnTypeBefore = match[1]?.trim();
  const returnTypeAfter = match[2]?.trim();
  const name = match[3]?.trim();
  const rawParams = match[4] ?? '';
  const remainder = (match[5] ?? '').trim();
  if (!name) return undefined;

  // 逗号后可能是「返回整数」或行内函数体
  let declaredReturnType = returnTypeBefore || returnTypeAfter;
  let inlineBody: string | undefined;
  if (remainder) {
    const returnOnly = remainder.match(RETURN_TYPE_ONLY_RE);
    if (returnOnly) declaredReturnType = returnOnly[1];
    else if (/^返回/.test(remainder)) inlineBody = remainder;
    else inlineBody = remainder;
  }

  const paramInfo = parseFunctionParams(rawParams);
  const notes = [...paramInfo.notes];
  let confidence: PseudoConfidence = 'high';
  if (!usedKeyword) {
    confidence = 'medium';
    notes.push('未使用「定义函数」关键字，根据「函数名(带类型参数)」语法推断为函数定义');
  }
  if (!paramInfo.allTyped) confidence = minConfidence([confidence, 'medium']);
  if (inlineBody) {
    notes.push('函数体写在同一行，已作为行内语句解析');
  }

  const inference: PseudoInference = {
    summary: `定义函数「${name}」（参数：${paramInfo.params.length ? paramInfo.params.map((item) => `${item.name}: ${item.type}`).join('、') : '无'}）`,
    functionName: name,
    functionParams: paramInfo.params,
    functionReturnType: declaredReturnType ? mapPseudoType(declaredReturnType) : undefined,
  };

  if (state.functions.has(name)) {
    confidence = minConfidence([confidence, 'medium']);
    notes.push(`函数名「${name}」重复定义，生成代码只保留第一次定义`);
    state.warnings.push(`函数名「${name}」被重复定义，生成代码只保留第一次定义`);
  }
  state.functions.set(name, {
    params: paramInfo.params,
    returnType: inference.functionReturnType,
    line: 0,
  });
  state.mapper.map(name, 'func');
  for (const param of paramInfo.params) state.mapper.map(param.name, 'var');

  return parsedStatement({
    kind: 'function',
    inference,
    confidence,
    notes,
    block: !inlineBody,
    inlineBodies: inlineBody ? [inlineBody] : [],
    scopeVariables: paramInfo.params.map((param) => ({
      name: param.name,
      type: (mapPseudoType(param.type) ?? 'int') as CType,
    })),
  });
}

/** 输出内容是否应当按表达式生成 */
function looksLikeExpressionContent(content: string, state: AnalyzerState): boolean {
  if (state.variables.has(content)) return true;
  if (/^[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]*\s*\(.*\)$/.test(content)) return true;
  const tokens = content.match(/[A-Za-z_][A-Za-z0-9_]*|[\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9_]*|\d+(?:\.\d+)?/g) ?? [];
  const hasKnownVariable = tokens.some((token) => state.variables.has(token));
  const hasDigit = tokens.some((token) => /^\d/.test(token));
  if (hasKnownVariable || hasDigit) return true;
  const hasOperator =
    /[+\-*/%<>!=&|]/.test(content) ||
    /(?:^|\s)(?:大于|小于|等于|不等于|并且|或者|加上|减去|乘以|除以|加|减|乘|除)(?:\s|$)/.test(content);
  return hasOperator && (hasKnownVariable || hasDigit);
}

/** 解析输出语句 */
function parsePrintStatement(text: string, state: AnalyzerState): ParsedStatement | undefined {
  const match = text.match(
    /^(?:输出|打印|显示|说|说出|打印出|输出结果|打印结果)\s*(?:内容|结果|文字|信息|以下内容)?\s*[:]?\s*(.*)$/,
  );
  if (!match) return undefined;

  let content = (match[1] ?? '').trim();
  content = content.replace(/\s*的(?:值|结果)$/, '').trim();
  content = content.replace(/[,;:]+$/, '').trim();

  if (!content) {
    return parsedStatement({
      kind: 'print',
      inference: { summary: '输出空行（原文没有给出输出内容）', printExpression: '', printIsExpression: false },
      confidence: 'medium',
      notes: ['输出语句没有内容，生成代码仅输出一个换行符，请人工确认'],
    });
  }

  // 引号包裹 → 字符串字面量
  const unquoted = unquoteString(content);
  if (unquoted !== undefined) {
    return parsedStatement({
      kind: 'print',
      inference: {
        summary: `输出字符串「${unquoted}」`,
        printExpression: unquoted,
        printIsExpression: false,
      },
      confidence: 'high',
      notes: ['识别为字符串字面量'],
    });
  }

  if (looksLikeExpressionContent(content, state)) {
    const info = translateValueForState(state, content);
    if (info.ok && info.text) {
      return parsedStatement({
        kind: 'print',
        inference: {
          summary: `输出表达式「${content}」的计算结果（C 表达式：${info.text}）`,
          printExpression: info.text,
          printIsExpression: true,
        },
        confidence: info.confidence,
        notes: [...info.notes, '按表达式输出，printf 的格式串由变量类型推断'],
      });
    }
  }

  // 其余情况按文字输出（例如「输出 Hello」），明确提示这是推断
  return parsedStatement({
    kind: 'print',
    inference: {
      summary: `输出文字「${content}」`,
      printExpression: content,
      printIsExpression: false,
    },
    confidence: 'high',
    notes: ['输出内容未加引号，也不是已声明的变量，按字符串字面量生成（系统推断）'],
  });
}

/** 解析输入语句 */
function parseInputStatement(text: string, state: AnalyzerState): ParsedStatement | undefined {
  const match = text.match(/^(?:输入|读入|读取|接收|获取输入|从键盘输入|从键盘读取)\s*(.*)$/);
  if (!match) return undefined;
  let rest = (match[1] ?? '').trim();
  let typeHint: CType | undefined;

  rest = rest.replace(/^(?:一个数|一个值|一个|一名)\s*/, '');
  const typeMatch = rest.match(new RegExp(`^(${TYPE_RE_SOURCE})(?:类型|型)?\\s*(?:的)?\\s*(.*)$`, 'i'));
  if (typeMatch) {
    typeHint = mapPseudoType(typeMatch[1]);
    rest = typeMatch[2].trim();
  }
  rest = rest
    .replace(/^(?:的|类型)?\s*(?:变量|变量名)?\s*/, '')
    .replace(/^(?:到|给|存入|存到|放到|赋给|放进)\s*/, '')
    .replace(/^(?:变量|变量名)\s*/, '')
    .replace(/^(?:数值|数字|值)\s*/, '')
    .replace(/^[,:]\s*/, '')
    .replace(/\s*的(?:值|内容|数字|数量)$/, '')
    .trim();
  if (!rest) return undefined;

  const names = rest
    .split(/\s*(?:[,，、]|和|以及)\s*/)
    .map((item) => item.replace(/[^\w\u4e00-\u9fff]/g, ''))
    .filter(Boolean);
  if (names.length === 0) return undefined;
  const target = names[0];
  if (!/^[A-Za-z_][A-Za-z0-9_]*$|^[\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9_]*$/.test(target)) return undefined;

  const knownType = state.variables.get(target);
  const targetType: CType = knownType ?? typeHint ?? 'int';
  const notes: string[] = [];
  let confidence: PseudoConfidence = knownType ? 'high' : 'medium';
  if (!knownType) {
    registerVariable(state, target, targetType);
    notes.push(`输入目标「${target}」没有找到变量声明，已按 ${targetType} 推断其类型（系统推断），生成代码可能需要补充声明`);
  }
  if (typeHint) notes.push(`原文标注了输入类型「${targetType}」，生成代码按该类型选择 scanf 格式`);
  if (names.length > 1) {
    confidence = minConfidence([confidence, 'medium']);
    notes.push('一行包含多个输入目标，目前只生成第一个目标的输入语句');
  }
  state.mapper.map(target, 'var');

  return parsedStatement({
    kind: 'input',
    inference: {
      summary: `读取用户输入并存入变量「${target}」`,
      assignmentTarget: target,
      declaredType: targetType,
    },
    confidence,
    notes,
  });
}

/** 解析返回语句 */
function parseReturnStatement(text: string, state: AnalyzerState): ParsedStatement | undefined {
  const match = text.match(/^(返回|return)\s*(.*)$/i);
  if (!match) return undefined;
  const valueRaw = (match[2] ?? '').trim().replace(/[,;]+$/, '');
  const insideFunction = findFunctionFrame(state) !== undefined;
  const notes: string[] = [];
  let confidence: PseudoConfidence = 'high';

  let returnValue: string | undefined;
  if (valueRaw) {
    const info = translateValueForState(state, valueRaw);
    notes.push(...info.notes);
    confidence = info.confidence;
    returnValue = info.text || undefined;
  }
  if (!insideFunction) {
    confidence = minConfidence([confidence, 'medium']);
    notes.push('返回语句不在函数体内，生成的 C 代码可能不符合你的预期');
  }

  return parsedStatement({
    kind: 'return',
    inference: {
      summary: returnValue ? `返回表达式「${valueRaw}」的值（C 表达式：${returnValue}）` : '返回（无返回值）',
      returnValue,
    },
    confidence,
    notes,
  });
}

/** 解析 break / continue */
function parseBreakContinueStatement(text: string, state: AnalyzerState): ParsedStatement | undefined {
  const inLoop = state.stack.some((frame) => frame.kind === 'loop');
  if (/^(?:跳出循环|退出循环|终止循环|停止循环|break)$/i.test(text)) {
    const notes: string[] = [];
    let confidence: PseudoConfidence = 'high';
    if (!inLoop) {
      confidence = 'medium';
      notes.push('跳出循环语句不在循环体内，生成的 break 可能无法通过编译');
    }
    return parsedStatement({
      kind: 'break',
      inference: { summary: '跳出当前循环（break）' },
      confidence,
      notes,
    });
  }
  if (/^(?:继续|继续下一次|跳过本次循环|进入下一轮|continue)$/i.test(text)) {
    const notes: string[] = [];
    let confidence: PseudoConfidence = 'high';
    if (!inLoop) {
      confidence = 'medium';
      notes.push('继续循环语句不在循环体内，生成的 continue 可能无法通过编译');
    }
    return parsedStatement({
      kind: 'continue',
      inference: { summary: '跳过本次循环剩余部分，进入下一轮（continue）' },
      confidence,
      notes,
    });
  }
  return undefined;
}

const DECLARE_RE = new RegExp(
  `^(?:创建|定义|声明|新建|初始化|令|设)\\s*(?:一个名为|一个叫做|一个|一名)?\\s*(${TYPE_RE_SOURCE})?\\s*(?:类型|型)?\\s*(?:的)?\\s*(?:变量|变量名|名字)?\\s*(${NAME_RE})\\s*(?:[,，]\\s*)?(?:(?:然后|并且|再|并)\\s*)?(?:把(?:它|其|该变量)?\\s*)?(?:赋值为|赋成|赋为|初始化为|初始值(?:为|是)|设为|设置为|的值为|的值是|等于|为|=)\\s*(.+)?$`,
  'i',
);

/** 根据初值推断变量类型 */
function inferDeclarationTypeByValue(rawValue: string | undefined): { type: CType; note?: string } {
  if (!rawValue) {
    return { type: 'int', note: '既没有声明类型也没有初值，默认按 int 处理（系统推断）' };
  }
  const value = rawValue.trim();
  const quoted = unquoteString(value);
  if (quoted !== undefined) {
    const singleQuoted = value.trim().startsWith("'");
    if (singleQuoted && quoted.length === 1) return { type: 'char' };
    return { type: 'char[]' };
  }
  if (/^\d+$/.test(value)) return { type: 'int' };
  if (/^\d+\.\d+$/.test(value)) return { type: 'double' };
  if (/^(?:真|假|成立|不成立|true|false)$/i.test(value)) return { type: 'int' };
  const hasOperator = /[+\-*/%]/.test(value);
  if (hasOperator) {
    return { type: /\d+\.\d+/.test(value) ? 'double' : 'int', note: '未声明类型，根据表达式初值推断类型（系统推断）' };
  }
  if (/[\u4e00-\u9fff]/.test(value) || /\s/.test(value)) {
    return { type: 'char[]', note: '未声明类型且初值像文字，按字符串（char 数组）推断（系统推断）' };
  }
  if (/^[A-Z][A-Za-z0-9_]*$/.test(value)) {
    return { type: 'char[]', note: '未声明类型且初值像专有名词，按字符串（char 数组）推断（系统推断）' };
  }
  return { type: 'int', note: '未声明类型，按 int 推断初值（系统推断）' };
}

/** 解析变量声明 */
function parseDeclarationStatement(text: string, state: AnalyzerState): ParsedStatement | undefined {
  if (/函数/.test(text)) return undefined;
  const match = text.match(DECLARE_RE);
  if (!match) return undefined;

  const typeWord = match[1]?.trim();
  const name = match[2].trim();
  let valueRaw: string | undefined = match[3]?.trim();
  if (valueRaw) {
    valueRaw = valueRaw.replace(/[,，;；]+$/, '').trim() || undefined;
  }
  if (!name) return undefined;

  const notes: string[] = [];
  let confidence: PseudoConfidence = 'high';
  let declaredType = mapPseudoType(typeWord);

  if (!declaredType) {
    const inferred = inferDeclarationTypeByValue(valueRaw);
    declaredType = inferred.type;
    confidence = minConfidence([confidence, 'medium']);
    notes.push(inferred.note ?? '未显式声明类型，已根据初值推断（系统推断）');
  } else if (typeWord) {
    if (/布尔|逻辑|bool|boolean/i.test(typeWord)) notes.push('C 语言没有布尔类型，布尔变量按 int 生成（0/1）');
    if (/字符串|文本|string/i.test(typeWord)) notes.push('字符串在 C 中用 char 数组表示');
  }

  state.mapper.map(name, 'var');

  let declaredValue: string | undefined;
  if (valueRaw) {
    if (declaredType === 'char[]') {
      const unquoted = unquoteString(valueRaw);
      declaredValue = unquoted ?? valueRaw;
      notes.push('字符串初值按字符串字面量处理');
    } else if (declaredType === 'char') {
      const unquoted = unquoteString(valueRaw);
      const content = (unquoted ?? valueRaw).trim();
      declaredValue = content.slice(0, 1);
      if (content.length > 1) {
        confidence = minConfidence([confidence, 'medium']);
        notes.push('字符初值包含多个字符，生成代码只使用第一个字符');
      }
    } else {
      const info = translateValueForState(state, valueRaw, [name]);
      notes.push(...info.notes);
      if (!info.ok) {
        confidence = 'low';
        notes.push('初值未能转换为 C 表达式，生成代码不包含初始化值');
      } else if (/^["']/.test(info.text.trim())) {
        confidence = minConfidence([confidence, 'medium']);
        notes.push('初值是字符串，与数值类型不匹配，生成代码不包含初始化值');
      } else {
        confidence = minConfidence([confidence, info.confidence]);
        declaredValue = info.text;
      }
    }
  } else {
    notes.push('该变量没有初始值（生成代码只声明不初始化）');
  }

  registerVariable(state, name, declaredType);

  return parsedStatement({
    kind: 'declare',
    inference: {
      summary: `声明变量「${name}」，类型 ${declaredType}${valueRaw ? `，初值「${valueRaw}」` : '，无初值'}`,
      declaredType,
      declaredName: name,
      declaredValue,
    },
    confidence,
    notes,
  });
}

const ASSIGN_TO_RE = new RegExp(
  `^把\\s*(?:变量\\s*)?(${NAME_RE})\\s*(?:的值)?\\s*(?:设为|设置为|赋值为|赋成|赋为|改成|变成|变为|更新为|等于|=|为)\\s*(.+)$`,
  'i',
);
const ASSIGN_COMPOUND_RE = new RegExp(
  `^(?:把|让)?\\s*(?:变量\\s*)?(${NAME_RE})\\s*(增加|加上|加|减少|减去|减|乘以|乘|除以|除)\\s*(.+)$`,
  'i',
);
const ASSIGN_PLAIN_RE = new RegExp(
  `^(${NAME_RE})\\s*(?:设为|设置为|赋值为|赋成|赋为|改成|变成|变为|等于|=)\\s*(.+)$`,
  'i',
);

/** 解析赋值语句 */
function parseAssignmentStatement(text: string, state: AnalyzerState): ParsedStatement | undefined {
  let target: string | undefined;
  let valueRaw: string | undefined;
  let operator = '=';
  let confidence: PseudoConfidence = 'high';
  const notes: string[] = [];
  let summaryHint = '';

  const toMatch = text.match(ASSIGN_TO_RE);
  if (toMatch) {
    target = toMatch[1].trim();
    valueRaw = toMatch[2].trim();
  } else {
    const compoundMatch = text.match(ASSIGN_COMPOUND_RE);
    if (compoundMatch) {
      target = compoundMatch[1].trim();
      const verb = compoundMatch[2];
      valueRaw = compoundMatch[3].trim();
      if (/增加|加上|加/.test(verb)) operator = '+=';
      else if (/减少|减去|减/.test(verb)) operator = '-=';
      else if (/乘以|乘/.test(verb)) operator = '*=';
      else operator = '/=';
      summaryHint = `（等价于 ${target} = ${target} ${operator.slice(0, -1)} 值）`;
    } else {
      const plainMatch = text.match(ASSIGN_PLAIN_RE);
      if (plainMatch) {
        target = plainMatch[1].trim();
        valueRaw = plainMatch[2].trim();
      }
    }
  }
  if (!target || !valueRaw) return undefined;
  valueRaw = valueRaw.replace(/[,;]+$/, '').trim();
  if (!valueRaw) return undefined;

  const knownTarget = state.variables.has(target);
  if (!knownTarget) {
    confidence = minConfidence([confidence, 'medium']);
    notes.push(`赋值目标「${target}」没有找到变量声明，生成的 C 代码可能无法通过编译`);
  }
  state.mapper.map(target, 'var');

  const info = translateValueForState(state, valueRaw, [target]);
  notes.push(...info.notes);
  let assignmentValue: string | undefined;
  if (!info.ok) {
    confidence = 'low';
    notes.push('赋值表达式未能转换为 C 表达式，生成代码仅保留注释');
  } else {
    confidence = minConfidence([confidence, info.confidence]);
    assignmentValue = info.text;
  }

  const summary = summaryHint
    ? `修改变量「${target}」：${operator === '+=' ? '增加' : operator === '-=' ? '减少' : operator === '*=' ? '乘以' : '除以'} ${valueRaw}${summaryHint}`
    : `将变量「${target}」赋值为「${valueRaw}」（C 表达式：${assignmentValue ?? valueRaw}）`;

  return parsedStatement({
    kind: 'assign',
    inference: {
      summary,
      assignmentTarget: target,
      assignmentValue,
      assignmentOperator: operator,
    },
    confidence,
    notes,
  });
}

/** 按顶层逗号拆分函数实参 */
function splitArguments(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;
  for (const ch of trimmed) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === '，') && depth === 0) {
      if (current.trim()) args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/** 解析函数调用 */
function parseCallStatement(text: string, state: AnalyzerState): ParsedStatement | undefined {
  let match = text.match(new RegExp(`^(?:调用|执行|运行)\\s*(${NAME_RE})\\s*\\((.*)\\)\\s*$`, 'i'));
  const hasKeyword = Boolean(match);
  if (!match) match = text.match(new RegExp(`^(${NAME_RE})\\s*\\((.*)\\)\\s*$`, 'i'));
  if (!match) return undefined;

  const name = match[1].trim();
  const rawArgs = match[2].trim();
  const notes: string[] = [];
  let confidence: PseudoConfidence = 'high';

  const argTexts = splitArguments(rawArgs);
  const callArgs: string[] = [];
  for (const argText of argTexts) {
    const info = translateValueForState(state, argText);
    notes.push(...info.notes);
    confidence = minConfidence([confidence, info.confidence]);
    callArgs.push(info.text || argText);
  }

  const known = state.functions.has(name) || state.knownFunctionNames.has(name);
  if (!known) {
    confidence = minConfidence([confidence, 'medium']);
    notes.push(`未找到函数「${name}」的定义，生成的 C 代码需要你补充该函数才能编译`);
  }
  if (!hasKeyword) notes.push('未使用「调用」关键字，根据函数调用语法推断');
  state.mapper.map(name, 'func');

  const signature = state.functions.get(name);
  if (signature && signature.params.length !== callArgs.length && rawArgs !== '') {
    confidence = minConfidence([confidence, 'medium']);
    notes.push(`调用参数个数（${callArgs.length}）与函数定义（${signature.params.length}）不一致，请人工确认`);
  }

  return parsedStatement({
    kind: 'call',
    inference: {
      summary: `调用函数「${name}」，参数：${rawArgs || '无'}`,
      callName: name,
      callArgs,
    },
    confidence,
    notes,
  });
}

/** 解析一个普通分句（不含「否则」和结束标记） */
function parseOrdinaryClause(text: string, state: AnalyzerState): ParsedStatement {
  const trimmed = text.trim();
  if (!trimmed) return unknownParsed(text);
  return (
    parseFunctionStatement(trimmed, state) ??
    parseLoopStatement(trimmed, state) ??
    parseIfStatement(trimmed, state) ??
    parsePrintStatement(trimmed, state) ??
    parseInputStatement(trimmed, state) ??
    parseReturnStatement(trimmed, state) ??
    parseBreakContinueStatement(trimmed, state) ??
    parseDeclarationStatement(trimmed, state) ??
    parseAssignmentStatement(trimmed, state) ??
    parseCallStatement(trimmed, state) ??
    unknownParsed(trimmed)
  );
}

// ---------------------------------------------------------------------------
// 行内语句体、注释、结束标记、否则分支
// ---------------------------------------------------------------------------

/** 创建 PseudoStatement（含行内语句体的递归解析） */
function materialize(state: AnalyzerState, parsedData: ParsedStatement, clause: Clause): PseudoStatement {
  const statement: PseudoStatement = {
    id: `ps_${++state.counter}`,
    kind: parsedData.kind,
    line: clause.line,
    endLine: clause.line,
    original: clause.raw,
    inference: parsedData.inference,
    confidence: parsedData.confidence,
    notes: [...parsedData.notes],
    children: [],
  };

  if (parsedData.scopeVariables) {
    for (const item of parsedData.scopeVariables) state.variables.set(item.name, item.type);
  }
  attachInlineBodies(state, statement, parsedData.inlineBodies, clause);
  if (parsedData.scopeVariables && !parsedData.block) {
    for (const item of parsedData.scopeVariables) state.variables.delete(item.name);
  }
  return statement;
}

/** 把同一行的语句体（如「就输出 Hello」）挂到父语句下 */
function attachInlineBodies(
  state: AnalyzerState,
  parent: PseudoStatement,
  bodies: string[],
  clause: Clause,
): void {
  for (const rawBody of bodies) {
    const body = rawBody.trim();
    if (!body) continue;
    const childClause: Clause = {
      line: clause.line,
      raw: clause.raw,
      text: body,
      indent: clause.indent,
      colon: false,
    };
    const childParsed = parseOrdinaryClause(body, state);
    const child = materialize(state, childParsed, childClause);
    child.parentId = parent.id;
    parent.children.push(child);
    pushParsedWarnings(state, childParsed);
    if (childParsed.block) {
      child.confidence = downgradeConfidence(child.confidence);
      child.notes.push('行内嵌套的块结构暂不支持完整分析，可能遗漏其内部语句');
      state.warnings.push(`第 ${clause.line} 行存在行内嵌套块结构，暂时无法完整分析`);
    }
  }
}

/** 处理整行注释 */
function handleCommentLine(
  state: AnalyzerState,
  raw: string,
  line: number,
  indent: number,
  content: string,
  lineResult: PseudoLineResult,
): void {
  popFramesForIndent(state, indent);
  const statement = materialize(
    state,
    parsedStatement({
      kind: 'comment',
      inference: { summary: `注释：${content}` },
      confidence: 'high',
      notes: ['注释行不参与执行，也不影响整体置信度'],
    }),
    { line, raw, text: content, indent, colon: false },
  );
  appendStatement(state, statement);
  assignLineResult(state, lineResult, statement);
}

interface EndMarker {
  family: 'if' | 'loop' | 'function' | 'any';
}

const IF_END_MARKERS = new Set([
  '结束如果',
  '结束条件',
  '结束如果语句',
  '结束如果块',
  '结束如果分支',
  '结束否则',
  '条件结束',
  '如果结束',
  'endif',
  'fi',
]);
const LOOP_END_MARKERS = new Set([
  '结束循环',
  '结束重复',
  '结束循环语句',
  '结束循环块',
  '循环结束',
  '重复结束',
  'endloop',
  'endfor',
  'endwhile',
  'loopend',
  'whileend',
  'forend',
]);
const FUNCTION_END_MARKERS = new Set([
  '结束函数',
  '结束函数定义',
  '结束定义',
  '函数结束',
  'endfunction',
  'functionend',
]);
const ANY_END_MARKERS = new Set(['结束', 'end', '}']);

/** 识别「结束如果/结束循环/结束函数」等结束标记 */
function matchEndMarker(text: string): EndMarker | undefined {
  const compact = text.replace(/[\s：:。；;!！]+/g, '').toLowerCase();
  if (!compact) return undefined;
  if (IF_END_MARKERS.has(compact)) return { family: 'if' };
  if (LOOP_END_MARKERS.has(compact)) return { family: 'loop' };
  if (FUNCTION_END_MARKERS.has(compact)) return { family: 'function' };
  if (ANY_END_MARKERS.has(compact)) return { family: 'any' };
  return undefined;
}

/** 处理结束标记 */
function handleEndMarker(
  state: AnalyzerState,
  marker: EndMarker,
  clause: Clause,
  lineResult: PseudoLineResult,
): void {
  let targetIndex = -1;
  for (let i = state.stack.length - 1; i >= 0; i -= 1) {
    const frame = state.stack[i];
    if (marker.family === 'any') {
      targetIndex = i;
      break;
    }
    if (marker.family === 'if' && (frame.kind === 'if' || frame.kind === 'elseif' || frame.kind === 'else')) {
      targetIndex = i;
      break;
    }
    if (marker.family === 'loop' && frame.kind === 'loop') {
      targetIndex = i;
      break;
    }
    if (marker.family === 'function' && frame.kind === 'function') {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex < 0) {
    state.warnings.push(`第 ${clause.line} 行的「${clause.text}」没有找到可闭合的块，已按无法识别处理`);
    popFramesForIndent(state, clause.indent);
    const statement = materialize(state, unknownParsed(clause.text), clause);
    appendStatement(state, statement);
    assignLineResult(state, lineResult, statement);
    return;
  }

  while (state.stack.length - 1 > targetIndex) closeFrame(state, false);
  const frame = closeFrame(state, true, clause.line);
  if (!frame) return;
  const lineIndex = clause.line - 1;
  if (!state.assigned[lineIndex]) {
    state.assigned[lineIndex] = true;
    lineResult.kind = frameStatementKind(frame.kind);
    lineResult.statementId = frame.statement.id;
    lineResult.inferredSummary = `结束标记「${clause.text}」：闭合第 ${frame.statement.line} 行的${blockLabel(frame.kind)}块`;
    lineResult.confidence = 'high';
  }
}

/**「重复… 直到 条件」中的「直到 条件」单独成行时，挂到最近的 do-while 帧上 */
function handleUntilClause(
  state: AnalyzerState,
  clause: Clause,
  conditionRaw: string,
  lineResult: PseudoLineResult,
): void {
  let targetIndex = -1;
  for (let i = state.stack.length - 1; i >= 0; i -= 1) {
    const frame = state.stack[i];
    if (frame.kind === 'loop' && frame.statement.inference.loopKind === 'dowhile' && !frame.statement.inference.loopWhile) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex < 0) {
    // 也可能出现在「重复…直到…」写在同一行的情况，这里不识别时按未知行处理
    state.warnings.push(`第 ${clause.line} 行的「直到…」没有找到对应的重复循环，已按无法识别处理`);
    popFramesForIndent(state, clause.indent);
    const statement = materialize(state, unknownParsed(clause.text), clause);
    appendStatement(state, statement);
    assignLineResult(state, lineResult, statement);
    return;
  }

  while (state.stack.length - 1 > targetIndex) closeFrame(state, false);
  const frame = state.stack[state.stack.length - 1];
  const info = translateValueForState(state, conditionRaw);
  const loop = frame.statement;
  loop.inference.loopWhile = info.text || conditionRaw;
  loop.inference.summary = `do-while 循环：先执行循环体，直到条件「${conditionRaw}」成立时停止（C 条件：${info.text || conditionRaw}）`;
  loop.confidence = info.confidence;
  loop.notes.push(...info.notes, `循环终止条件来自同一循环中「直到」语句（系统推断）`);
  closeFrame(state, true, clause.line);

  const lineIndex = clause.line - 1;
  if (!state.assigned[lineIndex]) {
    state.assigned[lineIndex] = true;
    lineResult.kind = 'loop';
    lineResult.statementId = loop.id;
    lineResult.inferredSummary = `循环终止条件「${conditionRaw}」：重复执行直到该条件成立`;
    lineResult.confidence = loop.confidence;
  }
  const loopLineIndex = loop.line - 1;
  if (state.assigned[loopLineIndex]) {
    state.lines[loopLineIndex].confidence = loop.confidence;
    state.lines[loopLineIndex].inferredSummary = loop.inference.summary;
  }
}

interface ElseClauseInfo {
  kind: 'else' | 'elseif';
  conditionRaw?: string;
  bodyText?: string;
}

/** 识别「否则 / 否则如果 / else if / else」分句 */
function matchElseClause(text: string): ElseClauseInfo | undefined {
  let match = text.match(/^否则\s*(?:如果|若|假如|假设|当)\s*(.+)$/);
  if (match) {
    const extracted = extractConditionAndBody(match[1]);
    return { kind: 'elseif', conditionRaw: extracted.condition, bodyText: extracted.body };
  }
  match = text.match(/^else\s+if\s+(.+)$/i);
  if (match) {
    const extracted = extractConditionAndBody(match[1]);
    return { kind: 'elseif', conditionRaw: extracted.condition, bodyText: extracted.body };
  }
  match = text.match(/^否则\s*(.*)$/);
  if (match) {
    const rest = match[1].trim();
    const conditional = rest.match(/^(?:如果|若|假如|假设)\s*(.+)$/);
    if (conditional) {
      const extracted = extractConditionAndBody(conditional[1]);
      return { kind: 'elseif', conditionRaw: extracted.condition, bodyText: extracted.body };
    }
    return { kind: 'else', bodyText: rest || undefined };
  }
  match = text.match(/^else\s*[:]?\s*(.*)$/i);
  if (match) {
    return { kind: 'else', bodyText: match[1].trim() || undefined };
  }
  return undefined;
}

/** 构造「否则 / 否则如果」对应的 ParsedStatement */
function buildElseParsed(info: ElseClauseInfo, state: AnalyzerState): ParsedStatement {
  if (info.kind === 'elseif' && info.conditionRaw) {
    const conditionInfo = translateValueForState(state, info.conditionRaw);
    return parsedStatement({
      kind: 'elseif',
      inference: {
        summary: `否则如果条件「${info.conditionRaw}」成立（C 条件：${conditionInfo.text}），执行该分支`,
        condition: conditionInfo.text,
      },
      confidence: conditionInfo.confidence,
      notes: [...conditionInfo.notes, '按「否则如果」分支生成'],
      block: !info.bodyText,
      inlineBodies: info.bodyText ? [info.bodyText] : [],
    });
  }
  if (info.kind === 'elseif') {
    return parsedStatement({
      kind: 'unknown',
      inference: { summary: '否则如果分支缺少条件表达式' },
      confidence: 'low',
      notes: ['「否则如果」后没有可识别的条件，未做猜测'],
    });
  }
  return parsedStatement({
    kind: 'else',
    inference: {
      summary: info.bodyText ? `否则执行：${info.bodyText}` : '否则执行以下语句块',
    },
    confidence: 'high',
    notes: ['否则分支本身不带条件，其置信度会与配对的如果分支合并'],
    block: !info.bodyText,
    inlineBodies: info.bodyText ? [info.bodyText] : [],
  });
}

/** 在语句列表中从后往前找最后一条非注释语句（用于 if/else 配对） */
function findLastMeaningful(statements: PseudoStatement[]): PseudoStatement | undefined {
  for (let i = statements.length - 1; i >= 0; i -= 1) {
    if (statements[i].kind !== 'comment') return statements[i];
  }
  return undefined;
}

interface ElseAttachment {
  container: PseudoStatement[];
  previous?: PseudoStatement;
}

/** 为「否则」找到应当配对的条件分支 */
function findElseContainer(state: AnalyzerState, indent: number): ElseAttachment {
  // 先关闭明显更深的块
  while (state.stack.length > 0) {
    const top = state.stack[state.stack.length - 1];
    if (top.openerIndent > indent) closeFrame(state, false);
    else break;
  }
  while (true) {
    const container = currentContainer(state);
    const previous = findLastMeaningful(container);
    if (previous && (previous.kind === 'if' || previous.kind === 'elseif')) {
      return { container, previous };
    }
    if (state.stack.length === 0) return { container };
    closeFrame(state, false);
  }
}

/** 处理「否则 / 否则如果」 */
function handleElseClause(
  state: AnalyzerState,
  clause: Clause,
  info: ElseClauseInfo,
  lineResult: PseudoLineResult,
): void {
  const attachment = findElseContainer(state, clause.indent);
  const parsedData = buildElseParsed(info, state);
  const statement = materialize(state, parsedData, clause);
  statement.parentId = attachment.previous?.parentId;
  attachment.container.push(statement);
  assignLineResult(state, lineResult, statement);
  pushParsedWarnings(state, parsedData);

  if (!attachment.previous) {
    statement.confidence = minConfidence([statement.confidence, 'low']);
    statement.notes.push('没有找到可以配对的「如果 / 否则如果」分支，生成代码会按普通代码块处理');
    state.warnings.push(
      `第 ${clause.line} 行的「${info.kind === 'else' ? '否则' : '否则如果'}」没有找到配对的条件分支，请检查结构`,
    );
  } else {
    statement.notes.push(`与第 ${attachment.previous.line} 行的「如果 / 否则如果」分支配对（系统推断）`);
    statement.confidence = minConfidence([statement.confidence, attachment.previous.confidence]);
    attachment.previous.endLine = Math.max(attachment.previous.endLine, clause.line);
  }

  if (parsedData.block) pushFrame(state, statement, clause, parsedData);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 分句构造：去掉句首尾标点、识别冒号块 */
function buildClause(sentence: string, line: number, raw: string, indent: number): Clause | undefined {
  const normalized = normalizeSentence(sentence);
  if (!normalized) return undefined;
  let text = normalized.replace(/^[,;、]+/, '').trim();
  let colon = false;
  if (text.endsWith(':')) {
    colon = true;
    text = text.slice(0, -1).trim();
  }
  text = text.replace(/[,;、]+$/, '').trim();
  if (!text) return undefined;
  return { line, raw, text, indent, colon };
}

/** 处理一个分句 */
function handleClause(state: AnalyzerState, clause: Clause, lineResult: PseudoLineResult): void {
  // 1. 「直到…」可能闭合 do-while
  const untilMatch = clause.text.match(/^(?:直到|一直到|循环直到)\s*(.+)$/);
  if (untilMatch) {
    handleUntilClause(state, clause, untilMatch[1], lineResult);
    return;
  }

  // 2. 显式结束标记
  const marker = matchEndMarker(clause.text);
  if (marker) {
    handleEndMarker(state, marker, clause, lineResult);
    return;
  }

  // 3. 否则 / 否则如果
  const elseInfo = matchElseClause(clause.text);
  if (elseInfo) {
    handleElseClause(state, clause, elseInfo, lineResult);
    return;
  }

  // 4. 根据缩进关闭已结束的块
  popFramesForIndent(state, clause.indent);

  // 5. 普通语句
  const parsedData = parseOrdinaryClause(clause.text, state);
  const statement = materialize(state, parsedData, clause);
  appendStatement(state, statement);
  assignLineResult(state, lineResult, statement);
  pushParsedWarnings(state, parsedData);
  if (
    statement.notes.some(
      (note) => note.includes('未声明的名字') || note.includes('没有找到变量声明'),
    )
  ) {
    state.warnings.push(
      `第 ${clause.line} 行引用了未声明的名字，系统已按推断处理，生成的 C 代码请人工确认：${statement.inference.summary}`,
    );
  }

  if (statement.kind === 'unknown') {
    state.warnings.push(`第 ${clause.line} 行无法识别：「${clause.text}」，已保留为注释，未静默丢弃`);
  }
  if (parsedData.block) pushFrame(state, statement, clause, parsedData);
}

/** 预扫描函数名：允许函数在定义之前被调用时仍能判断为已知函数 */
function prescanFunctionNames(rawLines: string[]): Set<string> {
  const names = new Set<string>();
  for (const raw of rawLines) {
    const text = normalizeSentence(stripInlineComment(raw));
    if (!text) continue;
    const match =
      text.match(new RegExp(`函数\\s*(?:名(?:为|叫|字)?\\s*)?(${NAME_RE})\\s*\\(`, 'i')) ??
      text.match(new RegExp(`^(?:定义|声明|创建)\\s*(${NAME_RE})\\s*\\(`, 'i'));
    if (match) names.add(match[1]);
  }
  return names;
}

/** 生成整体置信度、可执行性与全局提示 */
function buildSummaryNotes(
  state: AnalyzerState,
  rawLineCount: number,
  generatedLineCount: number,
  supportedExecutable: boolean,
  overallConfidence: PseudoConfidence,
  reasons: string[],
): void {
  const allStatements = collectStatements(state.root);
  state.notes.unshift(
    '分析结果严格区分三部分：lines[].original 与 statements[].original 是「用户原文」；statements[].inference 是「系统推断」，不是原文；generatedCode 是「生成的 C 代码」建议。',
    '生成的 C 代码只是根据推断结果给出的建议，不代表用户原文，默认不会替换用户输入；应用前请人工确认，系统推断不保证与你的本意一致。',
    `逐行结果共 ${rawLineCount} 行（空行已保留），共识别 ${allStatements.length} 条语句，生成代码 ${generatedLineCount} 行。`,
  );
  if (supportedExecutable) {
    state.notes.push('所有非注释语句均为高置信度，且不包含输入 / 未知语句，生成的 C 代码可以尝试交给解释器执行。');
  } else {
    state.notes.push(`生成代码暂不标记为可执行，原因：${reasons.join('；')}。`);
  }
  if (overallConfidence !== 'high') {
    state.notes.push(`整体置信度为 ${overallConfidence}，请重点核对低置信度的语句。`);
  }
}

/** 分析中文伪代码 */
export function analyzePseudo(source: SourceFile): PseudoAnalysis {
  const rawLines = source.lines();
  const state: AnalyzerState = {
    source,
    lines: rawLines.map((text, index) => ({ line: index + 1, original: text, kind: 'blank' })),
    assigned: new Array<boolean>(rawLines.length).fill(false),
    root: [],
    stack: [],
    variables: new Map<string, CType>(),
    functions: new Map<string, FunctionInfo>(),
    knownFunctionNames: prescanFunctionNames(rawLines),
    mapper: new IdentifierMapper(),
    warnings: [],
    notes: [],
    counter: 0,
  };

  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index];
    const lineNumber = index + 1;
    const lineResult = state.lines[index];
    const trimmed = raw.trim();
    if (!trimmed) continue; // 空行：lines 中保留 kind='blank'
    const indent = countIndent(raw);

    const commentContent = detectCommentLine(trimmed);
    if (commentContent !== undefined) {
      handleCommentLine(state, raw, lineNumber, indent, commentContent, lineResult);
      continue;
    }

    const withoutComment = stripInlineComment(raw);
    const inlineComment = raw.slice(withoutComment.length).trim();
    if (inlineComment) {
      state.notes.push(`第 ${lineNumber} 行包含行内注释「${inlineComment}」，注释不参与 C 代码生成。`);
    }
    const sentences = splitSentences(withoutComment);
    for (const sentence of sentences) {
      const normalized = normalizeSentence(sentence);
      if (!normalized) continue;
      for (const part of splitElseClauses(normalized)) {
        const clause = buildClause(part, lineNumber, raw, indent);
        if (!clause) continue;
        handleClause(state, clause, lineResult);
      }
    }

    // 没有产生任何语句的非空行：明确标记为 unknown，绝不静默丢弃
    if (!state.assigned[index]) {
      popFramesForIndent(state, indent);
      const statement = materialize(
        state,
        unknownParsed(trimmed),
        { line: lineNumber, raw, text: trimmed, indent, colon: false },
      );
      appendStatement(state, statement);
      assignLineResult(state, lineResult, statement);
      state.warnings.push(`第 ${lineNumber} 行无法识别：「${trimmed}」，已保留为注释，未静默丢弃`);
    }
  }

  // 收尾：关闭所有打开的块（未显式结束时按缩进 / 文件结尾推断）
  while (state.stack.length > 0) closeFrame(state, false);

  const allStatements = collectStatements(state.root);
  const nonCommentStatements = allStatements.filter((statement) => statement.kind !== 'comment');

  // 低置信度语句统一给出警告（notes 中已经解释了原因）
  for (const statement of allStatements) {
    if (statement.kind === 'unknown') continue;
    if (statement.confidence === 'low') {
      const reason = statement.notes[0] ?? statement.inference.summary;
      state.warnings.push(`第 ${statement.line} 行推断置信度低（${reason}），请人工确认`);
    }
  }

  // 生成 C 代码（同时回填 generatedStartLine / generatedEndLine）
  const generated = generateCCode(state.root, { mapper: state.mapper });
  state.warnings.push(...generated.warnings);
  const generatedLineCount = generated.code.split('\n').length;
  for (const statement of allStatements) {
    if (statement.generatedStartLine === undefined || statement.generatedEndLine === undefined) {
      statement.generatedStartLine = generatedLineCount;
      statement.generatedEndLine = generatedLineCount;
    }
  }

  const inputs = nonCommentStatements.filter((statement) => statement.kind === 'input');
  const unknowns = nonCommentStatements.filter((statement) => statement.kind === 'unknown');
  const notHigh = nonCommentStatements.filter((statement) => statement.confidence !== 'high');
  const reasons: string[] = [];
  if (inputs.length > 0) reasons.push(`包含 ${inputs.length} 条输入语句（依赖运行时交互，暂不标记为可执行）`);
  if (unknowns.length > 0) reasons.push(`包含 ${unknowns.length} 条无法识别的语句（生成代码中为注释）`);
  if (notHigh.length > 0) reasons.push(`有 ${notHigh.length} 条语句的推断置信度低于 high`);
  const supportedExecutable = reasons.length === 0;
  const overallConfidence: PseudoConfidence =
    nonCommentStatements.length === 0
      ? 'high'
      : minConfidence(nonCommentStatements.map((statement) => statement.confidence));

  buildSummaryNotes(
    state,
    rawLines.length,
    generatedLineCount,
    supportedExecutable,
    overallConfidence,
    reasons,
  );

  return {
    lines: state.lines,
    statements: state.root,
    generatedCode: generated.code,
    warnings: [...new Set(state.warnings)],
    notes: state.notes,
    confidence: overallConfidence,
    supportedExecutable,
    originalText: source.text,
  };
}
