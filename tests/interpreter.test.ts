/**
 * CodeLens C 子集解释器测试
 * ------------------------------------------------------------------
 * 所有用例都走真实链路：SourceFile → parseC → executeC，不伪造 AST。
 * 覆盖：算术与 printf、控制流（if/else、for/while/do-while、break/continue、
 * switch 贯穿）、函数与递归、数组、指针、结构体、malloc 链表、全局变量、
 * 作用域遮蔽、运行期错误（除零/空指针/越界/未初始化）、步数上限、
 * 不支持能力的明确报错，以及快照的行号/描述/scopes/heap/changed 与重复执行一致性。
 *
 * 说明：本文件中的回归用例还覆盖了测试过程中发现并修复的三个解释器缺陷
 * （指针相减、sizeof 字符串字面量、后缀自增的描述值）。
 */
import { describe, expect, it } from 'vitest';
import { SourceFile } from '../src/core/source';
import { parseC } from '../src/core/cParser';
import { executeC, ENGINE, type ExecuteOptions } from '../src/core/interpreter/interpreter';
import type {
  ExecutionResult,
  ExecutionSnapshot,
  ScopeView,
  VariableView,
} from '../src/core/interpreter/types';

// ------------------------------------------------------------------
// 测试辅助：真实解析链路 + 常用快照查询
// ------------------------------------------------------------------

/** 运行一段 C 源码：SourceFile → parseC → executeC（真实解析链路） */
function run(code: string, options: ExecuteOptions = {}) {
  const source = new SourceFile(code);
  const { program, issues } = parseC(source);
  const parseErrors = issues.filter((issue) => issue.severity === 'error');
  return { source, program, issues, parseErrors, result: executeC(program, source, options) };
}

/** 运行并断言解析阶段没有错误（用于所有应能正常解析的程序） */
function runValid(code: string, options: ExecuteOptions = {}) {
  const executed = run(code, options);
  expect(
    executed.parseErrors.map((issue) => `第 ${issue.line} 行：${issue.message}`),
    '真实解析器不应报语法错误',
  ).toEqual([]);
  return executed;
}

/** 找到最后一个满足条件的快照 */
function lastWhere(
  snapshots: ExecutionSnapshot[],
  predicate: (snapshot: ExecutionSnapshot) => boolean,
): ExecutionSnapshot | undefined {
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    if (predicate(snapshots[index])) return snapshots[index];
  }
  return undefined;
}

/** 找到第一个满足条件的快照 */
function firstWhere(
  snapshots: ExecutionSnapshot[],
  predicate: (snapshot: ExecutionSnapshot) => boolean,
): ExecutionSnapshot | undefined {
  return snapshots.find(predicate);
}

/** 快照中所有作用域的全部变量（含嵌套代码块） */
function allVariables(snapshot: ExecutionSnapshot): VariableView[] {
  return snapshot.scopes.flatMap((scope) => scope.variables);
}

/** 按名字取变量（优先取最内层作用域） */
function variableOf(snapshot: ExecutionSnapshot, name: string): VariableView | undefined {
  for (let index = snapshot.scopes.length - 1; index >= 0; index -= 1) {
    const variable = snapshot.scopes[index].variables.find((candidate) => candidate.name === name);
    if (variable) return variable;
  }
  return undefined;
}

/** 按 kind 取作用域 */
function scopeOf(snapshot: ExecutionSnapshot, kind: ScopeView['kind']): ScopeView | undefined {
  return snapshot.scopes.find((scope) => scope.kind === kind);
}

/** 快照描述里是否包含某段文字 */
function hasDescription(result: ExecutionResult, text: string): boolean {
  return result.snapshots.some((snapshot) => snapshot.description.includes(text));
}

/** 断言执行成功并返回结果 */
function expectOk(result: ExecutionResult): ExecutionResult {
  expect(result.status, `执行失败：${result.error?.message ?? ''}`).toBe('ok');
  expect(result.error).toBeUndefined();
  return result;
}

/** 断言执行失败：检查状态/错误类别/关键字/行号 */
function expectFailure(
  result: ExecutionResult,
  expected: { kind: 'runtime' | 'unsupported' | 'limit'; messageIncludes: string; line?: number },
): void {
  expect(result.status).toBe('error');
  expect(result.error).toBeDefined();
  expect(result.error?.kind).toBe(expected.kind);
  expect(result.error?.message).toContain(expected.messageIncludes);
  if (expected.line !== undefined) expect(result.error?.line).toBe(expected.line);
  const last = result.snapshots[result.snapshots.length - 1];
  expect(last?.phase).toBe('error');
}

// ------------------------------------------------------------------
// 复用的示例程序
// ------------------------------------------------------------------

/** 仓库内置示例：用头插法创建 3 个链表节点并遍历输出 */
const LINKED_LIST_SAMPLE = `#include <stdio.h>
#include <stdlib.h>

/* 链表节点：保存数据 + 指向下一个节点的指针 */
typedef struct LNode {
    int data;
    struct LNode *next;
} LNode;

/* 创建一个新节点 */
LNode *createNode(int value) {
    LNode *p = (LNode *)malloc(sizeof(LNode));
    if (p == NULL) {
        printf("内存分配失败\\n");
        return NULL;
    }
    p->data = value;
    p->next = NULL;
    return p;
}

int main(void) {
    LNode *head = NULL;       // 头指针：指向第一个节点

    // 用头插法创建 3 个节点：3 -> 2 -> 1 -> NULL
    for (int i = 1; i <= 3; i++) {
        LNode *node = createNode(i);
        node->next = head;
        head = node;
    }

    // 遍历链表，逐个输出节点的数据
    LNode *cur = head;
    while (cur != NULL) {
        printf("%d -> ", cur->data);
        cur = cur->next;
    }
    printf("NULL\\n");

    return 0;
}
`;

/** 交换两个变量的多行程序（用于快照行号与调用栈断言） */
const SWAP_PROGRAM = `#include <stdio.h>
void swap(int *a, int *b) {
    int temp = *a;
    *a = *b;
    *b = temp;
}
int main(void) {
    int x = 10;
    int y = 20;
    swap(&x, &y);
    printf("x=%d y=%d\\n", x, y);
    return 0;
}
`;

// ==================================================================
// 基础算术与 printf
// ==================================================================

describe('基础算术与 printf 输出', () => {
  it('执行整数/浮点算术并按 C 格式输出', () => {
    const code = `#include <stdio.h>
int main(void) {
    int a = 7, b = 3;
    printf("%d %d %d %d %d\\n", a + b, a - b, a * b, a / b, a % b);
    printf("%x %X %o %u %c\\n", 255, 255, 8, -1, 65);
    printf("%.2f %f %e\\n", 1.0 / 3.0, 2.5, 12345.0);
    printf("%s %p %%\\n", "hi", NULL);
    printf("[%5d][%-5d][%05d]\\n", 42, 42, 42);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe(
      '10 4 21 2 1\n' +
        'ff FF 10 4294967295 A\n' +
        '0.33 2.500000 1.234500e+04\n' +
        'hi (nil) %\n' +
        '[   42][42   ][00042]\n',
    );
    expect(result.engine).toBe(ENGINE);
    expect(result.entryFunction).toBe('main');
    expect(result.truncated).toBe(false);
    expect(typeof result.durationMs).toBe('number');
    expect(result.snapshots.length).toBeGreaterThan(0);
  });

  it('支持长度修饰符、宽度/精度与转义字符', () => {
    const code = `#include <stdio.h>
int main(void) {
    printf("%ld %lld %lu\\n", 12, 34, 56);
    printf("%6.2f|%-6d|\\n", 3.14159, 7);
    printf("tab\\there\\n");
    printf("%s\\n", "带引号的\\"文本\\"");
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('12 34 56\n  3.14|7     |\ntab\there\n带引号的"文本"\n');
  });

  it('printf 缺少参数时作为运行期错误中止', () => {
    const { result } = runValid(`#include <stdio.h>
int main(void) {
    int a = 1;
    printf("%d %d\\n", a);
    return 0;
}`);
    expectFailure(result, { kind: 'runtime', messageIncludes: '缺少 %d 对应的参数', line: 4 });
    expect(result.stdout).toBe('');
  });

  it('printf 多余参数只产生 warning，不影响输出', () => {
    const { result } = runValid(`#include <stdio.h>
int main(void) { printf("%d\\n", 1, 2); return 0; }`);
    expectOk(result);
    expect(result.stdout).toBe('1\n');
    expect(result.warnings.some((warning) => warning.includes('多出的 1 个参数被忽略'))).toBe(true);
  });

  it('sizeof 能计算常见类型、变量、数组与字符串字面量', () => {
    const code = `#include <stdio.h>
int main(void) {
    int a[4] = {1, 2, 3, 4};
    int *p = a;
    char c = 'x';
    printf("%d %d %d %d %d\\n", sizeof(int), sizeof(double), sizeof(p), sizeof(c), sizeof(a));
    printf("%d %d\\n", sizeof(a) / sizeof(a[0]), sizeof(&a[0]));
    printf("%d %d %d\\n", sizeof("abc"), sizeof(""), sizeof("a" "b"));
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    // 回归：字符串字面量的 sizeof 应得到字符数组大小（含结尾 NUL），而不是指针大小 8
    expect(result.stdout).toBe('4 8 8 1 16\n4 8\n4 1 3\n');
  });
});

// ==================================================================
// 控制流
// ==================================================================

describe('控制流：条件与循环', () => {
  it('if / else if / else 选择正确分支并记录条件快照', () => {
    const code = `#include <stdio.h>
int main(void) {
    int score = 75;
    if (score >= 90) { printf("A\\n"); }
    else if (score >= 60) { printf("B\\n"); }
    else { printf("C\\n"); }
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('B\n');
    expect(hasDescription(result, '判断条件 score >= 90 → 假')).toBe(true);
    expect(hasDescription(result, '判断条件 score >= 60 → 真，进入 if 分支')).toBe(true);
    const conditions = result.snapshots.filter((snapshot) => snapshot.phase === 'condition');
    expect(conditions.length).toBeGreaterThanOrEqual(2);
    for (const snapshot of conditions) {
      expect(snapshot.line).toBeGreaterThan(0);
      expect(snapshot.description).toContain('判断条件');
    }
  });

  it('逻辑运算短路求值，不会执行被跳过的除零表达式', () => {
    const code = `#include <stdio.h>
int main(void) {
    int x = 0;
    if (x != 0 && 10 / x > 1) { printf("bad\\n"); }
    if (x == 0 || 10 / x > 1) { printf("safe\\n"); }
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('safe\n');
  });

  it('for 循环记录初始化、条件与更新步骤', () => {
    const code = `#include <stdio.h>
int main(void) {
    int sum = 0;
    for (int i = 1; i <= 4; i++) { sum += i; }
    printf("sum=%d\\n", sum);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('sum=10\n');
    expect(hasDescription(result, 'for 循环初始化：声明 int i = 1')).toBe(true);
    expect(hasDescription(result, '判断 for 条件 i <= 4 → 真，进入第 1 轮循环')).toBe(true);
    expect(hasDescription(result, '执行 for 更新表达式 i++')).toBe(true);
    expect(hasDescription(result, '判断 for 条件 i <= 4 → 假，结束 for 循环')).toBe(true);
    expect(result.snapshots.some((snapshot) => snapshot.phase === 'loop')).toBe(true);
  });

  it('while 循环迭代到条件为假，并记录结束判断', () => {
    const code = `#include <stdio.h>
int main(void) {
    int n = 5, fact = 1;
    while (n > 1) { fact *= n; n--; }
    printf("%d\\n", fact);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('120\n');
    expect(hasDescription(result, '进入第 1 轮循环')).toBe(true);
    expect(hasDescription(result, '判断 while 条件 n > 1 → 假，结束 while 循环')).toBe(true);
  });

  it('do-while 至少执行一次循环体', () => {
    const code = `#include <stdio.h>
int main(void) {
    int count = 0;
    do { count++; } while (count < 3);
    int once = 10;
    do { printf("at least once: %d\\n", once); once++; } while (once < 5);
    printf("count=%d\\n", count);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('at least once: 10\ncount=3\n');
    expect(hasDescription(result, '判断 do-while 条件 count < 3 → 假，结束 do-while 循环')).toBe(true);
    const outputs = result.snapshots.filter((snapshot) => snapshot.phase === 'output');
    expect(outputs).toHaveLength(2);
    expect(outputs.map((snapshot) => snapshot.description)).toEqual([
      'printf 输出："at least once: 10\\n"',
      'printf 输出："count=3\\n"',
    ]);
  });

  it('break 与 continue 改变循环流程并给出中文说明', () => {
    const code = `#include <stdio.h>
int main(void) {
    int total = 0;
    for (int i = 1; i <= 10; i++) {
        if (i == 3) continue;
        if (i == 6) break;
        total += i;
    }
    printf("total=%d\\n", total);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('total=12\n'); // 1 + 2 + 4 + 5
    expect(hasDescription(result, '执行 continue，跳过本轮剩余语句')).toBe(true);
    expect(hasDescription(result, '执行 break，跳出 for 循环')).toBe(true);
  });

  it('switch 匹配 case 后按 C 语义贯穿，直到 break 或结束', () => {
    const code = `#include <stdio.h>
int main(void) {
    int level = 2;
    switch (level) {
        case 1:
            printf("one\\n");
        case 2:
            printf("two\\n");
        case 3:
            printf("three\\n");
            break;
        default:
            printf("other\\n");
    }
    switch (99) {
        case 1: printf("never\\n"); break;
        default: printf("default\\n");
    }
    switch (7) {
        case 1: printf("never\\n"); break;
    }
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('two\nthree\ndefault\n');
    expect(hasDescription(result, 'switch 判断 level = 2，进入 case 2')).toBe(true);
    expect(hasDescription(result, 'switch 贯穿：继续执行 case 3 的语句')).toBe(true);
    expect(hasDescription(result, '执行 break，跳出 switch 语句')).toBe(true);
    expect(hasDescription(result, 'switch 判断 99 = 99，进入 default 分支')).toBe(true);
    expect(hasDescription(result, 'switch 判断 7 = 7，没有匹配的 case，跳过 switch')).toBe(true);
  });

  it('嵌套循环中的 break / continue 只影响最内层循环', () => {
    const code = `#include <stdio.h>
int main(void) {
    int out = 0;
    for (int i = 0; i < 3; i++) {
        for (int j = 0; j < 3; j++) {
            if (j == 1) break;
            out++;
        }
        for (int k = 0; k < 3; k++) {
            if (k == 1) continue;
            out += 10;
        }
    }
    printf("out=%d\\n", out);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('out=63\n');
  });
});

// ==================================================================
// 函数与递归
// ==================================================================

describe('函数调用与递归', () => {
  it('函数调用产生参数、返回值与调用栈快照', () => {
    const code = `#include <stdio.h>
int add(int a, int b) { return a + b; }
int square(int x) { return x * x; }
int main(void) {
    int r = add(square(2), add(3, 4));
    printf("r=%d\\n", r);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('r=11\n');
    const nestedCall = firstWhere(
      result.snapshots,
      (snapshot) => snapshot.callStack.length === 2 && snapshot.callStack[1].functionName === 'square',
    );
    expect(nestedCall).toBeDefined();
    expect(nestedCall?.phase).toBe('call');
    expect(nestedCall?.callStack.map((frame) => frame.functionName)).toEqual(['main', 'square']);
    expect(nestedCall?.callStack[1].locals).toBeGreaterThanOrEqual(1);
    // 进入函数时参数已绑定到函数作用域（调用栈上最后一个函数作用域才是 square）
    const squareScope = nestedCall?.scopes.find((scope) => scope.name === '函数 square()');
    expect(squareScope).toBeDefined();
    expect(squareScope?.kind).toBe('function');
    expect(variableOf(nestedCall!, 'x')?.value.text).toBe('2');
    expect(hasDescription(result, '进入函数 square(2)')).toBe(true);
    expect(hasDescription(result, '函数 square 返回 4')).toBe(true);
  });

  it('递归调用维持调用栈，最终得到正确结果', () => {
    const code = `#include <stdio.h>
int factorial(int n) {
    if (n <= 1) { return 1; }
    return n * factorial(n - 1);
}
int main(void) {
    printf("5!=%d\\n", factorial(5));
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('5!=120\n');
    const deepest = result.snapshots.reduce(
      (best, snapshot) => (snapshot.callStack.length > best.callStack.length ? snapshot : best),
      result.snapshots[0],
    );
    // main + factorial(5..1)：递归最深处至少 5 层 factorial 帧
    expect(deepest.callStack.length).toBeGreaterThanOrEqual(6);
    expect(deepest.callStack[0].functionName).toBe('main');
    expect(deepest.callStack.slice(1).every((frame) => frame.functionName === 'factorial')).toBe(true);
  });

  it('递归超过调用深度上限时明确报错', () => {
    const code = `#include <stdio.h>
int down(int n) { return down(n - 1); }
int main(void) { printf("%d\\n", down(5)); return 0; }`;
    const { result } = runValid(code, { maxCallDepth: 5 });
    expectFailure(result, { kind: 'runtime', messageIncludes: '递归调用过深' });
    expect(result.error?.hint).toContain('递归深度');
  });

  it('函数缺少 return 时使用默认返回值并给出 warning', () => {
    const code = `#include <stdio.h>
int compute(int x) {
    if (x > 0) { return 1; }
}
int main(void) {
    printf("%d\\n", compute(-5));
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('0\n');
    expect(result.warnings.some((warning) => warning.includes('没有执行 return 语句'))).toBe(true);
  });

  it('void 函数可以带 return; 且不影响输出', () => {
    const code = `#include <stdio.h>
void greet(void) { printf("hi\\n"); return; }
int main(void) {
    greet();
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('hi\n');
  });

  it('数组参数退化为指向首元素的指针', () => {
    const code = `#include <stdio.h>
int sum(int arr[], int n) {
    int total = 0;
    for (int i = 0; i < n; i++) total += arr[i];
    return total;
}
int main(void) {
    int values[3] = {1, 2, 3};
    printf("%d\\n", sum(values, 3));
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('6\n');
    const sumCall = firstWhere(result.snapshots, (snapshot) => snapshot.callStack.some((frame) => frame.functionName === 'sum'));
    expect(sumCall).toBeDefined();
    const arrParam = variableOf(sumCall!, 'arr');
    expect(arrParam?.value.kind).toBe('pointer');
    expect(arrParam?.value.pointerTarget).toMatch(/^0x[0-9a-f]+$/);
  });

  it('main 的命令行参数被简化处理并给出 warning', () => {
    const code = `#include <stdio.h>
int main(int argc, char **argv) {
    printf("argc=%d argv=%p\\n", argc, argv);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('argc=1 argv=(nil)\n');
    expect(result.warnings.some((warning) => warning.includes('命令行参数已简化处理'))).toBe(true);
  });
});

// ==================================================================
// 数组与指针
// ==================================================================

describe('数组与指针', () => {
  it('数组按下标读写，初始化列表与字符数组都正确', () => {
    const code = `#include <stdio.h>
int main(void) {
    int arr[4] = {10, 20, 30, 40};
    int total = 0;
    for (int i = 0; i < 4; i++) { total += arr[i]; }
    arr[1] = 5;
    printf("total=%d arr[1]=%d\\n", total, arr[1]);
    char word[] = "hello";
    printf("%s %c\\n", word, word[1]);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('total=100 arr[1]=5\nhello e\n');
    const snapshot = firstWhere(result.snapshots, (candidate) => candidate.description.includes('声明 int[4] arr'));
    expect(snapshot).toBeDefined();
    const arr = variableOf(snapshot!, 'arr');
    expect(arr?.value.kind).toBe('array');
    expect(arr?.value.elements?.map((element) => element.text)).toEqual(['10', '20', '30', '40']);
    // 赋值后的快照里 arr[1] 变化
    const afterAssign = firstWhere(result.snapshots, (candidate) => candidate.description.includes('arr[1] = 5'));
    expect(variableOf(afterAssign!, 'arr')?.value.text).toBe('[10, 5, 30, 40]');
    // char word[] 在后续语句才声明，取它首次出现的快照
    const wordSnapshot = firstWhere(result.snapshots, (candidate) => variableOf(candidate, 'word') !== undefined);
    const word = variableOf(wordSnapshot!, 'word');
    expect(word?.value.kind).toBe('string');
    expect(word?.value.text).toBe('"hello"');
    expect(word?.typeText).toBe('char[6]');
  });

  it('二维数组与结构体数组的读写', () => {
    const code = `#include <stdio.h>
typedef struct Student { char name[8]; int age; } Student;
int main(void) {
    int grid[2][3] = {{1, 2, 3}, {4, 5, 6}};
    Student list[2] = {{"Ann", 18}, {"Bob", 19}};
    printf("%d %d\\n", grid[0][1], grid[1][2]);
    for (int i = 0; i < 2; i++) { printf("%s:%d ", list[i].name, list[i].age); }
    printf("\\n");
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('2 6\nAnn:18 Bob:19 \n');
    const list = variableOf(
      firstWhere(result.snapshots, (snapshot) => snapshot.description.includes('list')) ?? result.snapshots[0],
      'list',
    );
    expect(list?.value.kind).toBe('array');
    expect(list?.value.elements).toHaveLength(2);
  });

  it('指针取地址（&）与解引用（*）能修改原变量', () => {
    const code = `#include <stdio.h>
int main(void) {
    int x = 10;
    int *p = &x;
    *p = 42;
    printf("x=%d *p=%d\\n", x, *p);
    int y = 7;
    p = &y;
    *p += 3;
    printf("y=%d\\n", y);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('x=42 *p=42\ny=10\n');
    const pointerSnapshot = firstWhere(result.snapshots, (snapshot) => variableOf(snapshot, 'p')?.value.pointerTarget !== undefined);
    expect(pointerSnapshot).toBeDefined();
    const p = variableOf(pointerSnapshot!, 'p');
    expect(p?.value.kind).toBe('pointer');
    expect(p?.value.isNull).toBe(false);
    expect(p?.value.pointerTarget).toMatch(/^0x[0-9a-f]+$/);
    expect(p?.value.pointerTargetLabel).toBe('变量 x');
    expect(p?.typeText).toBe('int *');
    // NULL 指针的视图 isNull 为 true
    expect(variableOf(result.snapshots[0], 'x')).toBeUndefined();
    const xVar = variableOf(pointerSnapshot!, 'x');
    expect(xVar?.value.text).toBe('10');
  });

  it('通过指针参数在函数内交换调用者的变量', () => {
    const { result } = runValid(SWAP_PROGRAM);
    expectOk(result);
    expect(result.stdout).toBe('x=20 y=10\n');
    const callSnapshot = firstWhere(
      result.snapshots,
      (snapshot) => snapshot.callStack.length === 2 && snapshot.callStack[1].functionName === 'swap',
    );
    expect(callSnapshot).toBeDefined();
    expect(callSnapshot?.callStack.map((frame) => frame.functionName)).toEqual(['main', 'swap']);
    const scopeNames = callSnapshot!.scopes.map((scope) => scope.name);
    expect(scopeNames).toContain('函数 main()');
    expect(scopeNames).toContain('函数 swap()');
    const paramA = variableOf(callSnapshot!, 'a');
    const paramB = variableOf(callSnapshot!, 'b');
    expect(paramA?.value.kind).toBe('pointer');
    expect(paramA?.value.pointerTargetLabel).toBe('变量 x');
    expect(paramB?.value.pointerTargetLabel).toBe('变量 y');
  });

  it('支持指针算术与两个指针相减（回归：修复前 p - arr 会误报运行期错误）', () => {
    const code = `#include <stdio.h>
int main(void) {
    int arr[4] = {10, 20, 30, 40};
    int *p = arr;
    printf("%d ", *p);
    p++;
    printf("%d ", *p);
    p = p + 2;
    printf("%d %d\\n", *p, p - arr);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    // p 从 arr[0] 走到 arr[3]：*p = 40，p - arr = 3（元素个数，而不是字节数）
    expect(result.stdout).toBe('10 20 40 3\n');
    expect(result.error).toBeUndefined();
  });

  it('指针与 NULL / 其它指针比较', () => {
    const code = `#include <stdio.h>
int main(void) {
    int a = 1, b = 2;
    int *p = &a;
    int *q = &b;
    printf("%d %d %d\\n", p == q, p != q, p == NULL);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('0 1 0\n');
  });
});

// ==================================================================
// 结构体、堆与链表
// ==================================================================

describe('结构体与堆内存', () => {
  it('结构体成员访问（. 与 ->）、结构体赋值与成员地址', () => {
    const code = `#include <stdio.h>
typedef struct Point {
    int x;
    int y;
} Point;
int main(void) {
    Point p = {3, 4};
    Point q;
    q = p;
    q.x = 100;
    printf("p=(%d,%d) q=(%d,%d)\\n", p.x, p.y, q.x, q.y);
    Point *ptr = &p;
    ptr->y = 9;
    printf("p.y=%d\\n", p.y);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('p=(3,4) q=(100,4)\np.y=9\n');
    const structSnapshot = firstWhere(result.snapshots, (snapshot) => snapshot.description.includes('ptr->y = 9'));
    expect(structSnapshot).toBeDefined();
    const p = variableOf(structSnapshot!, 'p');
    expect(p?.value.kind).toBe('struct');
    expect(p?.value.typeText).toBe('struct Point');
    expect(p?.value.fields?.map((field) => `${field.name}:${field.text}`)).toEqual(['x:3', 'y:9']);
    const ptr = variableOf(structSnapshot!, 'ptr');
    expect(ptr?.value.pointerTargetLabel).toBe('变量 p');
  });

  it('malloc 创建 3 个链表节点，头插后遍历输出 3 -> 2 -> 1 -> NULL', () => {
    const { result } = runValid(LINKED_LIST_SAMPLE);
    expectOk(result);
    expect(result.stdout).toBe('3 -> 2 -> 1 -> NULL\n');
    // 背景约定：默认链表示例共执行 52 步（快照）
    expect(result.snapshots).toHaveLength(52);

    // 遍历到第一个节点时（cur -> 3），堆中已有 3 个 struct LNode 节点且被指针引用
    const traversal = firstWhere(result.snapshots, (snapshot) => snapshot.stdout === '3 -> 2 -> 1 -> ');
    expect(traversal).toBeDefined();
    const nodes = traversal!.heap.filter((object) => object.kind === 'struct');
    expect(nodes).toHaveLength(3);
    expect(nodes.map((node) => node.typeText)).toEqual(['struct LNode', 'struct LNode', 'struct LNode']);
    expect(nodes.every((node) => node.referenced === true)).toBe(true);
    // 节点数据：地址递增对应 data 1/2/3，头插后链表为 3 -> 2 -> 1 -> NULL
    expect(nodes.map((node) => node.fields?.find((field) => field.name === 'data')?.text)).toEqual(['1', '2', '3']);
    const nextTargets = nodes.map((node) => node.fields?.find((field) => field.name === 'next')?.pointerTarget);
    expect(nextTargets[0]).toBeUndefined(); // 节点 1 的 next = NULL
    expect(nextTargets[1]).toBe(nodes[0].address); // 节点 2 -> 节点 1
    expect(nextTargets[2]).toBe(nodes[1].address); // 节点 3 -> 节点 2
    // 变量视角：head 始终指向头节点（堆内存 #3，0x9020）；
    // 打印完第 3 个节点数据时 cur 停在最后一个节点（堆内存 #1，0x9000）
    const head = variableOf(traversal!, 'head');
    const cur = variableOf(traversal!, 'cur');
    expect(head?.value.text).toBe(nodes[2].address);
    expect(head?.value.pointerTargetLabel).toBe('堆内存 #3（struct LNode）');
    expect(cur?.value.text).toBe(nodes[0].address);
    expect(cur?.value.pointerTargetLabel).toBe('堆内存 #1（struct LNode）');
    // 调用 createNode 时调用栈体现 main → createNode
    const nodeScope = firstWhere(
      result.snapshots,
      (snapshot) => snapshot.callStack.length === 2 && snapshot.callStack[1].functionName === 'createNode',
    );
    expect(nodeScope?.callStack.map((frame) => frame.functionName)).toEqual(['main', 'createNode']);
  });

  it('malloc 超过模拟堆上限时返回 NULL 并通过 warning 说明', () => {
    const code = `#include <stdio.h>
#include <stdlib.h>
typedef struct Big { char data[16]; } Big;
int main(void) {
    Big *p = (Big *)malloc(sizeof(Big));
    if (p == NULL) { printf("alloc failed\\n"); return 1; }
    printf("ok\\n");
    return 0;
}`;
    const { result } = runValid(code, { maxHeapBytes: 8 });
    expectOk(result);
    expect(result.stdout).toBe('alloc failed\n');
    expect(result.snapshots[result.snapshots.length - 1].description).toContain('main 返回 1');
    expect(result.warnings.some((warning) => warning.includes('超出模拟堆上限'))).toBe(true);
  });

  it('free 之后继续解引用会报告悬空指针错误', () => {
    const code = `#include <stdio.h>
#include <stdlib.h>
typedef struct Node { int data; struct Node *next; } Node;
int main(void) {
    Node *p = (Node *)malloc(sizeof(Node));
    p->data = 5;
    p->next = NULL;
    printf("before=%d\\n", p->data);
    free(p);
    printf("after=%d\\n", p->data);
    return 0;
}`;
    const { result } = runValid(code);
    expect(result.status).toBe('error');
    expect(result.error?.kind).toBe('runtime');
    expect(result.error?.message).toContain('已经释放的内存');
    expect(result.error?.message).toContain('悬空指针');
    expect(result.stdout).toBe('before=5\n');
    expect(result.warnings.some((warning) => warning.includes('free 之后仍有指针指向'))).toBe(true);
    // free 语句之后的快照中，堆对象被标记为 freed
    expect(result.snapshots.some((snapshot) => snapshot.heap.some((object) => object.freed === true))).toBe(true);
  });

  it('free(NULL) 是安全的空操作', () => {
    const { result } = runValid(`#include <stdio.h>
#include <stdlib.h>
int main(void) {
    int *p = NULL;
    free(p);
    printf("ok\\n");
    return 0;
}`);
    expectOk(result);
    expect(result.stdout).toBe('ok\n');
  });

  it('重复释放同一块内存会报告运行期错误', () => {
    const code = `#include <stdio.h>
#include <stdlib.h>
typedef struct N { int v; } N;
int main(void) {
    N *p = (N *)malloc(sizeof(N));
    free(p);
    free(p);
    return 0;
}`;
    const { result } = runValid(code);
    expectFailure(result, { kind: 'runtime', messageIncludes: '重复释放同一块内存' });
  });

  it('字符串字面量只读，写入时报告错误', () => {
    const code = `#include <stdio.h>
int main(void) {
    char *s = "hello";
    s[0] = 'H';
    printf("%s\\n", s);
    return 0;
}`;
    const { result } = runValid(code);
    expectFailure(result, { kind: 'runtime', messageIncludes: '只读', line: 4 });
  });
});

// ==================================================================
// 全局变量与作用域
// ==================================================================

describe('全局变量与作用域', () => {
  it('全局变量在所有函数间共享，并在首帧快照中可见', () => {
    const code = `#include <stdio.h>
int counter = 100;
int values[3] = {1, 2, 3};
int bump(void) { counter += 5; return counter; }
int main(void) {
    printf("start=%d\\n", counter);
    bump();
    bump();
    printf("counter=%d values=%d\\n", counter, values[2]);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('start=100\ncounter=110 values=3\n');
    const first = result.snapshots[0];
    expect(first.phase).toBe('start');
    const globalScope = scopeOf(first, 'global');
    expect(globalScope?.name).toBe('全局作用域');
    const counter = globalScope?.variables.find((variable) => variable.name === 'counter');
    expect(counter?.value.text).toBe('100');
    expect(counter?.scopeKind).toBe('global');
    const values = globalScope?.variables.find((variable) => variable.name === 'values');
    expect(values?.value.kind).toBe('array');
    expect(values?.value.elements?.map((element) => element.text)).toEqual(['1', '2', '3']);
  });

  it('代码块内同名变量遮蔽外层变量，离开代码块后恢复', () => {
    const code = `#include <stdio.h>
int value = 100;
int main(void) {
    printf("global=%d\\n", value);
    {
        int value = 7;
        printf("inner=%d\\n", value);
    }
    printf("global=%d\\n", value);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('global=100\ninner=7\nglobal=100\n');
    const innerSnapshot = firstWhere(result.snapshots, (snapshot) => snapshot.description.includes('inner=7'));
    expect(innerSnapshot).toBeDefined();
    expect(innerSnapshot!.scopes.length).toBe(3);
    expect(innerSnapshot!.scopes.map((scope) => scope.kind)).toEqual(['global', 'function', 'block']);
    const shadowScope = innerSnapshot!.scopes[2];
    expect(shadowScope.name).toContain('代码块');
    expect(shadowScope.variables.find((variable) => variable.name === 'value')?.value.text).toBe('7');
    expect(innerSnapshot!.scopes[0].variables.find((variable) => variable.name === 'value')?.value.text).toBe('100');
    // 离开代码块后只剩全局 + 函数作用域
    const outerSnapshot = lastWhere(result.snapshots, (snapshot) => snapshot.functionName === 'main');
    expect(outerSnapshot!.scopes.some((scope) => scope.kind === 'block')).toBe(false);
  });

  it('快照的 scopes 结构：全局 / 函数 / 代码块三类作用域与声明行号', () => {
    const code = `int main(void) {
    int a = 1;
    if (a == 1) {
        int b = 2;
    }
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    const inner = firstWhere(result.snapshots, (snapshot) => allVariables(snapshot).some((variable) => variable.name === 'b'));
    expect(inner).toBeDefined();
    const b = variableOf(inner!, 'b');
    expect(b?.scopeKind).toBe('block');
    expect(b?.declaredLine).toBe(4);
    expect(b?.address).toMatch(/^0x[0-9a-f]+$/);
    expect(b?.typeText).toBe('int');
    expect(variableOf(inner!, 'a')?.declaredLine).toBe(2);
  });
});

// ==================================================================
// 快照：行号 / 描述 / changed / 输出
// ==================================================================

describe('执行快照', () => {
  it('快照行号与中英文描述对应真实源码行', () => {
    const code = `#include <stdio.h>
int main(void) {
    int a = 1;
    if (a == 1) {
        a = 2;
    }
    printf("%d\\n", a);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    const start = result.snapshots[0];
    expect(start.phase).toBe('start');
    expect(start.line).toBe(2); // main 定义所在行
    expect(start.description).toContain('开始执行程序');
    const declaration = firstWhere(result.snapshots, (snapshot) => snapshot.description.includes('声明 int a = 1'));
    expect(declaration?.line).toBe(3);
    expect(declaration?.range?.startLine).toBe(3);
    const condition = firstWhere(result.snapshots, (snapshot) => snapshot.phase === 'condition');
    expect(condition?.line).toBe(4);
    expect(condition?.description).toContain('判断条件 a == 1 → 真，进入 if 分支');
    const assignment = firstWhere(result.snapshots, (snapshot) => snapshot.description.includes('执行赋值 a = 2'));
    expect(assignment?.line).toBe(5);
    const output = firstWhere(result.snapshots, (snapshot) => snapshot.phase === 'output');
    expect(output?.line).toBe(7);
    expect(output?.description).toContain('printf 输出："2\\n"');
    const returned = firstWhere(result.snapshots, (snapshot) => snapshot.phase === 'return');
    expect(returned?.line).toBe(8);
    const end = result.snapshots[result.snapshots.length - 1];
    expect(end.phase).toBe('end');
    expect(end.line).toBe(9); // main 函数体结束行
    expect(end.description).toContain('程序执行结束，main 返回 0');
  });

  it('每个快照都带有完整的结构字段与递增 index', () => {
    const { result } = runValid(SWAP_PROGRAM);
    expectOk(result);
    expect(result.snapshots.length).toBeGreaterThan(5);
    result.snapshots.forEach((snapshot, index) => {
      expect(snapshot.index).toBe(index);
      expect(snapshot.line).toBeGreaterThanOrEqual(1);
      expect(snapshot.description.length).toBeGreaterThan(0);
      expect(Array.isArray(snapshot.callStack)).toBe(true);
      expect(Array.isArray(snapshot.scopes)).toBe(true);
      expect(Array.isArray(snapshot.heap)).toBe(true);
      expect(Array.isArray(snapshot.output)).toBe(true);
      expect(typeof snapshot.stdout).toBe('string');
      expect(Array.isArray(snapshot.warnings)).toBe(true);
      expect(snapshot.warnings.length === 0 || result.warnings.length > 0).toBe(true);
      // start 快照（尚未进入函数）与 end 快照（函数已返回）没有调用帧
      if (snapshot.phase !== 'start' && snapshot.phase !== 'end') {
        expect(snapshot.callStack.length, `快照 #${snapshot.index} 缺少调用栈`).toBeGreaterThanOrEqual(1);
        expect(snapshot.functionName).toBeTruthy();
      }
    });
    // std 输出与 output 行数组保持同步
    const outputs = result.snapshots.filter((snapshot) => snapshot.phase === 'output');
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs[outputs.length - 1].output).toEqual(['x=20 y=10']);
    expect(outputs[outputs.length - 1].stdout).toBe('x=20 y=10\n');
  });

  it('changed 标记准确反映本步变化的标量变量', () => {
    const code = `#include <stdio.h>
int main(void) {
    int n = 3;
    while (n > 0) { n--; }
    printf("%d\\n", n);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    const declaration = firstWhere(result.snapshots, (snapshot) => snapshot.description.includes('声明 int n = 3'));
    expect(variableOf(declaration!, 'n')?.value.changed).toBe(true);
    const firstCondition = firstWhere(result.snapshots, (snapshot) => snapshot.description.includes('进入第 1 轮循环'));
    expect(variableOf(firstCondition!, 'n')?.value.changed).toBe(false);
    const decrement = firstWhere(result.snapshots, (snapshot) => snapshot.description.includes('执行 n--'));
    // 后缀自减的表达式结果是旧值，但描述与面板都应显示更新后的值
    expect(decrement?.description).toContain('执行 n--（n 变为 2）');
    expect(variableOf(decrement!, 'n')?.value.text).toBe('2');
    expect(variableOf(decrement!, 'n')?.value.changed).toBe(true);
    const secondCondition = firstWhere(
      result.snapshots,
      (snapshot) => snapshot.description.includes('进入第 2 轮循环'),
    );
    expect(variableOf(secondCondition!, 'n')?.value.changed).toBe(false);
  });

  it('changed 标记同样作用于数组 / 结构体等聚合变量', () => {
    const code = `#include <stdio.h>
typedef struct P { int x; int y; } P;
int main(void) {
    int arr[3] = {0, 0, 0};
    P p = {1, 2};
    arr[1] = 5;
    p.x = 9;
    printf("%d %d\\n", arr[1], p.x);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    const assignArr = firstWhere(result.snapshots, (snapshot) => snapshot.description.includes('arr[1] = 5'));
    expect(variableOf(assignArr!, 'arr')?.value.changed).toBe(true);
    expect(variableOf(assignArr!, 'arr')?.value.text).toBe('[0, 5, 0]');
    const assignStruct = firstWhere(result.snapshots, (snapshot) => snapshot.description.includes('p.x = 9'));
    expect(variableOf(assignStruct!, 'p')?.value.changed).toBe(true);
    expect(variableOf(assignStruct!, 'p')?.value.text).toBe('{x: 9, y: 2}');
    const output = firstWhere(result.snapshots, (snapshot) => snapshot.phase === 'output');
    expect(variableOf(output!, 'arr')?.value.changed).toBe(false);
    expect(variableOf(output!, 'p')?.value.changed).toBe(false);
  });

  it('output / stdout 一致地累积 printf 输出', () => {
    const { result } = runValid(`#include <stdio.h>
int main(void) {
    printf("a");
    printf("b\\n");
    printf("c\\n");
    return 0;
}`);
    expectOk(result);
    expect(result.stdout).toBe('ab\nc\n');
    const outputs = result.snapshots.filter((snapshot) => snapshot.phase === 'output');
    expect(outputs).toHaveLength(3);
    expect(outputs[0].stdout).toBe('a');
    expect(outputs[0].output).toEqual(['a']);
    expect(outputs[1].stdout).toBe('ab\n');
    expect(outputs[1].output).toEqual(['ab']);
    expect(outputs[2].stdout).toBe('ab\nc\n');
    expect(outputs[2].output).toEqual(['ab', 'c']);
  });
});

// ==================================================================
// 运行期错误与能力边界
// ==================================================================

describe('运行期错误', () => {
  it('整数除以零明确报错并停止', () => {
    const code = `#include <stdio.h>
int main(void) {
    int a = 10, b = 0;
    printf("%d\\n", a / b);
    return 0;
}`;
    const { result } = runValid(code);
    expectFailure(result, { kind: 'runtime', messageIncludes: '除以零（整数除法）', line: 4 });
    expect(result.error?.hint).toContain('除数');
    expect(result.truncated).toBe(false);
  });

  it('取模除数为零同样报错', () => {
    const code = `#include <stdio.h>
int main(void) {
    int a = 10, b = 0;
    printf("%d\\n", a % b);
    return 0;
}`;
    const { result } = runValid(code);
    expectFailure(result, { kind: 'runtime', messageIncludes: '取模运算的除数为零' });
  });

  it('空指针解引用报错并给出提示', () => {
    const code = `#include <stdio.h>
int main(void) {
    int *p = NULL;
    printf("%d\\n", *p);
    return 0;
}`;
    const { result } = runValid(code);
    expectFailure(result, { kind: 'runtime', messageIncludes: '空指针解引用', line: 4 });
    expect(result.error?.hint).toContain('NULL');
    expect(result.error?.range?.startLine).toBe(4);
  });

  it('数组越界读写都明确报错', () => {
    const write = runValid(`#include <stdio.h>
int main(void) {
    int arr[3] = {1, 2, 3};
    arr[3] = 9;
    return 0;
}`);
    expectFailure(write.result, { kind: 'runtime', messageIncludes: '数组越界', line: 4 });
    expect(write.result.error?.message).toContain('0..2');

    const read = runValid(`#include <stdio.h>
int main(void) {
    int arr[3] = {1, 2, 3};
    printf("%d\\n", arr[-1]);
    return 0;
}`);
    expectFailure(read.result, { kind: 'runtime', messageIncludes: '数组越界', line: 4 });
    expect(read.result.error?.message).toContain('arr[-1]');
  });

  it('读取未初始化变量报错，结构体成员同样检查', () => {
    const scalar = runValid(`#include <stdio.h>
int main(void) {
    int x;
    printf("%d\\n", x);
    return 0;
}`);
    expectFailure(scalar.result, { kind: 'runtime', messageIncludes: '未初始化的变量 "x"', line: 4 });

    const member = runValid(`#include <stdio.h>
typedef struct P { int x; int y; } P;
int main(void) {
    P p;
    p.x = 1;
    printf("%d\\n", p.y);
    return 0;
}`);
    expectFailure(member.result, { kind: 'runtime', messageIncludes: '未初始化的结构体成员', line: 6 });
  });

  it('浮点数除以 0 不中止，而是得到 inf 并给出 warning', () => {
    const code = `#include <stdio.h>
int main(void) {
    double d = 0.0;
    printf("%f\\n", 1.0 / d);
    return 0;
}`;
    const { result } = runValid(code);
    expectOk(result);
    expect(result.stdout).toBe('inf\n');
    expect(result.warnings.some((warning) => warning.includes('浮点数除以 0'))).toBe(true);
  });

  it('同一作用域重复声明变量报错', () => {
    const { result } = runValid(`#include <stdio.h>
int main(void) { int x = 1; int x = 2; printf("%d\\n", x); return 0; }`);
    expectFailure(result, { kind: 'runtime', messageIncludes: '重复声明变量 "x"' });
  });
});

describe('执行限制与不支持能力', () => {
  it('超出步数上限时标记 truncated 并说明疑似死循环', () => {
    const code = `#include <stdio.h>
int main(void) {
    int i = 0;
    while (1) { i++; }
    return 0;
}`;
    const { result } = runValid(code, { maxSteps: 20 });
    expectFailure(result, { kind: 'limit', messageIncludes: '执行步数超过上限 20 步', line: 4 });
    expect(result.truncated).toBe(true);
    expect(result.error?.message).toContain('死循环');
    expect(result.error?.hint).toContain('循环条件');
    // 20 个正常快照 + 1 个 error 现场快照
    expect(result.snapshots).toHaveLength(21);
    expect(result.snapshots[result.snapshots.length - 1].description).toContain('执行中止');
  });

  it('没有 main 函数时明确报告 unsupported', () => {
    const { result } = runValid(`#include <stdio.h>
int helper(int x) { return x + 1; }`);
    expect(result.status).toBe('error');
    expect(result.error?.kind).toBe('unsupported');
    expect(result.error?.message).toContain('没有找到可执行的 main 函数');
    expect(result.reason).toContain('没有找到可执行的 main 函数');
    expect(result.entryFunction).toBeUndefined();
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].phase).toBe('error');
  });

  it('只有声明没有函数体的 main 同样报错', () => {
    const { result } = runValid('int main(void);');
    expectFailure(result, { kind: 'unsupported', messageIncludes: '只有声明、没有函数体' });
    expect(result.error?.hint).toContain('函数体');
  });

  it('scanf 等标准输入函数明确报不支持，而不是伪造输入', () => {
    const code = `#include <stdio.h>
int main(void) {
    int x = 0;
    scanf("%d", &x);
    return 0;
}`;
    const { result } = runValid(code);
    expectFailure(result, { kind: 'unsupported', messageIncludes: '不支持函数 scanf', line: 4 });
    expect(result.error?.message).toContain('标准输入');
    expect(result.reason).toContain('scanf');
    expect(result.error?.hint).toContain('只支持 printf');
    expect(result.stdout).toBe('');
    expect(result.truncated).toBe(false);
  });

  it('goto 等未支持语法在执行时明确报错', () => {
    const code = `#include <stdio.h>
int main(void) {
    goto end;
end:
    return 0;
}`;
    const { result } = run(code);
    expect(result.status).toBe('error');
    expect(result.error?.kind).toBe('unsupported');
    expect(result.error?.message).toContain('暂不支持');
    expect(result.error?.message).toContain('goto');
    expect(result.snapshots[result.snapshots.length - 1].phase).toBe('error');
  });
});

// ==================================================================
// 一致性与可重复执行
// ==================================================================

describe('重复执行一致性', () => {
  it('同一源码两次独立执行得到完全相同的快照与输出', () => {
    const first = runValid(LINKED_LIST_SAMPLE).result;
    const second = runValid(LINKED_LIST_SAMPLE).result;
    expectOk(first);
    expectOk(second);
    expect(second.status).toBe(first.status);
    expect(second.stdout).toBe(first.stdout);
    expect(second.entryFunction).toBe(first.entryFunction);
    expect(second.snapshots).toHaveLength(first.snapshots.length);
    expect(JSON.stringify(second.snapshots)).toBe(JSON.stringify(first.snapshots));
  });

  it('简单的数学程序两次执行结果一致且无外部依赖', () => {
    const code = `#include <stdio.h>
int main(void) {
    int sum = 0;
    for (int i = 1; i <= 10; i++) sum += i;
    printf("%d\\n", sum);
    return 0;
}`;
    const first = runValid(code).result;
    const second = runValid(code).result;
    expectOk(first);
    expect(first.stdout).toBe('55\n');
    expect(JSON.stringify(second.snapshots)).toBe(JSON.stringify(first.snapshots));
  });
});
