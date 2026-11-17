/**
 * 学习笔记弹窗
 * ------------------------------------------------------------------
 * 由本地规则从真实分析结果生成：结构、函数/类型、变量、控制流程、
 * 关键知识点、解析限制与自测问题。支持复制与下载 Markdown。
 * （AI 生成笔记属于可选增强，本弹窗明确标注内容来源。）
 */
import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../state/store';
import { generateLearningNotes } from '../services/notes';
import { downloadTextFile } from '../services/files';
import { Icon } from './Icons';

export function NotesDialog() {
  const open = useAppStore((state) => state.notesOpen);
  const setOpen = useAppStore((state) => state.setNotesOpen);
  const analysis = useAppStore((state) => state.analysis);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, setOpen]);

  const notes = useMemo(() => (open && analysis ? generateLearningNotes(analysis) : null), [open, analysis]);

  if (!open) return null;

  const copy = async () => {
    if (!notes) return;
    try {
      await navigator.clipboard.writeText(notes.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <div className="modal notes-modal" role="dialog" aria-modal="true" aria-label="学习笔记">
        <div className="modal-header">
          <div className="modal-title">
            <Icon name="notes" size={18} />
            <h2>学习笔记</h2>
            {notes && <span className="muted">{notes.generatedAt} 生成</span>}
          </div>
          <button className="icon-button" onClick={() => setOpen(false)} title="关闭">
            <Icon name="close" size={17} />
          </button>
        </div>

        {!analysis || !notes ? (
          <div className="modal-body panel-empty">还没有可生成笔记的代码。</div>
        ) : (
          <>
            <div className="notes-meta">
              <span className="tag">本地规则生成</span>
              <span className="tag">{analysis.languageLabel}</span>
              <span className="tag">非 AI 编造</span>
              <span className="muted">内容来自语法结构、符号表与问题列表；可下载为 Markdown 保存。</span>
            </div>
            <div className="modal-body notes-body">
              <pre className="notes-preview">{notes.markdown}</pre>
            </div>
            <div className="modal-footer notes-footer">
              <span className="muted">提示：配置 AI 后可在「AI 问答」中继续追问知识点。</span>
              <div className="notes-actions">
                <button className="button" onClick={copy}>
                  <Icon name={copied ? 'check' : 'copy'} size={14} />
                  {copied ? '已复制' : '复制 Markdown'}
                </button>
                <button
                  className="button primary"
                  onClick={() => downloadTextFile(`CodeLens-学习笔记-${analysis.languageLabel}.md`, notes.markdown, 'text/markdown')}
                >
                  <Icon name="download" size={14} />
                  下载 Markdown
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
