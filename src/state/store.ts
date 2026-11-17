/**
 * CodeLens 全局状态（Zustand）
 * ------------------------------------------------------------------
 * - 代码 / 语言 / 主题 / 解释深度 / 语义高亮设置
 * - 分析结果、选中节点、符号高亮、面板显隐
 * - 逐行执行状态（由内置 C 解释器提供）
 * - AI 设置与对话、学习笔记
 * 用户偏好会持久化到 localStorage；源码默认不持久化，避免残留隐私内容。
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { AnalysisResult, LanguageId, SemanticCategory, StructureNode } from '../core/analysisTypes';
import { LANGUAGE_OPTIONS, flattenStructure } from '../core/analysisTypes';
import { analyzeCode, detectLanguage, getExecutionTarget } from '../core/analyze';
import { SourceFile } from '../core/source';
import type { Explanation, ExplainLevel } from '../core/explain/types';
import { DEFAULT_AI_SETTINGS, buildAIContext, buildLocalAnswer, chatWithAI, type AIChatMessage, type AISettings } from '../services/ai';
import { readTextFile, type ImportedFile } from '../services/files';
import { DEFAULT_SAMPLE_ID, SAMPLES, getSample } from '../services/samples';
import { DEFAULT_DARK_COLORS, DEFAULT_LIGHT_COLORS, DEFAULT_CATEGORY_VISIBILITY, type CategoryVisibility, type ColorScheme } from '../core/semanticCatalog';
import type { ExecutionErrorInfo, ExecutionSnapshot } from '../core/interpreter/types';
import { parseC } from '../core/cParser';

export type ThemeModeType = 'dark' | 'light';
export type RightTab = 'explain' | 'relations' | 'ai';

export interface ExecutionState {
  status: 'idle' | 'running' | 'done' | 'error' | 'unsupported';
  steps: ExecutionSnapshot[];
  index: number;
  error: ExecutionErrorInfo | null;
  reason?: string;
  note?: string;
  label?: string;
  engine?: string;
  stdout?: string;
  warnings: string[];
  truncated: boolean;
  autoPlaying: boolean;
}

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  source: 'local' | 'ai' | 'error';
  createdAt: number;
}

export interface RevealRequest {
  offset: number;
  end?: number;
  nonce: number;
}

export interface Notice {
  id: number;
  message: string;
  type: 'info' | 'success' | 'warning';
}

export interface AppState {
  // ---- 编辑器 / 分析 ----
  code: string;
  fileName?: string;
  language: LanguageId;
  languageManuallySet: boolean;
  detectionNote?: string;
  analysis: AnalysisResult | null;
  analysisError: string | null;

  // ---- 交互选择 ----
  selectedOffset: number | null;
  selectedStructure: StructureNode | null;
  hoveredSymbolId: string | null;
  revealRequest: RevealRequest | null;

  // ---- 设置 ----
  theme: ThemeModeType;
  level: ExplainLevel;
  colorsDark: ColorScheme;
  colorsLight: ColorScheme;
  categoryVisibility: CategoryVisibility;
  showStructureBackground: boolean;
  showNestingDepth: boolean;

  // ---- 面板 ----
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  activeRightTab: RightTab;
  settingsOpen: boolean;
  aiSettingsOpen: boolean;
  notesOpen: boolean;
  helpOpen: boolean;
  notice: Notice | null;

  // ---- 执行 ----
  execution: ExecutionState;

  // ---- AI ----
  aiSettings: AISettings;
  aiChat: ChatEntry[];
  aiBusy: boolean;
  aiError: string | null;

  // ---- 动作 ----
  setCode: (code: string) => void;
  setLanguage: (language: LanguageId) => void;
  autoDetectLanguage: () => void;
  loadSample: (sampleId: string) => void;
  importFile: (file: File) => Promise<void>;
  applyCode: (code: string, options: { language: LanguageId; fileName?: string; notice?: string }) => void;
  applyGeneratedCode: (code: string) => void;

  selectAtOffset: (offset: number) => void;
  selectStructure: (structure: StructureNode | null) => void;
  jumpToRange: (range: { start: number; end: number }) => void;
  clearSelection: () => void;
  setHoveredSymbol: (symbolId: string | null) => void;
  requestReveal: (offset: number, end?: number) => void;

  setTheme: (theme: ThemeModeType) => void;
  toggleTheme: () => void;
  setLevel: (level: ExplainLevel) => void;
  setCategoryColor: (category: SemanticCategory, theme: ThemeModeType, color: string) => void;
  resetCategoryColors: (theme?: ThemeModeType) => void;
  toggleCategory: (category: SemanticCategory) => void;
  setShowStructureBackground: (value: boolean) => void;
  setShowNestingDepth: (value: boolean) => void;

  setLeftOpen: (value: boolean) => void;
  setRightOpen: (value: boolean) => void;
  setBottomOpen: (value: boolean) => void;
  setActiveRightTab: (tab: RightTab) => void;
  setSettingsOpen: (value: boolean) => void;
  setAiSettingsOpen: (value: boolean) => void;
  setNotesOpen: (value: boolean) => void;
  setHelpOpen: (value: boolean) => void;
  showNotice: (message: string, type?: Notice['type']) => void;
  clearNotice: () => void;

  runExecution: () => Promise<void>;
  resetExecution: () => void;
  setExecutionIndex: (index: number) => void;
  stepExecution: (delta: number) => void;
  toggleAutoPlay: () => void;

  setAISettings: (settings: AISettings) => void;
  askAI: (question: string, explanation: Explanation | null) => Promise<void>;
  clearAIChat: () => void;
  setAIError: (error: string | null) => void;
}

const initialSample = getSample(DEFAULT_SAMPLE_ID) ?? SAMPLES[0];
const initialAnalysis = analyzeCode(initialSample.code, { language: initialSample.language });

/** 找 main 函数 / 第一个函数作为初始释义对象 */
function findInitialStructure(analysis: AnalysisResult): StructureNode | null {
  const all = flattenStructure(analysis.tree);
  const main = all.find((node) => node.kind === 'function' && node.label.includes('main'));
  if (main) return main;
  const fn = all.find((node) => node.kind === 'function');
  if (fn) return fn;
  return all.find((node) => node.kind === 'program') ?? null;
}

const initialStructure = findInitialStructure(initialAnalysis);

const idleExecution = (): ExecutionState => ({
  status: 'idle',
  steps: [],
  index: 0,
  error: null,
  warnings: [],
  truncated: false,
  autoPlaying: false,
});

/** 根据偏移量查找符号（用于点击变量时高亮所有出现位置） */
export function findSymbolAtOffset(
  analysis: AnalysisResult | null,
  offset: number,
): { symbolId: string; end: number } | undefined {
  if (!analysis) return undefined;
  let best: { symbolId: string; end: number; size: number } | undefined;
  for (const symbol of analysis.symbolList) {
    for (const occurrence of symbol.occurrences) {
      if (offset >= occurrence.range.start && offset <= occurrence.range.end) {
        const size = occurrence.range.end - occurrence.range.start;
        if (!best || size < best.size) best = { symbolId: symbol.id, end: occurrence.range.end, size };
      }
    }
  }
  return best ? { symbolId: best.symbolId, end: best.end } : undefined;
}

let noticeCounter = 0;

/** 生成带语言信息的分析结果 */
function analyzeFor(code: string, language: LanguageId, fileName?: string): AnalysisResult {
  return analyzeCode(code, { language, fileName });
}

function languageLabelOf(language: LanguageId): string {
  return LANGUAGE_OPTIONS.find((option) => option.id === language)?.label ?? language;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      code: initialSample.code,
      fileName: undefined,
      language: initialSample.language,
      languageManuallySet: true,
      detectionNote: '内置示例：单链表创建与遍历',
      analysis: initialAnalysis,
      analysisError: null,

      selectedOffset: initialStructure?.range?.start ?? null,
      selectedStructure: initialStructure,
      hoveredSymbolId: null,
      revealRequest: null,

      theme: 'dark',
      level: 'intermediate',
      colorsDark: { ...DEFAULT_DARK_COLORS },
      colorsLight: { ...DEFAULT_LIGHT_COLORS },
      categoryVisibility: { ...DEFAULT_CATEGORY_VISIBILITY },
      showStructureBackground: true,
      showNestingDepth: true,

      leftOpen: true,
      rightOpen: true,
      bottomOpen: false,
      activeRightTab: 'explain',
      settingsOpen: false,
      aiSettingsOpen: false,
      notesOpen: false,
      helpOpen: false,
      notice: null,

      execution: idleExecution(),

      aiSettings: { ...DEFAULT_AI_SETTINGS },
      aiChat: [],
      aiBusy: false,
      aiError: null,

      setCode: (code: string) => {
        const state = get();
        if (code === state.code) return;
        const normalized = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const analysis = analyzeFor(normalized, state.language, state.fileName);
        set({
          code: normalized,
          analysis,
          analysisError: null,
          selectedOffset: null,
          selectedStructure: null,
          hoveredSymbolId: null,
          execution: idleExecution(),
          aiError: null,
        });
      },

      setLanguage: (language: LanguageId) => {
        const state = get();
        if (language === state.language && state.analysis) return;
        const analysis = analyzeFor(state.code, language, state.fileName);
        set({
          language,
          languageManuallySet: true,
          analysis,
          analysisError: null,
          selectedOffset: null,
          selectedStructure: null,
          hoveredSymbolId: null,
          execution: idleExecution(),
          notice: { id: ++noticeCounter, message: `已切换分析语言为「${languageLabelOf(language)}」`, type: 'info' },
        });
      },

      autoDetectLanguage: () => {
        const state = get();
        const detection = detectLanguage(state.code, state.fileName);
        const analysis = analyzeFor(state.code, detection.language, state.fileName);
        const changed = detection.language !== state.language;
        set({
          language: detection.language,
          languageManuallySet: false,
          detectionNote: detection.reason,
          analysis,
          analysisError: null,
          selectedOffset: null,
          selectedStructure: null,
          hoveredSymbolId: null,
          execution: idleExecution(),
          notice: {
            id: ++noticeCounter,
            message: changed
              ? `自动识别为「${languageLabelOf(detection.language)}」（${detection.reason}）`
              : `已重新识别：当前为「${languageLabelOf(detection.language)}」（${detection.reason}）`,
            type: 'info',
          },
        });
      },

      loadSample: (sampleId: string) => {
        const sample = getSample(sampleId);
        if (!sample) return;
        const analysis = analyzeFor(sample.code, sample.language);
        const structure = findInitialStructure(analysis);
        set({
          code: sample.code,
          fileName: undefined,
          language: sample.language,
          languageManuallySet: true,
          detectionNote: `示例：${sample.title}`,
          analysis,
          analysisError: null,
          selectedOffset: structure?.range?.start ?? null,
          selectedStructure: structure,
          hoveredSymbolId: null,
          execution: idleExecution(),
          notice: { id: ++noticeCounter, message: `已加载示例：${sample.title}`, type: 'success' },
        });
      },

      importFile: async (file: File) => {
        try {
          const imported: ImportedFile = await readTextFile(file);
          const analysis = analyzeFor(imported.code, imported.language, imported.fileName);
          const structure = findInitialStructure(analysis);
          set({
            code: imported.code,
            fileName: imported.fileName,
            language: imported.language,
            languageManuallySet: true,
            detectionNote: `${imported.fileName} · ${imported.detectionReason}`,
            analysis,
            analysisError: null,
            selectedOffset: structure?.range?.start ?? null,
            selectedStructure: structure,
            hoveredSymbolId: null,
            execution: idleExecution(),
            notice: {
              id: ++noticeCounter,
              message: `已导入 ${imported.fileName}（${languageLabelOf(imported.language)}）${imported.warnings.length ? `。${imported.warnings[0]}` : ''}`,
              type: imported.warnings.length ? 'warning' : 'success',
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          set({ notice: { id: ++noticeCounter, message, type: 'warning' } });
        }
      },

      applyCode: (code, options) => {
        const normalized = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const analysis = analyzeFor(normalized, options.language, options.fileName);
        set({
          code: normalized,
          fileName: options.fileName,
          language: options.language,
          languageManuallySet: true,
          analysis,
          analysisError: null,
          selectedOffset: null,
          selectedStructure: null,
          hoveredSymbolId: null,
          execution: idleExecution(),
          notice: options.notice ? { id: ++noticeCounter, message: options.notice, type: 'info' } : get().notice,
        });
      },

      applyGeneratedCode: (code: string) => {
        get().applyCode(code, {
          language: 'c',
          notice: '已将系统生成的 C 代码载入编辑器（生成代码 ≠ 伪代码原文），请核对后再分析/执行。',
        });
      },

      selectAtOffset: (offset: number) => {
        const state = get();
        const symbol = findSymbolAtOffset(state.analysis, offset);
        set({
          selectedOffset: offset,
          selectedStructure: null,
          activeRightTab: 'explain',
          hoveredSymbolId: symbol?.symbolId ?? null,
        });
      },

      selectStructure: (structure) => {
        if (!structure) {
          set({ selectedStructure: null, selectedOffset: null });
          return;
        }
        set({
          selectedStructure: structure,
          selectedOffset: structure.range?.start ?? null,
          activeRightTab: 'explain',
          hoveredSymbolId: null,
          revealRequest: structure.range
            ? { offset: structure.range.start, end: structure.range.end, nonce: Date.now() }
            : get().revealRequest,
        });
      },

      jumpToRange: (range) => {
        const state = get();
        const symbol = findSymbolAtOffset(state.analysis, range.start);
        set({
          selectedStructure: null,
          selectedOffset: range.start,
          activeRightTab: 'explain',
          hoveredSymbolId: symbol?.symbolId ?? null,
          revealRequest: { offset: range.start, end: range.end, nonce: Date.now() },
        });
      },

      clearSelection: () => set({ selectedOffset: null, selectedStructure: null, hoveredSymbolId: null }),
      setHoveredSymbol: (symbolId) => {
        if (get().hoveredSymbolId !== symbolId) set({ hoveredSymbolId: symbolId });
      },
      requestReveal: (offset, end) => set({ revealRequest: { offset, end, nonce: Date.now() } }),

      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' }),
      setLevel: (level) => set({ level }),

      setCategoryColor: (category, theme, color) => {
        const key = theme === 'dark' ? 'colorsDark' : 'colorsLight';
        set({ [key]: { ...get()[key], [category]: color } } as Partial<AppState>);
      },

      resetCategoryColors: (theme) => {
        if (!theme || theme === 'dark') set({ colorsDark: { ...DEFAULT_DARK_COLORS } });
        if (!theme || theme === 'light') set({ colorsLight: { ...DEFAULT_LIGHT_COLORS } });
      },

      toggleCategory: (category) =>
        set({ categoryVisibility: { ...get().categoryVisibility, [category]: !get().categoryVisibility[category] } }),

      setShowStructureBackground: (value) => set({ showStructureBackground: value }),
      setShowNestingDepth: (value) => set({ showNestingDepth: value }),

      setLeftOpen: (value) => set({ leftOpen: value }),
      setRightOpen: (value) => set({ rightOpen: value }),
      setBottomOpen: (value) => set({ bottomOpen: value }),
      setActiveRightTab: (tab) => set({ activeRightTab: tab }),
      setSettingsOpen: (value) => set({ settingsOpen: value }),
      setAiSettingsOpen: (value) => set({ aiSettingsOpen: value }),
      setNotesOpen: (value) => set({ notesOpen: value }),
      setHelpOpen: (value) => set({ helpOpen: value }),
      showNotice: (message, type = 'info') => set({ notice: { id: ++noticeCounter, message, type } }),
      clearNotice: () => set({ notice: null }),

      runExecution: async () => {
        const state = get();
        if (!state.analysis) return;
        const target = getExecutionTarget(state.analysis);
        if (!target.supported) {
          set({
            bottomOpen: true,
            execution: {
              ...idleExecution(),
              status: 'unsupported',
              reason: target.reason ?? '当前语言暂不支持执行。',
              label: target.label,
              note: target.note,
            },
          });
          return;
        }

        const runToken = ++executionRunToken;
        set({
          bottomOpen: true,
          execution: {
            ...idleExecution(),
            status: 'running',
            note: target.note,
            label: target.label,
          },
        });

        try {
          const source = new SourceFile(target.code);
          const parsed = parseC(source, { language: state.analysis.language === 'cpp' ? 'cpp' : 'c' });
          const { executeC } = await import('../core/interpreter/interpreter');
          const result = executeC(parsed.program, source, { maxSteps: 3000 });
          if (runToken !== executionRunToken) return;
          const status = result.status === 'unsupported' ? 'unsupported' : result.status === 'error' ? 'error' : 'done';
          set({
            execution: {
              status,
              steps: result.snapshots,
              index: result.snapshots.length > 0 ? 0 : 0,
              error: result.error ?? null,
              reason: result.reason,
              note: target.note,
              label: target.label,
              engine: result.engine,
              stdout: result.stdout,
              warnings: result.warnings,
              truncated: result.truncated,
              autoPlaying: false,
            },
          });
        } catch (error) {
          if (runToken !== executionRunToken) return;
          const message = error instanceof Error ? error.message : String(error);
          set({
            execution: {
              ...idleExecution(),
              status: 'error',
              error: {
                message: `执行引擎出错：${message}`,
                hint: '这可能是 CodeLens 尚未支持的语法或运行环境问题。CodeLens 不会伪造执行结果。',
                kind: 'unsupported',
              },
            },
          });
        }
      },

      resetExecution: () => {
        executionRunToken += 1;
        set({ execution: idleExecution() });
      },

      setExecutionIndex: (index) => {
        const execution = get().execution;
        if (!execution.steps.length) return;
        set({
          execution: {
            ...execution,
            index: Math.min(Math.max(index, 0), execution.steps.length - 1),
          },
        });
      },

      stepExecution: (delta) => {
        const execution = get().execution;
        if (!execution.steps.length) return;
        const next = Math.min(Math.max(execution.index + delta, 0), execution.steps.length - 1);
        const finished = next >= execution.steps.length - 1 && delta > 0;
        set({
          execution: {
            ...execution,
            index: next,
            autoPlaying: finished ? false : execution.autoPlaying,
          },
        });
      },

      toggleAutoPlay: () => {
        const execution = get().execution;
        if (!execution.steps.length) return;
        set({ execution: { ...execution, autoPlaying: !execution.autoPlaying } });
      },

      setAISettings: (settings) => {
        set({ aiSettings: settings, aiError: null });
        get().showNotice(settings.enabled ? 'AI 设置已保存（API Key 仅保存在本机浏览器）' : 'AI 功能已关闭', 'info');
      },

      askAI: async (question: string, explanation: Explanation | null) => {
        const trimmed = question.trim();
        if (!trimmed) return;
        const state = get();
        const userEntry: ChatEntry = {
          id: `chat-${Date.now()}-user`,
          role: 'user',
          content: trimmed,
          source: 'ai',
          createdAt: Date.now(),
        };
        set({ aiChat: [...state.aiChat, userEntry], aiError: null });

        if (!state.aiSettings.enabled || !state.aiSettings.apiKey.trim()) {
          const answer = buildLocalAnswer(explanation, trimmed);
          set((current) => ({
            aiBusy: false,
            aiChat: [
              ...current.aiChat,
              {
                id: `chat-${Date.now()}-local`,
                role: 'assistant',
                content: answer,
                source: 'local',
                createdAt: Date.now(),
              },
            ],
          }));
          return;
        }

        set({ aiBusy: true });
        try {
          if (!state.analysis) throw new Error('当前没有可分析的内容。');
          const context = buildAIContext(state.analysis, explanation, state.level);
          const history: AIChatMessage[] = state.aiChat
            .filter((entry) => entry.source !== 'error')
            .slice(-6)
            .map((entry) => ({ role: entry.role, content: entry.content }));
          const reply = await chatWithAI(state.aiSettings, [context, ...history, { role: 'user', content: trimmed }]);
          set((current) => ({
            aiBusy: false,
            aiChat: [
              ...current.aiChat,
              {
                id: `chat-${Date.now()}-ai`,
                role: 'assistant',
                content: reply,
                source: 'ai',
                createdAt: Date.now(),
              },
            ],
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          set((current) => ({
            aiBusy: false,
            aiError: message,
            aiChat: [
              ...current.aiChat,
              {
                id: `chat-${Date.now()}-error`,
                role: 'assistant',
                content: `AI 请求失败：${message}`,
                source: 'error',
                createdAt: Date.now(),
              },
            ],
          }));
        }
      },

      clearAIChat: () => set({ aiChat: [], aiError: null }),
      setAIError: (error) => set({ aiError: error }),
    }),
    {
      name: 'codelens-preferences',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        theme: state.theme,
        level: state.level,
        colorsDark: state.colorsDark,
        colorsLight: state.colorsLight,
        categoryVisibility: state.categoryVisibility,
        showStructureBackground: state.showStructureBackground,
        showNestingDepth: state.showNestingDepth,
        leftOpen: state.leftOpen,
        rightOpen: state.rightOpen,
        bottomOpen: state.bottomOpen,
        aiSettings: state.aiSettings,
      }),
      merge: (persisted, current) => {
        const prefs = (persisted ?? {}) as Partial<AppState>;
        return {
          ...current,
          ...prefs,
          colorsDark: { ...current.colorsDark, ...(prefs.colorsDark ?? {}) },
          colorsLight: { ...current.colorsLight, ...(prefs.colorsLight ?? {}) },
          categoryVisibility: { ...current.categoryVisibility, ...(prefs.categoryVisibility ?? {}) },
          aiSettings: { ...current.aiSettings, ...(prefs.aiSettings ?? {}) },
          // 源码/分析结果不持久化，始终从内置示例开始
          code: current.code,
          analysis: current.analysis,
          execution: current.execution,
          aiChat: [],
        };
      },
    },
  ),
);

let executionRunToken = 0;

// 开发环境下方便在控制台检查分析结果
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __codelensStore?: unknown }).__codelensStore = useAppStore;
}
