/**
 * 底部状态栏：解析状态、语言/分析器、当前光标/选中位置、执行状态与问题计数。
 */
import { useMemo } from 'react';
import { SourceFile } from '../core/source';
import { useAppStore } from '../state/store';
import { Icon } from './Icons';

export function StatusBar() {
  const analysis = useAppStore((state) => state.analysis);
  const execution = useAppStore((state) => state.execution);
  const selectedStructure = useAppStore((state) => state.selectedStructure);
  const selectedOffset = useAppStore((state) => state.selectedOffset);
  const setBottomOpen = useAppStore((state) => state.setBottomOpen);
  const setHelpOpen = useAppStore((state) => state.setHelpOpen);

  const position = useMemo(() => {
    if (!analysis) return null;
    if (selectedStructure?.range) {
      return { line: selectedStructure.range.startLine, endLine: selectedStructure.range.endLine };
    }
    if (selectedOffset !== null) {
      const source = new SourceFile(analysis.source);
      const pos = source.positionAt(selectedOffset);
      return { line: pos.line, endLine: pos.line };
    }
    return null;
  }, [analysis, selectedStructure, selectedOffset]);

  const errorCount = analysis?.stats.errors ?? 0;
  const warningCount = analysis?.stats.warnings ?? 0;
  const parseOk = Boolean(analysis) && errorCount === 0;

  return (
    <footer className="status-bar">
      <div className="status-left">
        <span className={`status-indicator ${parseOk ? 'ok' : errorCount ? 'error' : 'idle'}`} />
        <span className="status-text">
          {analysis ? (parseOk ? '分析完成' : `分析完成（${errorCount} 个错误）`) : '等待分析'}
        </span>
        {analysis && (
          <>
            <span className="status-sep" />
            <span className="status-text">{analysis.languageLabel}</span>
            <span className="status-muted">{analysis.analyzer}</span>
            <span className="status-sep" />
            <span className="status-muted">
              {analysis.stats.lines} 行 · {analysis.stats.tokens} 语义片段 · {analysis.stats.structures} 结构 · {analysis.stats.symbols} 符号
            </span>
          </>
        )}
      </div>

      <div className="status-center">
        {position ? (
          <>
            <Icon name="code" size={12} />
            <span>
              第 {position.line}
              {position.endLine !== position.line ? `–${position.endLine}` : ''} 行
            </span>
            {selectedStructure && <span className="status-muted">{selectedStructure.label}</span>}
          </>
        ) : analysis && analysis.issues.some((issue) => issue.line) ? (
          <button className="status-link" onClick={() => setHelpOpen(true)}>
            <Icon name="warning" size={12} />
            有 {analysis.issues.length} 条解析提示
          </button>
        ) : (
          <span className="status-muted">点击代码或结构节点查看释义</span>
        )}
      </div>

      <div className="status-right">
        <button
          className={`status-exec ${execution.status}`}
          onClick={() => setBottomOpen(true)}
          title="打开执行面板"
        >
          <Icon name="terminal" size={12} />
          {execution.status === 'idle'
            ? analysis?.execution.supported
              ? '执行：待运行'
              : '执行：不支持'
            : execution.status === 'running'
              ? '执行中…'
              : execution.status === 'unsupported'
                ? '执行：不支持'
                : execution.steps.length
                  ? `执行：${execution.index + 1}/${execution.steps.length} 步`
                  : '执行：失败'}
        </button>
        <button className={`status-issues ${errorCount ? 'has-error' : warningCount ? 'has-warning' : ''}`} onClick={() => setHelpOpen(true)} title="查看解析问题与能力边界">
          <Icon name={errorCount ? 'error' : warningCount ? 'warning' : 'checkCircle'} size={12} />
          {errorCount} 错误 / {warningCount} 警告
        </button>
        <span className="status-sep" />
        <span className="status-muted">本地运行 · 无后端</span>
      </div>
    </footer>
  );
}
