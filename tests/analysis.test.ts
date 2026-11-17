/**
 * 核心分析层测试
 * ------------------------------------------------------------------
 * 覆盖：语言识别、C 语义分类、符号关联、结构树、语义装饰、不同语言分析管线。
 * 这些测试保证 CodeLens 的"语义高亮/关联/结构树"确实来自 AST 而非正则猜测。
 */
import { describe, expect, it } from 'vitest';
import { SourceFile } from '../src/core/source';
import { parseC } from '../src/core/cParser';
import { buildIndex } from '../src/core/ast';
import { buildCSymbols } from '../src/core/symbols';
import { buildSemanticTokens } from '../src/core/semantic';
import { tokenizeC } from '../src/core/lexer';
import { buildCStructureTree } from '../src/core/structureTree';
import { analyzeCode, detectLanguage } from '../src/core/analyze';
import { buildDecorationSpecs, colorSchemeToCssVars } from '../src/editor/decorations';
import { DEFAULT_CATEGORY_VISIBILITY, DEFAULT_DARK_COLORS } from '../src/core/semanticCatalog';
import { SAMPLES } from '../src/services/samples';

const LINKED_LIST = SAMPLES.find((sample) => sample.id === 'c-linked-list')!.code;

/** 构建 C 分析上下文（语义、符号、结构树共享） */
function buildC(code: string) {
  const source = new SourceFile(code);
  const { program, issues } = parseC(source);
  const index = buildIndex(program);
  const symbols = buildCSymbols(program, index, source);
  const lex = tokenizeC(source);
  const tokens = buildSemanticTokens({ program, source, tokens: lex.tokens, comments: lex.comments, symbols });
  const tree = buildCStructureTree(program, index, source);
  return { source, program, issues, index, symbols, lex, tokens, tree };
}

function tokenText(source: SourceFile, token: { start: number; end: number }) {
  return source.text.slice(token.start, token.end);
}

describe('语言自动识别', () => {
  it('根据内容识别 C 语言', () => {
    const result = detectLanguage('#include <stdio.h>\nint main(void) { return 0; }');
    expect(result.language).toBe('c');
    expect(result.reason).toContain('include');
  });

  it('根据扩展名优先识别语言', () => {
    expect(detectLanguage('', 'demo.py').language).toBe('python');
    expect(detectLanguage('', 'demo.ts').language).toBe('typescript');
    expect(detectLanguage('console.log(1);', 'demo.js').language).toBe('javascript');
    expect(detectLanguage('int main(){}', 'legacy.h').language).toBe('c');
  });

  it('根据中文内容识别伪代码', () => {
    const result = detectLanguage('创建一个整数变量 a，赋值为 10。如果 a 大于 5，就输出 Hello。');
    expect(result.language).toBe('pseudo');
    expect(result.reason).toContain('中文');
  });

  it('识别 Python 与 TypeScript 特征', () => {
    expect(detectLanguage('def add(a, b):\n    return a + b\n').language).toBe('python');
    expect(detectLanguage('interface User { name: string }\nconst u: User = { name: "a" };').language).toBe('typescript');
  });

  it('无法识别时回退为纯文本而不是报错', () => {
    const result = detectLanguage('hello there, this is just some text without code syntax');
    expect(result.language).toBe('plaintext');
    expect(result.reason).toContain('未识别');
  });
});

describe('C 语义高亮分类（基于 AST + 符号表）', () => {
  it('能够区分类型、变量、控制结构、函数、运算符、指针、注释与预处理', () => {
    const { source, tokens } = buildC(LINKED_LIST);
    const categories = new Set(tokens.map((token) => token.category));
    for (const expected of ['type', 'data', 'control', 'function', 'operator', 'pointer', 'comment', 'preprocessor', 'punctuation']) {
      expect(categories.has(expected as never), `缺少语义类别：${expected}`).toBe(true);
    }
    const byCategory = (category: string) => tokens.filter((token) => token.category === category).map((token) => tokenText(source, token));
    expect(byCategory('control')).toEqual(expect.arrayContaining(['if', 'for', 'while', 'return']));
    expect(byCategory('function')).toEqual(expect.arrayContaining(['main', 'createNode', 'printf']));
    expect(byCategory('pointer')).toEqual(expect.arrayContaining(['*', '->']));
    expect(byCategory('type')).toEqual(expect.arrayContaining(['int', 'LNode', 'struct']));
    expect(byCategory('comment').some((text) => text.includes('链表节点'))).toBe(true);
    expect(byCategory('preprocessor').some((text) => text.includes('#include'))).toBe(true);
  });

  it('区分指针变量与数组变量并提供子类标记', () => {
    const code = 'int main() { int a[3]; int *p = a; LNode *q; return 0; }\n';
    const { tokens } = buildC(code);
    const arrayToken = tokens.find((token) => token.subkind === 'array-variable');
    const pointerTokens = tokens.filter((token) => token.subkind === 'pointer-variable');
    expect(arrayToken).toBeTruthy();
    expect(pointerTokens.length).toBeGreaterThanOrEqual(2);
  });

  it('函数调用与未声明的标准库调用都归为函数类别', () => {
    const code = 'int main() { printf("hi"); return 0; }\n';
    const { source, tokens } = buildC(code);
    const printfToken = tokens.find((token) => tokenText(source, token) === 'printf');
    expect(printfToken?.category).toBe('function');
    expect(printfToken?.subkind).toBe('call-unresolved');
  });

  it('注解指针成员访问：-> 为指针操作、成员名为数据', () => {
    const { source, tokens } = buildC('int main() { LNode *p; p->data = 1; return 0; }\n');
    const arrow = tokens.find((token) => tokenText(source, token) === '->');
    expect(arrow?.category).toBe('pointer');
    const dataToken = tokens.find((token) => tokenText(source, token) === 'data');
    expect(dataToken?.category).toBe('data');
  });

  it('字面量按类型细分（字符串/数字/字符）', () => {
    const code = 'int main() { char *s = "hi"; int n = 42; char c = \'a\'; return 0; }\n';
    const { tokens } = buildC(code);
    expect(tokens.some((token) => token.subkind === 'literal-string')).toBe(true);
    expect(tokens.some((token) => token.subkind === 'literal-int')).toBe(true);
    expect(tokens.some((token) => token.subkind === 'literal-char')).toBe(true);
  });
});

describe('符号表与关联定位', () => {
  it('同一变量的声明与使用归入同一符号', () => {
    const code = 'int main() { int x = 1; x = x + 2; return x; }\n';
    const { symbols } = buildC(code);
    const xSymbol = symbols.symbolList.find((symbol) => symbol.name === 'x');
    expect(xSymbol).toBeTruthy();
    expect(xSymbol!.kind).toBe('variable');
    expect(xSymbol!.occurrences.length).toBeGreaterThanOrEqual(4);
    expect(xSymbol!.occurrences.some((occurrence) => occurrence.role === 'declaration')).toBe(true);
    expect(xSymbol!.occurrences.filter((occurrence) => occurrence.role === 'reference').length).toBeGreaterThanOrEqual(3);
  });

  it('函数符号记录声明与调用位置', () => {
    const { symbols } = buildC(LINKED_LIST);
    const createNode = symbols.symbolList.find((symbol) => symbol.name === 'createNode');
    expect(createNode).toBeTruthy();
    expect(createNode!.kind).toBe('function');
    expect(createNode!.occurrences.some((occurrence) => occurrence.role === 'call')).toBe(true);
    expect(createNode!.occurrences.some((occurrence) => occurrence.role === 'declaration')).toBe(true);
  });

  it('结构体成员 next 能关联到声明与所有成员访问', () => {
    const { symbols } = buildC(LINKED_LIST);
    const nextSymbol = symbols.symbolList.find((symbol) => symbol.name === 'next' && symbol.kind === 'field');
    expect(nextSymbol).toBeTruthy();
    expect(nextSymbol!.occurrences.filter((occurrence) => occurrence.role === 'member').length).toBeGreaterThanOrEqual(3);
  });

  it('未声明的标识符明确归为 unknown，而不是伪造含义', () => {
    const { symbols } = buildC('int main() { printf("hi"); return 0; }\n');
    const printfSymbol = symbols.symbolList.find((symbol) => symbol.name === 'printf');
    expect(printfSymbol?.kind).toBe('unknown');
    expect(printfSymbol?.detail).toContain('未在本段代码');
  });

  it('指针类型推断支持 -> 成员解析', () => {
    const { symbols } = buildC(LINKED_LIST);
    const head = symbols.symbolList.find((symbol) => symbol.name === 'head');
    const type = head ? symbols.getSymbolType(head.id) : undefined;
    expect(type?.pointerDepth).toBe(1);
    expect(type?.name).toContain('LNode');
  });
});

describe('代码结构树', () => {
  it('识别程序、结构体、类型别名、函数、参数、循环、条件、变量等结构', () => {
    const { tree } = buildC(LINKED_LIST);
    const flat = JSON.stringify(tree);
    for (const label of ['程序', '结构体定义', '类型别名', '函数定义', '参数 value', 'for 循环', 'while 循环', '条件判断 if', '局部变量声明', '函数调用', '返回语句']) {
      expect(flat, `结构树缺少：${label}`).toContain(label);
    }
  });

  it('每个结构节点带有源码范围与父级关系', () => {
    const { tree, source } = buildC('int main() { int a = 1; if (a > 0) { a++; } return a; }\n');
    const flat: { label: string; range?: { start: number; end: number } }[] = [];
    const visit = (nodes: { label: string; range?: { start: number; end: number }; children: unknown[] }[]) => {
      for (const node of nodes) {
        flat.push(node);
        visit(node.children as never[]);
      }
    };
    visit(tree as never[]);
    expect(flat.length).toBeGreaterThan(5);
    for (const node of flat) {
      expect(node.range).toBeTruthy();
      expect(node.range!.start).toBeGreaterThanOrEqual(0);
      expect(node.range!.end).toBeLessThanOrEqual(source.text.length);
    }
  });
});

describe('语义装饰规格', () => {
  const analysis = analyzeCode(LINKED_LIST, { language: 'c' });

  it('为语义 token 生成内联颜色类', () => {
    const specs = buildDecorationSpecs({
      analysis,
      colors: DEFAULT_DARK_COLORS,
      visibility: DEFAULT_CATEGORY_VISIBILITY,
      showBoundaries: true,
      showNestingDepth: true,
    });
    expect(specs.length).toBeGreaterThan(50);
    expect(specs.some((spec) => spec.inlineClassName?.includes('cl-cat-type'))).toBe(true);
    expect(specs.some((spec) => spec.inlineClassName?.includes('cl-cat-control'))).toBe(true);
    expect(specs.some((spec) => spec.inlineClassName?.includes('cl-underline-pointer'))).toBe(true);
  });

  it('结构边界背景可开关', () => {
    const base = {
      analysis,
      colors: DEFAULT_DARK_COLORS,
      visibility: DEFAULT_CATEGORY_VISIBILITY,
      showNestingDepth: true,
    };
    const withBoundaries = buildDecorationSpecs({ ...base, showBoundaries: true });
    const withoutBoundaries = buildDecorationSpecs({ ...base, showBoundaries: false });
    expect(withBoundaries.some((spec) => spec.className?.includes('cl-boundary'))).toBe(true);
    expect(withoutBoundaries.some((spec) => spec.className?.includes('cl-boundary'))).toBe(false);
  });

  it('高亮关联符号、选中结构与执行行', () => {
    const mainSymbol = analysis.symbolList.find((symbol) => symbol.name === 'main')!;
    const specs = buildDecorationSpecs({
      analysis,
      colors: DEFAULT_DARK_COLORS,
      visibility: DEFAULT_CATEGORY_VISIBILITY,
      showBoundaries: false,
      showNestingDepth: false,
      highlightedSymbolId: mainSymbol.id,
      selectedStructureRange: analysis.tree[0].range,
      executionLine: 12,
      executionRange: { start: 0, end: 10, startLine: 12, startCol: 1, endLine: 12, endCol: 10 },
    });
    expect(specs.some((spec) => spec.className === 'cl-symbol-declaration')).toBe(true);
    expect(specs.some((spec) => spec.className === 'cl-selected-region')).toBe(true);
    expect(specs.some((spec) => spec.className === 'cl-exec-line' && spec.isWholeLine)).toBe(true);
  });

  it('关闭某类别后不再生成该类别 token 装饰', () => {
    const visibility = { ...DEFAULT_CATEGORY_VISIBILITY, comment: false };
    const specs = buildDecorationSpecs({
      analysis,
      colors: DEFAULT_DARK_COLORS,
      visibility,
      showBoundaries: false,
      showNestingDepth: false,
    });
    expect(specs.some((spec) => spec.inlineClassName?.includes('cl-cat-comment'))).toBe(false);
  });

  it('颜色方案可转换为 CSS 变量', () => {
    const vars = colorSchemeToCssVars(DEFAULT_DARK_COLORS);
    expect(vars['--cl-color-type']).toBe(DEFAULT_DARK_COLORS.type);
    expect(vars['--cl-color-pointer']).toBe(DEFAULT_DARK_COLORS.pointer);
  });
});

describe('统一分析管线', () => {
  it('C 分析返回完整能力与统计', () => {
    const analysis = analyzeCode('int main() { int a = 1; return a; }\n', { language: 'c' });
    expect(analysis.supportLevel).toBe('full');
    expect(analysis.capabilities.execution).toBe(true);
    expect(analysis.execution.supported).toBe(true);
    expect(analysis.program).toBeTruthy();
    expect(analysis.cIndex).toBeTruthy();
    expect(analysis.stats.lines).toBeGreaterThan(0);
    expect(analysis.stats.structures).toBeGreaterThan(0);
    expect(analysis.tokens.length).toBeGreaterThan(0);
    expect([...analysis.tokens].sort((a, b) => a.start - b.start)).toEqual(analysis.tokens);
  });

  it('空代码不会崩溃', () => {
    const analysis = analyzeCode('', { language: 'c' });
    expect(analysis.tokens).toEqual([]);
    expect(analysis.tree.length).toBeGreaterThan(0);
    expect(analysis.issues.some((issue) => issue.message.includes('还没有代码'))).toBe(true);
  });

  it('语法错误会明确报告 issue 而不是抛异常', () => {
    const analysis = analyzeCode('int main( { int x = ; }\n', { language: 'c' });
    expect(analysis.stats.errors).toBeGreaterThan(0);
    expect(analysis.issues.some((issue) => issue.severity === 'error')).toBe(true);
  });

  it('中文伪代码分析生成原文/推断/生成代码三部分', () => {
    const analysis = analyzeCode('创建一个整数变量 a，赋值为 10。\n如果 a 大于 5，就输出 Hello。\n否则输出 World。\n', { language: 'pseudo' });
    expect(analysis.language).toBe('pseudo');
    expect(analysis.pseudo).toBeTruthy();
    expect(analysis.pseudo!.generatedCode).toContain('int main');
    expect(analysis.pseudo!.lines.length).toBeGreaterThanOrEqual(3);
    expect(analysis.pseudo!.lines[0].original).toContain('创建一个整数变量');
    expect(analysis.pseudo!.statements.length).toBeGreaterThan(0);
    expect(analysis.tree[0].label).toContain('伪代码');
    expect(analysis.capabilities.execution).toBe(analysis.pseudo!.supportedExecutable);
  });

  it('JavaScript/TypeScript/Python 为结构级分析且明确不支持执行', () => {
    const js = analyzeCode('const list = [1, 2, 3];\nfunction sum(arr) { let total = 0; for (const x of arr) { total += x; } return total; }\n', { language: 'javascript' });
    expect(js.supportLevel).toBe('structural');
    expect(js.analyzer).toBe('babel-parser');
    expect(js.execution.supported).toBe(false);
    expect(js.execution.reason).toContain('执行');
    expect(js.tree.length).toBeGreaterThan(0);
    expect(js.symbolList.some((symbol) => symbol.name === 'sum')).toBe(true);

    const ts = analyzeCode('interface User { name: string; age: number }\nconst user: User = { name: "a", age: 1 };\n', { language: 'typescript' });
    expect(ts.supportLevel).toBe('structural');
    expect(ts.tokens.length).toBeGreaterThan(0);

    const python = analyzeCode('def add(a, b):\n    total = a + b\n    return total\n\nprint(add(1, 2))\n', { language: 'python' });
    expect(python.supportLevel).toBe('structural');
    expect(python.analyzer).toBe('python-structural');
    expect(python.tree.length).toBeGreaterThan(0);
    expect(python.execution.supported).toBe(false);
  });

  it('未知文本回退为有限分析而不是报错', () => {
    const analysis = analyzeCode('hello there, this is just some text', { language: 'plaintext' });
    expect(analysis.supportLevel).toBe('limited');
    expect(analysis.capabilities.realParser).toBe(false);
    expect(analysis.issues[0].severity).toBe('info');
    expect(analysis.tree[0].label).toContain('文本结构');
  });

  it('C++ 按 C 子集分析并声明能力边界', () => {
    const analysis = analyzeCode('#include <iostream>\nclass Demo { public: int x; };\nint main() { int a = 1; return a; }\n', { language: 'cpp' });
    expect(analysis.languageLabel).toContain('C++');
    expect(analysis.supportNotes.join(' ')).toContain('C++');
    expect(analysis.issues.some((issue) => issue.message.includes('class') || issue.message.includes('C++'))).toBe(true);
  });
});
