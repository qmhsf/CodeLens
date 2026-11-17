/**
 * JavaScript / TypeScript / Python 结构分析器测试
 * ------------------------------------------------------------------
 * 覆盖：关键词法分类、作用域符号、调用与成员关联、中文结构树、
 * 语法错误恢复、缩进错误、空输入、执行能力声明等。
 * 测试只依赖公开的 analyzeJavaScript / analyzePython 与共享类型。
 */
import { describe, expect, it } from 'vitest';
import { SourceFile } from '../src/core/source';
import { flattenStructure } from '../src/core/analysisTypes';
import type { LanguageAnalysis, SemanticCategory, StructureNode, SymbolInfo, SymbolKind } from '../src/core/analysisTypes';
import { analyzeJavaScript, analyzePython } from '../src/core/languages';

// ------------------------------------------------------------------
// 测试辅助
// ------------------------------------------------------------------

function js(code: string, language: 'javascript' | 'typescript' = 'javascript'): LanguageAnalysis {
  return analyzeJavaScript(new SourceFile(code), language);
}

function py(code: string): LanguageAnalysis {
  return analyzePython(new SourceFile(code));
}

/** 找到源码中第 occurrence 次出现的独立单词的语义分类 */
function categoryAtWord(result: LanguageAnalysis, text: string, word: string, occurrence = 0): SemanticCategory | undefined {
  const positions: number[] = [];
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    positions.push(match.index);
  }
  const position = positions[occurrence];
  if (position === undefined) return undefined;
  return result.tokens.find((token) => token.start === position && token.end === position + word.length)?.category;
}

/** 按精确文本查找 token（用于字符串/数字字面量） */
function categoryAtLiteral(result: LanguageAnalysis, text: string, literal: string): SemanticCategory | undefined {
  const position = text.indexOf(literal);
  if (position < 0) return undefined;
  return result.tokens.find((token) => token.start === position && token.end === position + literal.length)?.category;
}

function treeLabels(result: LanguageAnalysis): string[] {
  return flattenStructure(result.tree).map((node) => node.label);
}

function treeKinds(result: LanguageAnalysis): string[] {
  return flattenStructure(result.tree).map((node) => node.kind);
}

function findTreeNodes(result: LanguageAnalysis, predicate: (node: StructureNode) => boolean): StructureNode[] {
  return flattenStructure(result.tree).filter(predicate);
}

function symbolList(result: LanguageAnalysis): SymbolInfo[] {
  return Object.values(result.symbols);
}

function findSymbol(
  result: LanguageAnalysis,
  name: string,
  kind?: SymbolKind,
): SymbolInfo | undefined {
  return symbolList(result).find((symbol) => symbol.name === name && (kind ? symbol.kind === kind : true));
}

function occurrenceRoles(symbol: SymbolInfo | undefined): string[] {
  return symbol ? symbol.occurrences.map((occurrence) => occurrence.role) : [];
}

// ------------------------------------------------------------------
// JavaScript / TypeScript
// ------------------------------------------------------------------

describe('JavaScript / TypeScript 分析器', () => {
  it('使用 babel-parser 并声明结构级能力边界', () => {
    const result = js('const answer = 42;');
    expect(result.language).toBe('javascript');
    expect(result.languageLabel).toBe('JavaScript');
    expect(result.analyzer).toBe('babel-parser');
    expect(result.supportLevel).toBe('structural');
    expect(result.capabilities.realParser).toBe(true);
    expect(result.capabilities.semanticHighlight).toBe(true);
    expect(result.capabilities.structureTree).toBe(true);
    expect(result.capabilities.crossReference).toBe(true);
    expect(result.capabilities.explanations).toBe('basic');
    expect(result.capabilities.execution).toBe(false);
    expect(result.tree[0]?.label).toBe('程序');
  });

  it('关键字按控制 / 函数 / 类型 / 数据分类', () => {
    const code = [
      'const value = 1;',
      'let total = 0;',
      'function compute() {',
      '  if (value > 0) { return value; }',
      '  for (let i = 0; i < 3; i += 1) { total += i; }',
      '}',
      'class Counter {}',
      'const instance = new Counter();',
    ].join('\n');
    const result = js(code);
    expect(categoryAtWord(result, code, 'const')).toBe('data');
    expect(categoryAtWord(result, code, 'let')).toBe('data');
    expect(categoryAtWord(result, code, 'function')).toBe('function');
    expect(categoryAtWord(result, code, 'if')).toBe('control');
    expect(categoryAtWord(result, code, 'for')).toBe('control');
    expect(categoryAtWord(result, code, 'return')).toBe('control');
    expect(categoryAtWord(result, code, 'class')).toBe('type');
    expect(categoryAtWord(result, code, 'new')).toBe('type');
  });

  it('字符串 / 数字 / 布尔 / null 归为 data', () => {
    const code = 'const a = "hi";\nconst b = 42;\nconst c = true;\nconst d = null;';
    const result = js(code);
    expect(categoryAtLiteral(result, code, '"hi"')).toBe('data');
    expect(categoryAtLiteral(result, code, '42')).toBe('data');
    expect(categoryAtWord(result, code, 'true')).toBe('data');
    expect(categoryAtWord(result, code, 'null')).toBe('data');
  });

  it('运算符与标点分类', () => {
    const code = 'let sum = (a + b) * 2;';
    const result = js(code);
    expect(categoryAtWord(result, code, '+')).toBe('operator');
    expect(categoryAtWord(result, code, '*')).toBe('operator');
    expect(categoryAtWord(result, code, '=')).toBe('operator');
    expect(categoryAtLiteral(result, code, ';')).toBe('punctuation');
    expect(categoryAtLiteral(result, code, '(')).toBe('punctuation');
  });

  it('行注释与块注释都归为 comment', () => {
    const code = '// 行注释\n/* 块注释 */\nconst value = 1;';
    const result = js(code);
    const comments = result.tokens.filter((token) => token.category === 'comment');
    expect(comments.length).toBe(2);
    expect(comments[0]?.start).toBe(0);
  });

  it('变量符号包含声明与引用 occurrence，行列正确', () => {
    const code = 'const count = 1;\ncount = count + 1;';
    const result = js(code);
    const symbol = findSymbol(result, 'count', 'variable');
    expect(symbol).toBeDefined();
    expect(symbol?.declaration?.line).toBe(1);
    expect(occurrenceRoles(symbol)).toContain('declaration');
    expect(occurrenceRoles(symbol)).toContain('reference');
    const references = symbol?.occurrences.filter((occurrence) => occurrence.role === 'reference') ?? [];
    expect(references.length).toBeGreaterThanOrEqual(2);
    expect(references[0]?.line).toBe(2);
    expect(references[0]?.range.startCol).toBe(1);
  });

  it('函数符号包含 call occurrence，参数符号独立存在', () => {
    const code = 'function greet(name) {\n  return name;\n}\ngreet("Ada");';
    const result = js(code);
    const fn = findSymbol(result, 'greet', 'function');
    const param = findSymbol(result, 'name', 'parameter');
    expect(fn).toBeDefined();
    expect(param).toBeDefined();
    expect(occurrenceRoles(fn)).toContain('declaration');
    expect(occurrenceRoles(fn)).toContain('call');
    expect(categoryAtWord(result, code, 'greet', 1)).toBe('function');
    expect(categoryAtWord(result, code, 'name', 1)).toBe('data');
  });

  it('TypeScript 接口 / 类型别名 / 类与类型引用', () => {
    const code = [
      'interface Person { name: string; }',
      'type ID = string | number;',
      'class User implements Person { name: string = ""; }',
      'const id: ID = "u1";',
    ].join('\n');
    const result = js(code, 'typescript');
    const person = findSymbol(result, 'Person', 'typedef');
    const idAlias = findSymbol(result, 'ID', 'typedef');
    const user = findSymbol(result, 'User', 'class');
    expect(person?.detail).toBe('接口');
    expect(idAlias?.detail).toBe('类型别名');
    expect(user?.kind).toBe('class');
    // TS 类型关键字与类型引用应归为 type
    expect(categoryAtWord(result, code, 'string')).toBe('type');
    expect(categoryAtWord(result, code, 'ID', 1)).toBe('type');
    expect(occurrenceRoles(idAlias)).toContain('type');
  });

  it('类字段通过 this / 实例访问产生 member occurrence', () => {
    const code = [
      'class Person {',
      '  name: string;',
      '  greet() {',
      '    return this.name;',
      '  }',
      '}',
      'const p = new Person();',
      'p.name;',
    ].join('\n');
    const result = js(code, 'typescript');
    const field = findSymbol(result, 'name', 'field');
    const method = findSymbol(result, 'greet', 'function');
    expect(field).toBeDefined();
    expect(method).toBeDefined();
    const memberRoles = occurrenceRoles(field).filter((role) => role === 'member');
    expect(memberRoles.length).toBeGreaterThanOrEqual(2);
    expect(categoryAtWord(result, code, 'name', 1)).toBe('data');
  });

  it('结构树使用中文标签并保留 range 与 nodeId', () => {
    const code = [
      'import { readFile } from "fs";',
      'const data = readFile("a.txt");',
      'function load(path) {',
      '  if (path) {',
      '    for (let i = 0; i < 2; i++) {',
      '      return path;',
      '    }',
      '  }',
      '  return data;',
      '}',
      'load("x");',
    ].join('\n');
    const result = js(code);
    const labels = treeLabels(result);
    for (const label of ['程序', '导入', '变量声明', '函数定义', '参数', '条件判断', '循环', '返回', '函数调用']) {
      expect(labels).toContain(label);
    }
    expect(labels.filter((label) => label === '参数').length).toBe(1);
    const nodes = flattenStructure(result.tree);
    for (const node of nodes) {
      expect(node.range).toBeDefined();
      expect(node.range?.start).toBeGreaterThanOrEqual(0);
      expect(node.range?.end).toBeLessThanOrEqual(code.length);
    }
    const functionNode = nodes.find((node) => node.label === '函数定义');
    expect(functionNode?.nodeId).toBeTruthy();
    expect(functionNode?.range?.start).toBe(code.indexOf('function'));
  });

  it('嵌套函数调用在结构树中形成父子关系', () => {
    const code = 'function outer() { return add(multiply(1, 2)); }';
    const result = js(code);
    const calls = findTreeNodes(result, (node) => node.kind === 'call');
    expect(calls.length).toBe(2);
    const outerCall = calls.find((node) => node.secondary?.includes('add'));
    expect(outerCall?.children.some((child) => child.secondary?.includes('multiply'))).toBe(true);
  });

  it('语法错误通过 issues 报告，并尽量恢复结构树', () => {
    const code = 'const ok = 1;\nlet broken = ;\nconsole.log(ok);';
    const result = js(code);
    const errors = result.issues.filter((issue) => issue.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((issue) => issue.line === 2)).toBe(true);
    expect(result.tree.length).toBeGreaterThan(0);
    const labels = treeLabels(result);
    expect(labels).toContain('变量声明');
    // 合法部分仍然可以被分析
    expect(findSymbol(result, 'ok', 'variable')).toBeDefined();
    expect(categoryAtWord(result, code, 'console')).toBe('data');
    expect(categoryAtWord(result, code, 'log')).toBe('function');
  });

  it('未解析的引用不报错，按 reference 标记', () => {
    const code = 'missingFunction();\nunknownVariable;';
    const result = js(code);
    expect(result.issues.length).toBe(0);
    expect(findSymbol(result, 'missingFunction')).toBeUndefined();
    expect(categoryAtWord(result, code, 'missingFunction')).toBe('function');
    expect(categoryAtWord(result, code, 'unknownVariable')).toBe('data');
  });

  it('作用域内的局部变量不会泄漏到全局作用域', () => {
    const code = 'function f() {\n  let inner = 1;\n  return inner;\n}\ninner;';
    const result = js(code);
    const inner = findSymbol(result, 'inner', 'variable');
    expect(inner).toBeDefined();
    expect(inner?.scopeName).toContain('函数');
    // 函数内部的引用能解析，函数外无法解析但不会报错
    expect(occurrenceRoles(inner)).toContain('reference');
    expect(result.issues.length).toBe(0);
  });

  it('导入与导出在结构树中体现', () => {
    const code = 'import { readFile } from "fs";\nexport function load(path) {\n  return readFile(path);\n}';
    const result = js(code);
    expect(treeLabels(result)).toContain('导入');
    const fn = findSymbol(result, 'load', 'function');
    expect(fn).toBeDefined();
    const importSymbol = findSymbol(result, 'readFile', 'unknown');
    expect(importSymbol?.kind).toBe('unknown');
    expect(occurrenceRoles(importSymbol)).toContain('call');
    const functionNode = findTreeNodes(result, (node) => node.kind === 'function')[0];
    expect(functionNode?.badges).toContain('导出');
  });

  it('TypeScript 接口结构树包含接口定义与字段', () => {
    const code = 'interface Person {\n  name: string;\n  age?: number;\n}';
    const result = js(code, 'typescript');
    const labels = treeLabels(result);
    expect(labels).toContain('接口定义');
    expect(labels.filter((label) => label.startsWith('字段 ')).length).toBe(2);
  });

  it('空输入的 JavaScript 分析结果安全', () => {
    const result = js('');
    expect(result.tree).toHaveLength(1);
    expect(result.tree[0]?.label).toBe('程序');
    expect(result.tree[0]?.children).toHaveLength(0);
    expect(result.tokens).toHaveLength(0);
    expect(Object.keys(result.symbols)).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
  });

  it('JavaScript / TypeScript 明确声明不支持执行', () => {
    const jsResult = js('const x = 1;');
    const tsResult = js('const x: number = 1;', 'typescript');
    for (const result of [jsResult, tsResult]) {
      expect(result.execution.supported).toBe(false);
      expect(result.execution.reason).toContain('执行引擎');
      expect(result.execution.reason).toContain('不会伪造');
    }
    expect(tsResult.language).toBe('typescript');
    expect(tsResult.languageLabel).toBe('TypeScript');
    expect(tsResult.analyzer).toBe('babel-parser');
    expect(tsResult.supportNotes.some((note) => note.includes('结构级'))).toBe(true);
  });
});

// ------------------------------------------------------------------
// Python
// ------------------------------------------------------------------

describe('Python 分析器', () => {
  it('识别 def / 参数 / return 并生成中文结构树', () => {
    const code = 'def add(a, b):\n    return a + b\n';
    const result = py(code);
    const labels = treeLabels(result);
    expect(labels).toContain('函数定义');
    expect(labels.filter((label) => label === '参数').length).toBe(2);
    expect(labels).toContain('返回');
    const fn = findSymbol(result, 'add', 'function');
    expect(fn).toBeDefined();
    expect(findSymbol(result, 'a', 'parameter')).toBeDefined();
    expect(findSymbol(result, 'b', 'parameter')).toBeDefined();
    expect(categoryAtWord(result, code, 'def')).toBe('function');
    expect(categoryAtWord(result, code, 'return')).toBe('control');
    expect(categoryAtWord(result, code, 'a')).toBe('data');
    expect(categoryAtWord(result, code, '+')).toBe('operator');
  });

  it('函数调用产生 call occurrence，调用名归为 function', () => {
    const code = 'def add(a, b):\n    return a + b\n\nresult = add(1, 2)\n';
    const result = py(code);
    const fn = findSymbol(result, 'add', 'function');
    expect(occurrenceRoles(fn)).toContain('declaration');
    expect(occurrenceRoles(fn)).toContain('call');
    const callOccurrence = fn?.occurrences.find((occurrence) => occurrence.role === 'call');
    expect(callOccurrence?.line).toBe(4);
    expect(categoryAtWord(result, code, 'add', 1)).toBe('function');
    expect(categoryAtWord(result, code, 'result')).toBe('data');
    expect(treeLabels(result)).toContain('函数调用');
    expect(treeLabels(result)).toContain('赋值');
  });

  it('if / elif / else 形成嵌套分支结构', () => {
    const code = [
      'score = 85',
      'if score >= 90:',
      '    grade = "A"',
      'elif score >= 60:',
      '    grade = "B"',
      'else:',
      '    grade = "C"',
    ].join('\n');
    const result = py(code);
    const labels = treeLabels(result);
    expect(labels).toContain('条件判断');
    expect(labels).toContain('如果');
    expect(labels).toContain('否则如果');
    expect(labels).toContain('否则');
    expect(categoryAtWord(result, code, 'elif')).toBe('control');
    expect(findSymbol(result, 'grade', 'variable')).toBeDefined();
  });

  it('for / while 按缩进形成嵌套循环', () => {
    const code = [
      'for i in range(3):',
      '    if i > 1:',
      '        while i < 3:',
      '            break',
    ].join('\n');
    const result = py(code);
    const kinds = treeKinds(result);
    expect(kinds).toContain('for');
    expect(kinds).toContain('while');
    expect(kinds).toContain('if');
    expect(treeLabels(result)).toContain('跳出循环');
    const forNode = findTreeNodes(result, (node) => node.kind === 'for')[0];
    expect(forNode?.children.length).toBeGreaterThan(0);
    expect(findSymbol(result, 'i', 'variable')).toBeDefined();
    expect(findSymbol(result, 'range')).toBeUndefined();
  });

  it('class 与 self 方法成员访问可解析到方法符号', () => {
    const code = [
      'class Person:',
      '    def greet(self):',
      '        return self.name',
      '',
      '    def intro(self):',
      '        return self.greet()',
    ].join('\n');
    const result = py(code);
    const person = findSymbol(result, 'Person', 'class');
    const greet = findSymbol(result, 'greet', 'function');
    expect(person).toBeDefined();
    expect(greet).toBeDefined();
    expect(occurrenceRoles(greet)).toContain('call');
    expect(categoryAtWord(result, code, 'Person')).toBe('type');
    expect(categoryAtWord(result, code, 'greet', 1)).toBe('function');
    const classNode = findTreeNodes(result, (node) => node.kind === 'class')[0];
    expect(classNode?.label).toBe('类定义');
  });

  it('注释、三引号字符串与文档字符串', () => {
    const code = [
      'def greet(name):',
      '    """返回问候语"""',
      '    return "Hello " + name',
      '',
      '# 这是一条注释',
      'greet("Ada")  # 调用',
    ].join('\n');
    const result = py(code);
    const comments = result.tokens.filter((token) => token.category === 'comment');
    expect(comments.length).toBe(2);
    const strings = result.tokens.filter((token) => token.category === 'data' && token.subkind === 'string');
    expect(strings.length).toBeGreaterThanOrEqual(3);
    const docstring = strings.find((token) => code.slice(token.start, token.end).includes('返回问候语'));
    expect(docstring).toBeDefined();
    expect((docstring?.end ?? 0) - (docstring?.start ?? 0)).toBeGreaterThan(8);
    expect(treeLabels(result)).toContain('文档字符串');
    expect(categoryAtWord(result, code, 'greet', 1)).toBe('function');
  });

  it('import / from 导入生成结构节点与符号', () => {
    const code = 'import math\nfrom pathlib import Path\n';
    const result = py(code);
    expect(treeLabels(result).filter((label) => label === '导入').length).toBe(2);
    expect(findSymbol(result, 'math')?.kind).toBe('unknown');
    expect(findSymbol(result, 'Path')?.kind).toBe('unknown');
    expect(categoryAtWord(result, code, 'math')).toBe('data');
    expect(categoryAtWord(result, code, 'Path')).toBe('data');
  });

  it('赋值、增强赋值与内置函数调用', () => {
    const code = 'count = 0\ncount += 1\nprint(count)\n';
    const result = py(code);
    const count = findSymbol(result, 'count', 'variable');
    expect(count).toBeDefined();
    expect(occurrenceRoles(count)).toContain('declaration');
    expect(occurrenceRoles(count).filter((role) => role === 'reference').length).toBeGreaterThanOrEqual(2);
    expect(categoryAtWord(result, code, 'print')).toBe('function');
    expect(categoryAtWord(result, code, 'count', 2)).toBe('data');
    expect(treeLabels(result).filter((label) => label === '赋值').length).toBe(2);
  });

  it('缩进不一致时报告 error issue', () => {
    const code = 'def f():\n    x = 1\n  y = 2\n';
    const result = py(code);
    const errors = result.issues.filter((issue) => issue.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((issue) => issue.message.includes('缩进'))).toBe(true);
    expect(errors.some((issue) => issue.line === 3)).toBe(true);
    expect(result.tree.length).toBeGreaterThan(0);
    expect(treeLabels(result)).toContain('函数定义');
  });

  it('缺少冒号会报告语法错误但仍解析函数体', () => {
    const code = 'def f()\n    return 1\n';
    const result = py(code);
    expect(result.issues.some((issue) => issue.severity === 'error' && issue.message.includes('冒号'))).toBe(true);
    expect(treeLabels(result)).toContain('函数定义');
    expect(treeLabels(result)).toContain('返回');
    expect(findSymbol(result, 'f', 'function')).toBeDefined();
  });

  it('Python 关键字 / 内置类型 / 布尔值分类正确', () => {
    const code = 'def f(x):\n    if x:\n        return True\n\nclass A:\n    pass\n';
    const result = py(code);
    expect(categoryAtWord(result, code, 'def')).toBe('function');
    expect(categoryAtWord(result, code, 'if')).toBe('control');
    expect(categoryAtWord(result, code, 'return')).toBe('control');
    expect(categoryAtWord(result, code, 'True')).toBe('data');
    expect(categoryAtWord(result, code, 'class')).toBe('type');
    expect(categoryAtWord(result, code, 'pass')).toBe('control');
    expect(categoryAtWord(result, code, 'x')).toBe('data');
  });

  it('Python 数字与字符串字面量归为 data', () => {
    const code = 'name = "Ada"\nage = 36\nratio = 0.5\n';
    const result = py(code);
    expect(categoryAtLiteral(result, code, '"Ada"')).toBe('data');
    expect(categoryAtLiteral(result, code, '36')).toBe('data');
    expect(categoryAtLiteral(result, code, '0.5')).toBe('data');
  });

  it('Python 函数作用域参数与局部变量互不污染', () => {
    const code = 'def f(a):\n    b = a + 1\n    return b\n\nf(2)\n';
    const result = py(code);
    const parameter = findSymbol(result, 'a', 'parameter');
    const local = findSymbol(result, 'b', 'variable');
    expect(parameter?.scopeName).toContain('函数');
    expect(local?.scopeName).toContain('函数');
    expect(occurrenceRoles(local)).toContain('reference');
    expect(findSymbol(result, 'a', 'variable')).toBeUndefined();
    expect(result.issues).toHaveLength(0);
  });

  it('空输入的 Python 分析结果安全', () => {
    const result = py('');
    expect(result.tree).toHaveLength(1);
    expect(result.tree[0]?.label).toBe('程序');
    expect(result.tokens).toHaveLength(0);
    expect(Object.keys(result.symbols)).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
  });

  it('Python 明确声明结构级能力且不支持执行', () => {
    const result = py('print("hi")\n');
    expect(result.language).toBe('python');
    expect(result.languageLabel).toBe('Python');
    expect(result.analyzer).toBe('python-structural');
    expect(result.supportLevel).toBe('structural');
    expect(result.capabilities.realParser).toBe(true);
    expect(result.capabilities.execution).toBe(false);
    expect(result.capabilities.explanations).toBe('basic');
    expect(result.execution.supported).toBe(false);
    expect(result.execution.reason).toContain('执行引擎');
    expect(result.execution.reason).toContain('不会伪造');
    expect(result.supportNotes.some((note) => note.includes('结构级'))).toBe(true);
  });

  it('结构树节点带有合法范围，根节点覆盖全文', () => {
    const code = 'x = 1\nif x:\n    print(x)\n';
    const result = py(code);
    const root = result.tree[0];
    expect(root?.range?.start).toBe(0);
    expect(root?.range?.end).toBe(code.length);
    for (const node of flattenStructure(result.tree)) {
      expect(node.range).toBeDefined();
      expect(node.range?.start).toBeGreaterThanOrEqual(0);
      expect(node.range?.end).toBeLessThanOrEqual(code.length);
    }
  });

  it('语法错误（括号未闭合）会报告并保留已解析结构', () => {
    const code = 'values = (1, 2\ndef f():\n    return 1\n';
    const result = py(code);
    expect(result.issues.some((issue) => issue.severity === 'error')).toBe(true);
    expect(result.tree.length).toBeGreaterThan(0);
    expect(flattenStructure(result.tree).length).toBeGreaterThan(1);
    expect(result.issues.some((issue) => issue.message.includes('未闭合'))).toBe(true);
  });
});
