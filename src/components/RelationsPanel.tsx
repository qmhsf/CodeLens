/**
 * 关联代码面板
 * ------------------------------------------------------------------
 * 当用户点击变量 / 函数 / 结构体成员时，这里展示：
 * - 声明位置与所有使用位置（来自符号表），可点击跳转；
 * - 当前符号的类型、作用域与出现次数；
 * - 未选中具体符号时，可浏览本文件中的全部符号并按名称搜索。
 */
import { useMemo, useState } from 'react';
import type { SymbolInfo } from '../core/analysisTypes';
import { useAppStore } from '../state/store';
import type { Explanation } from '../core/explain/types';
import { Icon } from './Icons';

const ROLE_LABELS: Record<string, string> = {
  declaration: '声明',
  reference: '使用',
  call: '调用',
  type: '类型引用',
  member: '成员访问',
  parameter: '参数声明',
};

const KIND_LABELS: Record<string, string> = {
  variable: '变量',
  parameter: '参数',
  function: '函数',
  struct: '结构体',
  typedef: '类型别名',
  field: '成员',
  enum: '枚举',
  class: '类',
  unknown: '未解析',
};

interface RelationsPanelProps {
  explanation: Explanation | null;
}

export function RelationsPanel({ explanation }: RelationsPanelProps) {
  const analysis = useAppStore((state) => state.analysis);
  const jumpToRange = useAppStore((state) => state.jumpToRange);
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<string>('all');

  const symbol = explanation?.symbol;
  const groups = explanation?.relations ?? [];

  const filteredSymbols = useMemo<SymbolInfo[]>(() => {
    if (!analysis) return [];
    const normalized = query.trim().toLowerCase();
    return analysis.symbolList.filter((item) => {
      if (kindFilter !== 'all' && item.kind !== kindFilter) return false;
      if (!normalized) return true;
      return (
        item.name.toLowerCase().includes(normalized) ||
        (item.typeText ?? '').toLowerCase().includes(normalized) ||
        (item.detail ?? '').toLowerCase().includes(normalized)
      );
    });
  }, [analysis, query, kindFilter]);

  return (
    <div className="relations-panel">
      {symbol ? (
        <>
          <div className="relations-summary">
            <div className="relations-summary-head">
              <span className="symbol-kind-chip">{KIND_LABELS[symbol.kind] ?? symbol.kind}</span>
              <strong>{symbol.name}</strong>
              {symbol.typeText && <code className="symbol-type">{symbol.typeText}</code>}
            </div>
            <div className="relations-meta">
              {symbol.detail && <span>{symbol.detail}</span>}
              {symbol.scopeName && <span>作用域：{symbol.scopeName}</span>}
              <span>共 {symbol.occurrences.length} 处出现</span>
              {symbol.isPointer && <span className="tag tag-pointer">指针/数组</span>}
            </div>
          </div>

          {groups.length === 0 && <div className="panel-empty">这个符号没有可展示的关联位置。</div>}
          {groups.map((group) => (
            <div key={group.title} className="relation-group">
              <div className="relation-group-title">
                <Icon name="relation" size={14} />
                <span>{group.title}</span>
              </div>
              <div className="relation-items">
                {group.items.map((item, index) => (
                  <button
                    key={`${group.title}-${index}`}
                    className="relation-item"
                    onClick={() => item.range && jumpToRange(item.range)}
                    title={item.range ? '跳转到这段代码' : undefined}
                  >
                    <span className="relation-line">{item.line ?? '?'}</span>
                    <span className="relation-snippet">{item.label}</span>
                    <Icon name="arrowRight" size={12} />
                  </button>
                ))}
              </div>
            </div>
          ))}
          <p className="relations-tip">
            <Icon name="info" size={13} />
            点击任意位置可跳转；同名符号会在编辑器中同时高亮声明与全部使用位置。
          </p>
        </>
      ) : (
        <>
          <div className="relations-hint">
            <Icon name="relation" size={16} />
            <div>
              <strong>关联代码定位</strong>
              <p>点击编辑器中的变量、函数或结构体成员，这里会显示它的声明与全部使用位置。</p>
            </div>
          </div>
          <div className="symbol-search-row">
            <Icon name="search" size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索本文件中的符号…" spellCheck={false} />
          </div>
          <div className="symbol-filter-row">
            {[
              ['all', '全部'],
              ['variable', '变量'],
              ['parameter', '参数'],
              ['function', '函数'],
              ['struct', '结构体'],
              ['field', '成员'],
              ['unknown', '未解析'],
            ].map(([value, label]) => (
              <button
                key={value}
                className={`filter-chip ${kindFilter === value ? 'active' : ''}`}
                onClick={() => setKindFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="symbol-list">
            {filteredSymbols.length === 0 && <div className="panel-empty">没有匹配的符号。</div>}
            {filteredSymbols.map((item) => (
              <button
                key={item.id}
                className="symbol-row"
                onClick={() => {
                  if (item.declaration?.range) jumpToRange(item.declaration.range);
                }}
                title={item.declaration ? `第 ${item.declaration.line} 行` : '没有明确声明位置'}
              >
                <span className={`symbol-kind-dot kind-${item.kind}`} />
                <span className="symbol-name">{item.name}</span>
                <span className="symbol-type">{item.typeText}</span>
                <span className="symbol-count">{item.occurrences.length} 处</span>
              </button>
            ))}
          </div>
          {analysis && filteredSymbols.length > 0 && (
            <p className="relations-tip">
              <Icon name="info" size={13} />
              符号与位置由{analysis.languageLabel}分析器从语法结构中获得；未声明的名称会单独标记为“未解析”，不会编造含义。
            </p>
          )}
        </>
      )}
    </div>
  );
}

export { ROLE_LABELS, KIND_LABELS };
