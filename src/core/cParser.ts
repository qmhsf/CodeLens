/**
 * C / C++（C 子集）递归下降语法分析器
 * ------------------------------------------------------------------
 * 为什么手写解析器？
 * 1. 浏览器内离线运行，不需要下载 tree-sitter 的 wasm 语法文件；
 * 2. 产出的 AST 保留精确源码区间，能直接服务于语义高亮、释义、结构树与执行；
 * 3. 对初学者常见代码（变量、指针、数组、结构体、链表、函数、循环、条件）
 *    做针对性支持，遇到不支持的语法会明确报错或给出限制提示，而不是静默猜测。
 *
 * 支持的 C 语法子集：
 * - 预处理指令（保留原文，#define 常量供解释器使用）
 * - typedef / struct / union / enum（基础）
 * - 全局/局部变量声明（多声明符、指针、数组、初始化列表）
 * - 函数定义与声明、参数（含数组参数）
 * - 语句：块、if/else、for、while、do-while、switch/case、return、break、continue
 * - 表达式：赋值、复合赋值、三元、逻辑/比较/算术/位运算、函数调用、数组下标、
 *   结构体成员访问（. 与 ->）、取地址/解引用、自增自减、sizeof、类型转换
 *
 * 明确不支持（会报告 issue，不会伪造分析结果）：
 * - 函数指针、位域、goto/标签、K&R 风格函数定义、C++ 模板/STL/类继承等高级特性
 */
import {
  type BlockNode,
  type CaseClauseNode,
  type Declarator,
  type ExprNode,
  type ForNode,
  type FuncDeclNode,
  type IdentifierNode,
  type IfNode,
  type LiteralKind,
  type NodeId,
  type ParamNode,
  type ProgramNode,
  type StmtNode,
  type StructDeclNode,
  type StructFieldNode,
  type SwitchNode,
  type TopLevelNode,
  type TypeRef,
  type TypedefNode,
  type UnknownNode,
  type VarDeclNode,
} from './ast';
import type { ParseIssue } from './analysisTypes';
import {
  isQualifierKeyword,
  isStorageKeyword,
  isTypeSpecifierKeyword,
  tokenizeC,
  type CommentToken,
  type LexResult,
  type Token,
} from './lexer';
import type { SourceFile, SourceRange } from './source';

export interface CParseResult {
  program: ProgramNode;
  issues: ParseIssue[];
}

const ASSIGN_OPS = new Set([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '<<=',
  '>>=',
]);

/** 二元运算符优先级（数值越大优先级越高），与 C 语言一致 */
const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '<': 7,
  '<=': 7,
  '>': 7,
  '>=': 7,
  '<<': 8,
  '>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10,
};

const CPP_TOP_LEVEL_UNSUPPORTED = new Set(['class', 'namespace', 'using', 'template']);
const CPP_EXPRESSION_UNSUPPORTED = new Set(['new', 'delete', 'this']);
const KNOWN_EXTERNAL_TYPES = new Set([
  'FILE',
  'size_t',
  'ssize_t',
  'time_t',
  'clock_t',
  'uint8_t',
  'uint16_t',
  'uint32_t',
  'uint64_t',
  'int8_t',
  'int16_t',
  'int32_t',
  'int64_t',
  'bool',
  'string',
]);

/** 解析过程中的可恢复错误（记录 issue 后由上层回退） */
class RecoverableParseError extends Error {}

/**
 * 解析入口。
 * @param source 已规范化的源码对象（解析器与 UI 共享行索引）
 * @param options.language c 或 cpp（cpp 允许 & 引用语法，但仍只解析 C 子集）
 */
export function parseC(source: SourceFile, options: { language?: 'c' | 'cpp' } = {}): CParseResult {
  const lex = tokenizeC(source);
  const parser = new CParser(lex, source, options.language ?? 'c');
  return parser.run();
}

/** 从预处理指令原文中提取指令名，例如 "#include <stdio.h>" → include */
export function getDirectiveName(raw: string): string {
  const match = raw.match(/^#\s*([A-Za-z_]+)/);
  return match ? match[1] : '';
}

class CParser {
  private readonly tokens: Token[];
  private readonly comments: CommentToken[];
  private readonly source: SourceFile;
  private readonly language: 'c' | 'cpp';
  private readonly issues: ParseIssue[];
  private index = 0;
  private counter = 0;
  /** 已声明的 typedef 名称，帮助识别 `LNode *p;` 这类声明 */
  private typedefNames = new Set<string>();
  /** 已声明的 struct/union/enum 标签名 */
  private structNames = new Set<string>();
  /** 推测解析时暂存 issue 数量，失败后回滚，避免误报 */
  private issueCheckpoint = -1;

  constructor(lex: LexResult, source: SourceFile, language: 'c' | 'cpp') {
    this.tokens = lex.tokens;
    this.comments = lex.comments;
    this.source = source;
    this.language = language;
    this.issues = [...lex.issues];
  }

  run(): CParseResult {
    const items: TopLevelNode[] = [];
    while (!this.atEnd()) {
      const before = this.index;
      try {
        this.parseTopLevelItem(items);
      } catch (error) {
        if (error instanceof RecoverableParseError) {
          this.recoverTopLevel();
        } else {
          throw error;
        }
      }
      // 保证解析器一定前进，避免死循环
      if (this.index === before) this.index += 1;
    }

    const commentNodes = this.comments.map((comment) => ({
      id: this.nodeId(),
      kind: 'Comment' as const,
      range: this.source.range(comment.start, comment.end),
      text: comment.text,
      isBlock: comment.isBlock,
    }));

    const program: ProgramNode = {
      id: this.nodeId(),
      kind: 'Program',
      range: this.source.range(0, this.source.text.length),
      items,
      comments: commentNodes,
    };

    return { program, issues: this.issues };
  }

  // ---------------------------------------------------------------
  // token 操作工具
  // ---------------------------------------------------------------

  private peek(offset = 0): Token {
    const position = Math.min(this.index + offset, this.tokens.length - 1);
    return this.tokens[position];
  }

  private atEnd(): boolean {
    return this.peek().type === 'eof';
  }

  private current(): Token {
    return this.peek();
  }

  private checkValue(value: string, offset = 0): boolean {
    return this.peek(offset).value === value;
  }

  private checkType(type: Token['type'], offset = 0): boolean {
    return this.peek(offset).type === type;
  }

  private next(): Token {
    const token = this.current();
    if (token.type !== 'eof') this.index += 1;
    return token;
  }

  private acceptValue(value: string): boolean {
    if (this.checkValue(value)) {
      this.next();
      return true;
    }
    return false;
  }

  private expectValue(value: string, hint = `缺少 "${value}"`): Token {
    if (this.checkValue(value)) return this.next();
    this.fail(`这里需要 "${value}"`, hint);
    return this.current();
  }

  private expectIdentifier(hint = '这里需要一个标识符（变量名、函数名或类型名）'): Token {
    if (this.checkType('identifier')) return this.next();
    this.fail('这里需要一个标识符', hint);
    return this.current();
  }

  /** 记录错误并抛出可恢复异常 */
  private fail(message: string, hint?: string): never {
    const token = this.current();
    this.addIssue('error', message, hint, this.source.range(token.start, Math.max(token.end, token.start + 1)));
    throw new RecoverableParseError(message);
  }

  private addIssue(
    severity: ParseIssue['severity'],
    message: string,
    hint: string | undefined,
    range: SourceRange,
  ): void {
    // 推测解析失败时回滚 issue，避免把合法的分组表达式误判成语法错误
    if (this.issueCheckpoint >= 0) return;
    this.issues.push({ severity, message, hint, range, line: range.startLine });
  }

  private nodeId(): NodeId {
    this.counter += 1;
    return `c${this.counter}`;
  }

  private range(start: number, end: number): SourceRange {
    return this.source.range(start, end);
  }

  private lastEnd(fallback: number): number {
    const token = this.tokens[Math.max(0, this.index - 1)];
    return token ? token.end : fallback;
  }

  private identifier(token: Token): IdentifierNode {
    return {
      id: this.nodeId(),
      kind: 'Identifier',
      name: token.value,
      range: this.range(token.start, token.end),
    };
  }

  private unknown(start: number, end: number, note: string): UnknownNode {
    return {
      id: this.nodeId(),
      kind: 'Unknown',
      range: this.range(start, end),
      raw: this.source.text.slice(start, end),
      note,
    };
  }

  private beginSpeculation(): void {
    this.issueCheckpoint = this.issues.length;
  }

  private rollbackSpeculation(issueCountBefore: number): void {
    this.issues.length = issueCountBefore;
    this.issueCheckpoint = -1;
  }

  private endSpeculation(): void {
    this.issueCheckpoint = -1;
  }

  // ---------------------------------------------------------------
  // 顶层声明
  // ---------------------------------------------------------------

  private parseTopLevelItem(items: TopLevelNode[]): void {
    const token = this.current();

    if (token.type === 'eof') return;

    if (token.type === 'preprocessor') {
      items.push(this.parsePreprocessor());
      return;
    }

    if (token.value === ';') {
      // 多余的顶层分号：容忍并跳过
      this.next();
      return;
    }

    if (token.value === 'typedef') {
      items.push(...this.parseTypedef());
      return;
    }

    if (CPP_TOP_LEVEL_UNSUPPORTED.has(token.value)) {
      this.parseCppUnsupportedTopLevel(token.value, items);
      return;
    }

    if (token.value === '}') {
      const bad = this.next();
      this.addIssue('error', '多余的右花括号 "}"', '检查花括号是否成对', this.range(bad.start, bad.end));
      return;
    }

    const startOffset = token.start;
    try {
      this.parseDeclarationOrFunction(items, startOffset);
    } catch (error) {
      if (error instanceof RecoverableParseError) {
        this.recoverTopLevel();
        const end = this.lastEnd(startOffset);
        if (end > startOffset) {
          items.push(this.unknown(startOffset, end, '这一段代码无法解析，已跳过。'));
        }
      } else {
        throw error;
      }
    }
  }

  private parsePreprocessor(): TopLevelNode {
    const token = this.next();
    const directive = token.value.match(/^#\s*([A-Za-z_]+)/)?.[1] ?? '';
    return {
      id: this.nodeId(),
      kind: 'Preprocessor',
      range: this.range(token.start, token.end),
      directive,
      raw: token.value,
    };
  }

  private parseCppUnsupportedTopLevel(keyword: string, items: TopLevelNode[]): void {
    const start = this.current().start;
    const token = this.next();
    this.addIssue(
      'warning',
      `C++ 的 ${keyword} 语法暂未支持深度分析`,
      'CodeLens 目前按 C 子集解析 C++ 代码；这段结构会以原样跳过，不影响其余部分分析。',
      this.range(token.start, token.end),
    );
    this.skipTopLevelConstruct();
    items.push(this.unknown(start, this.lastEnd(start), `C++ ${keyword} 结构（暂未深度分析）`));
  }

  /** 跳过一段顶层结构（到分号或成对花括号结束） */
  private skipTopLevelConstruct(): void {
    let depth = 0;
    while (!this.atEnd()) {
      const token = this.current();
      if (token.value === '{') {
        depth += 1;
        this.next();
        continue;
      }
      if (token.value === '}') {
        depth = Math.max(0, depth - 1);
        this.next();
        if (depth === 0) return;
        continue;
      }
      if (token.value === ';' && depth === 0) {
        this.next();
        return;
      }
      this.next();
    }
  }

  private parseDeclarationOrFunction(items: TopLevelNode[], startOffset: number): void {
    const declaration = this.parseStorageAndType();
    if (declaration.structDef) items.push(declaration.structDef);

    if (this.checkValue(';')) {
      const semi = this.next();
      if (!declaration.structDef) {
        this.addIssue(
          'warning',
          '这里只有类型声明，缺少变量名或结构体体',
          '例如应写成 `struct Node { int value; };` 或 `int a;`',
          this.range(startOffset, semi.end),
        );
        items.push(this.unknown(startOffset, semi.end, '缺少声明内容的类型声明'));
      }
      return;
    }

    if (this.checkValue('(')) {
      // int (*fp)(void); 之类的函数指针 / 复杂括号声明
      const token = this.current();
      this.addIssue(
        'warning',
        '暂不支持函数指针等复杂声明',
        '初学阶段常见的 `int *p`、`int a[3]` 均可正常解析；函数指针会跳过。',
        this.range(token.start, token.end),
      );
      this.skipToSemicolon();
      items.push(this.unknown(startOffset, this.lastEnd(startOffset), '复杂的括号声明（暂不支持）'));
      return;
    }

    if (this.looksLikeFunctionDeclaration()) {
      items.push(this.parseFunction(declaration.type, declaration.storage, startOffset));
      return;
    }

    const varDecl = this.parseVarDeclaration(declaration.type, declaration.storage, startOffset, true);
    items.push(varDecl);
  }

  /** 形如 `类型 + 存储说明符` 的声明前缀 */
  private parseStorageAndType(): { type: TypeRef; storage?: string; structDef?: StructDeclNode } {
    const storageParts: string[] = [];
    // const 等限定符由 parseTypeSpec 处理；这里只读取存储类关键字
    while (isStorageKeyword(this.current().value)) {
      if (this.current().value === 'typedef') break;
      storageParts.push(this.next().value);
    }
    const spec = this.parseTypeSpec();
    return {
      type: spec.type,
      storage: storageParts.length ? storageParts.join(' ') : undefined,
      structDef: spec.structDef,
    };
  }

  private parseTypeSpec(): { type: TypeRef; structDef?: StructDeclNode } {
    const start = this.current().start;
    let isConst = false;
    let isUnsigned = false;
    const qualifiers: string[] = [];
    while (isQualifierKeyword(this.current().value)) {
      const qualifier = this.next().value;
      qualifiers.push(qualifier);
      if (qualifier === 'const') isConst = true;
    }

    let typeName = '';
    let isStruct = false;
    let structTag: string | undefined;
    let isCustom = false;
    let structDef: StructDeclNode | undefined;

    const token = this.current();

    if (token.value === 'struct' || token.value === 'union') {
      const parsed = this.parseStructOrUnion(token.value === 'union');
      typeName = parsed.type.name;
      isStruct = true;
      structTag = parsed.type.structTag;
      isCustom = true;
      structDef = parsed.def;
    } else if (token.value === 'enum') {
      const parsed = this.parseEnum();
      typeName = parsed.type.name;
      isStruct = false;
      structTag = parsed.type.structTag;
      isCustom = true;
      structDef = parsed.def;
    } else if (token.type === 'typeKeyword' && isTypeSpecifierKeyword(token.value)) {
      const parts: string[] = [];
      while (isTypeSpecifierKeyword(this.current().value)) {
        const part = this.next().value;
        parts.push(part);
        if (part === 'unsigned') isUnsigned = true;
      }
      if (!parts.some((part) => ['int', 'char', 'short', 'long', 'float', 'double', 'void', 'bool', '_Bool', 'wchar_t'].includes(part))) {
        parts.push('int');
      }
      typeName = parts.join(' ');
    } else if (token.type === 'identifier') {
      typeName = this.next().value;
      isCustom = true;
      if (!this.typedefNames.has(typeName) && !this.structNames.has(typeName) && !KNOWN_EXTERNAL_TYPES.has(typeName)) {
        // 未声明的自定义类型不直接报错：可能来自系统头文件；在释义层会提示
        this.addIssue(
          'info',
          `类型 "${typeName}" 没有在这段代码中定义`,
          '如果它来自系统头文件（如 FILE、size_t）可以忽略；如果是自定义类型，请确认 typedef / struct 是否写完整。',
          this.range(token.start, token.end),
        );
      }
    } else {
      this.fail(
        '这里需要一个数据类型（例如 int、char、double、struct Node 或自定义类型名）',
        '变量声明和函数定义都必须先写类型，例如 `int count = 0;`',
      );
    }

    while (isQualifierKeyword(this.current().value)) {
      const qualifier = this.next().value;
      qualifiers.push(qualifier);
      if (qualifier === 'const') isConst = true;
    }

    const end = this.lastEnd(start);
    const raw = this.source.text.slice(start, end);
    return {
      type: {
        raw,
        name: typeName,
        isStruct,
        structTag,
        isCustom,
        isConst,
        isUnsigned,
        range: this.range(start, end),
      },
      structDef,
    };
  }

  private parseStructOrUnion(isUnion: boolean): { type: TypeRef; def?: StructDeclNode } {
    const startToken = this.next(); // struct / union
    let tag: IdentifierNode | undefined;
    if (this.checkType('identifier')) {
      const token = this.next();
      tag = this.identifier(token);
      this.structNames.add(token.value);
    }

    let fields: StructFieldNode[] = [];
    let end = tag ? tag.range.end : startToken.end;
    let hadBody = false;

    if (this.checkValue('{')) {
      hadBody = true;
      this.next();
      while (!this.atEnd() && !this.checkValue('}')) {
        const before = this.index;
        try {
          const fieldStart = this.current().start;
          if (this.acceptValue(';')) continue;
          const fieldSpec = this.parseTypeSpec();
          if (fieldSpec.structDef) {
            this.addIssue(
              'info',
              '结构体内部嵌套定义的结构体暂不单独展开',
              '可以把它移到外层单独定义，分析会更完整。',
              fieldSpec.structDef.range,
            );
          }
          if (this.checkValue(';')) {
            // 匿名成员（C11）暂不支持
            const semi = this.next();
            this.addIssue(
              'warning',
              '结构体中的匿名成员暂不支持',
              '请为每个成员写明确的成员名。',
              this.range(fieldStart, semi.end),
            );
            continue;
          }
          if (this.checkValue(':')) {
            const colon = this.current();
            this.addIssue(
              'warning',
              '位域（bit-field）暂不支持',
              '初学阶段可以先忽略位域。',
              this.range(colon.start, colon.end),
            );
            this.skipToSemicolon();
            continue;
          }
          const declarators = this.parseDeclarators(false);
          const semi = this.expectValue(';', '结构体成员声明末尾缺少分号');
          const endOffset = semi.end;
          fields.push({
            id: this.nodeId(),
            kind: 'StructField',
            range: this.range(fieldStart, endOffset),
            type: fieldSpec.type,
            declarators,
          });
          end = endOffset;
        } catch (error) {
          if (error instanceof RecoverableParseError) {
            this.recoverStructField();
            if (this.index === before) this.index += 1;
            end = this.lastEnd(end);
          } else {
            throw error;
          }
        }
      }
      const close = this.expectValue('}', '结构体定义缺少右花括号 "}"');
      end = close.end;
    }

    const typeName = tag ? `${isUnion ? 'union' : 'struct'} ${tag.name}` : isUnion ? 'union <匿名>' : 'struct <匿名>';
    const type: TypeRef = {
      raw: this.source.text.slice(startToken.start, end),
      name: typeName,
      isStruct: true,
      structTag: tag?.name,
      isCustom: true,
      isConst: false,
      isUnsigned: false,
      range: this.range(startToken.start, end),
    };

    const def: StructDeclNode | undefined = hadBody
      ? {
          id: this.nodeId(),
          kind: 'StructDecl',
          range: this.range(startToken.start, end),
          tag,
          fields,
          typedefNames: [],
          isUnion,
        }
      : undefined;

    return { type, def };
  }

  private parseEnum(): { type: TypeRef; def?: StructDeclNode } {
    const startToken = this.next(); // enum
    let tag: IdentifierNode | undefined;
    if (this.checkType('identifier')) {
      const token = this.next();
      tag = this.identifier(token);
      this.structNames.add(token.value);
    }
    const enumTypeName = tag ? `enum ${tag.name}` : 'enum <匿名>';
    const enumType: TypeRef = {
      raw: this.source.text.slice(startToken.start, tag ? tag.range.end : startToken.end),
      name: enumTypeName,
      isStruct: false,
      structTag: tag?.name,
      isCustom: true,
      isConst: false,
      isUnsigned: false,
      range: this.range(startToken.start, tag ? tag.range.end : startToken.end),
    };

    let def: StructDeclNode | undefined;
    let end = tag ? tag.range.end : startToken.end;

    if (this.checkValue('{')) {
      this.next();
      const fields: StructFieldNode[] = [];
      while (!this.atEnd() && !this.checkValue('}')) {
        const before = this.index;
        try {
          const memberToken = this.expectIdentifier('枚举成员需要一个名字');
          const name = this.identifier(memberToken);
          const declarator: Declarator = {
            id: this.nodeId(),
            name,
            pointerDepth: 0,
            pointerStars: [],
            isReference: false,
            arrayDims: [],
            range: this.range(memberToken.start, memberToken.end),
          };
          if (this.acceptValue('=')) {
            const init = this.parseConditionalExpression();
            declarator.initializer = init;
            declarator.range = this.range(memberToken.start, init.range.end);
          }
          fields.push({
            id: this.nodeId(),
            kind: 'StructField',
            range: declarator.range,
            type: enumType,
            declarators: [declarator],
          });
          if (!this.acceptValue(',')) {
            if (!this.checkValue('}')) {
              const nextToken = this.current();
              this.addIssue(
                'warning',
                '枚举成员之间缺少逗号',
                undefined,
                this.range(nextToken.start, nextToken.end),
              );
            }
          }
        } catch (error) {
          if (error instanceof RecoverableParseError) {
            this.skipToSemicolon();
            if (this.index === before) this.index += 1;
          } else {
            throw error;
          }
        }
      }
      const close = this.expectValue('}', '枚举定义缺少右花括号 "}"');
      end = close.end;
      def = {
        id: this.nodeId(),
        kind: 'StructDecl',
        range: this.range(startToken.start, end),
        tag,
        fields,
        typedefNames: [],
        isUnion: false,
        isEnum: true,
      };
      enumType.range = this.range(startToken.start, end);
      enumType.raw = this.source.text.slice(startToken.start, end);
    }

    return { type: enumType, def };
  }

  private parseTypedef(): TopLevelNode[] {
    const startToken = this.next(); // typedef
    const nodes: TopLevelNode[] = [];
    const spec = this.parseTypeSpec();
    if (spec.structDef) nodes.push(spec.structDef);

    if (this.checkValue(';')) {
      const semi = this.next();
      this.addIssue('warning', 'typedef 缺少别名', '例如：`typedef struct Node Node;`', this.range(startToken.start, semi.end));
      nodes.push(this.unknown(startToken.start, semi.end, '缺少别名的 typedef'));
      return nodes;
    }

    const declarators = this.parseDeclarators(false);
    const semi = this.expectValue(';', 'typedef 末尾缺少分号');
    for (const declarator of declarators) {
      this.typedefNames.add(declarator.name.name);
      if (spec.structDef) {
        spec.structDef.typedefNames.push(declarator.name);
      }
      const typedefNode: TypedefNode = {
        id: this.nodeId(),
        kind: 'Typedef',
        range: this.range(startToken.start, Math.max(declarator.range.end, semi.start)),
        alias: declarator.name,
        target: spec.type,
        pointerDepth: declarator.pointerDepth,
        pointerStars: declarator.pointerStars,
      };
      nodes.push(typedefNode);
    }
    return nodes;
  }

  private parseVarDeclaration(
    type: TypeRef,
    storage: string | undefined,
    startOffset: number,
    isGlobal: boolean,
  ): VarDeclNode {
    if (this.checkValue('(')) {
      this.fail('函数指针等复杂声明暂不支持', '可以先使用普通指针或数组。');
    }
    const declarators = this.parseDeclarators(true);
    if (declarators.length === 0) {
      this.fail('变量声明缺少变量名', '例如：int count = 0;');
    }
    const semi = this.expectValue(';', '声明末尾缺少分号 ";"');
    return {
      id: this.nodeId(),
      kind: 'VarDecl',
      range: this.range(startOffset, semi.end),
      type,
      declarators,
      storage,
      isGlobal,
    };
  }

  private parseDeclarators(allowInitializer: boolean): Declarator[] {
    const declarators: Declarator[] = [this.parseDeclarator(allowInitializer)];
    while (this.acceptValue(',')) {
      declarators.push(this.parseDeclarator(allowInitializer));
    }
    return declarators;
  }

  private parseDeclarator(allowInitializer: boolean): Declarator {
    const start = this.current().start;
    const pointerStars: SourceRange[] = [];
    let pointerDepth = 0;
    let isReference = false;

    loop: while (true) {
      if (this.checkValue('*')) {
        const star = this.next();
        pointerStars.push(this.range(star.start, star.end));
        pointerDepth += 1;
        while (isQualifierKeyword(this.current().value)) this.next();
        continue;
      }
      if (this.checkValue('&') && this.language === 'cpp') {
        const amp = this.next();
        isReference = true;
        pointerStars.push(this.range(amp.start, amp.end));
        continue;
      }
      break loop;
    }

    if (this.checkValue('(')) {
      this.fail(
        '函数指针和复杂括号声明暂不支持',
        '如果这是 `int (*fp)(int)`，可以先把函数指针改造成普通函数调用后再试。',
      );
    }

    const nameToken = this.expectIdentifier('这里需要变量名或函数名');
    const name = this.identifier(nameToken);
    const arrayDims = this.parseArrayDims();
    let initializer: ExprNode | undefined;
    if (allowInitializer && this.acceptValue('=')) {
      initializer = this.parseInitializer();
    }
    const end = initializer ? initializer.range.end : this.lastEnd(nameToken.end);
    return {
      id: this.nodeId(),
      name,
      pointerDepth,
      pointerStars,
      isReference,
      arrayDims,
      initializer,
      range: this.range(start, end),
    };
  }

  private parseArrayDims(): (ExprNode | null)[] {
    const dims: (ExprNode | null)[] = [];
    while (this.checkValue('[')) {
      this.next();
      if (this.acceptValue(']')) {
        dims.push(null);
        continue;
      }
      const expression = this.parseAssignmentExpression();
      this.expectValue(']', '数组维度缺少右方括号 "]"');
      dims.push(expression);
    }
    return dims;
  }

  private parseInitializer(): ExprNode {
    if (this.checkValue('{')) {
      return this.parseInitializerList();
    }
    return this.parseAssignmentExpression();
  }

  private parseInitializerList(): ExprNode {
    const open = this.next(); // {
    const elements: ExprNode[] = [];
    if (!this.checkValue('}')) {
      while (!this.atEnd()) {
        elements.push(this.parseInitializer());
        if (!this.acceptValue(',')) break;
        if (this.checkValue('}')) break;
      }
    }
    const close = this.expectValue('}', '初始化列表缺少右花括号 "}"');
    return {
      id: this.nodeId(),
      kind: 'InitList',
      range: this.range(open.start, close.end),
      elements,
    };
  }

  private looksLikeFunctionDeclaration(): boolean {
    let offset = 0;
    while (this.checkValue('*', offset) || (this.language === 'cpp' && this.checkValue('&', offset))) {
      offset += 1;
    }
    return this.checkType('identifier', offset) && this.checkValue('(', offset + 1);
  }

  private parseFunction(returnType: TypeRef, storage: string | undefined, startOffset: number): FuncDeclNode {
    const returnPointerStars: SourceRange[] = [];
    let returnPointerDepth = 0;
    while (this.checkValue('*')) {
      const star = this.next();
      returnPointerStars.push(this.range(star.start, star.end));
      returnPointerDepth += 1;
      while (isQualifierKeyword(this.current().value) || isStorageKeyword(this.current().value)) this.next();
    }
    const nameToken = this.expectIdentifier('函数定义需要函数名');
    const name = this.identifier(nameToken);
    if (!this.checkValue('(')) {
      this.fail('函数名后面需要参数列表 "( ... )"', '例如：int main(void) { ... }');
    }
    const params = this.parseParams();
    let body: BlockNode | undefined;
    if (this.checkValue('{')) {
      body = this.parseBlock();
    } else {
      this.expectValue(';', '函数声明末尾缺少分号');
    }
    const end = body ? body.range.end : this.lastEnd(nameToken.end);
    return {
      id: this.nodeId(),
      kind: 'FuncDecl',
      range: this.range(startOffset, end),
      returnType,
      returnPointerDepth,
      returnPointerStars,
      name,
      params,
      body,
      storage,
      isDefinition: Boolean(body),
    };
  }

  private parseParams(): ParamNode[] {
    this.expectValue('(', '函数参数列表缺少左括号');
    const params: ParamNode[] = [];
    if (this.acceptValue(')')) return params;

    // `(void)` 表示没有参数
    if (this.checkValue('void') && this.checkValue(')', 1)) {
      this.next();
      this.next();
      return params;
    }

    while (!this.atEnd() && !this.checkValue(')')) {
      const before = this.index;
      try {
        if (this.checkValue('...')) {
          const token = this.next();
          this.addIssue(
            'info',
            '可变参数（...）暂不做参数级分析',
            '常见于 printf 声明，调用本身仍然可以分析。',
            this.range(token.start, token.end),
          );
        } else if (this.checkValue('(')) {
          const token = this.current();
          this.addIssue(
            'warning',
            '函数指针参数暂不支持',
            undefined,
            this.range(token.start, token.end),
          );
          this.skipBalanced();
        } else {
          params.push(this.parseParam());
        }
      } catch (error) {
        if (error instanceof RecoverableParseError) {
          // 参数解析失败时跳到逗号或右括号，避免整体失败
          while (!this.atEnd() && !this.checkValue(',') && !this.checkValue(')')) this.next();
          if (this.index === before) this.index += 1;
        } else {
          throw error;
        }
      }
      if (this.acceptValue(',')) {
        if (this.checkValue(')')) break; // 允许参数列表末尾多余逗号
        continue;
      }
      break;
    }
    this.expectValue(')', '函数参数列表缺少右括号');
    return params;
  }

  private parseParam(): ParamNode {
    const start = this.current().start;
    const spec = this.parseTypeSpec();
    const pointerStars: SourceRange[] = [];
    let pointerDepth = 0;
    let isReference = false;
    while (true) {
      if (this.checkValue('*')) {
        const star = this.next();
        pointerStars.push(this.range(star.start, star.end));
        pointerDepth += 1;
        continue;
      }
      if (this.checkValue('&') && this.language === 'cpp') {
        const amp = this.next();
        pointerStars.push(this.range(amp.start, amp.end));
        isReference = true;
        continue;
      }
      break;
    }
    let name: IdentifierNode | undefined;
    if (this.checkType('identifier')) {
      name = this.identifier(this.next());
    }
    const arrayDims = this.parseArrayDims();
    const end = this.lastEnd(start);
    return {
      id: this.nodeId(),
      kind: 'Param',
      range: this.range(start, end),
      type: spec.type,
      pointerDepth,
      pointerStars,
      isReference,
      name,
      arrayDims,
    };
  }

  // ---------------------------------------------------------------
  // 语句
  // ---------------------------------------------------------------

  private parseBlock(): BlockNode {
    const open = this.expectValue('{');
    const statements: StmtNode[] = [];
    while (!this.atEnd() && !this.checkValue('}')) {
      const before = this.index;
      const statementStart = this.current().start;
      try {
        statements.push(this.parseStatement());
      } catch (error) {
        if (error instanceof RecoverableParseError) {
          this.recoverStatement();
          const end = this.lastEnd(statementStart);
          if (end > statementStart) {
            statements.push(this.unknown(statementStart, end, '这一条语句无法解析，已跳过。'));
          }
        } else {
          throw error;
        }
      }
      if (this.index === before) this.index += 1;
    }
    const close = this.expectValue('}', '代码块缺少右花括号 "}"');
    return {
      id: this.nodeId(),
      kind: 'Block',
      range: this.range(open.start, close.end),
      statements,
    };
  }

  private parseStatement(): StmtNode {
    const token = this.current();
    const start = token.start;

    if (this.checkValue('{')) return this.parseBlock();
    if (this.checkValue(';')) {
      const semi = this.next();
      return { id: this.nodeId(), kind: 'EmptyStmt', range: this.range(semi.start, semi.end) };
    }

    if (token.type === 'preprocessor') {
      this.addIssue('info', '函数体内的预处理指令暂不做深度分析', undefined, this.range(token.start, token.end));
      this.next();
      return this.unknown(start, token.end, '预处理指令');
    }

    if (token.value === 'typedef') {
      this.addIssue(
        'warning',
        '函数内部的 typedef 暂不支持分析',
        '可以把 typedef 移到函数外面（全局作用域）。',
        this.range(token.start, token.end),
      );
      this.skipToSemicolon();
      return this.unknown(start, this.lastEnd(start), '局部 typedef（暂不支持）');
    }

    switch (token.value) {
      case 'if':
        return this.parseIf();
      case 'for':
        return this.parseFor();
      case 'while':
        return this.parseWhile();
      case 'do':
        return this.parseDoWhile();
      case 'switch':
        return this.parseSwitch();
      case 'return':
        return this.parseReturn();
      case 'break': {
        this.next();
        const semi = this.expectValue(';', 'break 后面缺少分号');
        return { id: this.nodeId(), kind: 'Break', range: this.range(start, semi.end) };
      }
      case 'continue': {
        this.next();
        const semi = this.expectValue(';', 'continue 后面缺少分号');
        return { id: this.nodeId(), kind: 'Continue', range: this.range(start, semi.end) };
      }
      case 'goto': {
        this.addIssue('warning', 'goto 语句暂不支持执行与分析', '初学阶段建议使用循环或函数替代 goto。', this.range(token.start, token.end));
        this.skipToSemicolon();
        return this.unknown(start, this.lastEnd(start), 'goto 语句（暂不支持）');
      }
      default:
        break;
    }

    // 标签语句：identifier:
    if (token.type === 'identifier' && this.checkValue(':', 1) && !this.checkValue('::', 1)) {
      this.addIssue('warning', '标签语句暂不支持', undefined, this.range(token.start, token.end));
      this.next();
      this.next();
      return this.unknown(start, this.lastEnd(start), '标签语句（暂不支持）');
    }

    if (this.looksLikeDeclaration()) {
      return this.parseDeclarationStatement();
    }

    try {
      const expression = this.parseExpression();
      const semi = this.expectValue(';', '语句末尾缺少分号 ";"');
      return {
        id: this.nodeId(),
        kind: 'ExprStmt',
        range: this.range(start, semi.end),
        expression,
      };
    } catch (error) {
      if (error instanceof RecoverableParseError) throw error;
      throw error;
    }
  }

  private parseDeclarationStatement(): StmtNode {
    const start = this.current().start;
    const spec = this.parseStorageAndType();
    if (spec.structDef) {
      this.addIssue(
        'info',
        '函数内部定义的结构体暂不单独展开',
        '可以把结构体定义移到函数外部，结构树会更完整。',
        spec.structDef.range,
      );
    }
    return this.parseVarDeclaration(spec.type, spec.storage, start, false);
  }

  private parseIf(): IfNode {
    const ifToken = this.next();
    this.expectValue('(', 'if 条件缺少左括号');
    const test = this.parseExpression();
    this.expectValue(')', 'if 条件缺少右括号');
    const consequent = this.parseStatement();
    let alternate: StmtNode | undefined;
    if (this.acceptValue('else')) {
      alternate = this.parseStatement();
    }
    const end = alternate ? alternate.range.end : consequent.range.end;
    return {
      id: this.nodeId(),
      kind: 'If',
      range: this.range(ifToken.start, end),
      test,
      consequent,
      alternate,
    };
  }

  private parseFor(): ForNode {
    const forToken = this.next();
    this.expectValue('(', 'for 循环缺少左括号');

    let init: ForNode['init'];
    if (this.checkValue(';')) {
      const semi = this.next();
      init = { id: this.nodeId(), kind: 'EmptyStmt', range: this.range(semi.start, semi.end) };
    } else if (this.looksLikeDeclaration()) {
      init = this.parseDeclarationStatement() as VarDeclNode;
    } else {
      const start = this.current().start;
      const expression = this.parseExpression();
      const semi = this.expectValue(';', 'for 循环初始化部分缺少分号');
      init = {
        id: this.nodeId(),
        kind: 'ExprStmt',
        range: this.range(start, semi.end),
        expression,
      };
    }

    let test: ExprNode | undefined;
    if (!this.checkValue(';')) {
      test = this.parseExpression();
    }
    this.expectValue(';', 'for 循环条件部分缺少分号');

    let update: ExprNode | undefined;
    if (!this.checkValue(')')) {
      update = this.parseExpression();
    }
    this.expectValue(')', 'for 循环头部缺少右括号');

    const body = this.parseStatement();
    return {
      id: this.nodeId(),
      kind: 'For',
      range: this.range(forToken.start, body.range.end),
      init,
      test,
      update,
      body,
    };
  }

  private parseWhile(): StmtNode {
    const whileToken = this.next();
    this.expectValue('(', 'while 条件缺少左括号');
    const test = this.parseExpression();
    this.expectValue(')', 'while 条件缺少右括号');
    const body = this.parseStatement();
    return {
      id: this.nodeId(),
      kind: 'While',
      range: this.range(whileToken.start, body.range.end),
      test,
      body,
    };
  }

  private parseDoWhile(): StmtNode {
    const doToken = this.next();
    const body = this.parseStatement();
    if (!this.checkValue('while')) {
      this.fail('do-while 循环缺少 while', 'do { ... } while (条件);');
    }
    this.next();
    this.expectValue('(', 'do-while 条件缺少左括号');
    const test = this.parseExpression();
    this.expectValue(')', 'do-while 条件缺少右括号');
    const semi = this.expectValue(';', 'do-while 语句末尾缺少分号');
    return {
      id: this.nodeId(),
      kind: 'DoWhile',
      range: this.range(doToken.start, semi.end),
      body,
      test,
    };
  }

  private parseSwitch(): SwitchNode {
    const switchToken = this.next();
    this.expectValue('(', 'switch 条件缺少左括号');
    const discriminant = this.parseExpression();
    this.expectValue(')', 'switch 条件缺少右括号');
    this.expectValue('{', 'switch 语句缺少左花括号');

    const clauses: CaseClauseNode[] = [];
    while (!this.atEnd() && !this.checkValue('}')) {
      const before = this.index;
      const clauseStart = this.current().start;
      let test: ExprNode | undefined;
      let isDefault = false;
      try {
        if (this.acceptValue('case')) {
          test = this.parseConditionalExpression();
          this.expectValue(':', 'case 标签缺少冒号');
        } else if (this.acceptValue('default')) {
          isDefault = true;
          this.expectValue(':', 'default 标签缺少冒号');
        } else {
          const stray = this.current();
          this.addIssue(
            'warning',
            'switch 语句中出现了不属于任何 case 的语句',
            '请检查 case/default 标签是否完整。',
            this.range(stray.start, stray.end),
          );
          this.skipToSemicolon();
          if (this.index === before) this.index += 1;
          continue;
        }
      } catch (error) {
        if (error instanceof RecoverableParseError) {
          this.recoverStatement();
          if (this.index === before) this.index += 1;
          continue;
        }
        throw error;
      }

      const statements: StmtNode[] = [];
      while (
        !this.atEnd() &&
        !this.checkValue('case') &&
        !this.checkValue('default') &&
        !this.checkValue('}')
      ) {
        const statementStart = this.current().start;
        const beforeStatement = this.index;
        try {
          statements.push(this.parseStatement());
        } catch (error) {
          if (error instanceof RecoverableParseError) {
            this.recoverStatement();
            const end = this.lastEnd(statementStart);
            if (end > statementStart) {
              statements.push(this.unknown(statementStart, end, 'case 中的语句无法解析，已跳过。'));
            }
          } else {
            throw error;
          }
        }
        if (this.index === beforeStatement) this.index += 1;
      }

      const end = statements.length ? statements[statements.length - 1].range.end : this.lastEnd(clauseStart);
      clauses.push({
        id: this.nodeId(),
        kind: 'CaseClause',
        range: this.range(clauseStart, end),
        test,
        isDefault,
        statements,
      });
    }

    const close = this.expectValue('}', 'switch 语句缺少右花括号');
    return {
      id: this.nodeId(),
      kind: 'Switch',
      range: this.range(switchToken.start, close.end),
      discriminant,
      clauses,
    };
  }

  private parseReturn(): StmtNode {
    const returnToken = this.next();
    let argument: ExprNode | undefined;
    if (!this.checkValue(';')) {
      argument = this.parseExpression();
    }
    const semi = this.expectValue(';', 'return 语句末尾缺少分号');
    return {
      id: this.nodeId(),
      kind: 'Return',
      range: this.range(returnToken.start, semi.end),
      argument,
    };
  }

  /** 判断当前位置是否是变量声明（用于区分 `LNode *p;` 与 `a * b;`） */
  private looksLikeDeclaration(): boolean {
    const token = this.current();
    if (token.type === 'typeKeyword') return true;
    if (isStorageKeyword(token.value) || isQualifierKeyword(token.value)) return true;
    if (token.value === 'struct' || token.value === 'union' || token.value === 'enum') return true;
    if (this.typedefNames.has(token.value)) return true;
    if (this.structNames.has(token.value)) return true;
    if (token.type !== 'identifier') return false;

    let offset = 1;
    while (this.checkValue('*', offset) || (this.language === 'cpp' && this.checkValue('&', offset))) offset += 1;
    if (this.checkValue('(', offset)) return false; // 可能是函数调用
    if (this.checkType('identifier', offset)) {
      if (this.checkValue('(', offset + 1)) return false; // 未知类型 函数名(...)
      return true;
    }
    // 形如 MyStruct *p;（类型名可能尚未被记录为 typedef）
    if (/^[A-Z]/.test(token.value)) {
      const next = this.peek(offset);
      return next.type === 'identifier';
    }
    return false;
  }

  // ---------------------------------------------------------------
  // 表达式
  // ---------------------------------------------------------------

  private parseExpression(): ExprNode {
    const first = this.parseAssignmentExpression();
    if (!this.checkValue(',')) return first;
    const items: ExprNode[] = [first];
    while (this.acceptValue(',')) {
      items.push(this.parseAssignmentExpression());
    }
    return {
      id: this.nodeId(),
      kind: 'Comma',
      range: this.range(first.range.start, items[items.length - 1].range.end),
      items,
    };
  }

  private parseAssignmentExpression(): ExprNode {
    const left = this.parseConditionalExpression();
    const token = this.current();
    if (ASSIGN_OPS.has(token.value)) {
      this.next();
      const value = this.parseAssignmentExpression();
      return {
        id: this.nodeId(),
        kind: 'Assign',
        range: this.range(left.range.start, value.range.end),
        op: token.value as Extract<ExprNode, { kind: 'Assign' }>['op'],
        target: left,
        value,
      };
    }
    return left;
  }

  private parseConditionalExpression(): ExprNode {
    const test = this.parseBinaryExpression(1);
    if (this.acceptValue('?')) {
      const consequent = this.parseExpression();
      this.expectValue(':', '三元运算符缺少冒号 ":"');
      const alternate = this.parseConditionalExpression();
      return {
        id: this.nodeId(),
        kind: 'Conditional',
        range: this.range(test.range.start, alternate.range.end),
        test,
        consequent,
        alternate,
      };
    }
    return test;
  }

  private parseBinaryExpression(minPrecedence: number): ExprNode {
    let left = this.parseUnaryExpression();
    while (true) {
      const token = this.current();
      const precedence = BINARY_PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.next();
      const right = this.parseBinaryExpression(precedence + 1);
      left = {
        id: this.nodeId(),
        kind: 'Binary',
        range: this.range(left.range.start, right.range.end),
        op: token.value as Extract<ExprNode, { kind: 'Binary' }>['op'],
        left,
        right,
      };
    }
    return left;
  }

  private parseUnaryExpression(): ExprNode {
    const token = this.current();

    if (token.value === 'sizeof') {
      return this.parseSizeof();
    }

    if (token.value === '++' || token.value === '--') {
      this.next();
      const operand = this.parseUnaryExpression();
      return {
        id: this.nodeId(),
        kind: 'Update',
        range: this.range(token.start, operand.range.end),
        op: token.value,
        prefix: true,
        operand,
      };
    }

    if (['+', '-', '!', '~', '*', '&'].includes(token.value) && token.type === 'operator') {
      this.next();
      const operand = this.parseUnaryExpression();
      return {
        id: this.nodeId(),
        kind: 'Unary',
        range: this.range(token.start, operand.range.end),
        op: token.value as Extract<ExprNode, { kind: 'Unary' }>['op'],
        operand,
      };
    }

    if (CPP_EXPRESSION_UNSUPPORTED.has(token.value)) {
      this.fail(
        `C++ 的 ${token.value} 表达式暂不支持`,
        'CodeLens 目前按 C 子集分析；new/delete/this 会作为不支持的语法跳过。可以先改用 C 风格的 malloc/free。',
      );
    }

    // 尝试解析类型转换：(类型)表达式
    if (token.value === '(') {
      const cast = this.tryParseCast();
      if (cast) return cast;
    }

    return this.parsePostfixExpression();
  }

  /** 尝试解析类型转换；不是转换时完整回滚，不影响正常括号表达式 */
  private tryParseCast(): ExprNode | null {
    const savedIndex = this.index;
    const issueCount = this.issues.length;
    const open = this.current();
    this.next();
    if (!this.isTypeNameStart()) {
      this.index = savedIndex;
      return null;
    }
    this.beginSpeculation();
    try {
      const spec = this.parseTypeSpec();
      const pointerStars: SourceRange[] = [];
      let pointerDepth = 0;
      while (this.checkValue('*')) {
        const star = this.next();
        pointerStars.push(this.range(star.start, star.end));
        pointerDepth += 1;
        while (isQualifierKeyword(this.current().value)) this.next();
      }
      if (!this.checkValue(')')) {
        this.rollbackSpeculation(issueCount);
        this.index = savedIndex;
        return null;
      }
      this.next();
      if (!this.canStartExpression()) {
        this.rollbackSpeculation(issueCount);
        this.index = savedIndex;
        return null;
      }
      const expression = this.parseUnaryExpression();
      this.endSpeculation();
      return {
        id: this.nodeId(),
        kind: 'Cast',
        range: this.range(open.start, expression.range.end),
        type: spec.type,
        pointerDepth,
        pointerStars,
        expr: expression,
      };
    } catch {
      this.rollbackSpeculation(issueCount);
      this.index = savedIndex;
      return null;
    }
  }

  private isTypeNameStart(): boolean {
    const token = this.current();
    if (token.type === 'typeKeyword' && isTypeSpecifierKeyword(token.value)) return true;
    if (token.value === 'struct' || token.value === 'union' || token.value === 'enum') return true;
    if (token.type === 'identifier' && (this.typedefNames.has(token.value) || this.structNames.has(token.value))) return true;
    return false;
  }

  private canStartExpression(): boolean {
    const token = this.current();
    if (token.type === 'eof') return false;
    if (['identifier', 'number', 'string', 'char'].includes(token.type)) return true;
    return ['(', 'sizeof', '!', '~', '+', '-', '*', '&', '++', '--', 'true', 'false'].includes(token.value);
  }

  private parseSizeof(): ExprNode {
    const sizeofToken = this.next();
    const pointerStars: SourceRange[] = [];
    let pointerDepth = 0;
    let typeName: TypeRef | undefined;
    let operand: ExprNode | undefined;

    if (this.checkValue('(') && this.isTypeNameStartAt(1)) {
      this.next(); // (
      const spec = this.parseTypeSpec();
      typeName = spec.type;
      while (this.checkValue('*')) {
        const star = this.next();
        pointerStars.push(this.range(star.start, star.end));
        pointerDepth += 1;
      }
      this.expectValue(')', 'sizeof 的类型缺少右括号');
    } else if (this.checkValue('(')) {
      this.next();
      operand = this.parseExpression();
      this.expectValue(')', 'sizeof 的表达式缺少右括号');
    } else {
      operand = this.parseUnaryExpression();
    }

    const end = this.lastEnd(sizeofToken.end);
    return {
      id: this.nodeId(),
      kind: 'Sizeof',
      range: this.range(sizeofToken.start, end),
      operand,
      typeName,
      pointerDepth,
      pointerStars,
      raw: this.source.text.slice(sizeofToken.start, end),
    };
  }

  private isTypeNameStartAt(offset: number): boolean {
    const token = this.peek(offset);
    if (token.type === 'typeKeyword' && isTypeSpecifierKeyword(token.value)) return true;
    if (token.value === 'struct' || token.value === 'union' || token.value === 'enum') return true;
    if (token.type === 'identifier' && (this.typedefNames.has(token.value) || this.structNames.has(token.value))) return true;
    return false;
  }

  private parsePostfixExpression(): ExprNode {
    let expression = this.parsePrimaryExpression();
    while (true) {
      if (this.checkValue('(')) {
        const args = this.parseArguments();
        const end = this.lastEnd(expression.range.end);
        expression = {
          id: this.nodeId(),
          kind: 'Call',
          range: this.range(expression.range.start, end),
          callee: expression,
          args,
        };
        continue;
      }
      if (this.checkValue('[')) {
        this.next();
        const index = this.parseExpression();
        const close = this.expectValue(']', '数组下标缺少右方括号 "]"');
        expression = {
          id: this.nodeId(),
          kind: 'Index',
          range: this.range(expression.range.start, close.end),
          base: expression,
          index,
        };
        continue;
      }
      if (this.checkValue('.') || this.checkValue('->')) {
        const arrow = this.current().value === '->';
        this.next();
        const memberToken = this.expectIdentifier('成员访问运算符后面需要成员名');
        const member = this.identifier(memberToken);
        expression = {
          id: this.nodeId(),
          kind: 'Member',
          range: this.range(expression.range.start, member.range.end),
          object: expression,
          member,
          arrow,
        };
        continue;
      }
      if (this.checkValue('++') || this.checkValue('--')) {
        const token = this.next();
        expression = {
          id: this.nodeId(),
          kind: 'Update',
          range: this.range(expression.range.start, token.end),
          op: token.value as '++' | '--',
          prefix: false,
          operand: expression,
        };
        continue;
      }
      if (this.checkValue('::')) {
        const scopeToken = this.current();
        this.addIssue(
          'warning',
          'C++ 作用域运算符 "::" 暂不支持',
          'CodeLens 目前主要支持 C；std::cout 之类的写法会无法完整解析。',
          this.range(scopeToken.start, scopeToken.end),
        );
        this.fail('暂不支持 "::"', '可以改用 printf 输出。');
      }
      break;
    }
    return expression;
  }

  private parseArguments(): ExprNode[] {
    this.expectValue('(', '函数调用缺少左括号');
    const args: ExprNode[] = [];
    if (this.acceptValue(')')) return args;
    while (!this.atEnd()) {
      args.push(this.parseAssignmentExpression());
      if (!this.acceptValue(',')) break;
    }
    this.expectValue(')', '函数调用缺少右括号 ")"');
    return args;
  }

  private parsePrimaryExpression(): ExprNode {
    const token = this.current();

    if (token.type === 'number') {
      this.next();
      const kind: LiteralKind = /[.eEfF]/.test(token.value) ? 'float' : 'int';
      return {
        id: this.nodeId(),
        kind: 'Literal',
        range: this.range(token.start, token.end),
        literalKind: kind,
        raw: token.value,
      };
    }

    if (token.type === 'string') {
      this.next();
      let end = token.end;
      let raw = token.value;
      // C 中相邻字符串会自动拼接
      while (this.checkType('string')) {
        const next = this.next();
        raw += next.value;
        end = next.end;
      }
      return {
        id: this.nodeId(),
        kind: 'Literal',
        range: this.range(token.start, end),
        literalKind: 'string',
        raw,
      };
    }

    if (token.type === 'char') {
      this.next();
      return {
        id: this.nodeId(),
        kind: 'Literal',
        range: this.range(token.start, token.end),
        literalKind: 'char',
        raw: token.value,
      };
    }

    if (token.value === 'true' || token.value === 'false') {
      this.next();
      return {
        id: this.nodeId(),
        kind: 'Literal',
        range: this.range(token.start, token.end),
        literalKind: 'bool',
        raw: token.value,
      };
    }

    if (token.value === 'nullptr') {
      this.next();
      return {
        id: this.nodeId(),
        kind: 'Literal',
        range: this.range(token.start, token.end),
        literalKind: 'null',
        raw: token.value,
      };
    }

    if (token.type === 'identifier') {
      this.next();
      return this.identifier(token);
    }

    if (token.value === '(') {
      this.next();
      const expression = this.parseExpression();
      this.expectValue(')', '括号表达式缺少右括号 ")"');
      return expression;
    }

    this.fail(
      `无法解析的表达式片段 "${token.value || '代码末尾'}"`,
      '检查是否缺少运算符、括号或分号；也可能是 CodeLens 暂不支持的语法。',
    );
  }

  // ---------------------------------------------------------------
  // 错误恢复
  // ---------------------------------------------------------------

  private recoverTopLevel(): void {
    let depth = 0;
    while (!this.atEnd()) {
      const token = this.current();
      if (token.value === '(' || token.value === '[') depth += 1;
      else if (token.value === ')' || token.value === ']') depth = Math.max(0, depth - 1);
      else if (token.value === '{') {
        depth += 1;
        this.next();
        continue;
      } else if (token.value === '}') {
        if (depth === 0) {
          this.next();
          return;
        }
        depth -= 1;
        this.next();
        if (depth === 0) return;
        continue;
      } else if (token.value === ';' && depth === 0) {
        this.next();
        return;
      }
      this.next();
    }
  }

  private recoverStatement(): void {
    let depth = 0;
    while (!this.atEnd()) {
      const token = this.current();
      if (token.value === '(' || token.value === '[') depth += 1;
      else if (token.value === ')' || token.value === ']') depth = Math.max(0, depth - 1);
      else if (token.value === '{') {
        depth += 1;
        this.next();
        continue;
      } else if (token.value === '}') {
        if (depth === 0) return; // 不消费外层块的右花括号
        depth -= 1;
        this.next();
        if (depth === 0) return;
        continue;
      } else if (token.value === ';' && depth === 0) {
        this.next();
        return;
      }
      this.next();
    }
  }

  private recoverStructField(): void {
    let depth = 0;
    while (!this.atEnd()) {
      const token = this.current();
      if (token.value === '{') depth += 1;
      else if (token.value === '}') {
        if (depth === 0) return;
        depth -= 1;
      } else if (token.value === ';' && depth === 0) {
        this.next();
        return;
      }
      this.next();
    }
  }

  private skipToSemicolon(): void {
    while (!this.atEnd() && !this.checkValue(';')) {
      if (this.checkValue('}')) return;
      this.next();
    }
    if (this.checkValue(';')) this.next();
  }

  private skipBalanced(): void {
    let depth = 0;
    while (!this.atEnd()) {
      const token = this.current();
      if (token.value === '(' || token.value === '[' || token.value === '{') depth += 1;
      else if (token.value === ')' || token.value === ']' || token.value === '}') {
        depth -= 1;
        this.next();
        if (depth <= 0) return;
        continue;
      }
      this.next();
    }
  }
}
