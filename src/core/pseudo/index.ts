/**
 * 中文伪代码分析模块 —— 公共 API
 * ------------------------------------------------------------------
 * 对外只暴露稳定的入口：
 * - analyzePseudo(source)：中文伪代码 → 结构化推断 + 生成的 C 代码；
 * - generateCCode(statements)：单独根据语句树重新生成 C 代码；
 * - 相关类型与工具（类型映射、表达式翻译、标识符映射）。
 *
 * 注意：分析结果里的 inference 字段是「系统推断」，不是「用户原文」；
 * generatedCode 只是「生成的 C 代码」建议，不代表原文。
 */

export { analyzePseudo } from './analyzer';
export {
  generateCCode,
  IdentifierMapper,
  mapPseudoType,
  translateExpressionToC,
} from './codegen';
export type {
  CodegenOptions,
  CodegenResult,
  CType,
  TranslatedExpression,
} from './codegen';
export type {
  PseudoAnalysis,
  PseudoConfidence,
  PseudoInference,
  PseudoLineResult,
  PseudoStatement,
  PseudoStatementKind,
} from './types';
