/**
 * 代码释义的类型契约
 * ------------------------------------------------------------------
 * 右侧释义面板消费 Explanation 结构。三种解释深度通过 ExplainLevel 控制：
 * - beginner：避免术语，多用生活化类比；
 * - intermediate：讲解语法规则、执行流程与代码关系；
 * - advanced：补充内存、指针、底层运行原理。
 */
import type { SemanticCategory, SymbolInfo } from '../analysisTypes';
import type { SourceRange } from '../source';

export type ExplainLevel = 'beginner' | 'intermediate' | 'advanced';

export const EXPLAIN_LEVEL_LABELS: Record<ExplainLevel, string> = {
  beginner: '初级',
  intermediate: '中级',
  advanced: '高级',
};

/** 代码组成拆解的一部分 */
export interface ExplainPart {
  /** 片段原文 */
  text: string;
  /** 该片段在代码中的角色，如「数据类型」「指针声明符」「变量名」 */
  role: string;
  /** 对应的语义颜色类别（可选，用于展示色块） */
  category?: SemanticCategory;
  /** 进一步说明 */
  detail?: string;
}

export interface ExplainRelationItem {
  label: string;
  line?: number;
  range?: SourceRange;
  role?: string;
}

export interface ExplainRelationGroup {
  title: string;
  items: ExplainRelationItem[];
}

/** 完整的代码释义 */
export interface Explanation {
  /** 当前代码片段的类型，如「指针变量声明」 */
  title: string;
  /** 代码类别标签，如「变量声明」 */
  codeType: string;
  /** 当前代码片段 */
  snippet: string;
  range?: SourceRange;
  nodeId?: string;
  /** 组成拆解 */
  composition: ExplainPart[];
  /** 整体释义 */
  meaning: string;
  /** 实际用途 */
  purpose: string;
  /** 为什么需要这一部分 */
  why: string;
  /** 与其他代码的关联 */
  relations: ExplainRelationGroup[];
  /** 初学者容易产生的误解 / 学习重点 */
  pitfalls: string[];
  /** 生活化类比 */
  analogy: string;
  /** 高级模式附加的底层解释（内存 / 指针 / 调用栈等） */
  advanced?: string;
  /** 当前解释深度 */
  level: ExplainLevel;
  /** 标签，用于 UI 徽标 */
  tags: string[];
  /** 相关符号（若当前片段关联到具体变量/函数等） */
  symbol?: SymbolInfo;
  /** 伪代码专用：原文 / 推断 / 生成代码三方对照 */
  comparisons?: { original: string; inferred: string; generated?: string; confidence?: string }[];
  /** 能力限制提示（如 JS/Python 暂不支持执行） */
  limitations?: string[];
}

export interface HoverInfo {
  title: string;
  badge?: string;
  summary: string;
  /** 简短提示，如「点击查看完整释义」 */
  hint: string;
  symbolKind?: string;
  category?: SemanticCategory;
}
