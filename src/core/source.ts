/**
 * 源码位置工具
 * ------------------------------------------------------------------
 * CodeLens 的所有分析结果（AST、语义 token、符号、结构树、执行步骤）
 * 都使用「基于字符偏移量」的位置信息，再按需换算成行号/列号。
 * 这样同一套位置模型可以同时服务于 Monaco 编辑器和结构化数据。
 */

/** 源码区间，start/end 为 0-based 字符偏移，行列为 1-based，便于直接展示 */
export interface SourceRange {
  start: number;
  end: number;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface SourcePosition {
  line: number;
  column: number;
}

/**
 * 带行索引的源码对象。
 * 行首偏移预先计算，`positionAt` 使用二分查找，避免每次换算都扫描全文。
 */
export class SourceFile {
  readonly text: string;
  /** 每一行第一个字符在全文中的偏移量（0-based） */
  readonly lineStarts: number[];

  constructor(text: string) {
    // 统一换行符，保证偏移计算简单可靠
    this.text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const starts = [0];
    for (let i = 0; i < this.text.length; i++) {
      if (this.text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    this.lineStarts = starts;
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  /** 获取 1-based 行号的整行文本（不含换行符） */
  lineText(line: number): string {
    const index = Math.min(Math.max(line, 1), this.lineCount) - 1;
    const start = this.lineStarts[index];
    const nextStart = index + 1 < this.lineStarts.length ? this.lineStarts[index + 1] : this.text.length;
    return this.text.slice(start, nextStart).replace(/\n$/, '');
  }

  /** 全部行文本 */
  lines(): string[] {
    return this.lineStarts.map((_, i) => this.lineText(i + 1));
  }

  /** 字符偏移 → 1-based 行列 */
  positionAt(offset: number): SourcePosition {
    const clamped = Math.min(Math.max(offset, 0), this.text.length);
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (this.lineStarts[mid] <= clamped) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: clamped - this.lineStarts[low] + 1 };
  }

  /** 1-based 行列 → 字符偏移 */
  offsetAt(line: number, column: number): number {
    const lineIndex = Math.min(Math.max(line, 1), this.lineCount) - 1;
    const start = this.lineStarts[lineIndex];
    const nextStart = lineIndex + 1 < this.lineStarts.length ? this.lineStarts[lineIndex + 1] : this.text.length;
    return Math.min(start + Math.max(column - 1, 0), nextStart);
  }

  /** 构造源码区间 */
  range(start: number, end: number): SourceRange {
    const s = Math.min(Math.max(start, 0), this.text.length);
    const e = Math.min(Math.max(end, s), this.text.length);
    const sp = this.positionAt(s);
    const ep = this.positionAt(e);
    return {
      start: s,
      end: e,
      startLine: sp.line,
      startCol: sp.column,
      endLine: ep.line,
      endCol: ep.column,
    };
  }

  /** 取区间对应的源码文本 */
  slice(range: Pick<SourceRange, 'start' | 'end'> | SourceRange): string {
    return this.text.slice(range.start, range.end);
  }

  /** 取某一行的起始偏移 */
  lineStartOffset(line: number): number {
    const index = Math.min(Math.max(line, 1), this.lineCount) - 1;
    return this.lineStarts[index];
  }

  /** 取某一行的结束偏移（不含换行符） */
  lineEndOffset(line: number): number {
    return this.lineStartOffset(line) + this.lineText(line).length;
  }
}

/** 判断一个偏移是否落在区间内（右开区间） */
export function inRange(offset: number, range: SourceRange): boolean {
  return offset >= range.start && offset < range.end;
}

/** 判断两个区间是否相交 */
export function rangesOverlap(a: SourceRange, b: SourceRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/** 区间是否包含另一个区间 */
export function rangeContains(outer: SourceRange, inner: SourceRange): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

/** 两个区间的距离（用于 hover/光标位置选最近的节点） */
export function rangeDistance(offset: number, range: SourceRange): number {
  if (offset < range.start) return range.start - offset;
  if (offset > range.end) return offset - range.end;
  return 0;
}

/** 常用空区间 */
export const EMPTY_RANGE = (source: SourceFile): SourceRange => source.range(0, 0);
