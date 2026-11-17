/**
 * 顶部工具栏
 * ------------------------------------------------------------------
 * 语言选择 / 自动识别 / 解释深度 / 示例 / 导入文件 / 主题 / AI / 笔记 / 设置，
 * 以及左右下三个面板的显隐开关。
 */
import { useEffect, useRef, useState } from 'react';
import { LANGUAGE_OPTIONS, type LanguageId } from '../core/analysisTypes';
import { EXPLAIN_LEVEL_LABELS, type ExplainLevel } from '../core/explain/types';
import { useAppStore } from '../state/store';
import { SAMPLES } from '../services/samples';
import { Icon } from './Icons';

const LEVELS: ExplainLevel[] = ['beginner', 'intermediate', 'advanced'];

export function Header() {
  const language = useAppStore((state) => state.language);
  const level = useAppStore((state) => state.level);
  const theme = useAppStore((state) => state.theme);
  const fileName = useAppStore((state) => state.fileName);
  const detectionNote = useAppStore((state) => state.detectionNote);
  const leftOpen = useAppStore((state) => state.leftOpen);
  const rightOpen = useAppStore((state) => state.rightOpen);
  const bottomOpen = useAppStore((state) => state.bottomOpen);
  const aiEnabled = useAppStore((state) => state.aiSettings.enabled && Boolean(state.aiSettings.apiKey));
  const { setLanguage, autoDetectLanguage, setLevel, toggleTheme, importFile, loadSample, setLeftOpen, setRightOpen, setBottomOpen, setSettingsOpen, setNotesOpen, setHelpOpen, setRightOpen: openRight, setActiveRightTab } = useAppStore();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [samplesOpen, setSamplesOpen] = useState(false);
  const samplesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!samplesOpen) return;
    const handler = (event: MouseEvent) => {
      if (samplesRef.current && !samplesRef.current.contains(event.target as Node)) setSamplesOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [samplesOpen]);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) await importFile(file);
    event.target.value = '';
  };

  const openAI = () => {
    openRight(true);
    setActiveRightTab('ai');
  };

  return (
    <header className="app-header">
      <div className="header-left">
        <button className="brand" onClick={() => setHelpOpen(true)} title="关于 CodeLens 与使用说明">
          <span className="brand-mark">
            <Icon name="logo" size={22} />
          </span>
          <span className="brand-text">
            <span className="brand-name">CodeLens</span>
            <span className="brand-tagline">代码结构可视化学习工具</span>
          </span>
        </button>
        <div className="header-file" title={fileName ?? detectionNote ?? '当前为内置示例'}>
          <Icon name="file" size={14} />
          <span>{fileName ?? '未命名示例.c'}</span>
          {detectionNote && <span className="header-file-note">{detectionNote}</span>}
        </div>
      </div>

      <div className="header-center">
        <div className="control-group" title="选择代码语言；也可以让 CodeLens 自动识别">
          <label className="control-label" htmlFor="language-select">
            语言
          </label>
          <select
            id="language-select"
            className="select"
            value={language}
            onChange={(event) => setLanguage(event.target.value as LanguageId)}
          >
            {LANGUAGE_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <button className="icon-button subtle" onClick={autoDetectLanguage} title="根据代码内容自动识别语言">
            <Icon name="refresh" size={16} />
          </button>
        </div>

        <div className="control-group" title="切换解释深度：初级使用类比，中级讲语法与执行，高级讲内存与底层原理">
          <span className="control-label">解释</span>
          <div className="segmented">
            {LEVELS.map((item) => (
              <button
                key={item}
                className={`segmented-button ${level === item ? 'active' : ''}`}
                onClick={() => setLevel(item)}
                title={`${EXPLAIN_LEVEL_LABELS[item]}模式`}
              >
                {EXPLAIN_LEVEL_LABELS[item]}
              </button>
            ))}
          </div>
        </div>

        <div className="control-group" ref={samplesRef}>
          <button className={`button ${samplesOpen ? 'active' : ''}`} onClick={() => setSamplesOpen((open) => !open)}>
            <Icon name="book" size={16} />
            <span>示例</span>
            <Icon name="chevronDown" size={14} />
          </button>
          {samplesOpen && (
            <div className="dropdown samples-dropdown">
              <div className="dropdown-title">内置真实示例</div>
              <div className="samples-list">
                {SAMPLES.map((sample) => (
                  <button
                    key={sample.id}
                    className="sample-item"
                    onClick={() => {
                      loadSample(sample.id);
                      setSamplesOpen(false);
                    }}
                  >
                    <div className="sample-item-head">
                      <span className={`language-dot language-${sample.language}`} />
                      <span className="sample-title">{sample.title}</span>
                    </div>
                    <span className="sample-desc">{sample.description}</span>
                    <span className="sample-tags">
                      {sample.tags.map((tag) => (
                        <span key={tag} className="tag">
                          {tag}
                        </span>
                      ))}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="control-group">
          <button className="button" onClick={() => fileInputRef.current?.click()} title="导入 .c/.cpp/.h/.py/.js/.ts 等代码文件">
            <Icon name="upload" size={16} />
            <span>导入文件</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".c,.h,.cpp,.cxx,.cc,.hpp,.py,.js,.mjs,.cjs,.jsx,.ts,.tsx,.pseudo,.txt"
            className="hidden-input"
            onChange={handleFileChange}
          />
        </div>
      </div>

      <div className="header-right">
        <div className="panel-toggles" title="显示/隐藏面板">
          <button className={`icon-button ${leftOpen ? 'active' : ''}`} onClick={() => setLeftOpen(!leftOpen)} title="代码结构树">
            <Icon name="panelLeft" size={16} />
          </button>
          <button className={`icon-button ${bottomOpen ? 'active' : ''}`} onClick={() => setBottomOpen(!bottomOpen)} title="执行过程与变量">
            <Icon name="panelBottom" size={16} />
          </button>
          <button className={`icon-button ${rightOpen ? 'active' : ''}`} onClick={() => setRightOpen(!rightOpen)} title="释义面板">
            <Icon name="panelRight" size={16} />
          </button>
        </div>
        <button className={`icon-button ${aiEnabled ? 'ai-enabled' : ''}`} onClick={openAI} title="AI 问答（需在设置中配置 API）">
          <Icon name="ai" size={17} />
        </button>
        <button className="icon-button" onClick={() => setNotesOpen(true)} title="生成本地学习笔记">
          <Icon name="notes" size={17} />
        </button>
        <button className="icon-button" onClick={toggleTheme} title={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}>
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
        </button>
        <button className="icon-button" onClick={() => setSettingsOpen(true)} title="设置：语义颜色、高亮类别、AI 接口">
          <Icon name="settings" size={17} />
        </button>
      </div>
    </header>
  );
}
