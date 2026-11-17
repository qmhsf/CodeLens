import { describe, expect, it } from 'vitest';
import { SourceFile } from '../src/core/source';
import { parseC } from '../src/core/cParser';
import { buildIndex, findDeepestNodeAt, type VarDeclNode, type FuncDeclNode, type StructDeclNode } from '../src/core/ast';

/** 解析辅助函数：返回解析结果与符号索引 */
function parse(code: string) {
  const source = new SourceFile(code);
  const result = parseC(source);
  const index = buildIndex(result.program);
  return { source, ...result, index };
}

const LINKED_LIST_SAMPLE = `#include <stdio.h>
#include <stdlib.h>

typedef struct LNode {
    int data;
    struct LNode *next;
} LNode;

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
    LNode *head = NULL;
    for (int i = 0; i < 3; i++) {
        LNode *node = createNode(i);
        node->next = head;
        head = node;
    }
    LNode *cur = head;
    while (cur != NULL) {
        printf("%d -> ", cur->data);
        cur = cur->next;
    }
    printf("NULL\\n");
    return 0;
}
`;

describe('C 词法 + 语法分析基础', () => {
  it('解析最简单的 main 函数', () => {
    const { program, issues } = parse('int main(void) { return 0; }\n');
    expect(issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
    expect(program.items).toHaveLength(1);
    const fn = program.items[0] as FuncDeclNode;
    expect(fn.kind).toBe('FuncDecl');
    expect(fn.name.name).toBe('main');
    expect(fn.isDefinition).toBe(true);
    expect(fn.returnType.name).toBe('int');
    expect(fn.params).toHaveLength(0);
    expect(fn.body?.statements).toHaveLength(1);
    expect(fn.body?.statements[0].kind).toBe('Return');
  });

  it('解析变量声明、指针、数组与初始化列表', () => {
    const { program } = parse('int a = 1, *p, arr[3] = {1, 2, 3};\n');
    const decl = program.items[0] as VarDeclNode;
    expect(decl.kind).toBe('VarDecl');
    expect(decl.declarators).toHaveLength(3);
    expect(decl.declarators[0].name.name).toBe('a');
    expect(decl.declarators[0].initializer?.kind).toBe('Literal');
    expect(decl.declarators[1].pointerDepth).toBe(1);
    expect(decl.declarators[1].pointerStars).toHaveLength(1);
    expect(decl.declarators[2].arrayDims).toHaveLength(1);
    expect(decl.declarators[2].initializer?.kind).toBe('InitList');
    expect(decl.type.name).toBe('int');
  });

  it('解析 typedef struct 与成员', () => {
    const { program, index } = parse('typedef struct Node { int value; struct Node *next; } Node;\n');
    // 顶层会拆成两个节点：结构体定义 + typedef 别名
    expect(program.items).toHaveLength(2);
    const structDecl = program.items[0] as StructDeclNode;
    expect(structDecl.kind).toBe('StructDecl');
    expect(structDecl.tag?.name).toBe('Node');
    expect(structDecl.fields).toHaveLength(2);
    expect(structDecl.fields[0].declarators[0].name.name).toBe('value');
    expect(structDecl.fields[1].type.name).toBe('struct Node');
    expect(structDecl.fields[1].declarators[0].pointerDepth).toBe(1);
    expect(structDecl.typedefNames[0].name).toBe('Node');
    expect(index.structs.get('Node')).toBe(structDecl);
    expect(program.items[1].kind).toBe('Typedef');
  });

  it('解析 if/else、for、while、do-while、switch', () => {
    const code = `int f(int n) {
  int sum = 0;
  if (n > 0) { sum = n; } else { sum = -n; }
  for (int i = 0; i < n; i++) { sum += i; }
  while (sum > 0) { sum--; }
  do { sum++; } while (sum < 3);
  switch (sum) {
    case 0: sum = 10; break;
    case 1: sum = 20; break;
    default: sum = -1;
  }
  return sum;
}`;
    const { program, issues } = parse(code);
    const fn = program.items[0] as FuncDeclNode;
    expect(issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
    const kinds = fn.body?.statements.map((statement) => statement.kind);
    expect(kinds).toEqual(['VarDecl', 'If', 'For', 'While', 'DoWhile', 'Switch', 'Return']);
    const switchNode = fn.body?.statements[5];
    expect(switchNode?.kind).toBe('Switch');
    if (switchNode?.kind === 'Switch') {
      expect(switchNode.clauses).toHaveLength(3);
      expect(switchNode.clauses[0].test?.kind).toBe('Literal');
      expect(switchNode.clauses[2].isDefault).toBe(true);
    }
  });

  it('解析完整的链表示例且不产生语法错误', () => {
    const { program, issues, index } = parse(LINKED_LIST_SAMPLE);
    const errors = issues.filter((issue) => issue.severity === 'error');
    expect(errors, JSON.stringify(errors.slice(0, 3), null, 2)).toHaveLength(0);
    expect(program.items.length).toBeGreaterThanOrEqual(5);
    expect(index.functions.get('main')).toHaveLength(1);
    expect(index.functions.get('createNode')).toHaveLength(1);
    expect(index.functions.get('main')?.[0].isDefinition).toBe(true);
    // 函数体内的 for 循环应当被识别
    const mainFn = index.functions.get('main')?.[0];
    const kinds = mainFn?.body?.statements.map((statement) => statement.kind) ?? [];
    expect(kinds).toContain('For');
    expect(kinds).toContain('While');
  });

  it('收集注释', () => {
    const { program } = parse('// 行注释\nint a = 1; /* 块注释 */\n');
    expect(program.comments).toHaveLength(2);
    expect(program.comments[0].text).toContain('行注释');
    expect(program.comments[1].isBlock).toBe(true);
  });

  it('解析预处理指令并保留原文', () => {
    const { program } = parse('#include <stdio.h>\n#define MAX 10\nint arr[MAX];\n');
    const first = program.items[0];
    const second = program.items[1];
    const third = program.items[2] as VarDeclNode;
    expect(first.kind).toBe('Preprocessor');
    if (first.kind === 'Preprocessor') expect(first.raw).toContain('stdio.h');
    if (second.kind === 'Preprocessor') expect(second.directive).toBe('define');
    // MAX 未定义成 typedef，数组维度被当作标识符表达式
    expect(third.kind).toBe('VarDecl');
    expect(third.declarators[0].arrayDims[0]?.kind).toBe('Identifier');
  });

  it('解析嵌套条件与函数调用表达式', () => {
    const { program } = parse('int main() { if (a && b || !c) printf("%d", x > 3 ? 1 : 2); return 0; }\n');
    const fn = program.items[0] as FuncDeclNode;
    const ifStmt = fn.body?.statements[0];
    expect(ifStmt?.kind).toBe('If');
    if (ifStmt?.kind === 'If') {
      expect(ifStmt.test.kind).toBe('Binary');
      expect(ifStmt.consequent.kind).toBe('ExprStmt');
      if (ifStmt.consequent.kind === 'ExprStmt') {
        expect(ifStmt.consequent.expression.kind).toBe('Call');
      }
    }
  });

  it('对缺失分号给出错误并继续解析后续函数', () => {
    const code = `int broken() {
  int a = 1
  return a;
}
int nextFn() { return 1; }
`;
    const { program, issues } = parse(code);
    expect(issues.some((issue) => issue.severity === 'error')).toBe(true);
    const fnNames = program.items
      .filter((item): item is FuncDeclNode => item.kind === 'FuncDecl')
      .map((item) => item.name.name);
    expect(fnNames).toContain('nextFn');
  });

  it('对未知语法给出明确提示而不是静默丢弃', () => {
    const { program, issues } = parse('int f() { goto end; end: return 0; }\n');
    expect(issues.some((issue) => issue.message.includes('goto'))).toBe(true);
    expect(program.items.length).toBeGreaterThan(0);
  });

  it('解析类型转换与 sizeof', () => {
    const { program } = parse('int main() { char *s = (char *)malloc(sizeof(int) * 4); return 0; }\n');
    const fn = program.items[0] as FuncDeclNode;
    expect(fn.body).toBeTruthy();
    const decl = fn.body?.statements[0];
    expect(decl?.kind).toBe('VarDecl');
    if (decl?.kind === 'VarDecl') {
      const init = decl.declarators[0].initializer;
      // 优先级：类型转换作用于整个 malloc(...) 调用
      expect(init?.kind).toBe('Cast');
      if (init?.kind === 'Cast') {
        expect(init.type.name).toBe('char');
        expect(init.pointerDepth).toBe(1);
        expect(init.expr.kind).toBe('Call');
        if (init.expr.kind === 'Call') {
          const argument = init.expr.args[0];
          expect(argument.kind).toBe('Binary');
          if (argument.kind === 'Binary') {
            expect(argument.op).toBe('*');
            expect(argument.left.kind).toBe('Sizeof');
            if (argument.left.kind === 'Sizeof') {
              expect(argument.left.typeName?.name).toBe('int');
            }
          }
        }
      }
    }
  });

  it('根据偏移找到最深层节点', () => {
    const code = 'int main() {\n  int value = 42;\n  return value;\n}\n';
    const { source, program } = parse(code);
    const valueOffset = code.indexOf('value = 42') + 2;
    const node = findDeepestNodeAt(program, valueOffset);
    expect(node?.kind).toBe('Identifier');
    if (node?.kind === 'Identifier') expect(node.name).toBe('value');
    expect(source.positionAt(valueOffset).line).toBe(2);
  });

  it('空代码不会崩溃', () => {
    const { program, issues } = parse('');
    expect(program.items).toHaveLength(0);
    expect(issues).toHaveLength(0);
  });
});
