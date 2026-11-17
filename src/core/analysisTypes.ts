/**
 * 通用分析结果契约
 * ------------------------------------------------------------------
 * 不同语言（C / C++ / 中文伪代码 / JS / TS / Python）的分析结果
 * 统一收敛为这一套结构，UI 层只依赖本文件即可完成：
 * 语义高亮、结构树、符号关联、释义、执行面板渲染。
 */
import type { SourceRange } from './source';
import type { ProgramNode, CNodeIndex } from './ast';
import type { PseudoAnalysis } from './pseudo/types';

export type LanguageId = 'c' | 'cpp' | 'pseudo' | 'javascript' | 'typescript' | 'python' | 'plaintext';

export interface LanguageOption {
  id: LanguageId;
  label: string;
  shortLabel: string;
  /** 语言支持程度说明，展示在界面上，避免用户误解能力边界 */
  supportNote: string;
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { id: 'c', label: 'C 语言', shortLabel: 'C', supportNote: '完整支持：AST 解析、语义高亮、结构树、释义、逐行执行' },
  { id: 'cpp', label: 'C++（C 子集）', shortLabel: 'C++', supportNote: '按 C 子集解析；class / template / STL / new / delete 等 C++ 特性暂不支持' },
  { id: 'pseudo', label: '中文伪代码', shortLabel: '伪代码', supportNote: '结构化推断 + C 代码生成；推断结果会明确标注，不当作原文' },
  { id: 'javascript', label: 'JavaScript', shortLabel: 'JS', supportNote: 'AST 结构分析 + 语义高亮 + 基础释义；暂不支持执行' },
  { id: 'typescript', label: 'TypeScript', shortLabel: 'TS', supportNote: 'AST 结构分析 + 语义高亮 + 基础释义；暂不支持执行' },
  { id: 'python', label: 'Python', shortLabel: 'Python', supportNote: '缩进结构解析 + 语义高亮 + 基础释义；暂不支持执行' },
  { id: 'plaintext', label: '纯文本 / 未知', shortLabel: '文本', supportNote: '按结构化文本做有限分析，并会明确提示能力限制' },
];

/** 支持程度：full=深度分析，structural=结构级分析，limited=有限文本分析 */
export type SupportLevel = 'full' | 'structural' | 'limited';

/**
 * 语义高亮分类。
 * 与需求中的默认分类对应：类型=蓝、数据=绿、控制=紫、函数=橙、
 * 运算符=粉、指针内存=青、注释=灰；预处理与标点作为补充类别。
 */
export type SemanticCategory =
  | 'type'
  | 'data'
  | 'control'
  | 'function'
  | 'operator'
  | 'pointer'
  | 'comment'
  | 'preprocessor'
  | 'punctuation';

/** 语义 token（半开区间 [start, end)） */
export interface SemanticToken {
  start: number;
  end: number;
  category: SemanticCategory;
  /** 更细的子类：如变量名 / 函数名 / 指针变量 / 字面量 / 成员名 */
  subkind?: string;
  /** 关联的 AST 节点 */
  nodeId?: string;
  /** 关联的符号 */
  symbolId?: string;
}

export type SymbolKind =
  | 'variable'
  | 'parameter'
  | 'function'
  | 'struct'
  | 'typedef'
  | 'field'
  | 'enum'
  | 'class'
  | 'unknown';

export type OccurrenceRole = 'declaration' | 'reference' | 'call' | 'type' | 'member' | 'parameter';

export interface SymbolOccurrence {
  range: SourceRange;
  nodeId?: string;
  role: OccurrenceRole;
  line: number;
  /** 所在行的源码预览，用于关联面板展示 */
  snippet: string;
}

export interface SymbolInfo {
  id: string;
  name: string;
  kind: SymbolKind;
  /** 声明位置（函数、结构体等） */
  declaration?: {
    range: SourceRange;
    nodeId?: string;
    line: number;
    snippet: string;
  };
  occurrences: SymbolOccurrence[];
  /** 类型/签名文本，如 "LNode *"、"int(int, char **)" */
  typeText?: string;
  detail?: string;
  isPointer?: boolean;
  scopeName?: string;
}

/** 结构树节点：语言无关的统一结构表示 */
export interface StructureNode {
  id: string;
  /** 中文标签，如「条件判断 if」 */
  label: string;
  /** 结构类别，用于图标与颜色，如 if / for / function / variable / call */
  kind: string;
  /** 简短补充信息，如条件表达式文本 */
  secondary?: string;
  icon?: string;
  range?: SourceRange;
  /** 关联的原始 AST 节点 id */
  nodeId?: string;
  badges?: string[];
  children: StructureNode[];
}

export interface ParseIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  hint?: string;
  range?: SourceRange;
  line?: number;
}

/** 执行能力说明：不支持时必须给出明确原因，不伪造执行结果 */
export interface ExecutionSupport {
  supported: boolean;
  engine?: string;
  reason?: string;
  limitations?: string[];
}

export interface AnalysisStats {
  lines: number;
  tokens: number;
  symbols: number;
  structures: number;
  errors: number;
  warnings: number;
  parseMs: number;
}

export type ExplanationLevel = 'full' | 'basic' | 'limited';
export type InterpreterCapability = 'supported' | 'unsupported';

export interface LanguageCapabilities {
  semanticHighlight: boolean;
  structureTree: boolean;
  explanations: ExplanationLevel;
  crossReference: boolean;
  execution: boolean;
  /** 是否基于真实语法解析（而非纯文本启发式） */
  realParser: boolean;
}

/**
 * 各语言分析器统一返回的中间结果。
 * analyze.ts 会为它补上源码、统计信息等字段，包装成 AnalysisResult。
 */
export interface LanguageAnalysis {
  language: LanguageId;
  languageLabel: string;
  supportLevel: SupportLevel;
  supportNotes: string[];
  tree: StructureNode[];
  tokens: SemanticToken[];
  symbols: Record<string, SymbolInfo>;
  issues: ParseIssue[];
  execution: ExecutionSupport;
  capabilities: LanguageCapabilities;
  analyzer: AnalyzerKind;
  program?: ProgramNode;
  cIndex?: CNodeIndex;
  pseudo?: PseudoAnalysis;
}

export type AnalyzerKind = 'c-parser' | 'babel-parser' | 'python-structural' | 'pseudo-parser' | 'text-structural';

export interface AnalysisResult extends Omit<LanguageAnalysis, 'symbols'> {
  /** 每次分析生成的唯一 id，用于防止异步竞态 */
  id: string;
  /** 归一化后的源码 */
  source: string;
  lines: string[];
  /** 符号表：id → 符号（保留 record 形式便于快速查询） */
  symbols: Record<string, SymbolInfo>;
  symbolList: SymbolInfo[];
  stats: AnalysisStats;
}

/** 在结构树中查找包含指定偏移量的最深层结构节点 */
export function findStructureAt(nodes: StructureNode[], offset: number): StructureNode | undefined {
  let found: StructureNode | undefined;
  const visit = (list: StructureNode[]) => {
    for (const node of list) {
      if (!node.range) continue;
      if (offset < node.range.start || offset > node.range.end) continue;
      found = node;
      visit(node.children);
    }
  };
  visit(nodes);
  return found;
}

/** 将结构树展平，便于搜索与统计 */
export function flattenStructure(nodes: StructureNode[]): StructureNode[] {
  const result: StructureNode[] = [];
  const visit = (list: StructureNode[]) => {
    for (const node of list) {
      result.push(node);
      visit(node.children);
    }
  };
  visit(nodes);
  return result;
}

/** 根据 id 在结构树中查找节点 */
export function findStructureById(nodes: StructureNode[], id: string | undefined): StructureNode | undefined {
  if (!id) return undefined;
  return flattenStructure(nodes).find((node) => node.id === id);
}
