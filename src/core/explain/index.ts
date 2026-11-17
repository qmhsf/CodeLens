/**
 * 释义统一入口
 * ------------------------------------------------------------------
 * UI 只依赖这里：根据分析结果与点击位置，返回完整释义或悬停提示。
 * C/C++ 使用精确 AST 释义；伪代码使用「原文/推断/生成代码」对照；
 * JS/TS/Python/纯文本使用结构级释义，并明确展示能力边界。
 */
import type { AnalysisResult, StructureNode } from '../analysisTypes';
import { explainCAt, explainCNodeById, hoverCAt } from './cExplainer';
import {
  explainPseudoAt,
  explainStructureNode,
  findStructureAtOffset,
  findStructureByAnyId,
  hoverStructureAt,
} from './structureExplainer';
import type { ExplainLevel, Explanation, HoverInfo } from './types';

export type { ExplainLevel, ExplainPart, ExplainRelationGroup, Explanation, HoverInfo } from './types';
export { EXPLAIN_LEVEL_LABELS } from './types';

/** 根据源码偏移生成完整释义 */
export function explainAt(analysis: AnalysisResult, offset: number, level: ExplainLevel): Explanation | null {
  if (!analysis) return null;
  if (analysis.program) {
    const explanation = explainCAt(analysis, offset, level);
    if (explanation) return explanation;
  }
  if (analysis.pseudo) {
    return explainPseudoAt(analysis, offset, level);
  }
  const structure = findStructureAtOffset(analysis.tree, offset);
  return structure ? explainStructureNode(analysis, structure, level) : null;
}

/** 根据节点 id（AST 节点或结构树节点）生成完整释义 */
export function explainByNodeId(analysis: AnalysisResult, nodeId: string | undefined, level: ExplainLevel): Explanation | null {
  if (!analysis || !nodeId) return null;
  if (analysis.program) {
    const explanation = explainCNodeById(analysis, nodeId, level);
    if (explanation) return explanation;
  }
  const structure = findStructureByAnyId(analysis, nodeId);
  if (analysis.pseudo && structure?.range) {
    const pseudoExplanation = explainPseudoAt(analysis, structure.range.start, level);
    if (pseudoExplanation) return pseudoExplanation;
  }
  return structure ? explainStructureNode(analysis, structure, level) : null;
}

/** 结构树节点点击：优先使用关联 AST 节点 id，否则使用结构树自身 id */
export function explainStructure(analysis: AnalysisResult, node: StructureNode, level: ExplainLevel): Explanation | null {
  if (!analysis) return null;
  // 伪代码：结构树节点对应伪代码语句，使用「原文 / 推断 / 生成代码」对照释义
  if (analysis.pseudo) {
    const pseudoExplanation = node.range ? explainPseudoAt(analysis, node.range.start, level) : null;
    if (pseudoExplanation) return pseudoExplanation;
  }
  if (analysis.program && node.nodeId) {
    const explanation = explainCNodeById(analysis, node.nodeId, level);
    if (explanation) return explanation;
  }
  return explainStructureNode(analysis, node, level);
}

/** 悬停提示 */
export function hoverAt(analysis: AnalysisResult, offset: number): HoverInfo | null {
  if (!analysis) return null;
  if (analysis.program) return hoverCAt(analysis, offset);
  return hoverStructureAt(analysis, offset);
}
