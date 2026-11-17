/**
 * 中文释义测试
 * ------------------------------------------------------------------
 * 验证右侧释义面板消费的核心内容：组成拆解、三种深度差异、关联位置、
 * 悬停提示、伪代码原文/推断/生成代码对照、以及非 C 语言的结构级释义。
 */
import { describe, expect, it } from 'vitest';
import { analyzeCode } from '../src/core/analyze';
import { explainAt, explainByNodeId, explainStructure, hoverAt } from '../src/core/explain';
import { flattenStructure } from '../src/core/analysisTypes';
import { SAMPLES } from '../src/services/samples';

const POINTER_CODE = `typedef struct LNode {
    int data;
    struct LNode *next;
} LNode;

LNode *p;
`;

const SAMPLE_ANALYSIS = analyzeCode(SAMPLES.find((sample) => sample.id === 'c-linked-list')!.code, { language: 'c' });
const POINTER_ANALYSIS = analyzeCode(POINTER_CODE, { language: 'c' });

function offsetOf(text: string, needle: string, extra = 0): number {
  const index = text.indexOf(needle);
  expect(index, `源码中未找到：${needle}`).toBeGreaterThanOrEqual(0);
  return index + extra;
}

describe('C 代码释义：变量与指针声明', () => {
  const pointerOffset = offsetOf(POINTER_CODE, 'LNode *p', 'LNode *'.length);

  it('点击指针变量名得到指针变量声明释义', () => {
    const explanation = explainAt(POINTER_ANALYSIS, pointerOffset, 'intermediate');
    expect(explanation).toBeTruthy();
    expect(explanation!.title).toBe('指针变量声明');
    expect(explanation!.codeType).toBe('变量声明');
    expect(explanation!.snippet).toContain('LNode *p');
  });

  it('组成拆解覆盖类型、指针、变量名与结束符', () => {
    const explanation = explainAt(POINTER_ANALYSIS, pointerOffset, 'intermediate')!;
    const roles = explanation.composition.map((part) => part.role);
    expect(roles).toEqual(expect.arrayContaining(['数据类型', '指针声明符', '变量名', '语句结束符']));
    const pointerPart = explanation.composition.find((part) => part.role === '指针声明符');
    expect(pointerPart?.text).toContain('*');
    expect(pointerPart?.category).toBe('pointer');
  });

  it('整体释义说明"保存地址"，并指出 p 不是结构体对象', () => {
    const explanation = explainAt(POINTER_ANALYSIS, pointerOffset, 'intermediate')!;
    expect(explanation.meaning).toContain('地址');
    expect(explanation.meaning).toContain('p');
    expect(explanation.pitfalls.join(' ')).toContain('不是 LNode 对象');
    expect(explanation.analogy).toContain('门牌');
  });

  it('三种解释深度产生不同内容，高级模式包含内存/字节', () => {
    const beginner = explainAt(POINTER_ANALYSIS, pointerOffset, 'beginner')!;
    const advanced = explainAt(POINTER_ANALYSIS, pointerOffset, 'advanced')!;
    expect(beginner.advanced).toBeUndefined();
    expect(advanced.advanced).toBeTruthy();
    expect(advanced.advanced).toContain('字节');
    expect(advanced.meaning).not.toBe(beginner.meaning);
  });

  it('声明符号带声明/使用位置，供关联面板展示', () => {
    const explanation = explainAt(POINTER_ANALYSIS, pointerOffset, 'intermediate')!;
    expect(explanation.symbol?.name).toBe('p');
    expect(explanation.symbol?.kind).toBe('variable');
    expect(explanation.symbol?.occurrences.some((occurrence) => occurrence.role === 'declaration')).toBe(true);
    expect(explanation.relations.length).toBeGreaterThan(0);
  });

  it('悬停返回简短提示而不是完整长文', () => {
    const hover = hoverAt(POINTER_ANALYSIS, pointerOffset);
    expect(hover).toBeTruthy();
    expect(hover!.title.length).toBeGreaterThan(0);
    expect(hover!.summary.length).toBeGreaterThan(0);
    expect(hover!.hint).toContain('释义');
  });
});

describe('C 代码释义：函数 / 调用 / 成员 / 表达式', () => {
  it('函数定义解释包含返回类型、参数与函数体说明', () => {
    const offset = offsetOf(SAMPLE_ANALYSIS.source, 'int main');
    const explanation = explainAt(SAMPLE_ANALYSIS, offset, 'intermediate')!;
    expect(explanation.title).toContain('main');
    expect(explanation.composition.some((part) => part.role === '返回类型')).toBe(true);
    expect(explanation.composition.some((part) => part.role === '函数体')).toBe(true);
    expect(explanation.meaning).toContain('void');
  });

  it('函数调用解释 printf 的参数与格式字符串', () => {
    const offset = offsetOf(SAMPLE_ANALYSIS.source, 'printf("NULL');
    const explanation = explainAt(SAMPLE_ANALYSIS, offset + 2, 'intermediate')!;
    expect(explanation.title).toContain('printf');
    expect(explanation.meaning).toContain('%');
    expect(explanation.codeType).toBe('函数调用');
  });

  it('指针成员访问 next 解释链表连接关系', () => {
    const offset = offsetOf(SAMPLE_ANALYSIS.source, 'node->next');
    const explanation = explainAt(SAMPLE_ANALYSIS, offset + 'node->'.length + 1, 'advanced')!;
    expect(explanation.title).toContain('成员访问');
    expect(explanation.meaning).toContain('next');
    expect(explanation.analogy + explanation.advanced).toMatch(/指针|地址|链表/);
    expect(explanation.relations.some((group) => group.title.includes('成员'))).toBe(true);
  });

  it('二元运算解释运算符含义与常见错误', () => {
    const code = 'int main() { int a = 3; if (a >= 2) { return 1; } return 0; }\n';
    const analysis = analyzeCode(code, { language: 'c' });
    const offset = offsetOf(code, '>=', 1);
    const explanation = explainAt(analysis, offset, 'intermediate')!;
    expect(explanation.title).toContain('二元运算');
    expect(explanation.composition.some((part) => part.role === '比较运算符')).toBe(true);
    expect(explanation.pitfalls.join(' ')).toContain('==');
  });

  it('数组下标访问解释从 0 开始与越界风险', () => {
    const code = 'int main() { int arr[3] = {1, 2, 3}; int x = arr[1]; return x; }\n';
    const analysis = analyzeCode(code, { language: 'c' });
    // 点击 '[' 位置，命中整个下标访问表达式
    const explanation = explainAt(analysis, offsetOf(code, 'arr[1]') + 3, 'intermediate')!;
    expect(explanation.title).toContain('数组下标');
    expect(explanation.pitfalls.join(' ')).toContain('0');
    expect(explanation.analogy).toContain('柜');
  });

  it('if 语句解释条件与两个分支', () => {
    const code = 'int main() { int a = 1; if (a > 0) { a++; } else { a--; } return a; }\n';
    const analysis = analyzeCode(code, { language: 'c' });
    const explanation = explainAt(analysis, offsetOf(code, 'if ('), 'intermediate')!;
    expect(explanation.title).toContain('条件判断');
    expect(explanation.composition.some((part) => part.role === '判断条件')).toBe(true);
    expect(explanation.composition.some((part) => part.role === '条件不成立时执行')).toBe(true);
    expect(explanation.pitfalls.join(' ')).toContain('==');
  });

  it('字面量解释类型与内存含义', () => {
    const code = 'int main() { int answer = 42; return answer; }\n';
    const analysis = analyzeCode(code, { language: 'c' });
    const explanation = explainAt(analysis, offsetOf(code, '42'), 'beginner')!;
    expect(explanation.title).toContain('整数');
    expect(explanation.meaning).toContain('42');
    expect(explanation.composition[0].text).toBe('42');
  });

  it('可以按结构树节点 id / AST 节点 id 生成释义', () => {
    const mainStructure = flattenStructure(SAMPLE_ANALYSIS.tree).find((node) => node.label.includes('main'))!;
    const byStructure = explainStructure(SAMPLE_ANALYSIS, mainStructure, 'intermediate')!;
    expect(byStructure.title.length).toBeGreaterThan(0);
    const byNode = explainByNodeId(SAMPLE_ANALYSIS, mainStructure.nodeId, 'intermediate')!;
    expect(byNode).toBeTruthy();
    expect(byNode.codeType.length).toBeGreaterThan(0);
  });
});

describe('中文伪代码释义', () => {
  const analysis = analyzeCode(
    '创建一个整数变量 a，赋值为 10。\n如果 a 大于 5，就输出 Hello。\n否则输出 World。\n',
    { language: 'pseudo' },
  );

  it('释义严格区分用户原文、系统推断与生成代码', () => {
    const offset = analysis.source.indexOf('如果');
    const explanation = explainAt(analysis, offset, 'intermediate')!;
    expect(explanation.codeType).toBe('伪代码推断');
    expect(explanation.comparisons?.length).toBeGreaterThan(0);
    const comparison = explanation.comparisons![0];
    expect(comparison.original).toContain('如果');
    expect(comparison.inferred.length).toBeGreaterThan(0);
    // 生成代码片段可能只覆盖语句体，但必须明确存在且来自生成结果
    expect(comparison.generated).toBeTypeOf('string');
    expect(explanation.meaning).toContain('系统推断');
  });

  it('未识别的行不会伪造语义，而是明确提示', () => {
    const weird = analyzeCode('创建一个整数变量 a，赋值为 10。\n随便写点无法理解的东西。\n', { language: 'pseudo' });
    const offset = weird.source.indexOf('随便');
    const explanation = explainAt(weird, offset, 'intermediate')!;
    expect(explanation).toBeTruthy();
    expect(`${explanation.meaning} ${explanation.pitfalls.join(' ')}`).toMatch(/未识别|不会|无法/);
  });
});

describe('非 C 语言的结构级释义', () => {
  it('JavaScript 提供结构级释义并声明能力边界', () => {
    const analysis = analyzeCode('function add(a, b) { return a + b; }\n', { language: 'javascript' });
    const offset = analysis.source.indexOf('function');
    const explanation = explainAt(analysis, offset, 'intermediate')!;
    expect(explanation).toBeTruthy();
    expect(explanation.title.length).toBeGreaterThan(0);
    expect(explanation.meaning.length).toBeGreaterThan(0);
    expect((explanation.limitations ?? []).join(' ')).toMatch(/执行|结构级/);
  });

  it('Python 提供结构级释义', () => {
    const analysis = analyzeCode('def add(a, b):\n    return a + b\n', { language: 'python' });
    const offset = analysis.source.indexOf('def');
    const explanation = explainAt(analysis, offset, 'beginner')!;
    expect(explanation).toBeTruthy();
    expect(explanation.level).toBe('beginner');
    expect(explanation.meaning.length).toBeGreaterThan(0);
  });

  it('纯文本回退也有可读释义', () => {
    const analysis = analyzeCode('hello there, this is just some text', { language: 'plaintext' });
    const explanation = explainAt(analysis, 2, 'intermediate');
    expect(explanation).toBeTruthy();
    expect(explanation!.title.length).toBeGreaterThan(0);
  });
});
