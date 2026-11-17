/**
 * 设置弹窗
 * ------------------------------------------------------------------
 * - 语义颜色：逐类自定义颜色 / 开关高亮 / 恢复默认（按当前主题）
 * - 结构显示：结构边界背景、嵌套层级
 * - AI 接口：OpenAI 兼容配置（默认关闭），支持连通性测试
 * 所有设置保存在本机 localStorage，不会上传；AI Key 仅在您主动提问时随请求发送。
 */
import { useEffect, useState } from 'react';
import { SEMANTIC_CATEGORIES } from '../core/semanticCatalog';
import { useAppStore } from '../state/store';
import { chatWithAI, type AISettings } from '../services/ai';
import { Icon } from './Icons';

type SettingsTab = 'colors' | 'display' | 'ai';

const TAB_LABELS: Record<SettingsTab, string> = {
  colors: '语义颜色',
  display: '结构显示',
  ai: 'AI 接口',
};

export function SettingsDialog() {
  const settingsOpen = useAppStore((state) => state.settingsOpen);
  const aiSettingsOpen = useAppStore((state) => state.aiSettingsOpen);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const setAiSettingsOpen = useAppStore((state) => state.setAiSettingsOpen);
  const open = settingsOpen || aiSettingsOpen;
  const close = () => {
    setSettingsOpen(false);
    setAiSettingsOpen(false);
  };
  const theme = useAppStore((state) => state.theme);
  const colors = useAppStore((state) => (state.theme === 'dark' ? state.colorsDark : state.colorsLight));
  const visibility = useAppStore((state) => state.categoryVisibility);
  const showStructureBackground = useAppStore((state) => state.showStructureBackground);
  const showNestingDepth = useAppStore((state) => state.showNestingDepth);
  const aiSettings = useAppStore((state) => state.aiSettings);
  const setCategoryColor = useAppStore((state) => state.setCategoryColor);
  const toggleCategory = useAppStore((state) => state.toggleCategory);
  const resetCategoryColors = useAppStore((state) => state.resetCategoryColors);
  const setShowStructureBackground = useAppStore((state) => state.setShowStructureBackground);
  const setShowNestingDepth = useAppStore((state) => state.setShowNestingDepth);
  const setAISettings = useAppStore((state) => state.setAISettings);

  const [tab, setTab] = useState<SettingsTab>('colors');
  const [form, setForm] = useState<AISettings>(aiSettings);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // 兼容设置入口：统一关闭两个弹窗状态
  const setOpen = (value: boolean) => {
    if (value) {
      setSettingsOpen(true);
    } else {
      close();
    }
  };

  useEffect(() => {
    if (!open) return;
    setTab(aiSettingsOpen ? 'ai' : 'colors');
    setForm(aiSettings);
    setTestResult(null);
    setTesting(false);
  }, [open, aiSettingsOpen, aiSettings]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, setOpen]);

  if (!open) return null;

  const saveAI = () => {
    setAISettings(form);
    setTestResult(null);
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const reply = await chatWithAI(
        { ...form, enabled: true },
        [
          { role: 'system', content: '你是连通性测试助手。' },
          { role: 'user', content: '请只回复：CodeLens 连接成功' },
        ],
      );
      setTestResult({ ok: true, message: `连接成功，模型返回：${reply.slice(0, 120)}` });
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <div className="modal settings-modal" role="dialog" aria-modal="true" aria-label="设置">
        <div className="modal-header">
          <div className="modal-title">
            <Icon name="settings" size={18} />
            <h2>设置</h2>
          </div>
          <button className="icon-button" onClick={() => setOpen(false)} title="关闭">
            <Icon name="close" size={17} />
          </button>
        </div>

        <div className="settings-tabs">
          {(Object.keys(TAB_LABELS) as SettingsTab[]).map((key) => (
            <button key={key} className={`settings-tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
              {TAB_LABELS[key]}
            </button>
          ))}
        </div>

        <div className="modal-body settings-body">
          {tab === 'colors' && (
            <>
              <div className="settings-section-head">
                <div>
                  <h3>语义高亮颜色</h3>
                  <p>颜色只改变前景文字；默认配色经过对比度筛选。关闭类别后，该类别恢复为编辑器默认颜色。</p>
                </div>
                <button className="button small" onClick={() => resetCategoryColors(theme)}>
                  <Icon name="reset" size={14} />
                  恢复默认
                </button>
              </div>
              <div className="color-rows">
                {SEMANTIC_CATEGORIES.map((category) => (
                  <div key={category.id} className={`color-row ${visibility[category.id] ? '' : 'disabled'}`}>
                    <label className="color-toggle" title={visibility[category.id] ? '关闭该类高亮' : '开启该类高亮'}>
                      <input
                        type="checkbox"
                        checked={visibility[category.id]}
                        onChange={() => toggleCategory(category.id)}
                      />
                    </label>
                    <span className="color-preview" style={{ color: colors[category.id] }}>
                      示例 code
                    </span>
                    <div className="color-meta">
                      <strong>{category.label}</strong>
                      <span>{category.description}</span>
                    </div>
                    <input
                      className="color-input"
                      type="color"
                      value={colors[category.id]}
                      onChange={(event) => setCategoryColor(category.id, theme, event.target.value)}
                      aria-label={`${category.label}颜色`}
                      title="自定义颜色"
                    />
                    <code className="color-hex">{colors[category.id]}</code>
                  </div>
                ))}
              </div>
              <p className="settings-note">
                <Icon name="info" size={13} />
                当前编辑的是「{theme === 'dark' ? '深色' : '浅色'}主题」的颜色；切换主题后会使用各自保存的配色。
              </p>
            </>
          )}

          {tab === 'display' && (
            <>
              <div className="settings-section-head">
                <div>
                  <h3>结构视觉</h3>
                  <p>CodeLens 用低透明度背景标记代码块边界，帮助观察函数体、循环体与条件分支的嵌套层级。</p>
                </div>
              </div>
              <div className="switch-rows">
                <label className="switch-row">
                  <div>
                    <strong>显示结构边界背景</strong>
                    <p>为函数体、循环体、条件分支添加低透明度背景。</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={showStructureBackground}
                    onChange={(event) => setShowStructureBackground(event.target.checked)}
                  />
                </label>
                <label className="switch-row">
                  <div>
                    <strong>显示嵌套层级差异</strong>
                    <p>嵌套越深，背景透明度略有变化；关闭后所有结构使用统一背景。</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={showNestingDepth}
                    onChange={(event) => setShowNestingDepth(event.target.checked)}
                  />
                </label>
              </div>
              <div className="boundary-preview">
                <div className="boundary-preview-title">预览</div>
                <div className="preview-block depth-1">
                  <span>函数体 / 第 1 层</span>
                  <div className="preview-block depth-2">
                    <span>{'for (...) {'}</span>
                    <div className="preview-block depth-3">
                      <span>if (...) {' 第 3 层'}</span>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {tab === 'ai' && (
            <>
              <div className="settings-section-head">
                <div>
                  <h3>AI 接口（可选）</h3>
                  <p>接入 OpenAI 兼容的 /chat/completions 接口。CodeLens 不内置密钥，也不会在未配置时伪造 AI 回答。</p>
                </div>
              </div>
              <div className="form-grid">
                <label className="form-row full">
                  <span className="form-label">启用 AI 问答</span>
                  <span className="form-checkbox">
                    <input
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
                    />
                    启用后，只有你主动提问时才会发送当前代码片段
                  </span>
                </label>
                <label className="form-row">
                  <span className="form-label">接口地址（Base URL）</span>
                  <input
                    className="text-input"
                    value={form.baseUrl}
                    onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                    placeholder="https://api.openai.com/v1"
                    spellCheck={false}
                  />
                </label>
                <label className="form-row">
                  <span className="form-label">模型名称</span>
                  <input
                    className="text-input"
                    value={form.model}
                    onChange={(event) => setForm({ ...form, model: event.target.value })}
                    placeholder="gpt-4o-mini"
                    spellCheck={false}
                  />
                </label>
                <label className="form-row full">
                  <span className="form-label">API Key</span>
                  <div className="input-with-action">
                    <input
                      className="text-input"
                      type={showKey ? 'text' : 'password'}
                      value={form.apiKey}
                      onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                      placeholder="sk-..."
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <button className="icon-button small" onClick={() => setShowKey((value) => !value)} title={showKey ? '隐藏' : '显示'}>
                      <Icon name={showKey ? 'eyeOff' : 'eye'} size={15} />
                    </button>
                  </div>
                </label>
                <label className="form-row full">
                  <span className="form-label">温度：{form.temperature.toFixed(1)}（越高回答越发散）</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.1}
                    value={form.temperature}
                    onChange={(event) => setForm({ ...form, temperature: Number(event.target.value) })}
                  />
                </label>
                <div className="form-row full ai-privacy">
                  <Icon name="warning" size={14} />
                  <span>
                    API Key 会保存在本机浏览器 localStorage。共享电脑请勿保存密钥。若浏览器阻止跨域请求（CORS），请填写支持浏览器访问的代理地址。
                  </span>
                </div>
              </div>
              {testResult && (
                <div className={`ai-test-result ${testResult.ok ? 'ok' : 'fail'}`}>
                  <Icon name={testResult.ok ? 'checkCircle' : 'error'} size={15} />
                  <span>{testResult.message}</span>
                </div>
              )}
              <div className="settings-actions">
                <button className="button" onClick={testConnection} disabled={testing || !form.baseUrl || !form.model || !form.apiKey}>
                  <Icon name={testing ? 'refresh' : 'globe'} size={14} />
                  {testing ? '测试中…' : '测试连接'}
                </button>
                <button className="button primary" onClick={saveAI}>
                  <Icon name="check" size={14} />
                  保存 AI 设置
                </button>
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <span className="muted">设置仅作用于当前浏览器。</span>
          <button className="button" onClick={() => setOpen(false)}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
