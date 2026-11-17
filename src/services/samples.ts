/**
 * 内置示例代码
 * ------------------------------------------------------------------
 * 这些是真实的、可以直接分析的代码/伪代码，不是伪造的功能演示。
 * 示例覆盖 C 语言的核心学习场景（指针、数组、结构体、链表、递归）以及
 * 中文伪代码与 JS/Python 的结构分析。
 */
import type { LanguageId } from '../core/analysisTypes';

export interface CodeSample {
  id: string;
  title: string;
  description: string;
  language: LanguageId;
  code: string;
  tags: string[];
}

export const SAMPLES: CodeSample[] = [
  {
    id: 'c-linked-list',
    title: '单链表：创建与遍历',
    description: '结构体、指针、malloc 与循环的组合，最适合观察“指针如何把节点串起来”。',
    language: 'c',
    tags: ['指针', '结构体', '链表', 'malloc'],
    code: `#include <stdio.h>
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
`,
  },
  {
    id: 'c-pointer-swap',
    title: '指针：交换两个变量的值',
    description: '观察函数如何通过指针修改调用者的变量，理解“地址传递”。',
    language: 'c',
    tags: ['指针', '函数', '取地址'],
    code: `#include <stdio.h>

/* 通过指针交换两个整数 */
void swap(int *a, int *b) {
    int temp = *a;   // 取出 a 指向的值
    *a = *b;         // 把 b 指向的值写入 a 指向的位置
    *b = temp;
}

int main(void) {
    int x = 10;
    int y = 20;
    printf("交换前: x = %d, y = %d\\n", x, y);
    swap(&x, &y);    // 传递变量地址
    printf("交换后: x = %d, y = %d\\n", x, y);
    return 0;
}
`,
  },
  {
    id: 'c-array-stats',
    title: '数组：求和、最大值与平均值',
    description: '数组、循环与函数返回值；适合观察数组下标与累加过程。',
    language: 'c',
    tags: ['数组', '循环', '函数'],
    code: `#include <stdio.h>

int main(void) {
    int scores[5] = {78, 92, 66, 88, 95};
    int sum = 0;
    int max = scores[0];

    for (int i = 0; i < 5; i++) {
        sum += scores[i];
        if (scores[i] > max) {
            max = scores[i];
        }
    }

    double average = (double)sum / 5;
    printf("总分: %d\\n", sum);
    printf("最高分: %d\\n", max);
    printf("平均分: %.2f\\n", average);

    return 0;
}
`,
  },
  {
    id: 'c-recursion',
    title: '递归：阶乘与调用栈',
    description: '同一个函数反复调用自身，适合结合执行面板观察调用栈与返回值。',
    language: 'c',
    tags: ['递归', '函数', '调用栈'],
    code: `#include <stdio.h>

/* 递归计算 n 的阶乘 */
int factorial(int n) {
    if (n <= 1) {
        return 1;
    }
    return n * factorial(n - 1);
}

int main(void) {
    for (int i = 1; i <= 5; i++) {
        printf("%d! = %d\\n", i, factorial(i));
    }
    return 0;
}
`,
  },
  {
    id: 'c-struct',
    title: '结构体：学生信息',
    description: '结构体定义、变量初始化与成员访问，理解“把相关数据打包”。',
    language: 'c',
    tags: ['结构体', '成员访问', 'typedef'],
    code: `#include <stdio.h>

typedef struct Student {
    char name[20];
    int age;
    double score;
} Student;

int main(void) {
    Student s1 = {"小明", 18, 92.5};
    Student s2;
    s2.age = 19;
    s2.score = 85.0;

    printf("学生1: %s, 年龄 %d, 成绩 %.1f\\n", s1.name, s1.age, s1.score);
    printf("学生2: 年龄 %d, 成绩 %.1f\\n", s2.age, s2.score);
    return 0;
}
`,
  },
  {
    id: 'pseudo-if',
    title: '伪代码：条件判断',
    description: '来自需求示例：变量声明、条件、输出与否则分支；系统会推断结构并生成 C 代码。',
    language: 'pseudo',
    tags: ['伪代码', '条件', '推断'],
    code: `创建一个整数变量 a，赋值为 10。
如果 a 大于 5，就输出 Hello。
否则输出 World。
`,
  },
  {
    id: 'pseudo-loop',
    title: '伪代码：循环累加',
    description: '循环、变量更新与输出；注意生成代码只是建议，不等于原文。',
    language: 'pseudo',
    tags: ['伪代码', '循环', '累加'],
    code: `创建一个整数变量 sum，赋值为 0。
循环 i 从 1 到 5，每次加 1：
    把 sum 设为 sum 加 i。
输出 sum。
`,
  },
  {
    id: 'js-demo',
    title: 'JavaScript：数组过滤',
    description: '结构级分析示例：箭头函数、数组方法与条件分支。',
    language: 'javascript',
    tags: ['JavaScript', '数组', '函数'],
    code: `// 过滤出及格的成绩并计算平均分
const scores = [78, 92, 66, 88, 95];

function passScores(list) {
  return list.filter((score) => score >= 60);
}

const passed = passScores(scores);
let total = 0;
for (const score of passed) {
  total += score;
}
const average = passed.length > 0 ? total / passed.length : 0;
console.log("及格成绩:", passed);
console.log("平均分:", average);
`,
  },
  {
    id: 'python-demo',
    title: 'Python：列表与循环',
    description: '缩进结构解析示例：函数、循环、条件与列表。',
    language: 'python',
    tags: ['Python', '列表', '循环'],
    code: `students = [
    {"name": "小明", "score": 92},
    {"name": "小红", "score": 58},
    {"name": "小刚", "score": 77},
]

def average(scores):
    total = 0
    for score in scores:
        total += score
    return total / len(scores)

scores = [student["score"] for student in students]
print("平均分:", average(scores))

for student in students:
    if student["score"] >= 60:
        print(student["name"], "及格")
    else:
        print(student["name"], "不及格")
`,
  },
];

export const DEFAULT_SAMPLE_ID = 'c-linked-list';

export function getSample(id: string): CodeSample | undefined {
  return SAMPLES.find((sample) => sample.id === id);
}

export function getSampleByLanguage(language: LanguageId): CodeSample | undefined {
  return SAMPLES.find((sample) => sample.language === language);
}
