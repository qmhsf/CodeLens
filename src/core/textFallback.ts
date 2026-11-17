/**
 * 未知语言 / 纯文本的兜底分析器
 * ------------------------------------------------------------------
 * 当源码无法识别为受支持的语言时，CodeLens 不直接报错，而是：
 * 1. 按行与缩进做有限的结构化分析（不是假装理解语义）；
 * 2. 明确提示支持能力有限；
 * 3. 提供基础文本高亮（数字/字符串/常见结构词），帮助阅读。
 */
import type { LanguageAnalysis, SemanticToken, StructureNode, SymbolInfo } from './analysisTypes';
import type { SourceFile } from './source';

interface TextLine {
  line: number;
  text: string;
  indent: number;
  range: { start: number; end: number };
}

/** 常见结构词：仅用于有限高亮，不代表真正的语法分析 */
const TEXT_KEYWORDS = [
  '如果',
  '否则',
  '循环',
  '重复',
  '当',
  '直到',
  '函数',
  '定义',
  '返回',
  '输入',
  '输出',
  '打印',
  '变量',
  '数组',
  '结构体',
  '指针',
  '如果',
  '否则',
  '函数',
  '循环',
  '返回',
  'if',
  'else',
  'for',
  'while',
  'return',
  'function',
  'def',
  'class',
  'import',
  'const',
  'let',
  'var',
  'print',
  'printf',
];

export function analyzePlainText(source: SourceFile): LanguageAnalysis {
  const lines = source.lines();
  const textLines: TextLine[] = lines
    .map((text, index) => ({ text, line: index + 1 }))
    .filter((item) => item.text.trim().length > 0)
    .map((item) => {
      const leading = item.text.match(/^[\t ]*/)?.[0] ?? '';
      const indent = leading.replace(/\t/g, '    ').length;
      const start = source.lineStartOffset(item.line);
      return {
        line: item.line,
        text: item.text,
        indent,
        range: { start, end: start + item.text.length },
      };
    });

  // 根据缩进构造简单的层级结构
  const roots: StructureNode[] = [];
  const stack: { indent: number; node: StructureNode }[] = [];
  for (const item of textLines) {
    const trimmed = item.text.trim();
    const node: StructureNode = {
      id: `text-line-${item.line}`,
      label: trimmed.length > 60 ? `${trimmed.slice(0, 59)}…` : trimmed,
      kind: 'text-line',
      secondary: `第 ${item.line} 行`,
      range: source.range(item.range.start, item.range.end),
      children: [],
    };
    while (stack.length && stack[stack.length - 1].indent >= item.indent) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else roots.push(node);
    stack.push({ indent: item.indent, node });
  }

  const tree: StructureNode[] = [
    {
      id: 'text-root',
      label: '文本结构（有限分析）',
      kind: 'program',
      secondary: `${textLines.length} 行非空文本`,
      range: source.range(0, source.text.length),
      children: roots,
      badges: ['未识别语言'],
    },
  ];

  const tokens = buildTextTokens(source);
  const symbols: Record<string, SymbolInfo> = {};

  return {
    language: 'plaintext',
    languageLabel: '纯文本 / 未知',
    supportLevel: 'limited',
    supportNotes: [
      '未能识别为 CodeLens 支持的语言，当前按结构化文本做有限分析：仅提取行与缩进层级。',
      '文本高亮仅基于常见结构词与字面量，不代表真实语法/语义解析。',
      '如这是代码，请在顶部语言选择器中手动切换为对应语言，以获得完整分析。',
      '不支持执行：纯文本没有可执行语义，CodeLens 不会伪造执行结果。',
    ],
    tree,
    tokens,
    symbols,
    issues: [
      {
        severity: 'info',
        message: '当前内容被识别为纯文本/未知语言，只提供有限的结构分析。',
        hint: '如果这是代码，请手动切换语言；如果这是中文伪代码，请选择「中文伪代码」。',
      },
    ],
    execution: {
      supported: false,
      reason: '纯文本 / 未知语言没有可靠的执行方式，CodeLens 不会伪造执行结果。',
    },
    capabilities: {
      semanticHighlight: true,
      structureTree: true,
      explanations: 'limited',
      crossReference: false,
      execution: false,
      realParser: false,
    },
    analyzer: 'text-structural',
  };
}

function buildTextTokens(source: SourceFile): SemanticToken[] {
  const tokens: SemanticToken[] = [];
  source.lines().forEach((line, index) => {
    const lineNumber = index + 1;
    const lineStart = source.lineStartOffset(lineNumber);
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      tokens.push({ start: lineStart, end: lineStart + line.length, category: 'comment', subkind: 'text-comment' });
      return;
    }
    const candidates: { start: number; end: number; category: SemanticToken['category'] }[] = [];
    for (const keyword of TEXT_KEYWORDS) {
      let from = 0;
      while (from <= line.length) {
        const position = line.indexOf(keyword, from);
        if (position === -1) break;
        candidates.push({
          start: lineStart + position,
          end: lineStart + position + keyword.length,
          category: /^(如果|否则|循环|重复|当|直到|返回|if|else|for|while|return)$/.test(keyword)
            ? 'control'
            : /^(函数|输出|打印|输入|printf|print|function|def|class|import|const|let|var)$/.test(keyword)
              ? 'function'
              : 'data',
        });
        from = position + keyword.length;
      }
    }
    for (const match of line.matchAll(/\d+(?:\.\d+)?/g)) {
      if (match.index !== undefined) {
        candidates.push({ start: lineStart + match.index, end: lineStart + match.index + match[0].length, category: 'data' });
      }
    }
    for (const match of line.matchAll(/"([^"\\]|\\.)*"/g)) {
      if (match.index !== undefined) {
        candidates.push({ start: lineStart + match.index, end: lineStart + match.index + match[0].length, category: 'data' });
      }
    }
    candidates.sort((a, b) => a.start - b.start || b.end - a.end);
    let lastEnd = -1;
    for (const candidate of candidates) {
      if (candidate.start < lastEnd) continue;
      tokens.push({ ...candidate, subkind: 'text-token' });
      lastEnd = candidate.end;
    }
  });
  return tokens;
}
