/**
 * C 语义高亮生成器
 * ------------------------------------------------------------------
 * 输入：AST + 词法 token + 符号表
 * 输出：按「语义类别」而非传统语法类别着色的 token 列表。
 *
 * 分类优先级（同一字符位置取优先级最高者）：
 * 5 注释 / 预处理
 * 4 指针声明符、解引用、->、operator（来自 AST 上下文）
 * 3 标识符（按符号种类区分变量/函数/类型）、字面量
 * 2 类型引用
 * 1 默认词法类别（关键字、标点等）
 *
 * 颜色只是视觉辅助：具体配色与开关由 UI 根据 semanticCatalog.ts 决定。
 */
import { walkAst, type CNode, type ProgramNode } from './ast';
import type { SemanticCategory, SemanticToken } from './analysisTypes';
import { CONTROL_KEYWORDS, type CommentToken, type Token } from './lexer';
import type { SourceFile, SourceRange } from './source';
import type { CSymbolTable } from './symbols';

interface Assignment {
  token: Token;
  category: SemanticCategory;
  subkind?: string;
  symbolId?: string;
  nodeId?: string;
  priority: number;
}

interface BuildOptions {
  program: ProgramNode;
  source: SourceFile;
  tokens: Token[];
  comments: CommentToken[];
  symbols: CSymbolTable;
}

export function buildSemanticTokens(options: BuildOptions): SemanticToken[] {
  const { program, tokens, comments, symbols } = options;
  const tokenByStart = new Map<number, Token>();
  for (const token of tokens) tokenByStart.set(token.start, token);

  const assignments = new Map<number, Assignment>();

  const assign = (
    token: Token | undefined,
    category: SemanticCategory,
    priority: number,
    extra: { subkind?: string; symbolId?: string; nodeId?: string } = {},
  ) => {
    if (!token || token.type === 'eof') return;
    const existing = assignments.get(token.start);
    if (existing && existing.priority > priority) return;
    assignments.set(token.start, { token, category, priority, ...extra });
  };

  /** 将区间内所有 token 标记为某类别（如类型引用） */
  const assignRange = (
    range: SourceRange,
    category: SemanticCategory,
    priority: number,
    extra: { subkind?: string; symbolId?: string; nodeId?: string } = {},
  ) => {
    for (const token of tokens) {
      if (token.type === 'eof') continue;
      if (token.start >= range.start && token.end <= range.end) {
        assign(token, category, priority, extra);
      }
    }
  };

  /** 从 [start, end) 区间中查找指定文本的 token */
  const findToken = (start: number, end: number, value?: string): Token | undefined => {
    return tokens.find(
      (token) =>
        token.type !== 'eof' &&
        token.start >= start &&
        token.end <= end &&
        (value === undefined || token.value === value),
    );
  };

  // ---- 1. 默认词法分类（低优先级） ---------------------------------
  for (const token of tokens) {
    switch (token.type) {
      case 'preprocessor':
        assign(token, 'preprocessor', 5);
        break;
      case 'keyword':
        if (CONTROL_KEYWORDS.has(token.value)) assign(token, 'control', 1);
        else if (token.value === 'sizeof') assign(token, 'pointer', 4);
        else if (token.value === 'true' || token.value === 'false' || token.value === 'nullptr') {
          assign(token, 'data', 1, { subkind: 'literal' });
        } else assign(token, 'operator', 1);
        break;
      case 'typeKeyword':
        assign(token, 'type', 1);
        break;
      case 'number':
      case 'string':
      case 'char':
        assign(token, 'data', 1, { subkind: 'literal' });
        break;
      case 'operator':
        assign(token, 'operator', 1);
        break;
      case 'punctuation':
        assign(token, 'punctuation', 1);
        break;
      default:
        break;
    }
  }

  // ---- 2. 类型引用：按符号表精确关联 ---------------------------------
  for (const reference of symbols.typeReferences) {
    const symbol = symbols.symbols[reference.symbolId];
    const subkind = symbol?.kind === 'typedef' ? 'typedef-reference' : symbol?.kind === 'enum' ? 'enum-reference' : 'struct-reference';
    assignRange(reference.range, 'type', 2, { symbolId: reference.symbolId, subkind });
  }

  // ---- 3. 标识符与字面量：以 AST 为准 ---------------------------------
  walkAst(program, (node) => {
    switch (node.kind) {
      case 'Identifier': {
        const symbolId = symbols.identifierSymbols.get(node.id);
        const symbol = symbolId ? symbols.symbols[symbolId] : undefined;
        const role = symbols.identifierRoles.get(node.id);
        let category: SemanticCategory = 'data';
        let subkind: string | undefined;

        if (symbol) {
          switch (symbol.kind) {
            case 'function':
              category = 'function';
              subkind = role === 'call' ? 'call' : 'declaration';
              break;
            case 'struct':
            case 'typedef':
            case 'enum':
              category = 'type';
              subkind = symbol.kind === 'enum' ? 'enum-reference' : 'struct-reference';
              break;
            case 'field':
              category = 'data';
              subkind = symbol.isPointer ? 'pointer-member' : 'member';
              break;
            case 'variable':
            case 'parameter': {
              category = 'data';
              const type = symbols.getSymbolType(symbolId);
              if (type?.arrayDims) subkind = 'array-variable';
              else if (type && type.pointerDepth > 0) subkind = 'pointer-variable';
              else subkind = symbol.kind === 'parameter' ? 'parameter' : 'variable';
              break;
            }
            default:
              if (role === 'call') {
                category = 'function';
                subkind = 'call-unresolved';
              } else {
                category = 'data';
                subkind = 'unresolved';
              }
              break;
          }
        } else if (role === 'declaration') {
          category = 'data';
          subkind = 'declaration';
        } else {
          category = 'data';
          subkind = 'unresolved';
        }

        assign(
          tokenByStart.get(node.range.start) ?? findToken(node.range.start, node.range.end),
          category,
          3,
          { symbolId, nodeId: node.id, subkind },
        );
        break;
      }
      case 'Literal': {
        const token = tokenByStart.get(node.range.start) ?? findToken(node.range.start, node.range.end);
        assign(token, 'data', 3, { subkind: `literal-${node.literalKind}`, nodeId: node.id });
        break;
      }
      case 'Member': {
        // -> 是内存/指针操作，单独用青色；. 保持标点色
        if (node.arrow) {
          const arrow = findToken(node.object.range.end, node.member.range.start, '->');
          assign(arrow, 'pointer', 4, { subkind: 'arrow', nodeId: node.id });
        }
        break;
      }
      case 'Binary': {
        const operatorToken = findToken(node.left.range.end, node.right.range.start, node.op);
        assign(operatorToken, 'operator', 4, { subkind: 'binary-operator', nodeId: node.id });
        break;
      }
      case 'Assign': {
        const operatorToken = findToken(node.target.range.end, node.value.range.start, node.op);
        assign(operatorToken, 'operator', 4, { subkind: 'assign-operator', nodeId: node.id });
        break;
      }
      case 'Unary': {
        const operatorToken = findToken(node.range.start, node.operand.range.start, node.op);
        if (node.op === '*' || node.op === '&') {
          assign(operatorToken, 'pointer', 4, { subkind: node.op === '*' ? 'deref' : 'address-of', nodeId: node.id });
        } else {
          assign(operatorToken, 'operator', 4, { subkind: 'unary-operator', nodeId: node.id });
        }
        break;
      }
      case 'Update': {
        const operatorToken = node.prefix
          ? findToken(node.range.start, node.operand.range.start, node.op)
          : findToken(node.operand.range.end, node.range.end, node.op);
        assign(operatorToken, 'operator', 4, { subkind: 'update-operator', nodeId: node.id });
        break;
      }
      case 'Conditional': {
        const question = findToken(node.test.range.end, node.consequent.range.start, '?');
        const colon = findToken(node.consequent.range.end, node.alternate.range.start, ':');
        assign(question, 'operator', 4, { subkind: 'ternary', nodeId: node.id });
        assign(colon, 'operator', 4, { subkind: 'ternary', nodeId: node.id });
        break;
      }
      case 'Sizeof': {
        const sizeofToken = findToken(node.range.start, node.range.end, 'sizeof');
        assign(sizeofToken, 'pointer', 4, { subkind: 'sizeof', nodeId: node.id });
        for (const star of node.pointerStars) assignRange(star, 'pointer', 4, { subkind: 'pointer-declarator', nodeId: node.id });
        break;
      }
      case 'Cast': {
        for (const star of node.pointerStars) assignRange(star, 'pointer', 4, { subkind: 'pointer-declarator', nodeId: node.id });
        break;
      }
      case 'VarDecl': {
        for (const declarator of node.declarators) {
          for (const star of declarator.pointerStars) {
            assignRange(star, 'pointer', 4, { subkind: 'pointer-declarator', nodeId: node.id });
          }
        }
        break;
      }
      case 'Param': {
        for (const star of node.pointerStars) {
          assignRange(star, 'pointer', 4, { subkind: 'pointer-declarator', nodeId: node.id });
        }
        break;
      }
      case 'FuncDecl': {
        for (const star of node.returnPointerStars) {
          assignRange(star, 'pointer', 4, { subkind: 'pointer-declarator', nodeId: node.id });
        }
        break;
      }
      case 'Typedef': {
        for (const star of node.pointerStars) {
          assignRange(star, 'pointer', 4, { subkind: 'pointer-declarator', nodeId: node.id });
        }
        break;
      }
      case 'Preprocessor': {
        const token = tokenByStart.get(node.range.start) ?? findToken(node.range.start, node.range.end);
        assign(token, 'preprocessor', 5, { nodeId: node.id });
        break;
      }
      default:
        break;
    }
  });

  // ---- 4. 完全兜底：仍未分类的 token 按词法类型着色 -------------------
  for (const token of tokens) {
    if (assignments.has(token.start) || token.type === 'eof') continue;
    switch (token.type) {
      case 'operator':
        assign(token, 'operator', 1);
        break;
      case 'punctuation':
        assign(token, 'punctuation', 1);
        break;
      case 'typeKeyword':
        assign(token, 'type', 1);
        break;
      default:
        break;
    }
  }

  const result: SemanticToken[] = [];
  for (const assignment of assignments.values()) {
    result.push({
      start: assignment.token.start,
      end: assignment.token.end,
      category: assignment.category,
      subkind: assignment.subkind,
      symbolId: assignment.symbolId,
      nodeId: assignment.nodeId,
    });
  }

  // ---- 5. 注释（注释不在普通 token 流中，单独补充） -------------------
  for (const comment of comments) {
    result.push({
      start: comment.start,
      end: comment.end,
      category: 'comment',
      subkind: comment.isBlock ? 'block-comment' : 'line-comment',
    });
  }

  result.sort((a, b) => a.start - b.start || a.end - b.end);
  return result;
}

/** 判断节点是否属于会被语义高亮覆盖的"可点击叶节点" */
export function isLeafNode(node: CNode): boolean {
  return node.kind === 'Identifier' || node.kind === 'Literal';
}
