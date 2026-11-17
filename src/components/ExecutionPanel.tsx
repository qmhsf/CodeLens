/**
 * 底部执行可视化面板
 * ------------------------------------------------------------------
 * 消费内置 C 子集解释器产生的快照：
 * - 单步 / 连续播放 / 回退 / 跳转，当前行由编辑器高亮；
 * - 变量面板：作用域、类型、值、地址、变化标记；
 * - 内存面板：模拟堆内存、指针目标、数组元素、链表节点与箭头关系；
 * - 输出控制台：printf 结果；
 * - 调用栈、运行警告与错误。
 * 不支持执行的语言会显示明确原因，绝不伪造执行结果。
 */
import { useEffect, useMemo, useState } from 'react';
import type { ExecutionSnapshot, HeapObjectView, VariableView } from '../core/interpreter/types';
import { useAppStore } from '../state/store';
import { Icon } from './Icons';

type MemoryTab = 'memory' | 'output' | 'issues';

function ValueCell({ variable }: { variable: VariableView }) {
  const value = variable.value;
  const pointerSuffix =
    value.pointerTarget && value.kind === 'pointer'
      ? ` → ${value.pointerTargetLabel ?? value.pointerTarget}`
      : '';
  return (
    <span className={`variable-value value-${value.kind}`} title={value.typeText}>
      <span className="value-main">{value.text}</span>
      {pointerSuffix && <span className="value-pointer-target">{pointerSuffix}</span>}
      {value.kind === 'pointer' && value.isNull && <span className="value-null">NULL</span>}
      {value.elements && value.elements.length > 0 && (
        <span className="value-array">
          {value.elements.map((element) => (
            <span key={element.index} className="array-cell" title={`[${element.index}]`}>
              <span className="array-index">{element.index}</span>
              <span>{element.text}</span>
            </span>
          ))}
        </span>
      )}
      {value.fields && value.fields.length > 0 && (
        <span className="value-fields">
          {value.fields.map((field) => (
            <span key={field.name} className="struct-field" title={field.typeText}>
              <span className="field-name">{field.name}</span>
              <span className="field-value">{field.text}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

function VariablesPanel() {
  const execution = useAppStore((state) => state.execution);
  const snapshot = execution.steps[execution.index];
  if (!snapshot) return null;
  const scopes = snapshot.scopes.filter((scope) => scope.variables.length > 0);
  if (!scopes.length) return <div className="panel-empty small">这一步还没有可见变量。</div>;

  return (
    <div className="variables-panel">
      {scopes.map((scope) => (
        <div key={scope.id} className="scope-block">
          <div className="scope-header">
            <Icon name="layers" size={13} />
            <span className="scope-name">{scope.name}</span>
            <span className="scope-kind">{scope.kind === 'global' ? '全局' : scope.kind === 'function' ? '函数作用域' : '块作用域'}</span>
            <span className="scope-count">{scope.variables.length} 个变量</span>
          </div>
          <div className="variable-table">
            {scope.variables.map((variable) => (
              <div key={`${scope.id}-${variable.name}-${variable.address ?? ''}`} className={`variable-row ${variable.value.changed ? 'changed' : ''}`}>
                <span className="variable-name" title={variable.declaredLine ? `声明于第 ${variable.declaredLine} 行` : undefined}>
                  {variable.name}
                </span>
                <span className="variable-type" title={variable.typeText}>
                  {variable.typeText}
                </span>
                <ValueCell variable={variable} />
                {variable.address && <span className="variable-address">{variable.address}</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 构建堆对象之间的指针链（链表可视化） */
interface HeapChain {
  startAddress: string;
  nodes: HeapObjectView[];
  cycle: boolean;
  incomingLabel?: string;
}

function buildHeapChains(snapshot: ExecutionSnapshot | undefined): {
  chains: HeapChain[];
  loose: HeapObjectView[];
} {
  if (!snapshot) return { chains: [], loose: [] };
  const heapByAddress = new Map<string, HeapObjectView>(snapshot.heap.map((item) => [item.address, item]));
  const incoming = new Set<string>();
  for (const object of snapshot.heap) {
    for (const field of object.fields ?? []) {
      if (field.pointerTarget) incoming.add(field.pointerTarget);
    }
  }
  // 变量指针目标作为链表的起点提示
  const variableTargets = new Map<string, string>();
  for (const scope of snapshot.scopes) {
    for (const variable of scope.variables) {
      const target = variable.value.pointerTarget;
      if (target && heapByAddress.has(target)) variableTargets.set(target, `${variable.name}`);
    }
  }

  const chains: HeapChain[] = [];
  const visited = new Set<string>();
  const starts = [...variableTargets.keys(), ...snapshot.heap.filter((object) => !incoming.has(object.address)).map((object) => object.address)];

  for (const start of starts) {
    if (visited.has(start) || !heapByAddress.has(start)) continue;
    const chain: HeapChain = { startAddress: start, nodes: [], cycle: false, incomingLabel: variableTargets.get(start) };
    let cursor: string | undefined = start;
    while (cursor && heapByAddress.has(cursor)) {
      if (visited.has(cursor)) {
        chain.cycle = true;
        break;
      }
      const object: HeapObjectView = heapByAddress.get(cursor)!;
      chain.nodes.push(object);
      visited.add(cursor);
      const pointerFields = (object.fields ?? []).filter((field) => Boolean(field.pointerTarget));
      const nextField = pointerFields.find((field) => /next/i.test(field.name)) ?? pointerFields[0];
      cursor = nextField?.pointerTarget;
      if (cursor && heapByAddress.has(cursor) && visited.has(cursor)) chain.cycle = true;
    }
    if (chain.nodes.length > 0) chains.push(chain);
  }
  const loose = snapshot.heap.filter((object) => !visited.has(object.address));
  return { chains, loose };
}

function HeapNodeCard({ object }: { object: HeapObjectView }) {
  return (
    <div className={`heap-node ${object.freed ? 'freed' : ''}`}>
      <div className="heap-node-head">
        <span className="heap-address">{object.address}</span>
        <span className="heap-type">{object.typeText}</span>
        {object.freed && <span className="tag tag-danger">已 free</span>}
      </div>
      {object.label && <div className="heap-label">{object.label}</div>}
      <div className="heap-fields">
        {(object.fields ?? []).map((field) => (
          <div key={field.name} className="heap-field">
            <span className="heap-field-name">{field.name}</span>
            <span className={`heap-field-value ${field.pointerTarget ? 'pointer' : ''}`}>
              {field.pointerTarget ? `→ ${field.pointerTarget}` : field.text}
            </span>
          </div>
        ))}
        {(object.elements ?? []).map((element) => (
          <div key={element.index} className="heap-element">
            <span className="heap-element-index">[{element.index}]</span>
            <span>{element.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MemoryPanel() {
  const execution = useAppStore((state) => state.execution);
  const snapshot = execution.steps[execution.index];
  const { chains, loose } = useMemo(() => buildHeapChains(snapshot), [snapshot]);
  if (!snapshot) return null;

  const arrays = (snapshot.heap ?? []).filter((object) => object.kind === 'array' || (object.elements?.length ?? 0) > 0);

  if (snapshot.heap.length === 0 && !snapshot.scopes.some((scope) => scope.variables.some((variable) => variable.value.kind === 'array' || variable.value.kind === 'struct'))) {
    return (
      <div className="panel-empty small">
        <Icon name="memory" size={20} />
        <span>当前步骤还没有堆内存对象。出现 malloc、数组或结构体后，这里会显示内存结构。</span>
      </div>
    );
  }

  return (
    <div className="memory-panel">
      {chains.length > 0 && (
        <div className="memory-section">
          <div className="memory-section-title">
            <Icon name="relation" size={13} />
            指针 / 链表结构
          </div>
          <div className="heap-chains">
            {chains.map((chain) => (
              <div key={chain.startAddress} className="heap-chain">
                {chain.incomingLabel && <span className="chain-source">{chain.incomingLabel} →</span>}
                {chain.nodes.map((node, index) => (
                  <div key={`${chain.startAddress}-${node.address}`} className="chain-fragment">
                    <HeapNodeCard object={node} />
                    {index < chain.nodes.length - 1 && <span className="chain-arrow">→</span>}
                  </div>
                ))}
                {chain.cycle ? (
                  <span className="chain-null cycle">↺ 循环</span>
                ) : (
                  <span className="chain-null">→ NULL</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {arrays.length > 0 && (
        <div className="memory-section">
          <div className="memory-section-title">
            <Icon name="layers" size={13} />
            数组对象
          </div>
          <div className="heap-arrays">
            {arrays.map((object) => (
              <div key={`array-${object.address}`} className="heap-array">
                <div className="heap-array-head">
                  <span className="heap-address">{object.address}</span>
                  <span className="heap-type">{object.typeText}</span>
                </div>
                <div className="array-boxes">
                  {(object.elements ?? []).map((element) => (
                    <div key={element.index} className="array-box">
                      <span className="array-index">{element.index}</span>
                      <span className="array-value">{element.text}</span>
                    </div>
                  ))}
                  {(object.elements?.length ?? 0) === 0 && <span className="muted">（空数组）</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {loose.length > 0 && (
        <div className="memory-section">
          <div className="memory-section-title">
            <Icon name="memory" size={13} />
            其他堆内存
          </div>
          <div className="heap-loose">
            {loose.map((object) => (
              <HeapNodeCard key={object.address} object={object} />
            ))}
          </div>
        </div>
      )}

      <p className="memory-note">
        <Icon name="info" size={12} />
        地址为 CodeLens 解释器模拟的虚拟地址，仅用于理解指针关系，不对应真实物理内存。
      </p>
    </div>
  );
}

function OutputPanel() {
  const execution = useAppStore((state) => state.execution);
  const snapshot = execution.steps[execution.index];
  const output = snapshot?.output ?? [];
  return (
    <div className="output-panel">
      {execution.note && (
        <div className="output-note">
          <Icon name="info" size={13} />
          <span>{execution.note}</span>
        </div>
      )}
      <div className="output-console">
        {output.length === 0 && <span className="muted">目前还没有输出。程序调用 printf 后，这里会显示内容。</span>}
        {output.map((line, index) => (
          <div key={index} className="output-line">
            <span className="output-line-number">{index + 1}</span>
            <span>{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function IssuesPanel() {
  const execution = useAppStore((state) => state.execution);
  const snapshot = execution.steps[execution.index];
  const warnings = [...(execution.warnings ?? []), ...(snapshot?.warnings ?? [])];
  return (
    <div className="issues-panel">
      {execution.error && (
        <div className="execution-error-card">
          <div className="execution-error-title">
            <Icon name="error" size={15} />
            <span>执行中止：{execution.error.message}</span>
          </div>
          {execution.error.line && <p>出错位置：第 {execution.error.line} 行</p>}
          {execution.error.hint && <p className="muted">{execution.error.hint}</p>}
        </div>
      )}
      {execution.truncated && (
        <div className="execution-warning-card">
          <Icon name="warning" size={14} />
          执行步数达到上限，快照被截断。可能是死循环，或代码运行步骤过多。
        </div>
      )}
      {warnings.length > 0 ? (
        <ul className="execution-warning-list">
          {warnings.map((warning, index) => (
            <li key={index}>
              <Icon name="warning" size={13} />
              {warning}
            </li>
          ))}
        </ul>
      ) : (
        !execution.error && <div className="panel-empty small">本次执行没有运行期警告。</div>
      )}
      <div className="execution-limitations">
        <strong>执行能力说明</strong>
        <ul>
          <li>执行引擎：{execution.engine ?? 'CodeLens C 子集解释器'}</li>
          <li>只支持 C 子集与 printf 输出；scanf、文件 IO、函数指针等会明确报错。</li>
          <li>生成内存为模拟模型，地址不代表真实物理内存。</li>
        </ul>
      </div>
    </div>
  );
}

export function ExecutionPanel() {
  const analysis = useAppStore((state) => state.analysis);
  const execution = useAppStore((state) => state.execution);
  const runExecution = useAppStore((state) => state.runExecution);
  const resetExecution = useAppStore((state) => state.resetExecution);
  const setBroken = useAppStore((state) => state.setBottomOpen);
  const stepExecution = useAppStore((state) => state.stepExecution);
  const setExecutionIndex = useAppStore((state) => state.setExecutionIndex);
  const toggleAutoPlay = useAppStore((state) => state.toggleAutoPlay);
  const [tab, setTab] = useState<MemoryTab>('memory');

  const snapshot = execution.steps[execution.index];
  const currentStep = execution.steps.length ? execution.index + 1 : 0;
  const supported = analysis?.execution.supported ?? false;
  const executionTargetLabel = analysis?.pseudo ? '由伪代码生成的 C 代码（非原文）' : analysis?.language === 'cpp' ? 'C++ 源码（按 C 子集执行）' : 'C 源码';

  // 自动播放
  useEffect(() => {
    if (!execution.autoPlaying || execution.steps.length === 0) return;
    const timer = window.setInterval(() => {
      const current = useAppStore.getState().execution;
      if (current.index >= current.steps.length - 1) {
        useAppStore.getState().toggleAutoPlay();
        return;
      }
      useAppStore.getState().stepExecution(1);
    }, 650);
    return () => window.clearInterval(timer);
  }, [execution.autoPlaying, execution.steps.length]);

  return (
    <div className="execution-panel">
      <div className="execution-header">
        <div className="execution-title">
          <Icon name="terminal" size={15} />
          <span>执行过程</span>
          {execution.label && <span className="execution-label">{execution.label}</span>}
          {snapshot && (
            <span className="execution-phase">
              第 {currentStep} / {execution.steps.length} 步 · 第 {snapshot.line} 行 · {snapshot.functionName ?? '程序'}
            </span>
          )}
        </div>
        <div className="execution-controls">
          <button className="icon-button small" onClick={resetExecution} title="重置执行" disabled={!execution.steps.length}>
            <Icon name="reset" size={15} />
          </button>
          <button className="icon-button small" onClick={() => stepExecution(-1)} title="上一步" disabled={!execution.steps.length || execution.index <= 0}>
            <Icon name="stepBack" size={15} />
          </button>
          <button
            className={`icon-button small ${execution.autoPlaying ? 'active' : ''}`}
            onClick={toggleAutoPlay}
            title={execution.autoPlaying ? '暂停自动播放' : '自动播放'}
            disabled={!execution.steps.length}
          >
            <Icon name={execution.autoPlaying ? 'pause' : 'play'} size={15} />
          </button>
          <button
            className="icon-button small"
            onClick={() => stepExecution(1)}
            title="下一步"
            disabled={!execution.steps.length || execution.index >= execution.steps.length - 1}
          >
            <Icon name="stepForward" size={15} />
          </button>
          <input
            className="execution-slider"
            type="range"
            min={0}
            max={Math.max(execution.steps.length - 1, 0)}
            value={execution.index}
            onChange={(event) => setExecutionIndex(Number(event.target.value))}
            disabled={!execution.steps.length}
            aria-label="执行进度"
          />
          <button
            className="button primary small"
            onClick={() => void runExecution()}
            disabled={execution.status === 'running'}
            title="运行 / 重新运行"
          >
            <Icon name={execution.status === 'running' ? 'refresh' : 'play'} size={14} />
            {execution.status === 'running' ? '运行中…' : execution.steps.length ? '重新运行' : '开始执行'}
          </button>
          <button className="icon-button small" onClick={() => setBroken(false)} title="收起执行面板">
            <Icon name="close" size={15} />
          </button>
        </div>
      </div>

      {!analysis && <div className="panel-empty">还没有可执行的代码。</div>}

      {analysis && !supported && (
        <div className="execution-unsupported">
          <div className="unsupported-icon">
            <Icon name="info" size={22} />
          </div>
          <div>
            <strong>当前语言暂不支持逐行执行</strong>
            <p>{analysis.execution.reason ?? 'CodeLens 不会为没有可靠执行引擎的语言伪造执行结果。'}</p>
            <div className="unsupported-detail">
              <span>语言：{analysis.languageLabel}</span>
              <span>分析能力：{analysis.supportLevel === 'full' ? '完整语义分析' : analysis.supportLevel === 'structural' ? '结构级分析' : '有限分析'}</span>
            </div>
            <p className="muted">
              {analysis.language === 'pseudo'
                ? '伪代码需要先生成可靠的 C 代码并满足执行条件，当前生成结果不满足要求。'
                : '你可以继续使用语义高亮、结构树与中文释义来理解代码；执行可视化目前仅支持 C/C++ 的 C 子集。'}
            </p>
          </div>
        </div>
      )}

      {analysis && supported && execution.status === 'idle' && (
        <div className="execution-idle">
          <div className="execution-idle-main">
            <div className="execution-idle-icon">
              <Icon name="terminal" size={24} />
            </div>
            <div>
              <strong>逐行观察程序运行</strong>
              <p>
                {analysis.pseudo
                  ? '伪代码会先生成 C 代码，再交给内置 C 子集解释器执行。可以观察变量变化、条件与循环；执行的是生成结果，不是用户原文。'
                  : '运行使用 CodeLens 内置的 C 子集解释器：可以观察变量变化、循环条件、数组、指针与链表。当前源码将作为执行目标。按 Ctrl/⌘ + Enter 也可以运行。'}
              </p>
              <div className="execution-idle-actions">
                <button className="button primary" onClick={() => void runExecution()}>
                  <Icon name="play" size={15} />
                  开始执行
                </button>
                <span className="muted">
                  执行目标：{execution.label ?? executionTargetLabel}
                </span>
              </div>
            </div>
          </div>
          <div className="execution-idle-hints">
            <span><Icon name="check" size={12} /> 支持：变量 / 控制流 / 函数 / 数组 / 指针 / malloc 链表 / printf</span>
            <span><Icon name="close" size={12} /> 不支持：scanf / 文件 IO / 函数指针 / 未定义行为</span>
          </div>
        </div>
      )}

      {analysis && execution.status === 'running' && (
        <div className="execution-loading">
          <Icon name="refresh" size={18} className="spin" />
          正在执行并生成快照…
        </div>
      )}

      {snapshot && (
        <div className="execution-body">
          <div className="execution-left">
            <div className="execution-description">
              <div className="execution-description-head">
                <span className={`phase-chip phase-${snapshot.phase}`}>{phaseLabel(snapshot.phase)}</span>
                <span className="execution-description-line">第 {snapshot.line} 行</span>
                <span className="muted">{snapshot.functionName ?? '程序'}</span>
              </div>
              <p>{snapshot.description}</p>
            </div>
            <VariablesPanel />
            {snapshot.callStack.length > 1 && (
              <div className="callstack-panel">
                <div className="memory-section-title">
                  <Icon name="layers" size={13} />
                  调用栈
                </div>
                <div className="callstack-list">
                  {[...snapshot.callStack].reverse().map((frame, index) => (
                    <div key={`${frame.functionName}-${index}`} className={`callstack-frame ${index === 0 ? 'current' : ''}`}>
                      <span className="callstack-function">{frame.functionName}()</span>
                      {frame.line && <span className="callstack-line">第 {frame.line} 行</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="execution-right">
            <div className="execution-tabs">
              <button className={`execution-tab ${tab === 'memory' ? 'active' : ''}`} onClick={() => setTab('memory')}>
                <Icon name="memory" size={13} />
                内存 / 结构
              </button>
              <button className={`execution-tab ${tab === 'output' ? 'active' : ''}`} onClick={() => setTab('output')}>
                <Icon name="terminal" size={13} />
                输出
                {snapshot.output.length > 0 && <span className="tab-badge">{snapshot.output.length}</span>}
              </button>
              <button className={`execution-tab ${tab === 'issues' ? 'active' : ''}`} onClick={() => setTab('issues')}>
                <Icon name="warning" size={13} />
                问题
                {execution.error && <span className="tab-badge danger">!</span>}
              </button>
            </div>
            <div className="execution-tab-content">
              {tab === 'memory' && <MemoryPanel />}
              {tab === 'output' && <OutputPanel />}
              {tab === 'issues' && <IssuesPanel />}
            </div>
          </div>
        </div>
      )}

      {!snapshot && execution.status === 'error' && execution.error && (
        <div className="execution-error-standalone">
          <Icon name="error" size={18} />
          <div>
            <strong>执行失败：{execution.error.message}</strong>
            {execution.error.hint && <p>{execution.error.hint}</p>}
            {execution.error.line && <p className="muted">出错位置：第 {execution.error.line} 行</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    start: '开始',
    statement: '执行语句',
    condition: '条件判断',
    loop: '循环',
    call: '函数调用',
    return: '返回',
    output: '输出',
    end: '结束',
    error: '错误',
  };
  return labels[phase] ?? phase;
}
