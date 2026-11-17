/**
 * 语义分类颜色规范
 * ------------------------------------------------------------------
 * 所有颜色都只作用于「前景文字」，并经过对比度筛选，保证代码可读性；
 * 结构边界使用低透明度背景色，避免与文字颜色冲突。
 * 用户可以在设置面板中修改每一类的颜色，或关闭某一类的着色。
 */
import type { SemanticCategory } from './analysisTypes';

export interface CategoryDefinition {
  id: SemanticCategory;
  label: string;
  description: string;
  /** 深色主题默认色 */
  dark: string;
  /** 浅色主题默认色 */
  light: string;
  /** 图例中的短标签 */
  legend: string;
}

export const SEMANTIC_CATEGORIES: CategoryDefinition[] = [
  {
    id: 'type',
    label: '数据类型',
    legend: '类型',
    description: '内置类型、结构体名、typedef 别名等，例如 int、LNode、struct。',
    dark: '#7aa2f7',
    light: '#1d4ed8',
  },
  {
    id: 'data',
    label: '变量与数据',
    legend: '数据',
    description: '变量名、参数名、成员名以及数字/字符串/字符字面量等信息载体。',
    dark: '#9ece6a',
    light: '#2f9e44',
  },
  {
    id: 'control',
    label: '控制结构',
    legend: '控制',
    description: 'if / else / for / while / return 等决定程序执行流程的关键字。',
    dark: '#bb9af7',
    light: '#7c3aed',
  },
  {
    id: 'function',
    label: '函数与调用',
    legend: '函数',
    description: '函数定义名、函数调用、标准库函数等可被执行的代码单元。',
    dark: '#ff9e64',
    light: '#c2410c',
  },
  {
    id: 'operator',
    label: '运算符与判断',
    legend: '运算',
    description: '算术、比较、逻辑、赋值运算符，是表达式计算的动作。',
    dark: '#f7768e',
    light: '#be123c',
  },
  {
    id: 'pointer',
    label: '指针与内存',
    legend: '指针',
    description: '* 声明符、* 解引用、& 取地址、-> 成员访问、malloc/free、sizeof 等。',
    dark: '#2ac3de',
    light: '#0e7490',
  },
  {
    id: 'comment',
    label: '注释',
    legend: '注释',
    description: '写给人的说明文字，不会参与程序执行。',
    dark: '#6f7787',
    light: '#6b7280',
  },
  {
    id: 'preprocessor',
    label: '预处理指令',
    legend: '预处理',
    description: '#include、#define 等由预处理器处理的指令。',
    dark: '#e0af68',
    light: '#a16207',
  },
  {
    id: 'punctuation',
    label: '标点与结构符号',
    legend: '标点',
    description: '括号、分号、逗号等结构符号；默认使用柔和颜色，不喧宾夺主。',
    dark: '#8b93a7',
    light: '#64748b',
  },
];

export const CATEGORY_BY_ID: Record<SemanticCategory, CategoryDefinition> = Object.fromEntries(
  SEMANTIC_CATEGORIES.map((category) => [category.id, category]),
) as Record<SemanticCategory, CategoryDefinition>;

export const DEFAULT_DARK_COLORS: Record<SemanticCategory, string> = Object.fromEntries(
  SEMANTIC_CATEGORIES.map((category) => [category.id, category.dark]),
) as Record<SemanticCategory, string>;

export const DEFAULT_LIGHT_COLORS: Record<SemanticCategory, string> = Object.fromEntries(
  SEMANTIC_CATEGORIES.map((category) => [category.id, category.light]),
) as Record<SemanticCategory, string>;

/**
 * 结构边界的背景色（深色主题）。
 * 每一层嵌套使用略有差异的透明度，帮助观察者感知层级深度。
 */
export const STRUCTURE_BOUNDARY_DARK = {
  block: 'rgba(122, 162, 247, 0.045)',
  function: 'rgba(158, 206, 106, 0.055)',
  control: 'rgba(187, 154, 247, 0.06)',
  struct: 'rgba(255, 158, 100, 0.055)',
  depthStep: 0.012,
};

export const STRUCTURE_BOUNDARY_LIGHT = {
  block: 'rgba(29, 78, 216, 0.03)',
  function: 'rgba(47, 158, 68, 0.035)',
  control: 'rgba(124, 58, 237, 0.04)',
  struct: 'rgba(194, 65, 12, 0.035)',
  depthStep: 0.01,
};

export type CategoryVisibility = Record<SemanticCategory, boolean>;

export const DEFAULT_CATEGORY_VISIBILITY: CategoryVisibility = {
  type: true,
  data: true,
  control: true,
  function: true,
  operator: true,
  pointer: true,
  comment: true,
  preprocessor: true,
  punctuation: true,
};

export type ColorScheme = Record<SemanticCategory, string>;
