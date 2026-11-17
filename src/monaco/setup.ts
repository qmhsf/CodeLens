import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { loader } from '@monaco-editor/react';

// 使用本地打包的 Monaco，而不是从 CDN 加载，保证离线可用。
// Monaco 需要 Web Worker 执行后台任务，这里使用 Vite 的 ?worker 导入。
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

loader.config({ monaco });

/**
 * 注册 CodeLens 专用语言。
 * CodeLens 不使用 Monaco 内置的语法着色，而是根据 AST 生成语义装饰；
 * 这里只注册语言 id 与基础编辑配置（注释、括号、自动缩进）。
 */
monaco.languages.register({ id: 'codelens' });
monaco.languages.setLanguageConfiguration('codelens', {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string', 'comment'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  indentationRules: {
    increaseIndentPattern: /^\s*(?:if|for|while|do|else|switch|case|default|struct|union|enum|typedef\s+struct).*[{:]\s*$|^\s*\{.*$/,
    decreaseIndentPattern: /^\s*\}|^\s*(?:else|case|default)\b/,
  },
});

/** 深色主题（与页面 CSS 变量保持一致） */
monaco.editor.defineTheme('codelens-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0d1017',
    'editor.foreground': '#e6e8ee',
    'editorLineNumber.foreground': '#4b5366',
    'editorLineNumber.activeForeground': '#aab4c8',
    'editorCursor.foreground': '#4f8cff',
    'editor.selectionBackground': '#26406b',
    'editor.inactiveSelectionBackground': '#1b2a44',
    'editor.lineHighlightBackground': '#141a24',
    'editorLineHighlightBorder': '#00000000',
    'editorIndentGuide.background1': '#1d2432',
    'editorIndentGuide.activeBackground1': '#2f3a4f',
    'editorBracketMatch.background': '#1e2b40',
    'editorBracketMatch.border': '#3a4c68',
    'editorGutter.background': '#0d1017',
    'editorWidget.background': '#151a23',
    'editorWidget.border': '#2a3242',
    'editorHoverWidget.background': '#151a23',
    'editorHoverWidget.border': '#2a3242',
    'editorSuggestWidget.background': '#151a23',
    'editorSuggestWidget.border': '#2a3242',
    'editorOverviewRuler.border': '#00000000',
    'scrollbarSlider.background': '#2a324255',
    'scrollbarSlider.hoverBackground': '#3a455c88',
    'scrollbarSlider.activeBackground': '#4a587099',
    'editorError.foreground': '#f7768e',
    'editorWarning.foreground': '#e0af68',
    'editorInfo.foreground': '#7aa2f7',
    'editorWhitespace.foreground': '#1d2432',
  },
});

/** 浅色主题 */
monaco.editor.defineTheme('codelens-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#fbfcfe',
    'editor.foreground': '#1f2937',
    'editorLineNumber.foreground': '#a3adbd',
    'editorLineNumber.activeForeground': '#475569',
    'editorCursor.foreground': '#2563eb',
    'editor.selectionBackground': '#c7dcff',
    'editor.inactiveSelectionBackground': '#e2ecff',
    'editor.lineHighlightBackground': '#f0f4fa',
    'editorLineHighlightBorder': '#00000000',
    'editorIndentGuide.background1': '#e6ebf2',
    'editorIndentGuide.activeBackground1': '#cdd6e3',
    'editorBracketMatch.background': '#e2ecff',
    'editorBracketMatch.border': '#93b4e8',
    'editorGutter.background': '#fbfcfe',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#dbe1ea',
    'editorHoverWidget.background': '#ffffff',
    'editorHoverWidget.border': '#dbe1ea',
    'editorSuggestWidget.background': '#ffffff',
    'editorSuggestWidget.border': '#dbe1ea',
    'editorOverviewRuler.border': '#00000000',
    'scrollbarSlider.background': '#cbd5e155',
    'scrollbarSlider.hoverBackground': '#b6c2d388',
    'scrollbarSlider.activeBackground': '#9aa8bd99',
    'editorError.foreground': '#be123c',
    'editorWarning.foreground': '#a16207',
    'editorInfo.foreground': '#1d4ed8',
    'editorWhitespace.foreground': '#eef2f8',
  },
});

export { monaco };
