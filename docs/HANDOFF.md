# CodeLens 交接文档（HANDOFF）

> 面向：后续接手的开发者 / AI 会话。
> 最后更新：**2026-11-17 15:25（Asia/Shanghai）**
> 项目位置：**`D:\CodeLens`**（Windows）。本文所有命令默认在 `D:\CodeLens` 下执行。
> 相关文档：[README](../README.md)（使用说明） · [ROADMAP](ROADMAP.md)（阶段计划与待办）。

---

## 0. 一页摘要

CodeLens 是一个**纯前端**的代码结构可视化学习工具：React 19 + TypeScript 7 + Vite 8 + Monaco 0.57 + Tailwind 4 + Zustand 5。当前已实现：

- **C / C++（C 子集）**：手写词法分析 + 递归下降 AST、符号表、9 类语义高亮、中文结构树、三种深度中文释义、符号关联定位、内置 C 子集逐行执行可视化（变量 / 数组 / 指针 / 链表 / `printf`）。
- **中文伪代码**：规则推断 + 逐行置信度 + 生成 C 代码，严格区分「原文 / 推断 / 生成代码」，满足条件时可执行生成的 C 代码。
- **JS / TS**：`@babel/parser` 真实 AST 的结构级分析（语义高亮 / 结构树 / 基础释义 / 符号关联），**不执行**。
- **Python**：自实现分词 + 缩进结构解析的结构级分析，**不执行**。
- **学习笔记**（本地规则生成 Markdown）、**AI 问答接口**（OpenAI 兼容，默认关闭，未配置时用本地规则解释兜底）。
- 浏览器实机验收脚本（50 项，playwright-core + 系统 Edge）、单元测试、VS Code 工程配置、文档与截图。

**当前状态**：功能可真实运行；单元测试 **6 个文件 / 193 用例全部通过**（2026-11-17 15:23 实测）；`tsc --noEmit` 与 `pnpm build` 通过；浏览器实机验收 **50/50 通过**（15:35 在解释器缺陷修复后复跑）；开发服务器在 `http://127.0.0.1:5173` 运行（如已停止需重新启动）。**已初始化本地 git 仓库（main 分支）并完成首次提交；尚未配置 GitHub 远程仓库**（见第 8 节）。

---

## 1. 当前完成状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 阶段一 | 三栏 UI、C 词法/语法分析、符号表、语义高亮、结构树、三种深度释义、关联定位、设置/主题/示例/导入 | ✅ 完成 |
| 阶段二 | C 子集逐行解释器、执行面板（单步/播放/滑块）、变量/堆内存/链表/调用栈/输出、诚实报错 | ✅ 完成（浏览器验收已回归） |
| 阶段三 | 中文伪代码推断 + C 代码生成、JS/TS Babel 分析、Python 结构分析、学习笔记、AI 接口、帮助与能力边界、浏览器验收、文档 | ✅ 基本完成 |
| 阶段四 | 工程质量、更多解析/执行引擎、AI 流式、学习体验、性能优化 | ⏳ 未开始（见 ROADMAP） |

说明：

- AI 能力**已实现接口**，但默认关闭，需要用户自行配置 OpenAI 兼容 API（Base URL / 模型 / API Key）。
- 解释器测试已由并行开发者补齐：`tests/interpreter.test.ts`（55 用例），解释器在 15:13 修复过 3 个缺陷（指针相减、`sizeof("abc")`、后缀自减描述）。
- 已初始化本地 git 仓库（`main` 分支，首次提交见第 8 节）；尚未配置 GitHub 远程仓库，用户可在提供仓库地址与凭据后推送。

---

## 2. 运行环境（本机）

> 这是当前这台机器（DSH 运行时）的实际情况。换机器/换会话请先核对，不要盲目照搬绝对路径。

| 项目 | 值 |
| --- | --- |
| 项目根目录 | `D:\CodeLens` |
| 依赖目录 | `D:\CodeLens\node_modules`（已安装，勿删除后重装除非必要） |
| Node.js（DSH 运行时） | `C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`，版本 **v24.21.0** |
| pnpm（DSH 运行时） | `C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs`，版本 **11.28.5** |
| pnpm store（实测 `pnpm store path`） | **`D:\.pnpm-store\v11`**（注意：早期任务描述说"store 在 C 盘"，与实测不符，以实测为准） |
| 系统 PATH | 默认**不包含** node/pnpm；需要时按下述命令临时加入 PATH |
| 开发服务器 | `http://127.0.0.1:5173`（由 `vite.config.ts` 指定 host/port；未设置 `strictPort`，端口被占用时会自动后移） |
| 浏览器验收 | 需要系统安装 Microsoft Edge。脚本默认路径 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（写在 `scripts/verify-ui.cjs` 常量中） |
| 版本要求 | Vite 8 要求 Node `^20.19.0 || >=22.12.0`；依赖声明见 `package.json` / `pnpm-lock.yaml` |

### 2.1 在 PowerShell 中准备命令（当前 DSH 环境）

```powershell
# 1）把 DSH 运行时的 node 加入 PATH，并定义绝对路径变量
$env:PATH = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;$env:PATH"
$node = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"

# 2）进入项目
cd D:\CodeLens

# 3）验证环境
& $node --version          # v24.21.0
& $node $pnpm --version    # 11.28.5
```

> 普通开发机若已安装 Node/pnpm 且在 PATH 中，可直接使用 `pnpm dev` / `pnpm test` 等命令，无需上面的绝对路径。

### 2.2 启动 / 确认开发服务器

```powershell
# 当前是否已有服务器在 5173（避免重复启动）
Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue

# 若没有运行，启动开发服务器（保持前台/后台运行）
& $node $pnpm dev
# 浏览器打开 http://127.0.0.1:5173
```

> 多智能体并行时**不要随意重启/杀死**别的成员正在使用的 5173 服务；先检查端口与进程。

---

## 3. 验证命令与最近一次结果

### 3.1 单元测试（Vitest）

```powershell
# 当前 DSH 环境
$env:PATH = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;$env:PATH"
$node = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
cd D:\CodeLens
& $node $pnpm test
```

普通环境：`cd D:\CodeLens; pnpm test`

**最近一次实测（2026-11-17 15:23）**：

```text
✓ tests/cParser.test.ts       (13 tests)
✓ tests/pseudo.test.ts        (42 tests)
✓ tests/languages.test.ts     (35 tests)
✓ tests/interpreter.test.ts   (55 tests)
✓ tests/explain.test.ts       (19 tests)
✓ tests/analysis.test.ts      (29 tests)

Test Files  6 passed (6)
     Tests  193 passed (193)
```

> 历史背景：早期只有 `cParser + pseudo + languages = 90` 个用例；之后并行开发者补充了 `analysis`、`explain`、`interpreter` 三个套件。**以你自己运行时的输出为准**；若数字变化，属正常开发进展，请更新本节。

### 3.2 类型检查

```powershell
# 已在 2026-11-17 15:20 实测通过（exit 0）
& $node "D:\CodeLens\node_modules\typescript\bin\tsc" -p "D:\CodeLens\tsconfig.json" --noEmit
```

`package.json` 中的脚本为 `pnpm typecheck`（`tsc -b --noEmit`）；该命令已在 2026-11-17 15:25 实测 exit 0，会更新 `tsconfig.tsbuildinfo` 构建缓存（已被 `.gitignore` 忽略）。TypeScript 7 为原生编译器，`node_modules/typescript` 中没有提供 `lib/tsserver.js`，因此**不要在 VS Code 里把 `typescript.tsdk` 指向项目内 TypeScript**（`.vscode/settings.json` 已刻意不设置）。

### 3.3 生产构建（未在本轮文档工作中重新执行）

```powershell
cd D:\CodeLens
& $node $pnpm build      # = tsc -b && vite build，产物在 dist/
& $node $pnpm preview    # 预览（默认 http://localhost:4173）
```

当前 `dist/` 是此前一次成功构建的产物（时间约 14:53）。主要体积（未 gzip）：

| 产物 | 大小 |
| --- | --- |
| `assets/index-*.js`（应用 + Monaco 主包） | 约 4.76 MB |
| `assets/ts.worker-*.js` | 约 6.61 MB |
| `assets/css.worker-*.js` | 约 1.03 MB |
| `assets/html.worker-*.js` | 约 0.71 MB |
| `assets/json.worker-*.js` | 约 0.41 MB |
| `assets/editor.worker-*.js` | 约 0.29 MB |
| 其余 Monaco 语言按需 chunk、CSS、字体 | 合计约 1 MB |

> 体积优化是 ROADMAP 4.6 的内容；改动打包方式后请重新记录此表。

### 3.4 浏览器实机验收（50 项）

```powershell
# 1）先确保开发服务器在运行（见 2.2）
# 2）普通环境（node 在 PATH 中）
cd D:\CodeLens
node scripts/verify-ui.cjs

# 或当前 DSH 环境（先执行 2.1 的 PATH 设置与变量定义）
cd D:\CodeLens
& $node scripts/verify-ui.cjs
```

- 脚本位置：`scripts/verify-ui.cjs`；使用 `playwright-core` + **系统 Microsoft Edge** 无头模式（不下载浏览器）。
- 检查内容：页面/品牌、三栏与状态栏、Monaco 语义装饰、9 类图例、结构树行数、释义面板、点击代码后的释义与关联高亮、执行面板与真实快照、变量面板、链表/堆内存可视化、单步推进、输出控制台、执行结束输出、解释深度切换、语义类别开关、本地文件导入与语言识别、伪代码分析/生成代码/执行条件、浅色主题、设置弹窗、控制台无错误、无未捕获异常，共 **50 项**。
- 通过标准：终端输出 `50/50 项通过`，退出码 0；脚本会重写 `docs/screenshots/01`–`09` 并生成 `docs/fixtures/import-test.c`。
- 最近记录：**50/50 通过**（2026-11-17 15:35 在解释器修复与 193 个单测之后复跑；截图 `01`–`09` 即由该脚本生成）。
- 如 Edge 不在默认路径：修改脚本顶部 `const EDGE = '...'`；可用环境变量覆盖被测地址 `CODELENS_URL`（PowerShell：`$env:CODELENS_URL="http://127.0.0.1:5173"`）。

---

## 4. 架构与数据流

### 4.1 数据流（从输入到界面）

```text
用户编辑 / 导入 / 加载示例
        │
        ▼
store.setCode(code)  ← src/state/store.ts（统一 CRLF→LF）
        │
        ▼
analyzeCode(code, { language, fileName })  ← src/core/analyze.ts 统一入口
        │  按语言分发：
        │  c / cpp   → parseC → buildIndex → buildCSymbols → buildSemanticTokens + buildCStructureTree
        │  javascript/ts → analyzeJavaScript（@babel/parser）
        │  python    → analyzePython（自实现分词 + 缩进解析）
        │  pseudo    → analyzePseudo → buildPseudoTree/Tokens/Issues
        │  plaintext → analyzePlainText
        ▼
AnalysisResult（analysisTypes.ts）
  id / source / lines / tree / tokens / symbols / symbolList / issues /
  execution / capabilities / supportNotes / stats / program? / cIndex? / pseudo?
        │
        ▼
Zustand store 保存 analysis，并驱动：
  ├─ EditorPanel：buildDecorationSpecs(analysis…) → Monaco decorations（语义色/下划线/边界/关联/执行行）
  ├─ StructureTree：analysis.tree 渲染中文结构树
  ├─ ExplainPanel：选择偏移/节点 → explainAt / explainStructure → Explanation
  ├─ RelationsPanel：analysis.symbolList 渲染声明与使用位置
  ├─ StatusBar：stats / execution 状态
  └─ ExecutionPanel：执行快照（见 4.2）
```

### 4.2 逐行执行

```text
runExecution()（store.ts）
  → getExecutionTarget(analysis)（analyze.ts）
      C/C++：源码本身；中文伪代码：analysis.pseudo.generatedCode（仅 supportedExecutable=true）
  → parseC(SourceFile(code), { language })（重新解析执行目标）
  → 动态 import('../core/interpreter/interpreter') → executeC(program, source, { maxSteps: 3000 })
  → ExecutionResult { status, engine, snapshots[], stdout, error?, warnings, truncated }
  → store.execution = { status, steps, index, error, stdout, warnings, truncated, … }
  → ExecutionPanel 渲染当前快照（变量/作用域、堆对象、调用栈、输出、问题）
  → EditorPanel 高亮当前执行行
```

- 执行引擎：`CodeLens C 子集解释器 v1`，入口 `executeC`。
- 快照字段契约见 `src/core/interpreter/types.ts`（`ExecutionSnapshot` / `ScopeView` / `HeapObjectView` / `ValueView` 等）。
- 模拟内存：全局区 `0x1000`、栈区 `0x4000`、堆区 `0x9000`；默认步数上限 3000、调用深度 100、堆 1 MiB。
- UI 不消费解释器内部实现，只消费快照；新增能力必须保持该契约向后兼容（只加可选字段）。

### 4.3 释义与 AI

```text
explainAt(analysis, offset, level) / explainStructure(analysis, node, level)
  ├─ C/C++：explain/cExplainer.ts（AST + 符号表，精确拆解/释义/关联/误区/类比/进阶）
  ├─ 伪代码：explain/structureExplainer.ts → explainPseudoAt（原文/推断/生成代码对照）
  └─ JS/TS/Python/纯文本：结构级释义（结构作用、子结构、能力边界）

AI：store.askAI(question, explanation)
  ├─ 未启用或没有 Key → services/ai.ts buildLocalAnswer()（明确标注「本地规则解释 · 非 AI」）
  └─ 已配置 → buildAIContext（完整代码 ≤8000 字符 + 选中片段 + 最近 6 条对话）
             → fetch POST {baseUrl}/chat/completions（Bearer Key，45s 超时）
```

### 4.4 状态持久化

`src/state/store.ts` 使用 Zustand `persist`：

- 写入 `localStorage` 键：`codelens-preferences`。
- 只持久化偏好：`theme / level / colorsDark / colorsLight / categoryVisibility / showStructureBackground / showNestingDepth / leftOpen / rightOpen / bottomOpen / aiSettings`。
- **不持久化**：`code / analysis / execution / aiChat`（刷新回到内置示例；如有需要才在隐私评审后改动）。
- 开发环境会把 store 挂到 `window.__codelensStore`，便于控制台排查。

---

## 5. 文件地图与模块职责

> 行数为 2026-11-17 的大致值，仅帮助定位，不要当作精确约束。

```text
D:\CodeLens
├─ index.html                  页面入口
├─ package.json                脚本/依赖（dev/build/test/typecheck/verify:ui 等）
├─ vite.config.ts              React + Tailwind + @ 别名 + server 127.0.0.1:5173 + Vitest 配置
├─ tsconfig.json               strict / bundler / @/* 路径
├─ .vscode/                    tasks（dev/build/test/verify-ui）、launch（Edge/Vitest）、settings、extensions
├─ .editorconfig / .gitignore  （本次新增）
├─ docs/
│  ├─ HANDOFF.md               本文件
│  ├─ ROADMAP.md               阶段计划/阶段四增强/风险
│  ├─ screenshots/             01 dark-overview、02 click-explain、03 execution、04 execution-final、05 pseudo、06 light-theme、07 settings
│  └─ fixtures/                verify-ui 生成的临时文件（已加入 .gitignore）
├─ public/favicon.svg
├─ scripts/
│  ├─ verify-ui.cjs            50 项浏览器验收（playwright-core + 系统 Edge；Edge 路径写死，注意修改）
├─ tests/                      193 个用例全部通过
│  ├─ cParser.test.ts          13：C 词法/语法、错误恢复、注释、预处理、类型转换等
│  ├─ analysis.test.ts         29：语言识别、语义分类、符号、结构树、装饰、统一管线
│  ├─ pseudo.test.ts           42：伪代码推断/代码生成/容错/置信度
│  ├─ languages.test.ts        35：JS/TS/Python 结构分析
│  ├─ explain.test.ts          19：C 释义/伪代码对照/非 C 结构级释义
│  └─ interpreter.test.ts      55：解释器执行、快照、指针/链表、错误场景
└─ src/
   ├─ main.tsx                 React 根；import './monaco/setup' 与 styles
   ├─ App.tsx                  三栏布局、拖拽导入、全局快捷键、弹窗、通知
   ├─ components/              Header / StructureTree / EditorPanel / ExplainPanel / RelationsPanel /
   │                           ExecutionPanel / AIPanel / SettingsDialog / NotesDialog / HelpDialog /
   │                           StatusBar / ErrorBoundary / Icons
   ├─ state/store.ts           全局状态与动作（~680 行；含持久化与执行编排）
   ├─ editor/decorations.ts    纯函数：AnalysisResult → Monaco DecorationSpec（可单测）
   ├─ monaco/setup.ts          本地 Monaco、Worker、语言 id、深/浅主题
   ├─ styles/index.css         设计变量、深浅主题、全部组件样式（~3800 行）
   ├─ services/
   │  ├─ samples.ts            9 个内置真实示例（C 5、伪代码 2、JS 1、Python 1）
   │  ├─ files.ts              文件导入（白名单 + 512KB 限制 + 语言识别）、文本下载
   │  ├─ notes.ts              本地规则生成 Markdown 学习笔记
   │  └─ ai.ts                 OpenAI 兼容接口、本地规则兜底、上下文构造
   └─ core/
      ├─ analysisTypes.ts      统一分析契约（LanguageId、SemanticToken、SymbolInfo、StructureNode、
      │                        ParseIssue、ExecutionSupport、LanguageCapabilities、AnalysisResult…）
      ├─ source.ts             SourceFile：CRLF 归一化、行列 ↔ 字符偏移（二分查找）
      ├─ lexer.ts              C 词法分析（~400 行；控制关键字、注释、预处理）
      ├─ ast.ts                C AST 类型 + 节点索引（~630 行）
      ├─ cParser.ts            C 子集递归下降解析（~1880 行；错误恢复、issue 报告）
      ├─ symbols.ts            C 符号表：作用域、遮蔽、声明/使用、类型推断（~920 行）
      ├─ semantic.ts           9 类语义 token（AST + 词法 + 符号表，~315 行）
      ├─ structureTree.ts       C 中文结构树（~505 行）
      ├─ semanticCatalog.ts    语义类别定义、默认色、结构边界色、可见性
      ├─ analyze.ts            统一分析管线、语言识别、执行目标、finalize（~530 行）
      ├─ textFallback.ts       未知文本有限分析
      ├─ explain/              types.ts / index.ts / cExplainer.ts（~2450 行）/ structureExplainer.ts
      ├─ pseudo/               types.ts / analyzer.ts（~2000 行）/ codegen.ts（~920 行）/ index.ts
      ├─ languages/            index.ts / javascript.ts（~2660 行）/ python.ts（~1960 行）
      └─ interpreter/          types.ts / interpreter.ts（~3777 行）/ index.ts
```

### 5.1 各层职责边界（改动前先看这里）

- **`core/` 不依赖 React / DOM**（除 `performance.now` 计时）；分析、解释、生成均可单测。新增分析能力优先放这里。
- **`analysisTypes.ts` 是跨模块契约**：UI、C 分析、多语言分析、伪代码都依赖它；修改字段时优先"新增可选字段"，避免破坏现有套件。
- **`state/store.ts` 负责编排**：不要在组件里重复调用 `analyzeCode`；所有分析结果应通过 store 进入 UI，保证选择/执行状态一致。
- **`editor/decorations.ts` 是纯函数**：可独立测试（`analysis.test.ts` 已覆盖），不要在内部直接调用 Monaco API。
- **`monaco/setup.ts` 只做注册与主题**：Monaco 从本地打包（不走 CDN），语义着色完全由 decorations 完成；不要启用来宾语言的内置 tokenizer。
- **`interpreter/` 不依赖浏览器/Node API**：纯 TypeScript，可重复执行；所有快照必须来自真实解释，不允许按示例硬编码。
- **`services/` 只做 I/O 与外部集成**：示例数据、文件读取/下载、笔记模板、AI 请求；不要在这里写 UI 逻辑。

---

## 6. 关键契约与设计约束（重要）

1. **不伪造**：不支持的语法/语言/执行必须通过 `issues`、`execution.reason`、`ExecutionErrorInfo` 明确说明；不允许返回编造的分析或执行结果。这是项目最重要的产品原则，新增功能必须遵守。
2. **能力边界要显式**：
   - 分析结果里 `supportLevel`（full / structural / limited）、`capabilities`、`supportNotes`、`execution` 都必须与实际能力一致；
   - UI 的「帮助 → 能力边界 / 解析问题」要同步更新；
   - README 能力矩阵、本文件、ROADMAP 也要同步。
3. **位置模型**：所有 token / 符号 / 结构 / 执行范围都用**0-based 字符偏移**表示，展示时由 `SourceFile` 转 1-based 行列；换行统一为 `\n`。
4. **伪代码三分法**：`original`（用户原文）/ `inference`（系统推断）/ `generatedCode`（生成代码）必须分字段保存、分样式展示；生成代码不得静默覆盖用户输入；低置信度必须警告。
5. **执行限制**：只支持 C/C++ 的 C 子集（或伪代码生成的可靠 C 代码）；只输出 `printf`/`puts`/`putchar`；`scanf`/文件 IO/其他库函数明确报错；内存地址是模拟值。默认步数 3000、调用深度 100、堆 1 MiB。
6. **C++ 仅 C 子集**：解析器把 `class`、`namespace`、`using`、`template` 以及 `new/delete/this` 视为不支持并报告 issue；**不要**在文档或 UI 中宣称支持 C++ 类/模板/STL。
7. **隐私**：无后端；源码默认不持久化；只有用户主动提问且已配置 AI 时才发送代码；API Key 存 localStorage（键 `codelens-preferences`），文档必须提示共享电脑风险。
8. **测试不许"改绿"**：测试失败要么修实现，要么明确标注为已知问题；不要删除/弱化断言来制造通过假象。
9. **依赖与脚本**：`package.json`/`vite.config.ts`/`tsconfig.json` 改动可能影响所有并行成员；多智能体会话中先确认任务写作用域。
10. **TypeScript 7**：原生编译器；VS Code 语言服务不用项目内 tsdk（包内无 `tsserver.js`）；`pnpm typecheck` = `tsc -b --noEmit`。

---

## 7. 各模块接手提示

### 7.1 C 解析链路（`lexer.ts` → `cParser.ts` → `ast.ts` → `symbols.ts`）

- 支持的语法子集写在 `cParser.ts` 文件头注释里；不支持项会报告 issue（如函数指针、位域、`goto`、K&R、复杂宏、C++ 语法）。
- AST 每个节点有唯一 `id` 与 `range`；`buildIndex` 生成 `CNodeIndex`（byId、parent、`findDeepestNodeAt` 等）。
- 符号表做块级作用域与变量遮蔽；对 `p->next` 这类成员访问依赖表达式类型推断（`InferredType`），改动时注意链表示例。
- 语义 token 分类有优先级（注释/预处理 > 指针/运算符 > 标识符 > 类型引用 > 默认词法），见 `semantic.ts` 文件头。

### 7.2 释义（`explain/`）

- `cExplainer.ts` 是最大的文案模块（约 2450 行），按 AST 节点类型分发三种深度文案；新增节点解释时同时补 `tests/explain.test.ts`。
- 结构级释义在 `structureExplainer.ts`，用 `KIND_META` 表按结构 kind 提供内容；JS/Python/伪代码/纯文本共用。
- 释义结果 `Explanation` 字段（composition/meaning/purpose/why/relations/pitfalls/analogy/advanced/tags/symbol/comparisons/limitations）由 `ExplainPanel` 渲染；不要新增 UI 专用字段到 core 类型而不更新 UI。

### 7.3 伪代码（`pseudo/`）

- `analyzer.ts`：逐行推断，行结果与源码行严格对齐（空行保留）；支持缩进嵌套与"结束如果/结束循环/结束函数"显式标记；支持无缩进单行 if/else。
- `codegen.ts`：把 `PseudoStatement` 树翻译为 C，`#include <stdio.h>` + `int main(void)`，并回填 `generatedStartLine/generatedEndLine`。
- `supportedExecutable` 的判定条件要谨慎；输入语句（`scanf`）或低置信度会使执行不可用。
- UI 中执行的是生成的 C 代码，不是伪代码原文；文案必须始终说明这一点。

### 7.4 JS/TS 与 Python（`languages/`）

- `javascript.ts`：`@babel/parser` 开启 `tokens: true`、`errorRecovery: true`；自实现作用域/符号/结构树；语法错误写 issues，尽量恢复结构树。
- `python.ts`：自实现 tokenizer（含三引号字符串、Unicode 标识符、缩进/去缩进）+ 基于缩进块的结构解析；缩进不一致、缺冒号等要报 issue。
- 两者 `execution.supported = false`，并给出明确 reason；`capabilities.explanations = 'basic'`；`supportLevel = 'structural'`。

### 7.5 解释器（`interpreter/`）

- 文件约 3777 行，纯 TS；入口 `executeC(program, source, options)`；`ENGINE = 'CodeLens C 子集解释器 v1'`。
- 新增语法/库函数支持时：先补 `UNSUPPORTED_C_FUNCTIONS`/错误文案（对不支持的保持明确），再同步 `tests/interpreter.test.ts` 和 README/HANDOFF 能力说明。
- 修改快照结构只允许"新增可选字段"，否则 UI 与测试会一起坏。
- 调试可单测直接调用：`const source = new SourceFile(code); const { program } = parseC(source); const result = executeC(program, source);`

### 7.6 UI 与状态（`components/`, `state/store.ts`）

- 中栏 `EditorPanel`：Monaco 异步挂载（`editorReady` 状态触发装饰 effect）、语义装饰、hover provider、点击/悬停、执行行高亮、结构树/关联跳转（`revealRequest` nonce）。
- `ExecutionPanel`：播放控制 + 自动播放定时器（650ms）+ 变量/内存/输出/问题四块；`VariablesPanel` 消费快照。
- `ExplainPanel`：三 Tab（释义/关联/AI），未选中代码时显示欢迎页与能力摘要。
- `SettingsDialog`：颜色/结构显示/AI 三个 Tab；颜色按当前主题保存（`colorsDark`/`colorsLight` 分开）。
- `Header`：语言选择（手动切换优先于自动识别）、解释深度、示例、导入文件、面板开关、主题、AI、笔记、设置。
- 快捷键：`Ctrl/⌘+Enter` 运行、`Ctrl/⌘+B/J/I` 切换左/下/右面板、`?` 帮助、`Esc` 关闭弹窗（见 `App.tsx`）。

### 7.7 服务（`services/`）

- `samples.ts`：9 个示例，`DEFAULT_SAMPLE_ID = 'c-linked-list'`；新增示例会被「示例」下拉与测试引用。
- `files.ts`：扩展名白名单 + `MAX_FILE_SIZE = 512KB`；导入后 `detectLanguage` 自动识别。
- `notes.ts`：8 节 Markdown 笔记；内容必须来自真实分析结果（结构、符号、issues、supportNotes），不能编造。
- `ai.ts`：Base URL 校验、45s 超时、`/chat/completions`、错误中文映射；未配置时 `buildLocalAnswer` 兜底并标注非 AI。

### 7.8 Monaco（`monaco/setup.ts`, `editor/decorations.ts`）

- Monaco 本地打包（`monaco-editor` + `@monaco-editor/react` 的 `loader.config`），Worker 用 Vite 的 `?worker` 导入；不依赖 CDN，离线可用。
- 只注册语言 id `codelens` 与编辑配置；**不要**启用来宾语言内置着色。
- 主题 `codelens-dark` / `codelens-light` 定义在 `setup.ts`；颜色强调与 CSS 变量配合，改配色时同时检查 `styles/index.css` 与 `decorations.ts`。
- 当前打包包含未使用的 Monaco 语言/Worker（导致体积偏大），优化方向见 ROADMAP 4.6。

---

## 8. 已知问题与待办（按优先级）

### P0（接手后优先处理）

1. **GitHub 远程仓库尚未配置（本地 git 已初始化）**：本地仓库位于 `D:\CodeLens\.git`，`main` 分支已有首次提交。需要用户提供 GitHub 仓库地址与凭据（PAT / SSH）后执行：
   ```powershell
   cd D:\CodeLens
   # 当前环境未安装系统 Git；本次使用便携版 Git：
   $env:PATH = "D:\_tools\git\package\out\cmd;D:\_tools\git\package\out\mingw64\bin;$env:PATH"
   git remote add origin https://github.com/<username>/<repo>.git
   git push -u origin main
   ```
   也可以先安装 Git for Windows（`winget install --id Git.Git -e`）后使用普通 `git` 命令。`.gitignore` 已就绪（忽略 `node_modules/`、`dist/`、`*.tsbuildinfo`、日志、临时截图等；`docs/screenshots/01`–`09`、源码、文档会提交）。
2. **浏览器验收**：已在解释器修复与新增测试后复跑，**50/50 通过**（见 3.4）；后续改动 UI/解析器/解释器后请再次复跑。
3. **CI**：已添加 `.github/workflows/ci.yml`（install → test → build），首次 push 到 GitHub 后生效；浏览器验收因依赖 Windows + Edge 暂未接入 CI。

### P1（近期）

4. ~~**`parse:cli` 脚本无效**~~：已从 `package.json` 移除该脚本（无 `scripts/inspect.ts`、未安装 `tsx`）。
5. ~~**C++ 能力文案不一致**~~：`LANGUAGE_OPTIONS` 中 C++ 的 `supportNote` 已改为"按 C 子集解析；class / template / STL / new / delete 等 C++ 特性暂不支持"。
6. **Monaco 体积大**：主 JS 约 5MB、TS Worker 约 6.6MB；建议改为只引入 `monaco-editor/esm/vs/editor/editor.api` + 必要 Worker，或按需加载，见 ROADMAP 4.6。
7. **自动语言识别是启发式**：无扩展名内容里出现 `class` 会被 C++ 特征先匹配（`detectLanguage` 中 `hasCppMarker` 在 JS 检测之前），可能误判；目前靠手动切换兜底。改进方案见 ROADMAP 4.2。
8. **`scripts/verify-ui.cjs` 与 debug 脚本写死 Edge 路径**：换机器或 Edge 安装位置不同会失败；建议改为环境变量/自动探测。
9. **AI 未配置时仅本地规则**：这是设计行为，不是 bug；但用户可能误以为是 AI。UI 与文档已明确标注。AI 没有流式输出、没有服务商预设，超时 45s、代码上下文截断 8000 字符。
10. **JS/TS/Python 无执行、C++ 仅 C 子集**：能力边界已在界面与文档中声明；扩展计划见 ROADMAP 4.2/4.3。
11. **无移动端实机验证**：CSS 只有基础窄屏适配（≤980px 侧栏浮层化、≤720px 隐藏部分信息）；触控/横屏/小屏未验证。

### P2（后续清理）

12. **分析同步执行**：每次按键同步重跑 `analyzeCode`，大文件可能卡顿（导入上限 512KB）；可考虑防抖 + Web Worker + 虚拟列表。
13. **无 LICENSE / 无 CHANGELOG**：如要开源或对外分发，需补充许可证与变更记录（版本 0.1.0）。
14. **`jsdom` 已安装但 Vitest `environment: 'node'`**：当前测试不依赖 DOM；若后续加组件测试再切换环境，否则可清理该依赖。
15. **`tsconfig.tsbuildinfo` 与 `dist/` 残留**：已被 `.gitignore` 忽略；不要提交。
16. **UI 文案与代码的一致性是长期维护点**：任何能力变化都要同步 `analysisTypes.ts` 的 supportNote、`HelpDialog` 能力边界、README 能力矩阵与本文件。
17. ~~**伪代码「应用生成的 C 代码」没有 UI 入口**~~：已在释义面板「原文 / 推断 / 生成代码对照」中接入「载入完整生成代码」按钮；点击前有确认提示，并明确标注生成代码 ≠ 原文。

---

## 9. 上下文耗尽后的接手步骤（推荐顺序）

> 目标：在 10–15 分钟内建立可信基线，再决定改什么。

1. **读文档**：本文件 → [ROADMAP](ROADMAP.md) → `README.md`。确认写作用域（多智能体会话先看任务板，避免与其他成员写同一文件）。
2. **准备环境**（当前 DSH 机器）：
   ```powershell
   $env:PATH = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;$env:PATH"
   $node = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
   $pnpm = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
   cd D:\CodeLens
   ```
3. **跑测试**：`& $node $pnpm test` → 期望 6 文件 / 193 用例通过（数字可能随开发增加；若有失败先判断是回归还是并行进行中的工作）。
4. **类型检查**：`& $node "D:\CodeLens\node_modules\typescript\bin\tsc" -p "D:\CodeLens\tsconfig.json" --noEmit` → 应 exit 0。
5. **确认开发服务器**：
   ```powershell
   Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
   # 未运行则：& $node $pnpm dev
   ```
6. **复跑浏览器验收**：`& $node scripts/verify-ui.cjs` → 期望 50/50；如失败，先看控制台错误与失败项，不要急着改代码。
7. **看 git 状态**（若已 init）：`git status --short`、`git log --oneline -5`；确认没有别人未提交的改动。
8. **从 ROADMAP 的 P0/P1 选任务**：建议先做 4.1（git/CI/测试稳定/清理 `parse:cli`/统一 C++ 文案），再做 4.6 的 Monaco 体积优化。多智能体会话请用任务板领取并写明写作用域。
9. **改动前先读文件**；按模块职责放置代码；先写/补测试，再改实现（或至少同步补测试）。
10. **完成后**：
    - `pnpm test`、`typecheck`、`pnpm build`、`verify-ui` 全绿；
    - 更新受影响的文档：本文件"当前完成状态/已知问题/最近验证结果"、ROADMAP 勾选、README 用户可见能力；
    - 若 UI 或截图相关，重新生成 `docs/screenshots/01`–`09`；
    - 提交并推送（如果已配置远程）。
11. **交接**：在任务板 `complete` 前，回复"改了什么、验证结果、遗留风险、下一步建议"，并更新本文件最后更新时间。

---

## 10. 调试技巧

- **开发环境暴露 store**：`window.__codelensStore.getState()` / `.getState().analysis` / `.getState().execution`；也可调用 `loadSample('pseudo-if')`、`setLanguage('c')`、`setTheme('light')`、`runExecution()`、`setExecutionIndex(n)`。
- **快速看分析结果**：
  ```js
  const s = window.__codelensStore.getState();
  console.log(s.analysis.language, s.analysis.supportLevel, s.analysis.stats, s.analysis.issues);
  ```
- **验收脚本依赖的 DOM 选择器**（改 UI 时注意别破坏）：`.monaco-editor [class*="cl-cat-"]`、`.tree-row`、`.legend-item`、`.explain-title-row h2`、`.explain-section`、`.execution-panel`、`.variable-row`、`.heap-node`、`.comparison-card`、`.settings-modal`、`.notice-toast`、`.editor-toolbar .button.primary`。
- **截图**：`docs/screenshots/01`–`09`（含 `05b-pseudo-execution.png`）由 `scripts/verify-ui.cjs` 生成；失败时脚本会尝试写 `99-failure.png`。调试用的 `debug-*.png` 与 debug 脚本已删除。
- **仅调试单测**：`& $node $pnpm exec vitest run tests/interpreter.test.ts`（或 VS Code 任务「test: 当前测试文件」）。
- **端口/进程**：`Get-NetTCPConnection -LocalPort 5173 -State Listen`；不要随意 `Stop-Process` 别人正在用的 dev server。
- **PowerShell 中文编码**：`Get-Content` 默认可能按 ANSI 显示 UTF-8 文件导致乱码；用 VS Code 或 `Get-Content -Encoding utf8` 阅读。

---

## 11. 多智能体 / 并行开发注意事项

- 本仓库曾由多个 AI 成员并行开发（伪代码、多语言、解释器、解释器测试、文档）。当前共享任务板中的任务与写作用域是准绳：**不要越过自己的写作用域修改他人文件**。
- 共享文件（`src/core/analysisTypes.ts`、`state/store.ts`、`src/App.tsx`、`README.md`、`HANDOFF.md`、测试配置）最容易冲突：改动前先读最新内容，改后立即验证。
- 不要为了"让测试变绿"而修改测试断言（除非任务就是修测试并且已确认期望行为）。
- 运行测试/构建时注意不要覆盖别人正在生成的 `dist/`、截图或临时文件；本轮文档工作时发生了多次并行测试与解释器修复，建议每次以最新输出为准。
- 若需要新增截图，先确认 `scripts/verify-ui.cjs` 的检查项与截图路径仍然有效。

---

## 12. 文档维护

- 本文件是"活文档"：每次完成阶段/修复 P0/改变能力边界时更新：
  - §1 当前状态；
  - §3 最近一次验证结果（日期 + 命令 + 输出摘要）；
  - §8 已知问题（完成项删除或移入 ROADMAP 已完成）；
  - 最后更新日期。
- README 面向使用者：只写已实现且可验证的能力；能力变化时同步能力矩阵与"已知限制"。
- ROADMAP 面向规划：勾选完成项、补充新计划与风险；不要删除历史已完成阶段，便于追溯。
- 文档中的版本号/测试数/体积数据都应带日期，避免读者误当作永久事实。

---

### 附：当前版本

- 版本：**0.1.0**（`package.json`）
- 最近更新：2026-11-17
- 技术栈：React 19.3 / TypeScript 7.0 / Vite 8.3 / Monaco 0.57 / Tailwind 4.3 / Zustand 5.1 / Vitest 5.1 / @babel/parser 8.1 / playwright-core 1.65
- 单元测试：**193 passed / 6 files**（2026-11-17 15:23）
- 浏览器验收：**50/50 通过**（最近记录；本轮解释器修复后建议复跑）
- 仓库：**尚无 git 仓库与远程**
