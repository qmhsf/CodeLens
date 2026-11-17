# CodeLens 路线图（ROADMAP）

> 本文档记录已完成阶段、后续计划、建议实现顺序与风险。
> 最后更新：2026-11-17（阶段一/二主体完成，阶段三基本完成；阶段四尚未开始）。
> 勾选状态以代码与测试的实际状态为准；如果与代码不一致，以代码为准并更新本文档。

---

## 阶段一：基础框架与 C 语言分析 ✅

目标：搭好纯前端三栏应用骨架，把 C 子集代码变成"可看、可点、可解释"的结构。

- [x] React 19 + TypeScript 7 + Vite 8 + Tailwind CSS 4 + Zustand 5 工程骨架（`vite.config.ts`、`tsconfig.json`、`src/main.tsx`）
- [x] 三栏布局 + 顶栏 + 状态栏 + 深浅主题 + 面板显隐（`src/App.tsx`、`src/components/`、`src/styles/index.css`）
- [x] C 词法分析器：标识符、关键字、数字、字符/字符串、运算符、注释、预处理指令（`src/core/lexer.ts`）
- [x] C 子集递归下降解析器，产出带精确源码区间的 AST（`src/core/cParser.ts`、`src/core/ast.ts`）
- [x] C 符号表：变量/参数/函数/结构体/typedef/成员、作用域、遮蔽、类型推断（`src/core/symbols.ts`）
- [x] 九类语义 token 与 Monaco 装饰（字色、指针/数组下划线、结构边界背景、嵌套层级）（`src/core/semantic.ts`、`src/editor/decorations.ts`）
- [x] 中文结构树：程序 → 函数/结构体/类型 → 参数/函数体 → 变量/条件/循环/调用；搜索、折叠、点击定位（`src/core/structureTree.ts`、`src/components/StructureTree.tsx`）
- [x] 三种深度中文释义：组成拆解/整体释义/用途/关联/误区/类比/进阶原理（`src/core/explain/`）
- [x] 符号关联定位：声明与全部使用位置高亮、关联面板跳转（`src/components/RelationsPanel.tsx`）
- [x] 语义颜色自定义、类别开关、结构显示设置（`src/components/SettingsDialog.tsx`、`src/core/semanticCatalog.ts`）
- [x] 内置真实示例、本地文件导入（≤ 512KB）、拖拽导入、帮助与能力边界弹窗
- [x] 解析错误与不支持语法通过 `issues` 明确提示，不静默丢弃
- [x] 单元测试：C 解析（`tests/cParser.test.ts`）+ 分析管线（`tests/analysis.test.ts`）

**阶段完成标准**：`pnpm test` 中 C 解析/分析相关用例通过；`pnpm build` 成功；主界面可完成"输入 → 高亮 → 结构树 → 释义 → 关联"闭环。

---

## 阶段二：逐行执行可视化 ✅（浏览器回归待复跑）

目标：用内置 C 子集解释器执行真实 AST，展示每一步的变量、内存与输出。

- [x] C 子集解释器：变量/表达式/控制流/函数调用与递归/数组/指针/结构体/`malloc`/`free`/`printf`（`src/core/interpreter/`）
- [x] 逐行快照：行号、中文说明、作用域与变量值、堆对象、调用栈、输出、警告
- [x] 内存可视化：模拟地址、指针箭头、数组元素、结构体成员、链表链、悬空指针提示
- [x] 执行面板：单步 / 上一步 / 自动播放 / 进度滑块 / 重置 / 重新运行；调用栈、输出控制台、问题页
- [x] 编辑器执行行高亮与当前行说明联动
- [x] 能力边界与诚实报错：`scanf`/文件 IO/函数指针/`goto`/C++ 等明确中止并给出中文原因与行号
- [x] 运行期错误：除零、空指针解引用、数组越界、读取未初始化变量、递归过深、步数超限
- [x] `tests/interpreter.test.ts` 高覆盖测试（55 用例：算术/控制流/函数递归/数组/指针/结构体/malloc 链表/错误场景等）与测试暴露缺陷的修复
- [ ] 解释器修改后，在最终版本复跑一次浏览器实机验收（确认执行面板行为无回归）

**阶段完成标准**：链表示例执行到结束并输出 `3 -> 2 -> 1 -> NULL`；执行面板变量/堆/输出/问题页正常；解释器测试全绿。

---

## 阶段三：中文伪代码、多语言结构分析、AI 与学习笔记 ✅

目标：在 C 之外扩展学习场景，并接入可选的 AI 增强。

### 3.1 中文伪代码

- [x] 规则驱动的逐行推断：变量声明/赋值/输出/输入/条件/循环/函数/返回/break/continue/调用/注释（`src/core/pseudo/analyzer.ts`）
- [x] 支持中文/英文标点、全角字符、缩进块与"结束如果/结束循环"等显式结束标记；兼容无缩进单行 `如果…，就输出…。/ 否则…`
- [x] 原文 / 系统推断 / 生成的 C 代码三方严格区分，逐行置信度与风险提示
- [x] C 代码生成与生成行号映射（`src/core/pseudo/codegen.ts`）
- [x] 伪代码结构树、语义关键词高亮、原文/推断/生成代码对照释义
- [x] 仅在生成代码足够可靠且无输入语句时允许执行"生成代码"，否则明确说明原因
- [x] 单元测试（`tests/pseudo.test.ts`）

### 3.2 JS / TS / Python 结构分析

- [x] JS/TS：`@babel/parser` 真实 AST（tokens + errorRecovery），自实现静态作用域、符号、结构树、语义 token（`src/core/languages/javascript.ts`）
- [x] Python：自实现分词器（字符串/三引号/注释/Unicode 标识符/缩进）+ 基于缩进块的结构解析（`src/core/languages/python.ts`）
- [x] 语法错误显式报告并尽量恢复结构树；明确声明不支持执行
- [x] 结构级中文释义（`src/core/explain/structureExplainer.ts`）
- [x] 单元测试（`tests/languages.test.ts`）

### 3.3 学习笔记与 AI 接口

- [x] 本地规则生成 Markdown 学习笔记（结构/函数/变量/控制流程/知识点/限制/自测题），支持复制与下载（`src/services/notes.ts`、`NotesDialog.tsx`）
- [x] 学习笔记明确标注"本地规则生成、非 AI 编造"
- [x] OpenAI 兼容 AI 接口：Base URL / 模型 / API Key / 温度 / 启用开关 / 连通性测试（`src/services/ai.ts`、`SettingsDialog.tsx`）
- [x] 未配置 AI 时使用本地规则解释并标注"非 AI"；请求失败原因原样反馈
- [x] 隐私边界：源码默认不持久化；API Key 仅存本机 localStorage；只有主动提问才发送代码
- [x] 能力边界集中展示：帮助弹窗的「能力边界 / 解析问题 / 关于·隐私」标签页

### 3.4 验收与文档

- [x] 浏览器实机验收脚本 `scripts/verify-ui.cjs`（playwright-core + 系统 Edge，51 项检查；最近一次运行 51/51 通过）
- [x] 实机截图 11 张（`docs/screenshots/01`–`10` + `05b`）
- [x] `README.md`、`docs/HANDOFF.md`、`docs/ROADMAP.md`
- [x] VS Code 工程配置（`.vscode/tasks.json`、`launch.json`、`settings.json`、`extensions.json`）与 `.editorconfig`、`.gitignore`
- [x] Git 仓库已推送：<https://github.com/qmhsf/CodeLens>；GitHub Actions CI 与 GitHub Pages 自动部署均已成功运行
- [x] 线上站点 <https://qmhsf.github.io/CodeLens/> 通过同一套 51 项浏览器验收（2026-11-17 实测）

**阶段完成标准**：伪代码示例可展示原文/推断/生成代码；JS/Python 可分析且明确不执行；笔记可下载；AI 未配置时行为与提示正确；本地与线上浏览器 51 项验收均通过。

---

## 阶段四：增强计划（尚未开始）

以下为建议的后续路线，按优先级与依赖关系分组。**任何新能力上线前都必须同步更新界面的能力边界文案与本文档，不允许把"实验中"包装成"已支持"。**

### 4.1 工程质量与收尾（P0，建议最先做）

- [x] **配置 Git 远程仓库并推送**：已推送 <https://github.com/qmhsf/CodeLens>（public，`main`）。
- [x] **GitHub Pages 自动部署**：`.github/workflows/deploy-pages.yml`；线上地址 <https://qmhsf.github.io/CodeLens/>。
- [x] **CI 工作流文件**：`.github/workflows/ci.yml` 已添加（`pnpm install --frozen-lockfile` → `pnpm test` → `pnpm build`），首次 push 后已成功运行。
- [x] **保持测试全绿并为新功能补测**：当前 6 个测试文件 / 193 用例全部通过（cParser、analysis、pseudo、languages、explain、interpreter）；新增能力必须补对应用例，禁止为了"变绿"弱化断言。
- [ ] **浏览器验收接入 CI**：Windows Runner 上安装/启用 Edge 后运行 `node scripts/verify-ui.cjs`（需先启动 dev server 或 preview server）。
- [x] ~~**清理无效脚本**~~：`package.json` 的 `parse:cli` 已删除。
- [x] ~~**统一 C++ 能力文案**~~：`LANGUAGE_OPTIONS` 中 C++ 说明已改为"按 C 子集解析；class / template / STL / new / delete 等 C++ 特性暂不支持"。
- [ ] **Monaco 体积优化**（详见 4.6）。
- [ ] **浏览器验收脚本可移植**：Edge 路径改为环境变量/自动探测，避免写死 `C:\Program Files (x86)\...`。

### 4.2 解析与释义能力（P1）

- [ ] **多语言正式解析器**：评估 tree-sitter（WASM）接入 C/C++/Python/JS/TS，替换/增强现有手写分析器；注意 bundle 体积与离线加载。
- [ ] **补齐 C 子集边界**：按真实需求决定是否支持函数指针、`goto`、位域、复杂宏等；未实现前继续明确报错。
- [ ] **C++ 子集扩展**：`class`/`namespace`/引用等基础语法若要支持，需要 AST、符号表、释义、执行全链路一起改，并更新能力矩阵。
- [ ] **语言自动识别改进**：从"关键词优先级"升级为"扩展名 > shebang > 内容打分"；新增用例覆盖误判场景（如 JS 的 `class`）。
- [ ] **释义覆盖扩展**：为更多节点类型（`switch`、`do-while`、`union`、`enum` 等）补齐三种深度文案；持续打磨初学者误区与类比质量。
- [ ] **未知文本分析增强**：更明确的缩进块结构、关键词覆盖和边界提示。

### 4.3 执行引擎扩展（P1/P2）

- [ ] **C 子集解释器增强**：`calloc`/`realloc`、更多结构体/数组成员场景、指针运算细节、`static` 变量、更完整的格式化输出。
- [ ] **Python 执行（可选、懒加载）**：通过 Pyodide/WASM 运行 Python，按需加载（体积大，必须默认关闭并明确提示）；只用于教学小片段。
- [ ] **JavaScript 执行（可选）**：评估 QuickJS WASM 等沙箱方案；必须解决超时/死循环/内存限制与安全边界。
- [ ] **C/C++ 真实编译执行**：clang WASM 体积与复杂度高，优先级低；如做需明确"非完整运行时"。
- [ ] **执行快照能力增强**：快照导出/对比、执行轨迹回放、断点式观察。
- [ ] **多语言执行能力矩阵**：新增能力必须同步更新 UI 的帮助、状态栏与 README/HANDOFF。

### 4.4 AI 增强（P2）

- [ ] **流式输出（SSE）**：AI 回答逐字显示，可中断；需要解析 `text/event-stream` 并处理 CORS/代理。
- [ ] **服务商预设**：OpenAI / DeepSeek / 本地 Ollama 等可选预设，降低配置门槛（仍不内置密钥）。
- [ ] **AI 生成释义/笔记（显式标注）**：与本地规则结果严格区分，默认关闭，需用户确认。
- [ ] **对话导出/清理增强**：导出 Markdown、清空会话、密钥一键清除。
- [ ] **更细的隐私控制**：发送前预览实际请求内容；按语言/片段长度限制。

### 4.5 学习体验（P2）

- [ ] **笔记导出 PDF**：在现有 Markdown 下载基础上增加 PDF（可用浏览器打印样式或 `pdf-lib` 等纯前端方案）。
- [x] **伪代码生成代码可查看 / 一键载入**：释义面板生成代码对照区已提供「载入完整生成代码」按钮（确认后替换编辑器内容，并标注生成代码 ≠ 原文）。
- [ ] **练习模式**：基于当前代码自动生成选择题/填空题（本地规则 + 可选 AI），记录本地进度。
- [ ] **分享功能**：生成只读分享链接（必须解决"源码不上传"与隐私的冲突，可考虑 URL 压缩编码 + 用户确认）。
- [ ] **移动端适配**：当前仅有基础窄屏 CSS（侧栏浮层化），需实机验证、触控操作与横屏布局优化。
- [ ] **国际化**：中文/英文 UI 文案抽离；当前全部硬编码中文。
- [ ] **可访问性**：键盘导航、焦点管理、ARIA 检查、对比度校验。

### 4.6 性能与可维护性（P2）

- [ ] **Monaco 精简打包**：改为只引入 `monaco-editor/esm/vs/editor/editor.api` 与必要 worker，去掉未使用的语言/Worker 产物；目标是把主包与 Worker 体积显著降低。
- [ ] **代码分割**：执行面板/解释器按需加载（解释器已用动态 `import`）；Monaco 异步加载骨架屏已有，可进一步拆包。
- [ ] **分析移入 Web Worker**：大文件解析不阻塞主线程；配合输入防抖（当前每次按键同步分析）。
- [ ] **结构树虚拟滚动**：超大文件结构树性能。
- [ ] **测试覆盖率门槛**：为 `src/core` 设置覆盖率目标与 CI 检查。
- [ ] **依赖升级策略**：TypeScript 7 / Vite 8 / React 19 均为较新版本，升级前先跑全量测试与浏览器验收。

---

## 建议实现顺序

1. **先稳定再扩展**：配置 GitHub 远程并首次推送 + 浏览器验收回归复跑 + CI 首次运行（4.1）。
2. **性能第一**：Monaco 精简与代码分割（4.6 前两项）——直接影响首屏体验与后续功能加载。
3. **解析增强**：语言自动识别改进 → tree-sitter 评估与试点（建议先 Python，再 JS/TS，最后 C/C++）。
4. **执行扩展**：C 子集解释器增强（低风险）→ Python via Pyodide（高价值但体积风险）→ JS 沙箱（高风险，放后）。
5. **AI 与学习体验**：AI 流式（低风险）→ 笔记 PDF/练习模式 → 分享/移动端/国际化（需产品决策）。
6. **每个阶段完成后**：`pnpm typecheck`、`pnpm test`、`pnpm build`、`node scripts/verify-ui.cjs` 全绿，更新 README/HANDOFF/ROADMAP 与能力边界文案。

---

## 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| tree-sitter / Pyodide / WASM 体积过大 | 首屏与加载时间显著变差，离线体验下降 | 懒加载 + 功能开关 + 体积预算（例如新增依赖 gzip 后 ≤ 1–2MB）；先做技术验证再合入 |
| 执行引擎不完整导致误导 | 用户以为支持完整语言，产生错误学习结论 | 坚持"能力矩阵 + 界面明确提示 + 不支持即报错"；新增能力必须同步文案与测试 |
| AI 回答不可靠 | 初学者把模型幻觉当事实 | 默认关闭；AI 结果与本地规则结果分开标注；提示"AI 可能出错，以代码与运行结果为准" |
| 浏览器 CORS/网络限制 | AI 功能在部分环境不可用 | 错误原样反馈 + 文档说明代理方案；本地规则兜底始终可用 |
| 隐私泄露（API Key/源码） | 共享电脑或恶意扩展风险 | Key 存 localStorage 需明示风险；源码不持久化；AI 请求仅在用户主动操作时发送 |
| 单人/多 AI 并行开发导致文件冲突 | 修改相互覆盖、测试波动 | 用任务板划分写作用域；改动前先读文件；提交前跑全量测试与 diff 审查 |
| 依赖版本过新（TS 7 / Vite 8） | 工具链/扩展兼容性问题 | 锁定 `pnpm-lock.yaml`；升级前跑 typecheck/test/build/browser verify；VS Code 不用 tsdk 指向项目 TS |
| 无远程仓库 | 磁盘故障/误删导致工作丢失 | 尽快 `git init` 并推送远程；截图与文档一起版本化 |

---

## 完成定义（每个阶段的验收门槛）

- `pnpm typecheck` 无错误；
- `pnpm test` 全绿（新增功能必须有对应测试）；
- `pnpm build` 成功；
- 开发服务器下 `node scripts/verify-ui.cjs` 51 项通过（新增 UI 需补充检查项）；
- 能力边界文案（界面帮助、README、HANDOFF）与实际行为一致；
- 不新增"伪造分析/伪造执行"的路径。
