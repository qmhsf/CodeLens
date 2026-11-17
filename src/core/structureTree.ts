/**
 * C 代码结构树生成器
 * ------------------------------------------------------------------
 * 把 AST 转换为面向初学者的中文结构树：
 * 程序 → 函数定义 → 参数 / 函数体 → 局部变量 / 条件判断 / 循环 ...
 * 每个节点都保留源码区间，点击即可定位到编辑器对应位置。
 */
import {
  type BlockNode,
  type CNodeIndex,
  type ExprNode,
  type FuncDeclNode,
  type ProgramNode,
  type StmtNode,
  type StructDeclNode,
  type TopLevelNode,
  type TypeRef,
  type VarDeclNode,
} from './ast';
import type { StructureNode } from './analysisTypes';
import type { SourceFile, SourceRange } from './source';

interface BuildContext {
  source: SourceFile;
  index: CNodeIndex;
}

export function buildCStructureTree(program: ProgramNode, index: CNodeIndex, source: SourceFile): StructureNode[] {
  const context: BuildContext = { source, index };
  const children: StructureNode[] = [];
  for (const item of program.items) {
    const node = buildTopLevel(item, context, false);
    if (node) children.push(node);
  }
  const totalLines = source.lineCount;
  return [
    {
      id: `st_${program.id}`,
      label: '程序',
      kind: 'program',
      icon: 'program',
      secondary: `${totalLines} 行代码`,
      range: program.range,
      nodeId: program.id,
      badges: [],
      children,
    },
  ];
}

function makeNode(
  input: {
    id: string;
    label: string;
    kind: string;
    range?: SourceRange;
    nodeId?: string;
    secondary?: string;
    icon?: string;
    badges?: string[];
    children?: StructureNode[];
  },
): StructureNode {
  return {
    id: input.id,
    label: input.label,
    kind: input.kind,
    secondary: input.secondary,
    icon: input.icon,
    range: input.range,
    nodeId: input.nodeId,
    badges: input.badges ?? [],
    children: input.children ?? [],
  };
}

function buildTopLevel(node: TopLevelNode, context: BuildContext, inFunction: boolean): StructureNode | undefined {
  switch (node.kind) {
    case 'Preprocessor': {
      const directive = node.directive || '预处理';
      return makeNode({
        id: `st_${node.id}`,
        label: `预处理指令 #${directive}`,
        kind: 'preprocessor',
        secondary: truncate(node.raw.replace(/\s+/g, ' '), 60),
        range: node.range,
        nodeId: node.id,
      });
    }
    case 'StructDecl':
      return buildStruct(node, context);
    case 'Typedef':
      return makeNode({
        id: `st_${node.id}`,
        label: `类型别名 ${node.alias.name}`,
        kind: 'typedef',
        secondary: `= ${formatType(node.target)}${' *'.repeat(node.pointerDepth)}`,
        range: node.range,
        nodeId: node.id,
      });
    case 'FuncDecl':
      return buildFunction(node, context);
    case 'VarDecl':
      return buildVarDecl(node, context, inFunction);
    case 'Comment':
      return undefined;
    case 'Unknown':
      return makeNode({
        id: `st_${node.id}`,
        label: '未解析片段',
        kind: 'unknown',
        secondary: node.note,
        range: node.range,
        nodeId: node.id,
        badges: ['不支持'],
      });
    default:
      return undefined;
  }
}

function buildStruct(node: StructDeclNode, context: BuildContext): StructureNode {
  const fields = node.fields.map((field) => {
    const declarator = field.declarators[0];
    const name = declarator?.name.name ?? '成员';
    const isEnum = node.isEnum;
    return makeNode({
      id: `st_${field.id}`,
      label: isEnum ? `枚举成员 ${name}` : `成员 ${name}`,
      kind: isEnum ? 'enum-member' : 'field',
      secondary: isEnum
        ? declarator?.initializer
          ? `= ${truncate(context.source.slice(declarator.initializer.range), 30)}`
          : ''
        : formatType(field.type, declarator?.pointerDepth ?? 0, declarator?.arrayDims.length ?? 0),
      range: field.range,
      nodeId: field.id,
    });
  });
  const label = node.isEnum ? '枚举定义' : node.isUnion ? '联合体定义' : '结构体定义';
  const name = node.tag?.name ?? node.typedefNames[0]?.name ?? '匿名';
  return makeNode({
    id: `st_${node.id}`,
    label: `${label} ${name}`,
    kind: node.isEnum ? 'enum' : 'struct',
    secondary: node.tag && node.typedefNames.length > 0 ? `tag: ${node.tag.name}` : undefined,
    range: node.range,
    nodeId: node.id,
    badges: node.typedefNames.map((alias) => `别名 ${alias.name}`),
    children: fields,
  });
}

function buildFunction(node: FuncDeclNode, context: BuildContext): StructureNode {
  const params = node.params.map((param) =>
    makeNode({
      id: `st_${param.id}`,
      label: `参数 ${param.name?.name ?? '(匿名)'}`,
      kind: 'parameter',
      secondary: formatType(param.type, param.pointerDepth, param.arrayDims.length),
      range: param.range,
      nodeId: param.id,
    }),
  );

  const children: StructureNode[] = [...params];
  if (node.body) {
    children.push(buildBlockWrapper(node.body, context, '函数体', 'function-body'));
  }
  return makeNode({
    id: `st_${node.id}`,
    label: `${node.isDefinition ? '函数定义' : '函数声明'} ${node.name.name}`,
    kind: 'function',
    secondary: `${formatType(node.returnType, node.returnPointerDepth, 0).trim()} ${node.name.name}(${node.params
      .map((param) => (param.name ? `${formatType(param.type, param.pointerDepth, param.arrayDims.length)} ${param.name.name}` : formatType(param.type, param.pointerDepth, param.arrayDims.length)))
      .join(', ')})`,
    range: node.range,
    nodeId: node.id,
    badges: node.isDefinition ? [] : ['仅声明'],
    children,
  });
}

function buildVarDecl(node: VarDeclNode, context: BuildContext, inFunction: boolean): StructureNode {
  const declarators = node.declarators.map((declarator) => {
    const typeText = formatType(node.type, declarator.pointerDepth, declarator.arrayDims.length);
    const init = declarator.initializer
      ? ` = ${truncate(context.source.slice(declarator.initializer.range), 45)}`
      : '';
    const child: StructureNode = makeNode({
      id: `st_${declarator.id}`,
      label: declarator.name.name,
      kind: 'variable',
      secondary: `${typeText}${init}`,
      range: declarator.range,
      nodeId: declarator.name.id,
      badges: [
        ...(node.storage ? [node.storage] : []),
        ...(declarator.pointerDepth > 0 ? ['指针'] : []),
        ...(declarator.arrayDims.length > 0 ? ['数组'] : []),
      ],
    });
    return child;
  });
  const label = inFunction ? '局部变量声明' : '全局变量声明';
  return makeNode({
    id: `st_${node.id}`,
    label,
    kind: inFunction ? 'local-declaration' : 'global-declaration',
    secondary: formatType(node.type),
    range: node.range,
    nodeId: node.id,
    children: declarators,
  });
}

function buildBlockWrapper(block: BlockNode, context: BuildContext, label: string, kind: string): StructureNode {
  return makeNode({
    id: `st_${block.id}`,
    label,
    kind,
    range: block.range,
    nodeId: block.id,
    children: block.statements.map((statement) => buildStatement(statement, context)),
  });
}

function buildStatement(statement: StmtNode, context: BuildContext): StructureNode {
  switch (statement.kind) {
    case 'Block':
      return buildBlockWrapper(statement, context, '代码块', 'block');
    case 'VarDecl':
      return buildVarDecl(statement, context, true);
    case 'ExprStmt':
      return buildExpressionStatement(statement.expression, statement, context);
    case 'If':
      return buildIf(statement, context);
    case 'For':
      return buildFor(statement, context);
    case 'While':
      return makeNode({
        id: `st_${statement.id}`,
        label: 'while 循环',
        kind: 'while',
        secondary: truncate(context.source.slice(statement.test.range), 60),
        range: statement.range,
        nodeId: statement.id,
        children: [
          makeNode({
            id: `st_${statement.test.id}`,
            label: '循环条件',
            kind: 'condition',
            secondary: truncate(context.source.slice(statement.test.range), 60),
            range: statement.test.range,
            nodeId: statement.test.id,
          }),
          buildBodyWrapper(statement.body, context, '循环体'),
        ],
      });
    case 'DoWhile':
      return makeNode({
        id: `st_${statement.id}`,
        label: 'do-while 循环',
        kind: 'do-while',
        secondary: `先执行一次，再判断 ${truncate(context.source.slice(statement.test.range), 40)}`,
        range: statement.range,
        nodeId: statement.id,
        children: [
          buildBodyWrapper(statement.body, context, '循环体'),
          makeNode({
            id: `st_${statement.test.id}`,
            label: '循环条件',
            kind: 'condition',
            secondary: truncate(context.source.slice(statement.test.range), 60),
            range: statement.test.range,
            nodeId: statement.test.id,
          }),
        ],
      });
    case 'Switch':
      return makeNode({
        id: `st_${statement.id}`,
        label: 'switch 多分支',
        kind: 'switch',
        secondary: truncate(context.source.slice(statement.discriminant.range), 50),
        range: statement.range,
        nodeId: statement.id,
        children: [
          makeNode({
            id: `st_${statement.discriminant.id}`,
            label: '判断表达式',
            kind: 'condition',
            secondary: truncate(context.source.slice(statement.discriminant.range), 60),
            range: statement.discriminant.range,
            nodeId: statement.discriminant.id,
          }),
          ...statement.clauses.map((clause) =>
            makeNode({
              id: `st_${clause.id}`,
              label: clause.isDefault ? 'default 默认分支' : `case ${truncate(context.source.slice(clause.test?.range ?? clause.range), 30)}`,
              kind: clause.isDefault ? 'default-clause' : 'case-clause',
              range: clause.range,
              nodeId: clause.id,
              badges: ['可贯穿'],
              children: clause.statements.map((child) => buildStatement(child, context)),
            }),
          ),
        ],
      });
    case 'Return':
      return makeNode({
        id: `st_${statement.id}`,
        label: '返回语句 return',
        kind: 'return',
        secondary: statement.argument ? truncate(context.source.slice(statement.argument.range), 60) : '返回空值',
        range: statement.range,
        nodeId: statement.id,
        children: statement.argument ? [buildExpressionChild(statement.argument, context)] : [],
      });
    case 'Break':
      return makeNode({
        id: `st_${statement.id}`,
        label: 'break 跳出',
        kind: 'break',
        range: statement.range,
        nodeId: statement.id,
      });
    case 'Continue':
      return makeNode({
        id: `st_${statement.id}`,
        label: 'continue 继续下一轮',
        kind: 'continue',
        range: statement.range,
        nodeId: statement.id,
      });
    case 'EmptyStmt':
      return makeNode({
        id: `st_${statement.id}`,
        label: '空语句 ;',
        kind: 'empty',
        range: statement.range,
        nodeId: statement.id,
      });
    case 'Unknown':
      return makeNode({
        id: `st_${statement.id}`,
        label: '未解析语句',
        kind: 'unknown',
        secondary: statement.note,
        range: statement.range,
        nodeId: statement.id,
        badges: ['不支持'],
      });
  }
}

function buildIf(node: Extract<StmtNode, { kind: 'If' }>, context: BuildContext): StructureNode {
  const children: StructureNode[] = [
    makeNode({
      id: `st_${node.test.id}`,
      label: '判断条件',
      kind: 'condition',
      secondary: truncate(context.source.slice(node.test.range), 60),
      range: node.test.range,
      nodeId: node.test.id,
    }),
    buildBodyWrapper(node.consequent, context, '条件成立时'),
  ];
  if (node.alternate) {
    children.push(buildBodyWrapper(node.alternate, context, '否则（else）'));
  }
  return makeNode({
    id: `st_${node.id}`,
    label: '条件判断 if',
    kind: 'if',
    secondary: node.alternate ? '包含 else 分支' : undefined,
    range: node.range,
    nodeId: node.id,
    children,
  });
}

function buildFor(node: Extract<StmtNode, { kind: 'For' }>, context: BuildContext): StructureNode {
  const children: StructureNode[] = [];
  if (node.init && node.init.kind !== 'EmptyStmt') {
    children.push(
      makeNode({
        id: `st_${node.init.id}`,
        label: '循环初始化',
        kind: 'loop-init',
        secondary: truncate(context.source.slice(node.init.range).replace(/;$/, ''), 50),
        range: node.init.range,
        nodeId: node.init.id,
      }),
    );
  }
  if (node.test) {
    children.push(
      makeNode({
        id: `st_${node.test.id}`,
        label: '循环条件',
        kind: 'condition',
        secondary: truncate(context.source.slice(node.test.range), 50),
        range: node.test.range,
        nodeId: node.test.id,
      }),
    );
  }
  if (node.update) {
    children.push(
      makeNode({
        id: `st_${node.update.id}`,
        label: '循环后更新',
        kind: 'loop-update',
        secondary: truncate(context.source.slice(node.update.range), 40),
        range: node.update.range,
        nodeId: node.update.id,
      }),
    );
  }
  children.push(buildBodyWrapper(node.body, context, '循环体'));
  return makeNode({
    id: `st_${node.id}`,
    label: 'for 循环',
    kind: 'for',
    secondary: truncate(context.source.text.slice(node.range.start, node.body.range.start).replace(/\)\s*$/, ')'), 70),
    range: node.range,
    nodeId: node.id,
    children,
  });
}

function buildBodyWrapper(node: StmtNode, context: BuildContext, label: string): StructureNode {
  if (node.kind === 'Block') return buildBlockWrapper(node, context, label, 'block');
  return makeNode({
    id: `st_wrap_${node.id}`,
    label,
    kind: 'block',
    range: node.range,
    nodeId: node.id,
    children: [buildStatement(node, context)],
  });
}

function buildExpressionStatement(
  expression: ExprNode,
  statement: Extract<StmtNode, { kind: 'ExprStmt' }>,
  context: BuildContext,
): StructureNode {
  let label = '表达式语句';
  let kind = 'expression-statement';
  if (expression.kind === 'Assign') {
    label = '赋值语句';
    kind = 'assignment';
  } else if (expression.kind === 'Call') {
    label = '函数调用';
    kind = 'call';
  } else if (expression.kind === 'Update') {
    label = '自增 / 自减';
    kind = 'update';
  } else if (expression.kind === 'Comma') {
    label = '逗号表达式语句';
    kind = 'comma';
  }
  return makeNode({
    id: `st_${statement.id}`,
    label,
    kind,
    secondary: truncate(context.source.slice(expression.range), 70),
    range: statement.range,
    nodeId: statement.id,
    children: expression.kind === 'Call' ? [buildExpressionChild(expression, context)] : [],
  });
}

/** 为调用/返回等语句生成可点击的表达式子节点 */
function buildExpressionChild(expression: ExprNode, context: BuildContext): StructureNode {
  if (expression.kind === 'Call') {
    const calleeName = expression.callee.kind === 'Identifier' ? expression.callee.name : context.source.slice(expression.callee.range);
    return makeNode({
      id: `st_${expression.id}`,
      label: `函数调用 ${calleeName}()`,
      kind: 'call',
      secondary: truncate(context.source.slice(expression.range), 60),
      range: expression.range,
      nodeId: expression.id,
    });
  }
  return makeNode({
    id: `st_${expression.id}`,
    label: '表达式',
    kind: 'expression',
    secondary: truncate(context.source.slice(expression.range), 60),
    range: expression.range,
    nodeId: expression.id,
  });
}

function formatType(type: TypeRef, pointerDepth = 0, arrayDims = 0): string {
  return `${type.name}${' *'.repeat(pointerDepth)}${'[]'.repeat(arrayDims)}`;
}

function truncate(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
