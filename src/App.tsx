/**
 * CodeLens 应用外壳
 * ------------------------------------------------------------------
 * 三栏布局：左结构树 / 中编辑器与执行 / 右释义
 * 顶部工具栏 + 底部状态栏；支持拖拽导入、快捷键、通知与弹窗。
 */
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from './state/store';
import { Header } from './components/Header';
import { StructureTree } from './components/StructureTree';
import { EditorPanel } from './components/EditorPanel';
import { ExplainPanel } from './components/ExplainPanel';
import { ExecutionPanel } from './components/ExecutionPanel';
import { StatusBar } from './components/StatusBar';
import { SettingsDialog } from './components/SettingsDialog';
import { NotesDialog } from './components/NotesDialog';
import { HelpDialog } from './components/HelpDialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Icon } from './components/Icons';

function NoticeToast() {
  const notice = useAppStore((state) => state.notice);
  const clearNotice = useAppStore((state) => state.clearNotice);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => clearNotice(), 5200);
    return () => window.clearTimeout(timer);
  }, [notice, clearNotice]);

  if (!notice) return null;
  return (
    <div className={`notice-toast notice-${notice.type}`} role="status">
      <Icon name={notice.type === 'success' ? 'checkCircle' : notice.type === 'warning' ? 'warning' : 'info'} size={15} />
      <span>{notice.message}</span>
      <button className="icon-button tiny" onClick={clearNotice} title="关闭提示">
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}

function DragOverlay() {
  return (
    <div className="drop-overlay">
      <div className="drop-card">
        <Icon name="upload" size={30} />
        <strong>松开以导入代码文件</strong>
        <p>支持 .c / .cpp / .h / .py / .js / .ts 等代码文件，大小不超过 512KB</p>
      </div>
    </div>
  );
}

export default function App() {
  const theme = useAppStore((state) => state.theme);
  const leftOpen = useAppStore((state) => state.leftOpen);
  const rightOpen = useAppStore((state) => state.rightOpen);
  const bottomOpen = useAppStore((state) => state.bottomOpen);
  const importFile = useAppStore((state) => state.importFile);
  const showNotice = useAppStore((state) => state.showNotice);
  const setLeftOpen = useAppStore((state) => state.setLeftOpen);
  const setRightOpen = useAppStore((state) => state.setRightOpen);
  const setBottomOpen = useAppStore((state) => state.setBottomOpen);
  const setHelpOpen = useAppStore((state) => state.setHelpOpen);

  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  // 全局快捷键
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      const modifier = event.ctrlKey || event.metaKey;

      if (modifier && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setLeftOpen(!useAppStore.getState().leftOpen);
        return;
      }
      if (modifier && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setBottomOpen(!useAppStore.getState().bottomOpen);
        return;
      }
      if (modifier && event.key.toLowerCase() === 'i') {
        event.preventDefault();
        setRightOpen(!useAppStore.getState().rightOpen);
        return;
      }
      if (modifier && event.key === 'Enter') {
        const insideEditor = target?.closest('.monaco-editor');
        if (!insideEditor) {
          event.preventDefault();
          void useAppStore.getState().runExecution();
        }
        return;
      }
      if (event.key === '?' && !isTyping) {
        event.preventDefault();
        setHelpOpen(true);
        return;
      }
      if (event.key === 'Escape') {
        const state = useAppStore.getState();
        if (state.settingsOpen || state.aiSettingsOpen || state.notesOpen || state.helpOpen) {
          useAppStore.setState({ settingsOpen: false, aiSettingsOpen: false, notesOpen: false, helpOpen: false });
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [setBottomOpen, setHelpOpen, setLeftOpen, setRightOpen]);

  const onDragEnter = (event: React.DragEvent) => {
    event.preventDefault();
    if (!event.dataTransfer.types.includes('Files')) return;
    dragCounter.current += 1;
    setDragging(true);
  };
  const onDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setDragging(false);
  };
  const onDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) {
      showNotice('未检测到文件。请拖拽本地代码文件。', 'warning');
      return;
    }
    await importFile(file);
  };

  return (
    <ErrorBoundary>
      <div
        className="app-shell"
        data-theme={theme}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <Header />
        <div className={`app-body ${leftOpen ? 'with-left' : ''} ${rightOpen ? 'with-right' : ''}`}>
          {leftOpen && <StructureTree />}
          <div className="center-column">
            <EditorPanel />
            {bottomOpen && <ExecutionPanel />}
          </div>
          {rightOpen && <ExplainPanel />}
        </div>
        <StatusBar />

        <SettingsDialog />
        <NotesDialog />
        <HelpDialog />
        {dragging && <DragOverlay />}
        <NoticeToast />
      </div>
    </ErrorBoundary>
  );
}
