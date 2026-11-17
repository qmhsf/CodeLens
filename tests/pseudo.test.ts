/**
 * 中文伪代码分析器测试
 * ------------------------------------------------------------------
 * 覆盖：声明 / 赋值 / 条件 / 循环 / 函数 / 输入输出 / 中文标点 /
 * 未知行 / C 代码生成 / 行号映射 / 置信度 / 空输入 / 行对齐 等。
 */

import { describe, expect, it } from 'vitest';
import { SourceFile } from '../src/core/source';
import { analyzePseudo, generateCCode } from '../src/core/pseudo/index';
import type { PseudoAnalysis, PseudoStatement } from '../src/core/pseudo/types';

function analyze(text: string): PseudoAnalysis {
  return analyzePseudo(new SourceFile(text));
}

/** 递归展平语句树 */
function flattenStatements(statements: PseudoStatement[]): PseudoStatement[] {
  const result: PseudoStatement[] = [];
  const visit = (list: PseudoStatement[]) => {
    for (const statement of list) {
      result.push(statement);
      visit(statement.children);
    }
  };
  visit(statements);
  return result;
}

function generatedLines(analysis: PseudoAnalysis): string[] {
  return analysis.generatedCode.split('\n');
}

const REQUIREMENT_EXAMPLE =
  '创建一个整数变量 a，赋值为 10。\n如果 a 大于 5，就输出 Hello。\n否则输出 World。';

describe('基础结构', () => {
  it('空输入也能返回完整、可用的分析结构', () => {
    const analysis = analyze('');
    expect(analysis.lines).toHaveLength(1);
    expect(analysis.lines[0].kind).toBe('blank');
    expect(analysis.statements).toHaveLength(0);
    expect(analysis.confidence).toBe('high');
    expect(analysis.supportedExecutable).toBe(true);
    expect(analysis.generatedCode).toContain('#include <stdio.h>');
    expect(analysis.generatedCode).toContain('int main(void)');
    expect(analysis.originalText).toBe('');
  });

  it('lines 与源码行数一致，空行保留、原文不丢失', () => {
    const text = '创建一个整数变量 a，赋值为 1。\n\n输出 a\n';
    const source = new SourceFile(text);
    const analysis = analyzePseudo(source);
    expect(analysis.lines).toHaveLength(source.lineCount);
    expect(analysis.lines.map((line) => line.original)).toEqual(source.lines());
    expect(analysis.lines[1].kind).toBe('blank');
    expect(analysis.lines[3].kind).toBe('blank');
    expect(analysis.originalText).toBe(source.text);
    expect(analysis.lines[0].statementId).toBe(analysis.statements[0].id);
  });

  it('逐行结果的 inferredSummary 是系统推断，不是原文', () => {
    const analysis = analyze('创建一个整数变量 a，赋值为 10。');
    const line = analysis.lines[0];
    expect(line.inferredSummary).toBeTruthy();
    expect(line.inferredSummary).not.toBe(line.original);
    expect(line.confidence).toBe('high');
    expect(analysis.statements[0].original).toBe('创建一个整数变量 a，赋值为 10。');
  });
});

describe('变量声明与赋值', () => {
  it('识别「创建一个整数变量 a，赋值为 10」', () => {
    const analysis = analyze('创建一个整数变量 a，赋值为 10。');
    expect(analysis.statements).toHaveLength(1);
    const statement = analysis.statements[0];
    expect(statement.kind).toBe('declare');
    expect(statement.inference.declaredName).toBe('a');
    expect(statement.inference.declaredType).toBe('int');
    expect(statement.inference.declaredValue).toBe('10');
    expect(statement.confidence).toBe('high');
    expect(statement.inference.summary).toContain('声明变量');
    expect(analysis.generatedCode).toContain('int a = 10;');
  });

  it('常见中文类型映射为 C 类型', () => {
    const analysis = analyze(
      [
        '创建一个小数变量 x，赋值为 3.5。',
        '创建一个字符变量 c，赋值为 A。',
        '创建一个布尔变量 ok，赋值为 真。',
        '创建一个字符串变量 name，赋值为 Tom。',
      ].join('\n'),
    );
    const declarations = analysis.statements.filter((statement) => statement.kind === 'declare');
    expect(declarations.map((statement) => statement.inference.declaredType)).toEqual([
      'double',
      'char',
      'int',
      'char[]',
    ]);
    expect(analysis.generatedCode).toContain('double x = 3.5;');
    expect(analysis.generatedCode).toContain("char c = 'A';");
    expect(analysis.generatedCode).toContain('int ok = 1;');
    expect(analysis.generatedCode).toContain('char name[100] = "Tom";');
  });

  it('未显式声明类型时按初值推断，并降低置信度', () => {
    const analysis = analyze('令 a 等于 5。\n令 pi 为 3.14。');
    const declarations = analysis.statements.filter((statement) => statement.kind === 'declare');
    expect(declarations).toHaveLength(2);
    expect(declarations[0].inference.declaredType).toBe('int');
    expect(declarations[1].inference.declaredType).toBe('double');
    expect(declarations[0].confidence).toBe('medium');
    expect(declarations[0].notes.join('')).toContain('系统推断');
  });

  it('支持「把 a 设为」「a 增加」「a = a + 1」三种赋值写法', () => {
    const analysis = analyze(
      ['创建一个整数变量 a，赋值为 1。', '把 a 设为 5。', 'a 增加 2。', 'a = a + 1。'].join('\n'),
    );
    const assignments = analysis.statements.filter((statement) => statement.kind === 'assign');
    expect(assignments).toHaveLength(3);
    expect(assignments[0].inference.assignmentTarget).toBe('a');
    expect(assignments[1].inference.assignmentOperator).toBe('+=');
    expect(analysis.generatedCode).toContain('a = 5;');
    expect(analysis.generatedCode).toContain('a += 2;');
    expect(analysis.generatedCode).toContain('a = a + 1;');
  });
});

describe('条件判断', () => {
  it('识别需求示例：无缩进的「如果…，就输出…。」与紧随的「否则…」行', () => {
    const analysis = analyze(REQUIREMENT_EXAMPLE);
    expect(analysis.statements.map((statement) => statement.kind)).toEqual(['declare', 'if', 'else']);
    expect(analysis.statements[1].children[0].kind).toBe('print');
    expect(analysis.statements[2].children[0].kind).toBe('print');
    expect(analysis.lines.map((line) => line.kind)).toEqual(['declare', 'if', 'else']);
    expect(analysis.generatedCode).toContain('if (a > 5) {');
    expect(analysis.generatedCode).toContain('printf("Hello\\n");');
    expect(analysis.generatedCode).toContain('} else {');
    expect(analysis.generatedCode).toContain('printf("World\\n");');
    expect(analysis.supportedExecutable).toBe(true);
    expect(analysis.confidence).toBe('high');
  });

  it('支持缩进 if/else 块与「结束如果」标记', () => {
    const analysis = analyze(
      [
        '创建一个整数变量 a，赋值为 10。',
        '如果 a 大于 5：',
        '    输出 正数',
        '否则：',
        '    输出 非正数',
        '结束如果',
      ].join('\n'),
    );
    expect(analysis.statements.map((statement) => statement.kind)).toEqual(['declare', 'if', 'else']);
    expect(analysis.statements[1].children).toHaveLength(1);
    expect(analysis.statements[2].children).toHaveLength(1);
    expect(analysis.generatedCode).toContain('if (a > 5) {');
    expect(analysis.generatedCode).toContain('} else {');
    expect(analysis.generatedCode).not.toContain('else if');
    // 「结束如果」是结构标记，对应源码行的 kind 归到被闭合的条件块
    expect(analysis.lines[5].kind).toBe('if');
    expect(analysis.lines[5].statementId).toBe(analysis.statements[2].id);
  });

  it('支持「否则如果 / else if」链', () => {
    const analysis = analyze(
      [
        '创建一个整数变量 a，赋值为 0。',
        '如果 a 大于 0：',
        '    输出 正数',
        '否则如果 a 等于 0：',
        '    输出 零',
        '否则：',
        '    输出 负数',
        '结束如果',
      ].join('\n'),
    );
    expect(analysis.statements.map((statement) => statement.kind)).toEqual([
      'declare',
      'if',
      'elseif',
      'else',
    ]);
    expect(analysis.generatedCode).toContain('} else if (a == 0) {');
    expect(analysis.generatedCode).toContain('} else {');
    expect(analysis.lines[3].kind).toBe('elseif');
  });

  it('条件表达式支持大于/小于/等于/不等于/并且/或者/不是', () => {
    const analysis = analyze(
      [
        '创建一个整数变量 a，赋值为 5。',
        '创建一个整数变量 b，赋值为 6。',
        '如果 a 大于等于 5 并且 b 不等于 0，就输出 条件成立。',
        '如果 a 小于 3 或者 b 大于 10，就输出 另一个条件。',
        '如果 不是 a 等于 0，就输出 非零。',
      ].join('\n'),
    );
    expect(analysis.generatedCode).toContain('a >= 5 && b != 0');
    expect(analysis.generatedCode).toContain('a < 3 || b > 10');
    expect(analysis.generatedCode).toContain('!(a == 0)');
    expect(analysis.supportedExecutable).toBe(true);
  });

  it('条件引用未声明变量时降低置信度并给出说明', () => {
    const analysis = analyze('如果 count 大于 5，就输出 大。');
    const ifStatement = analysis.statements[0];
    expect(ifStatement.kind).toBe('if');
    expect(ifStatement.confidence).toBe('medium');
    expect(ifStatement.notes.join('')).toContain('未声明');
    expect(analysis.supportedExecutable).toBe(false);
  });
});

describe('循环', () => {
  it('支持「从…到…」的 for 循环（系统补全计数器并标注）', () => {
    const analysis = analyze(['从 1 到 5：', '    输出 i', '结束循环'].join('\n'));
    const loop = analysis.statements[0];
    expect(loop.kind).toBe('loop');
    expect(loop.inference.loopKind).toBe('for');
    expect(loop.inference.loopVariable).toBe('i');
    expect(loop.inference.loopFrom).toBe('1');
    expect(loop.inference.loopTo).toBe('5');
    expect(loop.confidence).toBe('medium');
    expect(analysis.generatedCode).toContain('for (int i = 1; i <= 5; i += 1) {');
    expect(analysis.generatedCode).toContain('printf("%d\\n", i);');
  });

  it('支持带变量和步长的 for 循环', () => {
    const analysis = analyze(
      ['循环变量 i 从 1 到 10 每次加 2：', '    输出 i', '结束循环'].join('\n'),
    );
    const loop = analysis.statements[0];
    expect(loop.inference.loopKind).toBe('for');
    expect(loop.inference.loopStep).toBe('2');
    expect(analysis.generatedCode).toContain('for (int i = 1; i <= 10; i += 2) {');
    expect(analysis.supportedExecutable).toBe(true);
  });

  it('支持「当…时」的 while 循环', () => {
    const analysis = analyze(
      [
        '创建整数变量 i，赋值为 0。',
        '当 i 小于 3 时：',
        '    输出 i',
        '    把 i 增加 1',
        '结束循环',
      ].join('\n'),
    );
    const loop = analysis.statements[1];
    expect(loop.inference.loopKind).toBe('while');
    expect(loop.inference.loopWhile).toBe('i < 3');
    expect(analysis.generatedCode).toContain('while (i < 3) {');
    expect(analysis.generatedCode).toContain('i += 1;');
  });

  it('支持「重复…直到…」的 do-while 循环', () => {
    const analysis = analyze(
      [
        '创建整数变量 i，赋值为 0。',
        '重复：',
        '    输出 i',
        '    把 i 增加 1',
        '直到 i 大于等于 3',
      ].join('\n'),
    );
    const loop = analysis.statements[1];
    expect(loop.inference.loopKind).toBe('dowhile');
    expect(loop.inference.loopWhile).toBe('i >= 3');
    expect(analysis.generatedCode).toContain('do {');
    expect(analysis.generatedCode).toContain('} while (!(i >= 3));');
    expect(analysis.lines[4].kind).toBe('loop');
  });

  it('「重复 N 次」按计数循环推断，置信度为 medium', () => {
    const analysis = analyze(['循环 3 次：', '    输出 你好', '结束循环'].join('\n'));
    const loop = analysis.statements[0];
    expect(loop.inference.loopKind).toBe('for');
    expect(loop.confidence).toBe('medium');
    expect(analysis.generatedCode).toContain('for (int i = 0; i <= 2; i += 1) {');
    expect(analysis.supportedExecutable).toBe(false);
  });

  it('循环体内的跳出循环 / 继续下一轮能被识别', () => {
    const analysis = analyze(
      [
        '创建整数变量 i，赋值为 0。',
        '当 i 小于 10 时：',
        '    如果 i 等于 5：',
        '        跳出循环',
        '    结束如果',
        '    如果 i 等于 3：',
        '        继续',
        '    结束如果',
        '    把 i 增加 1',
        '结束循环',
      ].join('\n'),
    );
    const loop = analysis.statements[1];
    expect(flattenStatements(loop.children).map((statement) => statement.kind)).toContain('break');
    expect(flattenStatements(loop.children).map((statement) => statement.kind)).toContain('continue');
    expect(analysis.generatedCode).toContain('break;');
    expect(analysis.generatedCode).toContain('continue;');
    expect(analysis.generatedCode).toContain('if (i == 5) {');
    expect(analysis.supportedExecutable).toBe(true);
  });
});

describe('函数、输入与输出', () => {
  it('识别函数定义、返回语句与函数调用', () => {
    const analysis = analyze(
      [
        '定义函数 add(整数 a, 整数 b)：',
        '    返回 a + b',
        '结束函数',
        '创建一个整数变量 result，赋值为 add(3, 4)。',
        '输出 result',
      ].join('\n'),
    );
    const fn = analysis.statements[0];
    expect(fn.kind).toBe('function');
    expect(fn.inference.functionName).toBe('add');
    expect(fn.inference.functionParams).toEqual([
      { name: 'a', type: 'int' },
      { name: 'b', type: 'int' },
    ]);
    expect(fn.inference.functionReturnType).toBe('int');
    expect(fn.children[0].kind).toBe('return');
    expect(analysis.generatedCode).toContain('int add(int a, int b) {');
    expect(analysis.generatedCode).toContain('return a + b;');
    expect(analysis.generatedCode).toContain('int result = add(3, 4);');
    expect(analysis.supportedExecutable).toBe(true);
  });

  it('识别独立的函数调用语句', () => {
    const analysis = analyze(
      ['定义函数 greet(整数 n)：', '    输出 你好', '结束函数', '调用 greet(5)'].join('\n'),
    );
    const call = analysis.statements.find((statement) => statement.kind === 'call');
    expect(call).toBeDefined();
    expect(call?.inference.callName).toBe('greet');
    expect(analysis.generatedCode).toContain('greet(5);');
  });

  it('输入语句生成 scanf，并禁止标记为可执行', () => {
    const analysis = analyze(
      ['创建整数变量 a，赋值为 0。', '输入 a', '输出 a'].join('\n'),
    );
    expect(analysis.statements.map((statement) => statement.kind)).toEqual([
      'declare',
      'input',
      'print',
    ]);
    expect(analysis.generatedCode).toContain('scanf("%d", &a);');
    expect(analysis.generatedCode).toContain('printf("%d\\n", a);');
    expect(analysis.supportedExecutable).toBe(false);
    expect(analysis.lines[1].kind).toBe('input');
  });

  it('给未声明变量赋值时降低置信度并提示可能无法编译', () => {
    const analysis = analyze('把 a 设为 5。');
    const assignment = analysis.statements[0];
    expect(assignment.kind).toBe('assign');
    expect(assignment.confidence).toBe('medium');
    expect(assignment.notes.join('')).toContain('没有找到变量声明');
    expect(analysis.warnings.join('\n')).toContain('未声明');
    expect(analysis.generatedCode).toContain('a = 5;');
    expect(analysis.supportedExecutable).toBe(false);
  });

  it('调用未定义函数时给出警告并保留调用', () => {
    const analysis = analyze('调用 foo(1)');
    const call = analysis.statements[0];
    expect(call.kind).toBe('call');
    expect(call.confidence).toBe('medium');
    expect(analysis.generatedCode).toContain('foo(1);');
    expect(analysis.generatedCode).toContain('未定义的函数');
    expect(analysis.supportedExecutable).toBe(false);
  });

  it('输出内容区分表达式与字符串字面量', () => {
    const analysis = analyze(
      [
        '创建整数变量 a，赋值为 7。',
        '输出 a',
        '输出 你好',
        '输出 "带引号的文字"',
        '输出 a * 2',
      ].join('\n'),
    );
    const prints = analysis.statements.filter((statement) => statement.kind === 'print');
    expect(prints).toHaveLength(4);
    expect(prints[0].inference.printIsExpression).toBe(true);
    expect(prints[1].inference.printIsExpression).toBe(false);
    expect(prints[1].inference.printExpression).toBe('你好');
    expect(prints[2].inference.printExpression).toBe('带引号的文字');
    expect(analysis.generatedCode).toContain('printf("%d\\n", a);');
    expect(analysis.generatedCode).toContain('printf("你好\\n");');
    expect(analysis.generatedCode).toContain('printf("带引号的文字\\n");');
    expect(analysis.generatedCode).toContain('printf("%d\\n", a * 2);');
  });
});

describe('容错与行结构', () => {
  it('无法识别的行标记为 unknown，保留为 C 注释并加入 warnings', () => {
    const analysis = analyze('创建一个整数变量 a，赋值为 1。\n今天天气不错。\n输出 a');
    const unknown = analysis.statements[1];
    expect(unknown.kind).toBe('unknown');
    expect(unknown.confidence).toBe('low');
    expect(analysis.lines[1].kind).toBe('unknown');
    expect(analysis.lines[1].original).toBe('今天天气不错。');
    expect(analysis.warnings.join('\n')).toContain('无法识别');
    expect(analysis.generatedCode).toContain('/* 未能理解:');
    expect(analysis.generatedCode).toContain('今天天气不错');
    expect(analysis.confidence).toBe('low');
    expect(analysis.supportedExecutable).toBe(false);
  });

  it('支持 # 与 // 注释行，注释不影响整体置信度', () => {
    const analysis = analyze(
      ['# 第一行注释', '创建一个整数变量 a，赋值为 1。', '// 第三行注释', '输出 a'].join('\n'),
    );
    expect(analysis.lines[0].kind).toBe('comment');
    expect(analysis.lines[2].kind).toBe('comment');
    expect(analysis.statements[0].kind).toBe('comment');
    expect(analysis.generatedCode).toContain('// 第一行注释');
    expect(analysis.generatedCode).toContain('// 第三行注释');
    expect(analysis.confidence).toBe('high');
    expect(analysis.supportedExecutable).toBe(true);
  });

  it('中文标点与英文标点得到相同的结构与生成代码', () => {
    const chinese = analyze('创建一个整数变量 a，赋值为 10。如果 a 大于 5，就输出 Hello。');
    const english = analyze('创建一个整数变量 a, 赋值为 10. 如果 a 大于 5, 就输出 Hello.');
    expect(chinese.statements.map((statement) => statement.kind)).toEqual(
      english.statements.map((statement) => statement.kind),
    );
    expect(chinese.generatedCode).toBe(english.generatedCode);
    expect(chinese.supportedExecutable).toBe(true);
  });

  it('CRLF 换行与空行不会破坏行对齐', () => {
    const text = '创建整数变量 a，赋值为 1。\r\n\r\n输出 a\r\n';
    const source = new SourceFile(text);
    const analysis = analyzePseudo(source);
    expect(analysis.lines).toHaveLength(source.lineCount);
    expect(analysis.lines.map((line) => line.original)).toEqual(source.lines());
    expect(analysis.lines[1].kind).toBe('blank');
  });

  it('多余的结束标记会给出明确提示，而不是静默忽略', () => {
    const analysis = analyze('结束如果');
    expect(analysis.statements[0].kind).toBe('unknown');
    expect(analysis.warnings.join('\n')).toContain('没有找到可闭合的块');
    expect(analysis.generatedCode).toContain('未能理解');
    expect(analysis.supportedExecutable).toBe(false);
  });

  it('行内注释会被记录到 notes，不会悄悄消失', () => {
    const analysis = analyze('创建一个整数变量 a，赋值为 1。 # 行内注释');
    expect(analysis.notes.join('\n')).toContain('行内注释');
    expect(analysis.generatedCode).toContain('int a = 1;');
  });
});

describe('C 代码生成与行号映射', () => {
  it('生成的 C 代码包含 include、main，且语句行号范围有效', () => {
    const analysis = analyze(
      [
        '创建一个整数变量 a，赋值为 1。',
        '如果 a 大于 0：',
        '    输出 a',
        '否则：',
        '    输出 0',
        '结束如果',
      ].join('\n'),
    );
    const lines = generatedLines(analysis);
    expect(analysis.generatedCode).toContain('#include <stdio.h>');
    expect(analysis.generatedCode).toContain('int main(void)');

    const allStatements = flattenStatements(analysis.statements);
    expect(allStatements.length).toBeGreaterThan(3);
    for (const statement of allStatements) {
      const start = statement.generatedStartLine;
      const end = statement.generatedEndLine;
      expect(start, `${statement.kind} 缺少 generatedStartLine`).toBeTypeOf('number');
      expect(end, `${statement.kind} 缺少 generatedEndLine`).toBeTypeOf('number');
      expect(start).toBeGreaterThanOrEqual(1);
      expect(end!).toBeGreaterThanOrEqual(start!);
      expect(end!).toBeLessThanOrEqual(lines.length);
    }

    const declaration = analysis.statements[0];
    expect(lines[(declaration.generatedStartLine ?? 1) - 1]).toContain('int a = 1;');
    const ifStatement = analysis.statements[1];
    expect(lines[(ifStatement.generatedStartLine ?? 1) - 1]).toContain('if (');
    const elseStatement = analysis.statements[2];
    expect(lines[(elseStatement.generatedStartLine ?? 1) - 1]).toContain('else');
  });

  it('每条语句都带结构化 summary、confidence 与 notes 数组', () => {
    const analysis = analyze(REQUIREMENT_EXAMPLE);
    for (const statement of flattenStatements(analysis.statements)) {
      expect(statement.inference.summary.length).toBeGreaterThan(0);
      expect(['high', 'medium', 'low']).toContain(statement.confidence);
      expect(Array.isArray(statement.notes)).toBe(true);
      expect(statement.original.length).toBeGreaterThan(0);
    }
  });

  it('生成代码的大括号配平，且没有把中文混入代码主体', () => {
    const analysis = analyze(
      [
        '创建一个整数变量 a，赋值为 10。',
        '如果 a 大于 5：',
        '    输出 大于',
        '否则：',
        '    输出 不大于',
        '结束如果',
      ].join('\n'),
    );
    const code = analysis.generatedCode;
    expect((code.match(/\{/g) ?? []).length).toBe((code.match(/\}/g) ?? []).length);
    // 去掉注释与字符串字面量后，代码主体不应再出现中文（中文只允许出现在字符串/注释里）
    const codeWithoutCommentsAndStrings = code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''");
    expect(codeWithoutCommentsAndStrings).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('整体置信度取非注释语句的最低值，并说明不可执行原因', () => {
    const analysis = analyze('从 1 到 5：\n    输出 i\n结束循环');
    expect(analysis.confidence).toBe('medium');
    expect(analysis.supportedExecutable).toBe(false);
    expect(analysis.notes.join('\n')).toContain('生成代码暂不标记为可执行');
  });

  it('notes / warnings 明确说明生成代码只是建议、不代表用户原文', () => {
    const analysis = analyze(REQUIREMENT_EXAMPLE);
    const notes = analysis.notes.join('\n');
    expect(notes).toContain('系统推断');
    expect(notes).toContain('用户原文');
    expect(notes).toContain('不代表用户原文');
  });

  it('可以直接从 statements 再次生成 C 代码', () => {
    const analysis = analyze(REQUIREMENT_EXAMPLE);
    const regenerated = generateCCode(analysis.statements);
    expect(regenerated.code).toContain('#include <stdio.h>');
    expect(regenerated.code).toContain('int main(void)');
    expect(regenerated.code).toContain('if (a > 5) {');
    expect(regenerated.warnings).toEqual([]);
  });

  it('支持无缩进、用结束标记的冒号块写法', () => {
    const analysis = analyze(
      ['如果 a 大于 5：', '输出 Hello', '结束如果'].join('\n'),
    );
    const ifStatement = analysis.statements[0];
    expect(ifStatement.kind).toBe('if');
    expect(ifStatement.children[0].kind).toBe('print');
    expect(analysis.lines[1].statementId).toBe(ifStatement.children[0].id);
    expect(analysis.generatedCode).toContain('printf("Hello\\n");');
  });

  it('嵌套 if/else 块按缩进正确归属', () => {
    const analysis = analyze(
      [
        '创建一个整数变量 a，赋值为 5。',
        '如果 a 大于 0：',
        '    如果 a 大于 3：',
        '        输出 很大',
        '    否则：',
        '        输出 一般',
        '    结束如果',
        '否则：',
        '    输出 负数',
        '结束如果',
      ].join('\n'),
    );
    const outerIf = analysis.statements[1];
    expect(outerIf.children[0].kind).toBe('if');
    expect(outerIf.children[0].children[0].kind).toBe('print');
    expect(analysis.statements[2].kind).toBe('else');
    expect(analysis.generatedCode).toContain('if (a > 0) {');
    expect(analysis.generatedCode).toContain('if (a > 3) {');
    expect(analysis.supportedExecutable).toBe(true);
  });

  it('全角标识符、数字与标点会被规范化后识别', () => {
    const analysis = analyze('创建一个整数变量 ａ，赋值为 ３。');
    const statement = analysis.statements[0];
    expect(statement.kind).toBe('declare');
    expect(statement.inference.declaredName).toBe('a');
    expect(statement.inference.declaredValue).toBe('3');
    expect(analysis.generatedCode).toContain('int a = 3;');
    expect(analysis.lines[0].original).toBe('创建一个整数变量 ａ，赋值为 ３。');
  });

  it('「如果…则…，否则…」写在同一行也能拆分', () => {
    const analysis = analyze('如果 a 大于 5 则输出 A，否则输出 B');
    expect(analysis.statements.map((statement) => statement.kind)).toEqual(['if', 'else']);
    expect(analysis.generatedCode).toContain('printf("A\\n");');
    expect(analysis.generatedCode).toContain('printf("B\\n");');
  });

  it('输入目标未声明时补充系统推断的声明并提示', () => {
    const analysis = analyze('读取一个整数到 a\n输出 a');
    expect(analysis.statements.map((statement) => statement.kind)).toEqual(['input', 'print']);
    expect(analysis.generatedCode).toContain('int a; /* 根据输入语句补充的声明（系统推断），请确认 */');
    expect(analysis.generatedCode).toContain('scanf("%d", &a);');
    expect(analysis.generatedCode).toContain('printf("%d\\n", a);');
    expect(analysis.notes.join('\n')).toContain('系统推断');
    expect(analysis.supportedExecutable).toBe(false);
  });

  it('没有返回语句的函数推断为 void', () => {
    const analysis = analyze(
      ['定义函数 show(整数 n)：', '    输出 n', '结束函数', '调用 show(1)'].join('\n'),
    );
    const fn = analysis.statements[0];
    expect(fn.inference.functionReturnType).toBe('void');
    expect(analysis.generatedCode).toContain('void show(int n);');
    expect(analysis.generatedCode).toContain('void show(int n) {');
    expect(analysis.generatedCode).toContain('show(1);');
    expect(analysis.supportedExecutable).toBe(true);
  });
});
