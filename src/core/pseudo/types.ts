/**
 * 中文伪代码分析结果类型
 * ------------------------------------------------------------------
 * 设计原则：
 * 1. 必须区分「用户原文」「系统推断」「生成的 C 代码」，三者分别存放；
 * 2. 每一行都带置信度，低置信度必须显式提示，不能假装理解；
 * 3. 生成代码只作为建议，默认不会覆盖用户输入，需用户主动应用。
 */

/** 推断置信度：high=结构明确；medium=可合理推断；low=仅猜测，需要用户确认 */
export type PseudoConfidence = 'high' | 'medium' | 'low';

export type PseudoStatementKind =
  | 'declare'
  | 'assign'
  | 'print'
  | 'input'
  | 'if'
  | 'elseif'
  | 'else'
  | 'loop'
  | 'function'
  | 'return'
  | 'break'
  | 'continue'
  | 'call'
  | 'comment'
  | 'unknown';

/** 由系统推断出的结构化信息（不是用户原文） */
export interface PseudoInference {
  /** 一句话结构化描述 */
  summary: string;
  /** 变量声明 */
  declaredType?: string;
  declaredName?: string;
  declaredValue?: string;
  /** 赋值 */
  assignmentTarget?: string;
  assignmentValue?: string;
  assignmentOperator?: string;
  /** 输出 / 输入 */
  printExpression?: string;
  printIsExpression?: boolean;
  /** 条件 */
  condition?: string;
  /** 循环 */
  loopVariable?: string;
  loopFrom?: string;
  loopTo?: string;
  loopStep?: string;
  loopWhile?: string;
  loopKind?: 'for' | 'while' | 'dowhile' | 'forEach';
  /** 函数 */
  functionName?: string;
  functionParams?: { name: string; type: string }[];
  functionReturnType?: string;
  /** 调用 */
  callName?: string;
  callArgs?: string[];
  /** 返回值 */
  returnValue?: string;
}

export interface PseudoStatement {
  id: string;
  kind: PseudoStatementKind;
  /** 原始行号（1-based） */
  line: number;
  endLine: number;
  /** 用户原文（该条语句对应的原始行） */
  original: string;
  /** 系统推断 */
  inference: PseudoInference;
  confidence: PseudoConfidence;
  /** 推断说明 / 风险提示 */
  notes: string[];
  /** 子结构：条件分支、循环体、函数体 */
  children: PseudoStatement[];
  parentId?: string;
  /** 对应生成的 C 代码行号范围（1-based，含两端） */
  generatedStartLine?: number;
  generatedEndLine?: number;
}

export interface PseudoLineResult {
  line: number;
  original: string;
  kind: PseudoStatementKind | 'blank';
  statementId?: string;
  /** 推断摘要（与原文严格区分） */
  inferredSummary?: string;
  confidence?: PseudoConfidence;
}

export interface PseudoAnalysis {
  /** 逐行分析结果，顺序与源码行一致 */
  lines: PseudoLineResult[];
  /** 结构化语句树（顶层语句） */
  statements: PseudoStatement[];
  /** 生成的 C 代码（标注为生成结果，非用户原文） */
  generatedCode: string;
  /** 整体风险提示 */
  warnings: string[];
  notes: string[];
  /** 整体置信度取所有非注释语句的最低置信度 */
  confidence: PseudoConfidence;
  /** 生成代码是否足够可靠，可以交给解释器执行（例如所有语句都成功推断） */
  supportedExecutable: boolean;
  /** 用户原文快照 */
  originalText: string;
}
