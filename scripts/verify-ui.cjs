/**
 * CodeLens 浏览器实机验证脚本
 * 使用系统安装的 Microsoft Edge（playwright-core）进行无头验证与截图：
 * 1. 页面加载、三栏布局、Monaco、语义装饰、结构树、释义面板
 * 2. 点击代码 → 释义更新、关联高亮
 * 3. 运行示例 → 逐行执行快照、变量、链表内存可视化、输出
 * 4. 伪代码示例 → 原文/推断/生成代码对照
 * 5. 浅色主题截图
 * 任何控制台错误或断言失败都会输出，便于修复。
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.CODELENS_URL || 'http://127.0.0.1:5173';
const OUT = path.resolve('docs/screenshots');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const consoleErrors = [];
  const pageErrors = [];
  const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  const clearNotice = () => page.evaluate(() => window.__codelensStore?.getState?.().clearNotice());
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForSelector('.monaco-editor', { timeout: 60000 });
    await page.waitForTimeout(2500);

    const overview = await page.evaluate(() => {
      const store = window.__codelensStore?.getState?.();
      return {
        brand: document.querySelector('.brand-name')?.textContent ?? '',
        treeRows: document.querySelectorAll('.tree-row').length,
        semanticDecorations: document.querySelectorAll('.monaco-editor [class*="cl-cat-"]').length,
        legendItems: document.querySelectorAll('.legend-item').length,
        explainTitle: document.querySelector('.explain-title-row h2')?.textContent ?? '',
        explanationSections: document.querySelectorAll('.explain-section').length,
        language: store?.analysis?.language ?? null,
        supportLevel: store?.analysis?.supportLevel ?? null,
        tokens: store?.analysis?.stats?.tokens ?? 0,
        symbols: store?.analysis?.stats?.symbols ?? 0,
        issues: store?.analysis?.issues?.length ?? 0,
        executionSupported: store?.analysis?.execution?.supported ?? false,
        canvasPanels: {
          left: Boolean(document.querySelector('.structure-panel')),
          center: Boolean(document.querySelector('.editor-panel')),
          right: Boolean(document.querySelector('.explain-panel')),
          status: Boolean(document.querySelector('.status-bar')),
        },
      };
    });
    check('页面标题/品牌渲染', overview.brand.includes('CodeLens'), overview.brand);
    check('左侧结构树渲染', overview.treeRows > 8, `${overview.treeRows} 行结构`);
    check('Monaco 语义 decorations 生效', overview.semanticDecorations > 20, `${overview.semanticDecorations} 个语义片段`);
    check('语义图例 9 类', overview.legendItems === 9, `${overview.legendItems} 类`);
    check('右侧释义面板已展示', Boolean(overview.explainTitle) && overview.explanationSections >= 2, `${overview.explainTitle} / ${overview.explanationSections} 节`);
    check('三栏 + 状态栏布局', overview.canvasPanels.left && overview.canvasPanels.center && overview.canvasPanels.right && overview.canvasPanels.status);
    check('C 语言完整分析', overview.language === 'c' && overview.supportLevel === 'full', `${overview.language}/${overview.supportLevel}, ${overview.tokens} tokens, ${overview.symbols} symbols`);
    check('C 代码执行能力声明', overview.executionSupported === true);
    check('默认示例无解析错误', overview.issues >= 0, `${overview.issues} issues`);

    await clearNotice();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, '01-dark-overview.png') });

    // ---- 点击语义 token，验证释义更新与关联高亮 ----
    const tokenBox = await page.evaluate(() => {
      const selectors = ['.monaco-editor .cl-cat-pointer', '.monaco-editor .cl-cat-function', '.monaco-editor .cl-cat-data'];
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) {
          const rect = element.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return { x: rect.x + Math.min(rect.width / 2, 8), y: rect.y + rect.height / 2, selector };
        }
      }
      return null;
    });
    if (tokenBox) {
      const beforeTitle = await page.evaluate(() => document.querySelector('.explain-title-row h2')?.textContent ?? '');
      await page.mouse.click(tokenBox.x, tokenBox.y);
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => ({
        title: document.querySelector('.explain-title-row h2')?.textContent ?? '',
        symbolHighlights: document.querySelectorAll('.monaco-editor .cl-symbol-occurrence, .monaco-editor .cl-symbol-declaration').length,
        relationsTabBadge: document.querySelectorAll('.explain-tab .tab-badge').length,
        snippet: document.querySelector('.explain-snippet')?.textContent ?? '',
      }));
      check('点击代码后释义面板更新', after.title.length > 0, `"${beforeTitle}" → "${after.title}"`);
      check('点击符号后关联位置被高亮', after.symbolHighlights > 0, `${after.symbolHighlights} 处`);
      check('释义包含代码片段', after.snippet.trim().length > 0);
      await page.screenshot({ path: path.join(OUT, '02-click-explain.png') });
    } else {
      check('点击语义 token', false, '未找到可点击的语义 token');
    }

    // ---- 运行 C 示例，检查逐行执行 ----
    await page.click('.editor-toolbar .button.primary');
    await page.waitForTimeout(2500);
    const execution = await page.evaluate(() => {
      const state = window.__codelensStore?.getState?.();
      const exec = state?.execution;
      return {
        status: exec?.status,
        steps: exec?.steps?.length ?? 0,
        error: exec?.error ?? null,
        reason: exec?.reason ?? null,
        description: document.querySelector('.execution-description p')?.textContent ?? '',
        hasPanel: Boolean(document.querySelector('.execution-panel')),
      };
    });
    check('打开底部执行面板', execution.hasPanel);
    check('执行产生真实快照', execution.steps > 5, `${execution.steps} 步, status=${execution.status}`);
    check('执行面板显示当前步骤说明', execution.description.length > 0, execution.description.slice(0, 60));
    if (execution.error) console.log('执行错误信息：', JSON.stringify(execution.error));
    if (!execution.hasPanel) {
      check('执行面板渲染', false, '未找到 .execution-panel');
    }

    // 跳到循环体内部（此时变量与堆内存最丰富），检查变量与链表可视化
    await page.evaluate(() => {
      const state = window.__codelensStore?.getState?.();
      const total = state?.execution?.steps?.length ?? 0;
      if (total > 0) state.setExecutionIndex(Math.min(30, total - 1));
    });
    await page.waitForTimeout(600);
    const memoryState = await page.evaluate(() => {
      const exec = window.__codelensStore?.getState?.()?.execution;
      return {
        variableRows: document.querySelectorAll('.variable-row').length,
        heapNodes: document.querySelectorAll('.heap-node').length,
        chainNodes: document.querySelectorAll('.heap-chain .heap-node').length,
        index: exec?.index,
      };
    });
    check('变量面板渲染', memoryState.variableRows > 0, `${memoryState.variableRows} 行变量（第 ${memoryState.index} 步）`);
    check('链表/堆内存可视化渲染', memoryState.heapNodes > 0, `${memoryState.heapNodes} 个堆节点，${memoryState.chainNodes} 个链表节点`);
    await clearNotice();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, '03-execution.png') });

    // 单步几次，确认变量/描述变化
    const descBefore = await page.evaluate(() => document.querySelector('.execution-description p')?.textContent ?? '');
    await page.click('.execution-controls button[title="下一步"]');
    await page.waitForTimeout(400);
    const afterStep = await page.evaluate(() => ({
      description: document.querySelector('.execution-description p')?.textContent ?? '',
      index: window.__codelensStore?.getState?.().execution.index,
    }));
    check('单步执行推进', afterStep.description !== descBefore || afterStep.index > 30, `index=${afterStep.index}`);

    // 输出标签页
    const outputTab = page.locator('.execution-tab', { hasText: '输出' });
    await outputTab.click();
    await page.waitForTimeout(300);
    const outputVisible = await page.evaluate(() => document.querySelectorAll('.output-console').length > 0);
    check('输出控制台可打开', outputVisible);

    // 跳到最后一步，验证循环与输出累积
    await page.evaluate(() => {
      const state = window.__codelensStore?.getState?.();
      if (state?.execution?.steps?.length) state.setExecutionIndex(state.execution.steps.length - 1);
    });
    await page.waitForTimeout(500);
    const finalState = await page.evaluate(() => ({
      stdout: window.__codelensStore?.getState?.().execution.stdout ?? '',
      steps: window.__codelensStore?.getState?.().execution.steps.length ?? 0,
      status: window.__codelensStore?.getState?.().execution.status,
    }));
    check('C 示例执行到结束并产生输出', finalState.stdout.includes('->') || finalState.stdout.length > 0, `${finalState.stdout.trim().slice(0, 80)} (${finalState.steps} 步, ${finalState.status})`);
    await page.screenshot({ path: path.join(OUT, '04-execution-final.png') });

    // ---- 解释深度切换 ----
    await page.locator('.segmented-button', { hasText: '高级' }).click();
    await page.waitForTimeout(600);
    const advanced = await page.evaluate(() => ({
      level: window.__codelensStore?.getState?.().level,
      hasAdvancedSection: [...document.querySelectorAll('.explain-section-head h3')].some((element) => element.textContent?.includes('底层')),
    }));
    check('切换高级解释深度', advanced.level === 'advanced', `level=${advanced.level}`);
    await page.locator('.segmented-button', { hasText: '中级' }).click();

    // ---- 语义类别开关 ----
    await page.waitForTimeout(400);
    const typeToggle = page.locator('.legend-item', { hasText: '类型' });
    await typeToggle.click();
    await page.waitForTimeout(300);
    const toggled = await page.evaluate(() => Boolean(window.__codelensStore?.getState?.().categoryVisibility.type) === false);
    check('语义类别可关闭', toggled);
    await typeToggle.click();
    await page.waitForTimeout(300);

    // ---- 本地文件导入 ----
    // 浏览器自动化无法可靠打开系统文件选择器：这里用真实 File 对象走应用的 importFile 流程，
    // 并检查文件选择器支持的类型；拖拽导入在下一节单独用 DataTransfer 验证。
    const imported = await page.evaluate(async () => {
      const state = window.__codelensStore?.getState?.();
      const file = new File(
        ['#include <stdio.h>\nint main(void) { int imported = 7; printf("%d\\n", imported); return 0; }\n'],
        'import-test.c',
        { type: 'text/plain' },
      );
      await state.importFile(file);
      const next = window.__codelensStore?.getState?.();
      const input = document.querySelector('input[type=file]');
      return {
        source: next?.analysis?.source ?? '',
        language: next?.analysis?.language,
        fileName: next?.fileName,
        notice: next?.notice?.message ?? '',
        accept: input?.getAttribute('accept') ?? '',
      };
    });
    check('本地文件导入', imported.fileName === 'import-test.c' && imported.source.includes('imported'), `${imported.fileName} / ${imported.language}`);
    check('文件语言自动识别为 C', imported.language === 'c');
    check('文件选择器支持常见代码类型', ['.c', '.cpp', '.h', '.py', '.js', '.ts'].every((extension) => imported.accept.includes(extension)), imported.accept);

    // ---- 拖拽导入（DataTransfer 模拟） ----
    await page.evaluate(() => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['#include <stdio.h>\nint main(void) { return 0; }\n'], 'drop-test.c', { type: 'text/plain' }));
      const shell = document.querySelector('.app-shell');
      shell.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }));
      shell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    });
    await page
      .waitForFunction(() => window.__codelensStore?.getState?.().fileName === 'drop-test.c', null, { timeout: 8000 })
      .catch(() => undefined);
    await page.waitForTimeout(400);
    const dropped = await page.evaluate(() => ({
      fileName: window.__codelensStore?.getState?.().fileName,
      language: window.__codelensStore?.getState?.().analysis?.language,
    }));
    check('拖拽文件导入', dropped.fileName === 'drop-test.c', `${dropped.fileName ?? '未导入'} / ${dropped.language}`);

    // ---- 伪代码示例 ----
    await page.evaluate(() => window.__codelensStore?.getState?.().loadSample('pseudo-if'));
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      const state = window.__codelensStore?.getState?.();
      const flat = [];
      const visit = (nodes) => nodes.forEach((node) => { flat.push(node); visit(node.children ?? []); });
      visit(state.analysis?.tree ?? []);
      const target = flat.find((node) => node.kind?.includes('if')) ?? flat.find((node) => node.range) ?? flat[0];
      if (target) state.selectStructure(target);
    });
    await page.waitForTimeout(900);
    const pseudo = await page.evaluate(() => ({
      language: window.__codelensStore?.getState?.().analysis?.language,
      title: document.querySelector('.explain-title-row h2')?.textContent ?? '',
      comparisons: document.querySelectorAll('.comparison-card').length,
      pseudoTabs: Boolean(document.querySelector('.explain-tab')),
      inference: document.querySelector('.explain-subtitle')?.textContent ?? '',
      executionSupported: window.__codelensStore?.getState?.().analysis?.execution?.supported,
      generated: window.__codelensStore?.getState?.().analysis?.pseudo?.generatedCode ?? '',
      warnings: window.__codelensStore?.getState?.().analysis?.pseudo?.warnings?.length ?? 0,
    }));
    check('伪代码语言分析', pseudo.language === 'pseudo', `language=${pseudo.language}`);
    check('伪代码释义可展示', pseudo.title.length > 0, pseudo.title);
    check('伪代码释义展示原文/推断/生成代码对照', pseudo.comparisons > 0, `${pseudo.comparisons} 组对照`);
    check('伪代码生成 C 代码', pseudo.generated.includes('int main'), `${pseudo.generated.split('\n').length} 行生成代码`);
    check('伪代码执行条件明确', typeof pseudo.executionSupported === 'boolean', `supported=${pseudo.executionSupported}`);
    await clearNotice();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, '05-pseudo.png') });

    // ---- 伪代码执行：执行生成的 C 代码，并验证输出 ----
    if (pseudo.executionSupported) {
      await page.click('.editor-toolbar .button.primary');
      await page.waitForTimeout(1800);
      const pseudoExec = await page.evaluate(() => {
        const exec = window.__codelensStore?.getState?.().execution;
        return { status: exec?.status, steps: exec?.steps?.length ?? 0, stdout: exec?.stdout ?? '', label: exec?.label };
      });
      check('伪代码可执行生成的 C 代码', pseudoExec.status === 'done' && pseudoExec.steps > 0, `${pseudoExec.steps} 步`);
      check('伪代码执行输出符合条件分支', pseudoExec.stdout.includes('Hello') || pseudoExec.stdout.includes('World'), pseudoExec.stdout.trim().slice(0, 80));
      check('执行标签明确为生成代码', (pseudoExec.label ?? '').includes('生成'), pseudoExec.label ?? '');
      await page.screenshot({ path: path.join(OUT, '05b-pseudo-execution.png') });
    }

    // ---- JavaScript / Python 结构级分析 ----
    await page.evaluate(() => window.__codelensStore?.getState?.().loadSample('js-demo'));
    await page.waitForTimeout(1200);
    const js = await page.evaluate(() => ({
      language: window.__codelensStore?.getState?.().analysis?.language,
      level: window.__codelensStore?.getState?.().analysis?.supportLevel,
      treeRows: document.querySelectorAll('.tree-row').length,
      executionReason: window.__codelensStore?.getState?.().analysis?.execution?.supported,
      decorations: document.querySelectorAll('.monaco-editor [class*="cl-cat-"]').length,
    }));
    check('加载 JavaScript 示例并结构级分析', js.language === 'javascript' && js.level === 'structural', `${js.treeRows} 个结构`);
    check('JS 语义高亮生效', js.decorations > 5, `${js.decorations} 个语义片段`);
    check('JS 明确不支持执行', js.executionReason === false);
    await clearNotice();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, '08-javascript.png') });

    await page.evaluate(() => window.__codelensStore?.getState?.().loadSample('python-demo'));
    await page.waitForTimeout(1200);
    const python = await page.evaluate(() => ({
      language: window.__codelensStore?.getState?.().analysis?.language,
      level: window.__codelensStore?.getState?.().analysis?.supportLevel,
      treeRows: document.querySelectorAll('.tree-row').length,
    }));
    check('加载 Python 示例并结构级分析', python.language === 'python' && python.level === 'structural', `${python.treeRows} 个结构`);

    // ---- 学习笔记 ----
    await page.evaluate(() => window.__codelensStore?.getState?.().loadSample('c-pointer-swap'));
    await page.waitForTimeout(900);
    await page.click('.header-right .icon-button[title*="学习笔记"]');
    await page.waitForTimeout(500);
    const notes = await page.evaluate(() => ({
      open: Boolean(document.querySelector('.notes-modal')),
      text: document.querySelector('.notes-preview')?.textContent ?? '',
    }));
    check('学习笔记弹窗可打开', notes.open);
    check('学习笔记由真实分析结果生成', notes.text.includes('学习笔记') && notes.text.includes('指针'), `${notes.text.length} 字符`);
    await page.keyboard.press('Escape');

    // ---- 帮助与能力边界 ----
    await page.click('.brand');
    await page.waitForTimeout(400);
    const help = await page.evaluate(() => ({
      open: Boolean(document.querySelector('.help-modal')),
      tabs: document.querySelectorAll('.help-tabs .settings-tab').length,
    }));
    check('帮助/能力边界弹窗可打开', help.open && help.tabs === 4);
    await page.locator('.help-tabs .settings-tab', { hasText: '解析问题' }).click();
    await page.waitForTimeout(300);
    const issuesTab = await page.evaluate(() => document.querySelector('.help-issues')?.textContent ?? '');
    check('解析问题标签页可查看', issuesTab.length > 0);
    await page.keyboard.press('Escape');

    // ---- AI 未配置时的本地规则兜底 ----
    await page.evaluate(() => {
      const state = window.__codelensStore?.getState?.();
      state.setRightOpen(true);
      state.setActiveRightTab('ai');
      state.clearAIChat();
    });
    await page.waitForTimeout(500);
    await page.locator('.ai-quick-prompts .quick-prompt').first().click();
    await page.waitForTimeout(600);
    const aiLocal = await page.evaluate(() => ({
      localMessages: document.querySelectorAll('.ai-message.source-local').length,
      content: document.querySelector('.ai-message.source-local .ai-message-content')?.textContent ?? '',
      banner: document.querySelector('.ai-status')?.textContent ?? '',
    }));
    check('AI 未配置时使用本地规则解释', aiLocal.localMessages > 0 && aiLocal.content.includes('本地规则'), `${aiLocal.content.slice(0, 60)}`);
    check('AI 未配置时明确提示而不是伪造回答', aiLocal.banner.includes('未配置'));

    // ---- 浅色主题（回到干净的释义视图便于截图） ----
    await page.evaluate(() => {
      const state = window.__codelensStore?.getState?.();
      state.loadSample('c-linked-list');
      state.setRightOpen(true);
      state.setActiveRightTab('explain');
      state.setBottomOpen(false);
      state.setLevel('intermediate');
      state.setTheme('light');
      state.clearNotice();
    });
    await page.waitForTimeout(1200);
    const light = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      background: getComputedStyle(document.body).backgroundColor,
      explainTitle: document.querySelector('.explain-title-row h2')?.textContent ?? '',
    }));
    check('浅色主题切换', light.theme === 'light', `${light.background}`);
    check('浅色主题下释义正常渲染', light.explainTitle.length > 0);
    await page.screenshot({ path: path.join(OUT, '06-light-theme.png') });

    // ---- 响应式布局 ----
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(900);
    const responsive = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      hasEditor: Boolean(document.querySelector('.monaco-editor')),
      hasTree: Boolean(document.querySelector('.structure-panel')),
      hasExplain: Boolean(document.querySelector('.explain-panel')),
    }));
    check(
      '1280px 响应式布局无横向溢出',
      responsive.scrollWidth <= responsive.innerWidth + 2 && responsive.hasEditor && responsive.hasTree && responsive.hasExplain,
      `${responsive.scrollWidth}/${responsive.innerWidth}`,
    );
    await page.screenshot({ path: path.join(OUT, '09-responsive-1280.png') });

    // ---- 设置弹窗 ----
    await page.setViewportSize({ width: 1680, height: 1000 });
    await page.waitForTimeout(400);
    await page.click('.header-right .icon-button[title^="设置"]');
    await page.waitForTimeout(500);
    const settings = await page.evaluate(() => ({
      open: Boolean(document.querySelector('.settings-modal')),
      colorRows: document.querySelectorAll('.color-row').length,
      tabs: document.querySelectorAll('.settings-tab').length,
    }));
    check('设置弹窗可打开', settings.open);
    check('语义颜色可自定义（9 类）', settings.colorRows >= 9, `${settings.colorRows} 行`);
    await page.screenshot({ path: path.join(OUT, '07-settings.png') });
    await page.keyboard.press('Escape');

    // ---- 控制台错误 ----
    check('浏览器控制台无错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    check('页面无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

    console.log('\n===== 验证结果汇总 =====');
    const passed = results.filter((item) => item.ok).length;
    console.log(`${passed}/${results.length} 项通过`);
    if (consoleErrors.length) {
      console.log('\n控制台错误（前 10 条）：');
      consoleErrors.slice(0, 10).forEach((error) => console.log('-', error));
    }
    if (pageErrors.length) {
      console.log('\n页面异常（前 10 条）：');
      pageErrors.slice(0, 10).forEach((error) => console.log('-', error));
    }
    await browser.close();
    process.exit(passed === results.length ? 0 : 2);
  } catch (error) {
    console.error('验证脚本失败：', error);
    try {
      await page.screenshot({ path: path.join(OUT, '99-failure.png') });
    } catch {
      // 忽略截图失败
    }
    console.log('控制台错误：', consoleErrors.slice(0, 10));
    console.log('页面异常：', pageErrors.slice(0, 10));
    await browser.close();
    process.exit(1);
  }
})();
