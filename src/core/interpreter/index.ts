/**
 * CodeLens C 子集解释器公共 API
 * ------------------------------------------------------------------
 * UI 层只需要从这里导入：
 * - executeC(program, source, options?)：执行已解析的 C 程序，得到逐行快照
 * - ExecutionResult / ExecutionSnapshot / ScopeView / HeapObjectView 等类型
 *
 * 约定：执行结果全部来自真实解释执行；不支持的能力或运行期错误会通过
 * status = 'error' 与 error（中文原因 + 行号）明确报告，绝不伪造。
 */
export { executeC, ENGINE } from './interpreter';
export type { ExecuteOptions } from './interpreter';
export type {
  CallFrameView,
  ExecutionErrorInfo,
  ExecutionResult,
  ExecutionSnapshot,
  ExecutionStatus,
  HeapObjectView,
  ScopeView,
  ValueView,
  VariableView,
} from './types';
export { unsupportedExecution } from './types';
