/**
 * 中间代码编辑区
 * ------------------------------------------------------------------
 * Monaco 负责编辑体验，CodeLens 自己负责：
 * 1. 基于 AST 的语义颜色装饰（而不是传统语法高亮）；
 * 2. 指针/数组下划线、结构边界背景、嵌套层级；
 * 3. 悬停释义、点击选中、同名符号关联高亮；
 * 4. 执行当前行高亮；
 * 5. 拖拽文件导入（由外层 App 统一处理）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import type { AnalysisResult } from '../core/analysisTypes';
import { SEMANTIC_CATEGORIES } from '../core/semanticCatalog';
import { findSymbolAtOffset, useAppStore } from '../state/store';
import { hoverAt } from '../core/explain';
import { monaco } from '../monaco/setup';
import { buildDecorationSpecs, colorSchemeToCssVars } from '../editor/decorations';
import { Icon, CATEGORY_ICONS } from './Icons';

/** 编辑器主题名 */
function monacoTheme(theme: 'dark' | 'light'): string {
  return theme === 'dark' ? 'codelens-dark' : 'codelens-light';
}

/** 在分析结果中查找包含偏移量的符号出现范围（用于 hover 定位） */
function findOccurrenceRangeAt(analysis: AnalysisResult | null, offset: number) {
  if (!analysis) return undefined;
  let best: { start: number; end: number } | undefined;
  for (const symbol of analysis.symbolList) {
    for (const occurrence of symbol.occurrences) {
      if (offset >= occurrence.range.start && offset <= occurrence.range.end) {
        const size = occurrence.range.end - occurrence.range.start;
        if (!best || size < best.end - best.start) best = { start: occurrence.range.start, end: occurrence.range.end };
      }
    }
  }
  return best;
}

export function EditorPanel() {
  const code = useAppStore((state) => state.code);
  const theme = useAppStore((state) => state.theme);
  const analysis = useAppStore((state) => state.analysis);
  const colors = useAppStore((state) => (state.theme === 'dark' ? state.colorsDark : state.colorsLight));
  const visibility = useAppStore((state) => state.categoryVisibility);
  const selectedStructure = useAppStore((state) => state.selectedStructure);
  const hoveredSymbolId = useAppStore((state) => state.hoveredSymbolId);
  const execution = useAppStore((state) => state.execution);
  const revealRequest = useAppStore((state) => state.revealRequest);
  const showStructureBackground = useAppStore((state) => state.showStructureBackground);
  const showNestingDepth = useAppStore((state) => state.showNestingDepth);
  const setCode = useAppStore((state) => state.setCode);
  const selectAtOffset = useAppStore((state) => state.selectAtOffset);
  const setHoveredSymbol = useAppStore((state) => state.setHoveredSymbol);
  const toggleCategory = useAppStore((state) => state.toggleCategory);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const runExecution = useAppStore((state) => state.runExecution);
  const setBottomOpen = useAppStore((state) => state.setBottomOpen);

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const setCodeRef = useRef(setCode);
  setCodeRef.current = setCode;
  // Monaco 是异步挂载的：用状态触发装饰 effect 在挂载完成后重新执行
  const [editorReady, setEditorReady] = useState(false);

  /** 当前执行行（仅当分析语言为 C/C++ 且执行快照存在时） */
  const executionLine = useMemo(() => {
    if (!analysis || (analysis.language !== 'c' && analysis.language !== 'cpp')) return null;
    if (!execution.steps.length || execution.status === 'idle' || execution.status === 'unsupported') return null;
    const step = execution.steps[Math.min(execution.index, execution.steps.length - 1)];
    return step?.range?.startLine ?? step?.line ?? null;
  }, [analysis?.language, execution.steps, execution.index, execution.status]);

  const executionRange = useMemo(() => {
    if (executionLine === null) return null;
    return execution.steps[execution.index]?.range ?? null;
  }, [executionLine, execution.steps, execution.index]);

  const cssVars = useMemo(() => colorSchemeToCssVars(colors) as CSSProperties, [colors]);

  const options = useMemo<Monaco.editor.IStandaloneEditorConstructionOptions>(
    () => ({
      fontSize: 14,
      fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, "Microsoft YaHei", monospace',
      fontLigatures: false,
      lineHeight: 23,
      letterSpacing: 0,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      padding: { top: 18, bottom: 24 },
      renderLineHighlight: 'all',
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: true,
      foldingHighlight: false,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      bracketPairColorization: { enabled: false },
      guides: { bracketPairs: false, indentation: true, highlightActiveIndentation: false },
      renderWhitespace: 'selection',
      tabSize: 4,
      insertSpaces: true,
      wordWrap: 'off',
      hover: { enabled: 'on', delay: 280 },
      links: false,
      contextmenu: true,
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      occurrencesHighlight: 'off',
      selectionHighlight: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      stickyScroll: { enabled: false },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      renderValidationDecorations: 'off',
      fixedOverflowWidgets: true,
      accessibilitySupport: 'auto',
    }),
    [],
  );

  /** 注册 hover / 点击 / 鼠标移动监听 */
  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
    decorationsRef.current = editor.createDecorationsCollection([]);
    setEditorReady(true);

    const hoverProvider = monaco.languages.registerHoverProvider('codelens', {
      provideHover(model, position) {
        const current = useAppStore.getState().analysis;
        if (!current) return null;
        const offset = model.getOffsetAt(position);
        const info = hoverAt(current, offset);
        if (!info) return null;
        const occurrence = findOccurrenceRangeAt(current, offset);
        const range = occurrence
          ? (() => {
              const start = model.getPositionAt(occurrence.start);
              const end = model.getPositionAt(occurrence.end);
              return new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
            })()
          : new monaco.Range(position.lineNumber, 1, position.lineNumber, model.getLineMaxColumn(position.lineNumber));
        return {
          range,
          contents: [
            { value: `**${info.title}**${info.badge ? `　·　\`${info.badge}\`` : ''}` },
            { value: info.summary },
            { value: `_${info.hint}_` },
          ],
        };
      },
    });

    const mouseDisposable = editor.onMouseMove((event) => {
      const position = event.target.position;
      const current = useAppStore.getState().analysis;
      if (!position || !current) return;
      const model = editor.getModel();
      if (!model) return;
      const offset = model.getOffsetAt(position);
      const symbol = findSymbolAtOffset(current, offset);
      setHoveredSymbol(symbol?.symbolId ?? null);
    });

    const mouseLeaveDisposable = editor.onMouseLeave(() => setHoveredSymbol(null));

    const clickDisposable = editor.onMouseDown((event) => {
      const position = event.target.position;
      const model = editor.getModel();
      if (!position || !model) return;
      selectAtOffset(model.getOffsetAt(position));
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      void runExecution();
    });

    // 组件卸载时释放监听与 provider
    editor.onDidDispose(() => {
      hoverProvider.dispose();
      mouseDisposable.dispose();
      mouseLeaveDisposable.dispose();
      clickDisposable.dispose();
    });
  };

  /** 装饰与主题更新 */
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    monaco.editor.setTheme(monacoTheme(theme));
    if (!analysis) {
      decorationsRef.current?.clear();
      return;
    }
    const specs = buildDecorationSpecs({
      analysis,
      colors,
      visibility,
      selectedStructureRange: selectedStructure?.range,
      highlightedSymbolId: hoveredSymbolId,
      executionLine,
      executionRange,
      showBoundaries: showStructureBackground,
      showNestingDepth,
    });
    const decorations = specs.map((spec) => ({
      range: new monaco.Range(spec.startLine, spec.startCol, spec.endLine, spec.endCol),
      options: {
        inlineClassName: spec.inlineClassName,
        className: spec.className,
        isWholeLine: spec.isWholeLine ?? false,
        hoverMessage: spec.hoverMessage ? { value: spec.hoverMessage } : undefined,
      },
    }));
    decorationsRef.current?.set(decorations);
  }, [analysis, colors, visibility, selectedStructure, hoveredSymbolId, executionLine, executionRange, showStructureBackground, showNestingDepth, theme, editorReady]);

  /** 结构树/关联面板触发的定位 */
  useEffect(() => {
    if (!revealRequest) return;
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const start = model.getPositionAt(revealRequest.offset);
    // 仅移动光标并滚动，选中范围由 cl-selected-region 背景装饰表达，
    // 避免 Monaco 默认选区色盖住语义高亮颜色。
    editor.setPosition(start);
    editor.revealPositionInCenterIfOutsideViewport(start, monaco.editor.ScrollType.Smooth);
  }, [revealRequest?.nonce]);

  const analysisForToolbar = analysis;
  const canRun = Boolean(analysisForToolbar?.execution.supported);

  return (
    <div className="editor-panel">
      <div className="editor-toolbar">
        <div className="editor-toolbar-left">
          <span className={`language-chip language-${analysisForToolbar?.language ?? 'plaintext'}`}>
            <span className="language-dot" />
            {analysisForToolbar?.languageLabel ?? '加载中'}
          </span>
          {analysisForToolbar && (
            <span className="editor-stat" title="分析统计">
              {analysisForToolbar.stats.lines} 行 · {analysisForToolbar.stats.tokens} 语义片段 · {analysisForToolbar.stats.parseMs}ms
            </span>
          )}
          {analysisForToolbar && analysisForToolbar.issues.length > 0 && (
            <button className="editor-issue-chip" onClick={() => useAppStore.getState().setHelpOpen(true)} title="查看解析问题与能力边界">
              <Icon name="warning" size={13} />
              {analysisForToolbar.stats.errors} 错误 / {analysisForToolbar.stats.warnings} 警告
            </button>
          )}
        </div>
        <div className="editor-toolbar-right">
          <span className="editor-hint">Ctrl/⌘ + Enter 运行</span>
          <button
            className={`button primary ${canRun ? '' : 'ghost'}`}
            onClick={() => {
              setBottomOpen(true);
              void runExecution();
            }}
            title={canRun ? '运行逐行执行可视化' : '查看当前语言的执行支持说明'}
          >
            <Icon name="play" size={15} />
            {canRun ? (execution.status === 'idle' ? '运行' : '重新运行') : '执行说明'}
          </button>
        </div>
      </div>

      <div className="editor-host" style={cssVars} data-language={analysisForToolbar?.language}>
        <Editor
          height="100%"
          language="codelens"
          theme={monacoTheme(theme)}
          value={code}
          options={options}
          onChange={(value) => setCodeRef.current(value ?? '')}
          onMount={handleMount}
          loading={
            <div className="editor-loading">
              <Icon name="code" size={22} />
              <span>正在加载 Monaco 编辑器…</span>
            </div>
          }
        />
      </div>

      <div className="editor-legend" title="点击色块可开启/关闭对应类别的高亮">
        {SEMANTIC_CATEGORIES.map((category) => (
          <button
            key={category.id}
            className={`legend-item ${visibility[category.id] ? '' : 'disabled'}`}
            onClick={() => toggleCategory(category.id)}
            title={`${category.label}：${category.description}\n点击${visibility[category.id] ? '关闭' : '开启'}该类别高亮`}
          >
            <span className="legend-swatch" style={{ background: colors[category.id] }} />
            <Icon name={CATEGORY_ICONS[category.id] ?? 'code'} size={12} />
            <span>{category.legend}</span>
          </button>
        ))}
        <span className="legend-spacer" />
        <button className="legend-settings" onClick={() => setSettingsOpen(true)} title="自定义语义颜色与结构背景">
          <Icon name="settings" size={13} />
          颜色设置
        </button>
      </div>
    </div>
  );
}
