/**
 * 编辑器语义装饰生成器
 * ------------------------------------------------------------------
 * 纯函数：把分析结果转换为 Monaco 可消费的装饰规格（不直接依赖 Monaco API）。
 * 内容包括：
 * 1. 语义 token 前景色（变量/类型/函数/运算/指针/注释等）；
 * 2. 指针变量、数组变量的下划线标记，帮助识别数据类别；
 * 3. 代码块/结构边界背景（按嵌套层级递减透明度）；
 * 4. 选中结构、关联符号的声明与使用高亮；
 * 5. 当前执行行高亮。
 * 颜色来自设置中的 ColorScheme，通过 CSS 变量注入，便于用户自定义。
 */
import { getChildren, type CNode, type ProgramNode } from '../core/ast';
import type { AnalysisResult } from '../core/analysisTypes';
import type { CategoryVisibility, ColorScheme } from '../core/semanticCatalog';
import { SourceFile, type SourceRange } from '../core/source';

export interface DecorationSpec {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  /** 作用于整行的背景类 */
  className?: string;
  /** 作用于文字/词语的内联类 */
  inlineClassName?: string;
  isWholeLine?: boolean;
  hoverMessage?: string;
}

export interface DecorationOptions {
  analysis: AnalysisResult;
  colors: ColorScheme;
  visibility: CategoryVisibility;
  selectedStructureRange?: SourceRange;
  highlightedSymbolId?: string | null;
  executionLine?: number | null;
  executionRange?: SourceRange | null;
  showBoundaries: boolean;
  showNestingDepth: boolean;
}

/** 构建全部装饰规格 */
export function buildDecorationSpecs(options: DecorationOptions): DecorationSpec[] {
  const { analysis, visibility, showBoundaries } = options;
  const source = new SourceFile(analysis.source);
  const specs: DecorationSpec[] = [];

  // ---- 1. 语义 token ----
  for (const token of analysis.tokens) {
    if (!visibility[token.category]) continue;
    const start = source.positionAt(token.start);
    const end = source.positionAt(token.end);
    const classes = ['cl-sem', `cl-cat-${token.category}`];
    if (token.subkind === 'pointer-variable' || token.subkind === 'pointer-member') classes.push('cl-underline-pointer');
    if (token.subkind === 'array-variable') classes.push('cl-underline-array');
    if (token.subkind === 'call') classes.push('cl-call');
    if (token.category === 'comment') classes.push('cl-comment');
    if (token.category === 'preprocessor') classes.push('cl-preprocessor');
    specs.push({
      startLine: start.line,
      startCol: start.column,
      endLine: end.line,
      endCol: end.column,
      inlineClassName: classes.join(' '),
    });
  }

  // ---- 2. 结构边界背景 ----
  if (showBoundaries && analysis.program) {
    collectBoundaries(analysis.program, source, options.showNestingDepth, specs);
  }

  // ---- 3. 关联符号高亮 ----
  if (options.highlightedSymbolId) {
    const symbol = analysis.symbols[options.highlightedSymbolId];
    if (symbol) {
      for (const occurrence of symbol.occurrences) {
        const start = source.positionAt(occurrence.range.start);
        const end = source.positionAt(occurrence.range.end);
        specs.push({
          startLine: start.line,
          startCol: start.column,
          endLine: end.line,
          endCol: end.column,
          className: occurrence.role === 'declaration' ? 'cl-symbol-declaration' : 'cl-symbol-occurrence',
        });
      }
    }
  }

  // ---- 4. 选中结构范围 ----
  if (options.selectedStructureRange) {
    const start = source.positionAt(options.selectedStructureRange.start);
    const end = source.positionAt(options.selectedStructureRange.end);
    specs.push({
      startLine: start.line,
      startCol: start.column,
      endLine: end.line,
      endCol: end.column,
      className: 'cl-selected-region',
    });
  }

  // ---- 5. 当前执行行 ----
  if (options.executionLine && options.executionLine > 0) {
    specs.push({
      startLine: options.executionLine,
      startCol: 1,
      endLine: options.executionLine,
      endCol: 1,
      className: 'cl-exec-line',
      isWholeLine: true,
    });
  }
  if (options.executionRange) {
    const start = source.positionAt(options.executionRange.start);
    const end = source.positionAt(options.executionRange.end);
    specs.push({
      startLine: start.line,
      startCol: start.column,
      endLine: end.line,
      endCol: end.column,
      inlineClassName: 'cl-exec-range',
    });
  }

  return specs;
}

/** 递归收集代码块背景（块嵌套层级由浅到深） */
function collectBoundaries(program: ProgramNode, source: SourceFile, showDepth: boolean, specs: DecorationSpec[]): void {
  let counter = 0;
  const visit = (node: CNode, blockDepth: number, parentKind?: string) => {
    if (node.kind === 'Block' && node.range.end - node.range.start > 2) {
      const innerStart = node.range.start + 1;
      const innerEnd = node.range.end - 1;
      if (innerEnd > innerStart) {
        const start = source.positionAt(innerStart);
        const end = source.positionAt(innerEnd);
        const kindClass = boundaryKindClass(parentKind);
        const depth = showDepth ? Math.min(blockDepth + 1, 4) : 1;
        counter += 1;
        specs.push({
          startLine: start.line,
          startCol: start.column,
          endLine: end.line,
          endCol: end.column,
          className: `cl-boundary ${kindClass} cl-depth-${depth}`,
        });
        void counter;
      }
      for (const child of getChildren(node)) visit(child, blockDepth + 1, node.kind);
      return;
    }
    for (const child of getChildren(node)) visit(child, blockDepth, node.kind);
  };
  visit(program, 0);
}

function boundaryKindClass(parentKind?: string): string {
  switch (parentKind) {
    case 'FuncDecl':
      return 'cl-boundary-function';
    case 'For':
    case 'While':
    case 'DoWhile':
    case 'Switch':
    case 'If':
      return 'cl-boundary-control';
    default:
      return 'cl-boundary-block';
  }
}

/** 将颜色方案转换为 CSS 变量（挂载在编辑器容器上，供装饰类使用） */
export function colorSchemeToCssVars(colors: ColorScheme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [category, color] of Object.entries(colors)) {
    vars[`--cl-color-${category}`] = color;
  }
  return vars;
}
