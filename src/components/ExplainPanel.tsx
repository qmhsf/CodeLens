/**
 * 右侧释义面板
 * ------------------------------------------------------------------
 * 三个标签页：
 * - 释义：当前点击片段的完整中文解释（组成拆解/作用/关联/误区/类比/进阶原理）
 * - 关联：声明与使用位置列表，可跳转
 * - AI 问答：基于当前片段向（用户配置的）AI 连续提问
 * 未选中代码时展示欢迎引导与当前语言能力说明。
 */
import { useMemo, useState } from 'react';
import { useAppStore } from '../state/store';
import { explainAt, explainStructure, EXPLAIN_LEVEL_LABELS } from '../core/explain';
import type { Explanation, ExplainLevel } from '../core/explain/types';
import { CATEGORY_BY_ID, SEMANTIC_CATEGORIES } from '../core/semanticCatalog';
import { Icon } from './Icons';
import { RelationsPanel } from './RelationsPanel';
import { AIPanel } from './AIPanel';

const LEVEL_DESCRIPTIONS: Record<ExplainLevel, string> = {
  beginner: '用最简单的中文和生活类比解释，避免复杂术语',
  intermediate: '讲解语法规则、执行逻辑与代码之间的关系',
  advanced: '深入内存、指针、调用栈与底层运行原理',
};

interface SectionProps {
  title: string;
  icon: React.ReactNode;
  tone?: 'default' | 'accent' | 'warning' | 'calm';
  aside?: React.ReactNode;
  children: React.ReactNode;
}

function Section({ title, icon, tone = 'default', aside, children }: SectionProps) {
  return (
    <section className={`explain-section tone-${tone}`}>
      <div className="explain-section-head">
        <span className="explain-section-icon">{icon}</span>
        <h3>{title}</h3>
        {aside}
      </div>
      <div className="explain-section-body">{children}</div>
    </section>
  );
}

function levelBadge(level: ExplainLevel) {
  return <span className={`level-badge level-${level}`}>{EXPLAIN_LEVEL_LABELS[level]}模式</span>;
}

function ExplanationBody({ explanation }: { explanation: Explanation }) {
  const colors = useAppStore((state) => (state.theme === 'dark' ? state.colorsDark : state.colorsLight));
  const jumpToRange = useAppStore((state) => state.jumpToRange);
  const setActiveRightTab = useAppStore((state) => state.setActiveRightTab);
  const analysis = useAppStore((state) => state.analysis);
  const applyGeneratedCode = useAppStore((state) => state.applyGeneratedCode);
  const [copied, setCopied] = useState(false);
  const generatedCode = analysis?.pseudo?.generatedCode;

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(explanation.snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const loadGenerated = () => {
    if (!generatedCode) return;
    const confirmed = window.confirm(
      '这会把系统生成的完整 C 代码载入编辑器（当前源码将被替换），并切换到 C 语言分析。\n生成代码是系统推断结果，不是你的伪代码原文。继续吗？',
    );
    if (confirmed) applyGeneratedCode(generatedCode);
  };

  return (
    <div className="explanation">
      <div className="explain-header">
        <div className="explain-title-row">
          <div>
            <h2>{explanation.title}</h2>
            <div className="explain-subtitle">
              <span className="code-type-chip">{explanation.codeType}</span>
              {levelBadge(explanation.level)}
              {explanation.tags.map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                </span>
              ))}
            </div>
          </div>
          <div className="explain-header-actions">
            <button className="icon-button small" onClick={copySnippet} title="复制代码片段">
              <Icon name={copied ? 'check' : 'copy'} size={14} />
            </button>
          </div>
        </div>
        <pre className="explain-snippet" title="当前代码片段">
          <code>{explanation.snippet}</code>
        </pre>
        {explanation.range && (
          <div className="explain-location">
            <Icon name="code" size={12} />
            第 {explanation.range.startLine}
            {explanation.range.endLine !== explanation.range.startLine ? `–${explanation.range.endLine}` : ''} 行
            {explanation.symbol && (
              <>
                <span className="dot-separator">·</span>
                <span>
                  {explanation.symbol.name}
                  {explanation.symbol.typeText ? `：${explanation.symbol.typeText}` : ''}
                </span>
                <button className="link-button" onClick={() => setActiveRightTab('relations')}>
                  查看 {explanation.symbol.occurrences.length} 处关联
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {explanation.comparisons?.length ? (
        <Section
          title="原文 / 推断 / 生成代码对照"
          icon={<Icon name="layers" size={15} />}
          tone="warning"
          aside={
            generatedCode ? (
              <button className="button small" onClick={loadGenerated} title="将完整生成代码载入编辑器（会替换当前源码）">
                <Icon name="code" size={13} />
                载入完整生成代码
              </button>
            ) : undefined
          }
        >
          <div className="comparison-grid">
            {explanation.comparisons.map((comparison, index) => (
              <div key={index} className="comparison-card">
                <div className="comparison-source">
                  <span className="comparison-label original">用户原文</span>
                  <p>{comparison.original}</p>
                </div>
                <div className="comparison-source">
                  <span className="comparison-label inferred">系统推断</span>
                  <p>{comparison.inferred}</p>
                  {comparison.confidence && <span className="tag">{comparison.confidence}</span>}
                </div>
                {comparison.generated && (
                  <div className="comparison-source">
                    <span className="comparison-label generated">生成的 C 代码（非原文）</span>
                    <pre>
                      <code>{comparison.generated}</code>
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {explanation.composition.length > 0 && (
        <Section title="组成拆解" icon={<Icon name="tree" size={15} />}>
          <div className="composition-list">
            {explanation.composition.map((part, index) => {
              const category = part.category ? CATEGORY_BY_ID[part.category] : undefined;
              return (
                <div key={`${part.text}-${index}`} className="composition-row">
                  <span
                    className="composition-swatch"
                    style={{ background: category && colors[part.category!] ? colors[part.category!] : 'var(--cl-border-strong)' }}
                    title={category?.label ?? part.role}
                  />
                  <div className="composition-main">
                    <div className="composition-head">
                      <code className="composition-code">{part.text}</code>
                      <span className="composition-role">{part.role}</span>
                      {category && <span className="composition-category">{category.label}</span>}
                    </div>
                    {part.detail && <p className="composition-detail">{part.detail}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <Section title="整体释义" icon={<Icon name="explain" size={15} />} tone="accent">
        <p className="explain-paragraph">{explanation.meaning}</p>
      </Section>

      {explanation.purpose && (
        <Section title="实际用途" icon={<Icon name="checkCircle" size={15} />}>
          <p className="explain-paragraph">{explanation.purpose}</p>
        </Section>
      )}

      {explanation.why && (
        <Section title="为什么需要这一部分" icon={<Icon name="help" size={15} />}>
          <p className="explain-paragraph">{explanation.why}</p>
        </Section>
      )}

      {explanation.relations.length > 0 && (
        <Section
          title="与其他代码的关联"
          icon={<Icon name="relation" size={15} />}
          aside={
            explanation.symbol ? (
              <button className="link-button" onClick={() => setActiveRightTab('relations')}>
                打开关联面板
              </button>
            ) : undefined
          }
        >
          <div className="explain-relations">
            {explanation.relations.map((group) => (
              <div key={group.title} className="explain-relation-group">
                <div className="explain-relation-title">{group.title}</div>
                {group.items.length === 0 && <p className="muted">暂无记录。</p>}
                {group.items.slice(0, 12).map((item, index) => (
                  <button
                    key={`${group.title}-${index}`}
                    className="explain-relation-item"
                    onClick={() => item.range && jumpToRange(item.range)}
                    title={item.range ? '跳转到这段代码' : undefined}
                  >
                    {item.line !== undefined && <span className="relation-line">{item.line}</span>}
                    <span>{item.label}</span>
                    {item.range && <Icon name="arrowRight" size={12} />}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </Section>
      )}

      {explanation.pitfalls.length > 0 && (
        <Section title="初学者容易误解的地方" icon={<Icon name="warning" size={15} />} tone="warning">
          <ul className="pitfall-list">
            {explanation.pitfalls.map((pitfall, index) => (
              <li key={index}>{pitfall}</li>
            ))}
          </ul>
        </Section>
      )}

      {explanation.analogy && (
        <Section title="一个简单的类比" icon={<Icon name="sparkles" size={15} />} tone="calm">
          <p className="explain-analogy">{explanation.analogy}</p>
        </Section>
      )}

      {explanation.advanced && (
        <Section title="进阶：底层原理" icon={<Icon name="memory" size={15} />}>
          <p className="explain-paragraph">{explanation.advanced}</p>
        </Section>
      )}

      {explanation.limitations?.length ? (
        <Section title="能力边界说明" icon={<Icon name="info" size={15} />}>
          <ul className="limitation-list">
            {explanation.limitations.map((limitation, index) => (
              <li key={index}>{limitation}</li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function Welcome() {
  const analysis = useAppStore((state) => state.analysis);
  const languageLabel = analysis?.languageLabel ?? '尚未分析';
  const issues = analysis?.issues ?? [];
  const supportedLanguages = SEMANTIC_CATEGORIES.length > 0;

  return (
    <div className="explain-welcome">
      <div className="welcome-hero">
        <span className="welcome-icon">
          <Icon name="logo" size={26} />
        </span>
        <div>
          <h2>点击任意代码，开始理解它</h2>
          <p>CodeLens 会把代码拆成有颜色、有类型、有关系的小块，并告诉你它在程序里起什么作用。</p>
        </div>
      </div>

      <div className="welcome-steps">
        {[
          ['1', '选择代码', '在中间编辑器点击任意一行代码，或点击左侧结构树中的节点。'],
          ['2', '查看释义', '右侧会显示组成拆解、整体释义、实际用途、关联代码与常见误区。'],
          ['3', '切换深度', '顶部切换初级 / 中级 / 高级，同一个片段会得到不同层次的解释。'],
          ['4', '观察执行', '打开底部「执行」面板，逐行查看变量、指针与链表的变化。'],
        ].map(([number, title, description]) => (
          <div key={number} className="welcome-step">
            <span className="welcome-step-number">{number}</span>
            <div>
              <strong>{title}</strong>
              <p>{description}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="welcome-capabilities">
        <div className="capability-card">
          <span className="capability-label">当前语言</span>
          <strong>{languageLabel}</strong>
          {analysis && <span className="muted">{analysis.supportLevel === 'full' ? '完整语义分析' : analysis.supportLevel === 'structural' ? '结构级分析' : '有限文本分析'}</span>}
        </div>
        <div className="capability-card">
          <span className="capability-label">分析引擎</span>
          <strong>{analysis?.analyzer ?? '—'}</strong>
          {analysis && <span className="muted">{analysis.stats.structures} 个结构 · {analysis.stats.symbols} 个符号</span>}
        </div>
        <div className="capability-card">
          <span className="capability-label">逐行执行</span>
          <strong>{analysis?.execution.supported ? '支持' : '不支持'}</strong>
          <span className="muted">{analysis?.execution.supported ? analysis.execution.engine ?? '内置解释器' : analysis?.execution.reason ?? '当前语言暂不支持执行'}</span>
        </div>
        <div className="capability-card">
          <span className="capability-label">解析问题</span>
          <strong>{issues.length}</strong>
          <span className="muted">{issues.length ? '点击编辑器工具栏查看详情' : '当前代码没有解析问题'}</span>
        </div>
      </div>

      {analysis?.supportNotes.length ? (
        <div className="welcome-note">
          <Icon name="info" size={14} />
          <div>
            <strong>能力说明</strong>
            <ul>
              {analysis.supportNotes.slice(0, 3).map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {supportedLanguages && (
        <div className="welcome-tip">
          <Icon name="sparkles" size={14} />
          <span>提示：点击变量名可以看到它的声明与所有使用位置；悬停会显示简短释义。</span>
        </div>
      )}
    </div>
  );
}

export function ExplainPanel() {
  const analysis = useAppStore((state) => state.analysis);
  const selectedOffset = useAppStore((state) => state.selectedOffset);
  const selectedStructure = useAppStore((state) => state.selectedStructure);
  const level = useAppStore((state) => state.level);
  const activeTab = useAppStore((state) => state.activeRightTab);
  const setActiveTab = useAppStore((state) => state.setActiveRightTab);
  const setRightOpen = useAppStore((state) => state.setRightOpen);

  const explanation = useMemo(() => {
    if (!analysis) return null;
    if (selectedStructure) return explainStructure(analysis, selectedStructure, level);
    if (selectedOffset !== null && selectedOffset !== undefined) return explainAt(analysis, selectedOffset, level);
    return null;
  }, [analysis, selectedStructure, selectedOffset, level]);

  const tabs = [
    { id: 'explain' as const, label: '释义', icon: 'explain' as const },
    { id: 'relations' as const, label: '关联', icon: 'relation' as const },
    { id: 'ai' as const, label: 'AI 问答', icon: 'ai' as const },
  ];

  return (
    <div className="side-panel explain-panel">
      <div className="panel-header">
        <div className="panel-title">
          <Icon name="explain" size={16} />
          <span>代码释义</span>
          {explanation && <span className="panel-level">{EXPLAIN_LEVEL_LABELS[level]}模式</span>}
        </div>
        <button className="icon-button tiny" onClick={() => setRightOpen(false)} title="收起释义面板">
          <Icon name="chevronRight" size={15} />
        </button>
      </div>

      <div className="explain-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`explain-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            role="tab"
            aria-selected={activeTab === tab.id}
          >
            <Icon name={tab.icon} size={14} />
            {tab.label}
            {tab.id === 'relations' && explanation?.symbol && (
              <span className="tab-badge">{explanation.symbol.occurrences.length}</span>
            )}
          </button>
        ))}
        <div className="explain-tabs-hint" title={LEVEL_DESCRIPTIONS[level]}>
          {levelBadge(level)}
        </div>
      </div>

      <div className="explain-scroll">
        {activeTab === 'explain' && (explanation ? <ExplanationBody explanation={explanation} /> : <Welcome />)}
        {activeTab === 'relations' && <RelationsPanel explanation={explanation} />}
        {activeTab === 'ai' && <AIPanel explanation={explanation} />}
      </div>
    </div>
  );
}
