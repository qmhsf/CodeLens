/**
 * 左侧代码结构树
 * ------------------------------------------------------------------
 * 由分析结果中的 StructureNode 树渲染：
 * 支持展开/折叠、搜索过滤、点击定位到源码、显示当前选中节点，
 * 并在底部展示当前分析引擎与能力边界。
 */
import { useEffect, useMemo, useState } from 'react';
import type { StructureNode } from '../core/analysisTypes';
import { flattenStructure } from '../core/analysisTypes';
import { useAppStore } from '../state/store';
import { Icon, structureIcon } from './Icons';

interface FlatSearchResult {
  visible: Set<string>;
  expanded: Set<string>;
}

function filterTree(nodes: StructureNode[], query: string): FlatSearchResult {
  const visible = new Set<string>();
  const expanded = new Set<string>();
  const normalized = query.trim().toLowerCase();
  if (!normalized) return { visible, expanded };

  const visit = (node: StructureNode, ancestors: string[]): boolean => {
    const selfMatch =
      node.label.toLowerCase().includes(normalized) ||
      (node.secondary ?? '').toLowerCase().includes(normalized) ||
      (node.badges ?? []).some((badge) => badge.toLowerCase().includes(normalized));
    let childMatch = false;
    for (const child of node.children) {
      if (visit(child, [...ancestors, node.id])) childMatch = true;
    }
    if (selfMatch || childMatch) {
      visible.add(node.id);
      for (const ancestor of ancestors) expanded.add(ancestor);
      if (childMatch) expanded.add(node.id);
      return true;
    }
    return false;
  };

  for (const node of nodes) visit(node, []);
  return { visible, expanded };
}

function findPath(nodes: StructureNode[], targetId: string): string[] {
  const path: string[] = [];
  const visit = (node: StructureNode, ancestors: string[]): boolean => {
    if (node.id === targetId) {
      path.push(...ancestors);
      return true;
    }
    for (const child of node.children) {
      if (visit(child, [...ancestors, node.id])) return true;
    }
    return false;
  };
  for (const node of nodes) {
    if (visit(node, [])) break;
  }
  return path;
}

interface TreeRowProps {
  node: StructureNode;
  depth: number;
  expanded: Set<string>;
  visible: Set<string> | null;
  selectedId?: string;
  onToggle: (id: string) => void;
  onSelect: (node: StructureNode) => void;
}

function TreeRow({ node, depth, expanded, visible, selectedId, onToggle, onSelect }: TreeRowProps) {
  const isExpanded = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  const isSelected = selectedId === node.id;
  const secondary = node.secondary ?? '';
  return (
    <div className="tree-node-wrap">
      <div
        className={`tree-row ${isSelected ? 'selected' : ''} ${node.badges?.includes('不支持') ? 'unsupported' : ''}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => onSelect(node)}
        title={[node.label, secondary, ...(node.badges ?? [])].filter(Boolean).join('\n')}
        role="treeitem"
        aria-selected={isSelected}
      >
        <button
          className={`tree-chevron ${hasChildren ? '' : 'invisible'}`}
          onClick={(event) => {
            event.stopPropagation();
            if (hasChildren) onToggle(node.id);
          }}
          tabIndex={-1}
          aria-label={isExpanded ? '折叠' : '展开'}
        >
          <Icon name={isExpanded ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
        <span className={`tree-icon kind-${node.kind.split('-')[0]}`}>
          <Icon name={structureIcon(node.kind)} size={14} />
        </span>
        <span className="tree-label">{node.label}</span>
        {secondary && <span className="tree-secondary">{secondary}</span>}
        {node.badges?.length ? (
          <span className="tree-badges">
            {node.badges.slice(0, 2).map((badge) => (
              <span key={badge} className={`badge ${badge === '不支持' ? 'badge-error' : badge.includes('置信度') ? 'badge-warning' : ''}`}>
                {badge}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      {hasChildren && isExpanded && (
        <div className="tree-children" role="group">
          {node.children
            .filter((child) => !visible || visible.has(child.id))
            .map((child) => (
              <TreeRow
                key={child.id}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                visible={visible}
                selectedId={selectedId}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))}
        </div>
      )}
    </div>
  );
}

export function StructureTree() {
  const analysis = useAppStore((state) => state.analysis);
  const selectedStructure = useAppStore((state) => state.selectedStructure);
  const selectStructure = useAppStore((state) => state.selectStructure);
  const setLeftOpen = useAppStore((state) => state.setLeftOpen);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // 默认展开前两层，便于第一眼看到程序骨架
  useEffect(() => {
    if (!analysis) return;
    const initial = new Set<string>();
    const visit = (nodes: StructureNode[], depth: number) => {
      for (const node of nodes) {
        if (depth <= 2) initial.add(node.id);
        visit(node.children, depth + 1);
      }
    };
    visit(analysis.tree, 0);
    setExpanded(initial);
    setQuery('');
  }, [analysis?.id]);

  // 选中节点变化时自动展开其祖先路径
  useEffect(() => {
    if (!selectedStructure || !analysis) return;
    const ancestors = findPath(analysis.tree, selectedStructure.id);
    if (!ancestors.length) return;
    setExpanded((previous) => {
      const next = new Set(previous);
      for (const id of ancestors) next.add(id);
      return next;
    });
  }, [selectedStructure?.id, analysis?.id]);

  const searchResult = useMemo(() => (analysis ? filterTree(analysis.tree, query) : { visible: new Set<string>(), expanded: new Set<string>() }), [analysis, query]);
  const isSearching = query.trim().length > 0;
  const effectiveExpanded = isSearching ? searchResult.expanded : expanded;
  const visibleIds = isSearching ? searchResult.visible : null;
  const totalNodes = analysis ? flattenStructure(analysis.tree).length : 0;

  const toggle = (id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="side-panel structure-panel">
      <div className="panel-header">
        <div className="panel-title">
          <Icon name="tree" size={16} />
          <span>代码结构</span>
          {analysis && <span className="panel-count">{totalNodes - 1}</span>}
        </div>
        <div className="panel-header-actions">
          <button className="icon-button tiny" onClick={() => setLeftOpen(false)} title="收起结构树">
            <Icon name="chevronLeft" size={15} />
          </button>
        </div>
      </div>

      <div className="tree-search">
        <Icon name="search" size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索函数 / 变量 / 结构…"
          spellCheck={false}
        />
        {query && (
          <button className="icon-button tiny" onClick={() => setQuery('')} title="清除搜索">
            <Icon name="close" size={13} />
          </button>
        )}
      </div>

      <div className="tree-scroll" role="tree">
        {!analysis && <div className="panel-empty">还没有分析结果。</div>}
        {analysis && analysis.tree.length === 0 && (
          <div className="panel-empty">
            <Icon name="empty" size={26} />
            <p>没有识别出结构。</p>
            <p className="muted">请检查代码或切换语言；解析问题会显示在下方状态栏。</p>
          </div>
        )}
        {analysis &&
          analysis.tree.map((node) => (
            <TreeRow
              key={node.id}
              node={node}
              depth={0}
              expanded={effectiveExpanded}
              visible={visibleIds}
              selectedId={selectedStructure?.id}
              onToggle={toggle}
              onSelect={selectStructure}
            />
          ))}
        {isSearching && searchResult.visible.size === 0 && <div className="panel-empty">没有匹配“{query}”的结构。</div>}
      </div>

      {analysis && (
        <div className="tree-footer">
          <div className="tree-footer-row">
            <span className={`support-pill support-${analysis.supportLevel}`}>
              {analysis.supportLevel === 'full' ? '完整分析' : analysis.supportLevel === 'structural' ? '结构级分析' : '有限分析'}
            </span>
            <span className="muted">{analysis.analyzer}</span>
          </div>
          <div className="tree-footer-note" title={analysis.supportNotes.join('\n')}>
            {analysis.supportNotes[0]}
          </div>
          {analysis.issues.length > 0 && (
            <div className="tree-footer-issues">
              <Icon name="warning" size={13} />
              <span>
                {analysis.stats.errors} 个错误 · {analysis.stats.warnings} 个警告
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
