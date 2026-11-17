/**
 * 帮助 / 能力边界弹窗
 * ------------------------------------------------------------------
 * 集中展示：快速上手、当前语言支持矩阵、解析问题、执行能力边界、隐私说明。
 * 这是 CodeLens "不支持的语法必须明确说明" 的主要出口。
 */
import { useEffect, useState } from 'react';
import { LANGUAGE_OPTIONS } from '../core/analysisTypes';
import { useAppStore } from '../state/store';
import { Icon } from './Icons';

type HelpTab = 'guide' | 'capabilities' | 'issues' | 'about';

const TABS: { id: HelpTab; label: string }[] = [
  { id: 'guide', label: '快速上手' },
  { id: 'capabilities', label: '能力边界' },
  { id: 'issues', label: '解析问题' },
  { id: 'about', label: '关于 / 隐私' },
];

export function HelpDialog() {
  const open = useAppStore((state) => state.helpOpen);
  const setOpen = useAppStore((state) => state.setHelpOpen);
  const analysis = useAppStore((state) => state.analysis);
  const jumpToRange = useAppStore((state) => state.jumpToRange);
  const [tab, setTab] = useState<HelpTab>('guide');

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
      <div className="modal help-modal" role="dialog" aria-modal="true" aria-label="帮助与能力说明">
        <div className="modal-header">
          <div className="modal-title">
            <Icon name="help" size={18} />
            <h2>CodeLens 使用指南与能力边界</h2>
          </div>
          <button className="icon-button" onClick={() => setOpen(false)} title="关闭">
            <Icon name="close" size={17} />
          </button>
        </div>

        <div className="help-tabs">
          {TABS.map((item) => (
            <button key={item.id} className={`settings-tab ${tab === item.id ? 'active' : ''}`} onClick={() => setTab(item.id)}>
              {item.label}
            </button>
          ))}
        </div>

        <div className="modal-body help-body">
          {tab === 'guide' && (
            <div className="help-guide">
              <section>
                <h3>四步开始</h3>
                <ol className="help-steps">
                  <li><strong>输入代码：</strong>直接编辑、粘贴，或拖拽 .c/.cpp/.h/.py/.js/.ts 文件到页面；也可以加载顶部「示例」。</li>
                  <li><strong>看语义颜色：</strong>蓝色=类型、绿色=变量与数据、紫色=控制结构、橙色=函数、粉色=运算符、青色=指针与内存、灰色=注释。底部图例可开关类别。</li>
                  <li><strong>点击代码或结构树：</strong>右侧展示组成拆解、整体释义、实际用途、关联位置、常见误区与类比；顶部可切换初级/中级/高级。</li>
                  <li><strong>打开执行：</strong>点击顶部中间的底部面板开关或工具栏「运行」，逐行查看变量、数组、指针与链表（目前仅 C/C++ 的 C 子集）。</li>
                </ol>
              </section>
              <section>
                <h3>交互技巧</h3>
                <ul className="help-list">
                  <li>悬停代码：显示简短释义；点击变量名：高亮它的声明与所有使用位置。</li>
                  <li>结构树支持搜索、折叠、点击定位；关联标签页可按名称浏览所有符号。</li>
                  <li>Ctrl/⌘ + Enter 运行；Ctrl/⌘ + B 收起结构树；Ctrl/⌘ + J 收起执行面板；Ctrl/⌘ + I 收起释义面板。</li>
                  <li>顶部「刷新」图标会根据代码内容重新自动识别语言；手动切换语言会以手动选择为准。</li>
                  <li>「学习笔记」会把当前代码的分析结果整理成 Markdown，可下载复习。</li>
                </ul>
              </section>
              <section>
                <h3>中文伪代码示例</h3>
                <pre className="help-code">{`创建一个整数变量 a，赋值为 10。
如果 a 大于 5，就输出 Hello。
否则输出 World。`}</pre>
                <p className="muted">
                  切换语言到「中文伪代码」后，CodeLens 会区分用户原文、系统推断和生成的 C 代码。推断结果不会当成你的原文，低置信度会明确标出。
                </p>
              </section>
            </div>
          )}

          {tab === 'capabilities' && (
            <div className="help-capabilities">
              <section>
                <h3>语言支持矩阵</h3>
                <div className="capability-table">
                  {LANGUAGE_OPTIONS.map((option) => (
                    <div key={option.id} className={`capability-row ${analysis?.language === option.id ? 'current' : ''}`}>
                      <div className="capability-lang">
                        <span className={`language-dot language-${option.id}`} />
                        {option.label}
                        {analysis?.language === option.id && <span className="tag">当前</span>}
                      </div>
                      <p>{option.supportNote}</p>
                    </div>
                  ))}
                </div>
              </section>
              <section>
                <h3>当前分析结果的能力边界</h3>
                {analysis ? (
                  <>
                    <div className="capability-current">
                      <span className={`support-pill support-${analysis.supportLevel}`}>
                        {analysis.supportLevel === 'full' ? '完整语义分析' : analysis.supportLevel === 'structural' ? '结构级分析' : '有限文本分析'}
                      </span>
                      <span>分析器：{analysis.analyzer}</span>
                      <span>执行：{analysis.execution.supported ? '支持' : '不支持'}</span>
                    </div>
                    <ul className="help-list">
                      {analysis.supportNotes.map((note, index) => (
                        <li key={index}>{note}</li>
                      ))}
                    </ul>
                    <p className="muted">
                      CodeLens 的原则：能分析的分析，不能分析或无法可靠执行的会明确说明；不会用正则猜测语义，也不会伪造执行结果。
                    </p>
                  </>
                ) : (
                  <p className="muted">还没有分析结果。</p>
                )}
              </section>
              <section>
                <h3>执行能力</h3>
                {analysis?.execution.supported ? (
                  <>
                    <p>
                      <Icon name="checkCircle" size={14} /> {analysis.execution.engine}
                    </p>
                    <ul className="help-list">
                      <li>基于解析后的 AST 逐行解释执行，输出真实的逐行快照。</li>
                      <li>内存地址为模拟地址，用于理解指针关系，不代表真实物理内存。</li>
                      <li>不支持：scanf/文件 IO、函数指针、goto、C++ 模板/STL、未定义行为；遇到会中止并给出中文原因。</li>
                    </ul>
                  </>
                ) : (
                  <p>
                    <Icon name="info" size={14} /> {analysis?.execution.reason ?? '当前语言没有可靠执行引擎，CodeLens 不会伪造执行结果。'}
                  </p>
                )}
              </section>
            </div>
          )}

          {tab === 'issues' && (
            <div className="help-issues">
              {!analysis || analysis.issues.length === 0 ? (
                <div className="panel-empty">
                  <Icon name="checkCircle" size={22} />
                  <p>没有解析问题。</p>
                </div>
              ) : (
                <>
                  <p className="muted">
                    CodeLens 会把解析失败、暂不支持的语法、低置信度推断都明确列出，而不是静默忽略。点击带位置的条目可以跳转。
                  </p>
                  <div className="issue-list">
                    {analysis.issues.map((issue, index) => (
                      <button
                        key={index}
                        className={`issue-row severity-${issue.severity}`}
                        onClick={() => issue.range && jumpToRange(issue.range)}
                        disabled={!issue.range}
                      >
                        <Icon name={issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info'} size={15} />
                        <div className="issue-content">
                          <div className="issue-message">
                            {issue.line ? <span className="issue-line">第 {issue.line} 行</span> : null}
                            {issue.message}
                          </div>
                          {issue.hint && <div className="issue-hint">{issue.hint}</div>}
                        </div>
                        {issue.range && <Icon name="arrowRight" size={13} />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'about' && (
            <div className="help-about">
              <section>
                <h3>CodeLens v0.1.0</h3>
                <p>面向编程初学者的代码结构可视化学习工具。通过语义颜色、结构拆解、中文释义与逐行执行，帮助理解代码“由什么组成、为什么这样写、运行时会怎样”。</p>
                <div className="tech-tags">
                  {['React 19', 'TypeScript', 'Vite', 'Monaco Editor', 'Tailwind CSS', 'Zustand', 'Vitest'].map((tag) => (
                    <span key={tag} className="tag">{tag}</span>
                  ))}
                </div>
              </section>
              <section>
                <h3>数据与隐私</h3>
                <ul className="help-list">
                  <li>所有代码分析、语义高亮、伪代码推断、C 子集执行都在浏览器本地完成，CodeLens 没有后端服务器。</li>
                  <li>源码默认不写入 localStorage，只保存主题、颜色、面板与 AI 设置。</li>
                  <li>只有在你主动点击 AI 提问且已配置 API 时，当前代码与问题才会发送到你配置的接口。</li>
                  <li>API Key 仅保存在本机浏览器 localStorage；共享电脑请勿保存。</li>
                </ul>
              </section>
              <section>
                <h3>本地运行</h3>
                <pre className="help-code">{`pnpm install
pnpm dev       # 启动开发服务器
pnpm test      # 运行单元测试
pnpm build     # 生产构建`}</pre>
                <p className="muted">技术文档、架构说明与后续开发计划见项目根目录 README.md、docs/HANDOFF.md 与 docs/ROADMAP.md。</p>
              </section>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <span className="muted">不支持的语法会明确说明，不猜测、不伪造。</span>
          <button className="button primary" onClick={() => setOpen(false)}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
