/**
 * 逐行执行可视化结果类型
 * ------------------------------------------------------------------
 * 解释器以「快照」形式记录每一步的内存状态：
 * - scopes：作用域与变量的当前值（栈内存视角）
 * - heap：malloc 分配的对象（堆内存视角，可绘制链表/数组）
 * - output：printf 输出
 * UI 只消费快照，不关心解释器内部实现；不支持的语言/语法必须
 * 通过 ExecutionResult.reason / error 明确说明，禁止伪造执行结果。
 */
import type { SourceRange } from '../source';

export type ExecutionStatus = 'ok' | 'error' | 'unsupported';

export interface ExecutionErrorInfo {
  message: string;
  hint?: string;
  line?: number;
  range?: SourceRange;
  kind: 'runtime' | 'unsupported' | 'limit';
}

/** 变量值在界面上的可视化表示 */
export interface ValueView {
  kind: 'scalar' | 'pointer' | 'array' | 'struct' | 'string' | 'function' | 'unknown';
  /** 主显示文本，如 "10" / "0x1008" / "NULL" / "\"hello\"" */
  text: string;
  typeText?: string;
  /** 指针指向的地址（十六进制字符串），NULL 时为空 */
  pointerTarget?: string;
  /** 指针目标的标签，如 "堆对象 #1 (LNode)" */
  pointerTargetLabel?: string;
  isNull?: boolean;
  address?: string;
  /** 数组元素 */
  elements?: { index: number; text: string; pointerTarget?: string }[];
  /** 结构体成员 */
  fields?: { name: string; typeText: string; text: string; pointerTarget?: string }[];
  /** 本步是否发生变化（用于高亮变量值的变化） */
  changed?: boolean;
}

export interface VariableView {
  name: string;
  typeText: string;
  scopeName: string;
  scopeKind: 'global' | 'function' | 'block';
  value: ValueView;
  declaredLine?: number;
  address?: string;
}

export interface ScopeView {
  id: string;
  name: string;
  kind: 'global' | 'function' | 'block';
  variables: VariableView[];
}

export interface HeapObjectView {
  address: string;
  typeText: string;
  kind: 'struct' | 'array' | 'memory' | 'string';
  label?: string;
  fields?: { name: string; typeText: string; text: string; pointerTarget?: string }[];
  elements?: { index: number; text: string; pointerTarget?: string }[];
  freed?: boolean;
  /** 是否被任何指针/变量引用（用于显示悬空指针警告） */
  referenced?: boolean;
}

export interface CallFrameView {
  functionName: string;
  line?: number;
  locals?: number;
}

export interface ExecutionSnapshot {
  index: number;
  /** 当前执行行（1-based） */
  line: number;
  /** 这一步发生了什么（中文描述） */
  description: string;
  phase: 'start' | 'statement' | 'condition' | 'loop' | 'call' | 'return' | 'output' | 'end' | 'error';
  range?: SourceRange;
  functionName?: string;
  callStack: CallFrameView[];
  scopes: ScopeView[];
  heap: HeapObjectView[];
  output: string[];
  stdout: string;
  warnings: string[];
}

export interface ExecutionResult {
  status: ExecutionStatus;
  /** 执行引擎标识，例如 "CodeLens C 子集解释器 v1" */
  engine: string;
  /** 不支持执行时的原因（如 JS/Python） */
  reason?: string;
  snapshots: ExecutionSnapshot[];
  stdout: string;
  error?: ExecutionErrorInfo;
  /** 是否因为步数上限被截断 */
  truncated: boolean;
  entryFunction?: string;
  warnings: string[];
  durationMs?: number;
}

/** 空执行结果（用于不支持的语言） */
export function unsupportedExecution(reason: string): ExecutionResult {
  return {
    status: 'unsupported',
    engine: 'CodeLens C 子集解释器 v1',
    reason,
    snapshots: [],
    stdout: '',
    truncated: false,
    warnings: [],
  };
}
