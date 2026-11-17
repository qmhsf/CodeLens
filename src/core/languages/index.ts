/**
 * 结构分析器导出入口
 * ------------------------------------------------------------------
 * 主分析调度（src/core/analyze.ts）只需从这里按语言导入对应分析函数，
 * 各分析器内部自行完成解析、语义高亮、结构树、符号表与错误报告。
 *
 * 能力边界：
 * - analyzeJavaScript / analyzePython 均为「结构级」分析，不做执行；
 * - 返回的 LanguageAnalysis.execution.supported 恒为 false。
 */
export { analyzeJavaScript } from './javascript';
export { analyzePython } from './python';
