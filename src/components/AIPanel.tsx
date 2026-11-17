/**
 * AI 问答面板
 * ------------------------------------------------------------------
 * - 未配置 AI 时：明确提示，并允许使用「本地规则解释」（不是 AI，不联网）；
 * - 已配置时：把当前代码 + 选中片段作为上下文，调用用户配置的 OpenAI 兼容接口；
 * - 支持针对当前选中代码连续追问，展示对话历史与错误原因；
 * - CodeLens 不内置、不伪造任何 AI 密钥或回答。
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { useAppStore } from '../state/store';
import type { Explanation } from '../core/explain/types';
import { Icon } from './Icons';

interface AIPanelProps {
  explanation: Explanation | null;
}

const QUICK_PROMPTS = ['这段代码整体在做什么？', '给我解释一下当前选中的这一行', '这里有哪些初学者容易踩的坑？', '帮我列出理解这段代码需要的前置知识'];

export function AIPanel({ explanation }: AIPanelProps) {
  const aiSettings = useAppStore((state) => state.aiSettings);
  const aiChat = useAppStore((state) => state.aiChat);
  const aiBusy = useAppStore((state) => state.aiBusy);
  const aiError = useAppStore((state) => state.aiError);
  const askAI = useAppStore((state) => state.askAI);
  const clearAIChat = useAppStore((state) => state.clearAIChat);
  const setAiSettingsOpen = useAppStore((state) => state.setAiSettingsOpen);
  const [question, setQuestion] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const configured = aiSettings.enabled && Boolean(aiSettings.apiKey.trim());

  const submit = async (text?: string) => {
    const value = (text ?? question).trim();
    if (!value || aiBusy) return;
    setQuestion('');
    await askAI(value, explanation);
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="ai-panel">
      <div className={`ai-status ${configured ? 'configured' : ''}`}>
        <Icon name="ai" size={15} />
        {configured ? (
          <span>
            已连接：{aiSettings.model || '未指定模型'} · 代码仅在你主动提问时发送
          </span>
        ) : (
          <span>AI 未配置：当前只会使用本地规则解释，不会联网，也不会伪造回答。</span>
        )}
        <button className="link-button" onClick={() => setAiSettingsOpen(true)}>
          {configured ? 'AI 设置' : '配置 AI'}
        </button>
      </div>

      <div className="ai-messages" ref={listRef}>
        {aiChat.length === 0 && (
          <div className="ai-empty">
            <span className="ai-empty-icon">
              <Icon name="sparkles" size={20} />
            </span>
            <strong>针对这段代码提问</strong>
            <p>
              {explanation
                ? `当前选中：${explanation.title}。可以问“这一行为什么这么写？”`
                : '先在代码中点击一段代码，再提问效果更好。'}
            </p>
            <div className="ai-quick-prompts">
              {QUICK_PROMPTS.map((prompt) => (
                <button key={prompt} className="quick-prompt" onClick={() => void submit(prompt)}>
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
        {aiChat.map((entry) => (
          <div key={entry.id} className={`ai-message role-${entry.role} source-${entry.source}`}>
            <div className="ai-message-meta">
              <span>{entry.role === 'user' ? '你' : entry.source === 'local' ? '本地规则解释' : entry.source === 'error' ? '请求失败' : 'AI'}</span>
              {entry.source === 'local' && <span className="tag">非 AI</span>}
            </div>
            <div className="ai-message-content">{entry.content}</div>
          </div>
        ))}
        {aiBusy && (
          <div className="ai-message role-assistant">
            <div className="ai-message-meta">AI</div>
            <div className="ai-message-content ai-typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      {aiError && (
        <div className="ai-error">
          <Icon name="error" size={14} />
          <span>{aiError}</span>
        </div>
      )}

      <div className="ai-composer">
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={configured ? '针对选中代码提问，Enter 发送，Shift+Enter 换行…' : '未配置 AI：提问将使用本地规则解释…'}
          spellCheck={false}
        />
        <div className="ai-composer-actions">
          <button className="icon-button tiny" onClick={clearAIChat} title="清空对话" disabled={aiBusy}>
            <Icon name="trash" size={14} />
          </button>
          <button className="button primary small" onClick={() => void submit()} disabled={aiBusy || !question.trim()}>
            <Icon name="arrowRight" size={14} />
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
