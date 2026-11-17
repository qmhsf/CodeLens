/**
 * AI 解释服务接口
 * ------------------------------------------------------------------
 * Phase 3 的 AI 能力通过统一接口接入，默认不启用、不发送任何代码。
 * - 支持 OpenAI 兼容的 /chat/completions 接口（可替换 baseUrl / model）；
 * - 未配置 API 时，界面会明确提示，并使用本地规则解释作为替代；
 * - 用户主动点击「AI 解释 / 提问」才会把代码片段发送到所配置的服务；
 * - API Key 保存在浏览器 localStorage，仅当前用户可见（注意共享电脑风险）。
 *
 * 不做任何伪造：请求失败、未配置、CORS 限制都会原样反馈给用户。
 */
import type { AnalysisResult } from '../core/analysisTypes';
import type { Explanation, ExplainLevel } from '../core/explain/types';

export interface AISettings {
  enabled: boolean;
  /** OpenAI 兼容接口地址，例如 https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 温度，默认 0.4 */
  temperature: number;
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  enabled: false,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.4,
};

export interface AIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const SYSTEM_PROMPT = `你是 CodeLens 的教学助手，面向编程初学者。
回答要求：
1. 用简体中文回答，解释清楚、循序渐进，避免堆砌术语；必要时使用生活化类比。
2. 只根据提供的代码和上下文回答；不确定时明确说明不确定，绝不编造代码行为或执行结果。
3. 解释代码时区分「代码本身」与「你的推断」。
4. 回答尽量简短，每次聚焦一个知识点；如果需要展开，先给出结论再补充细节。`;

/** 构造发送给 AI 的上下文（只包含当前代码与选中片段，不包含无关信息） */
export function buildAIContext(
  analysis: AnalysisResult,
  explanation: Explanation | null,
  level: ExplainLevel,
): AIChatMessage {
  const levelLabel = level === 'beginner' ? '初级（零基础，多用类比）' : level === 'intermediate' ? '中级（理解语法与执行流程）' : '高级（理解内存与底层原理）';
  const selected = explanation
    ? `\n用户当前选中的代码片段：\n\`\`\`\n${explanation.snippet}\n\`\`\`\n代码类型：${explanation.title}\n`
    : '';
  const code = analysis.source.length > 8000 ? `${analysis.source.slice(0, 8000)}\n/* ...（代码过长已截断）... */` : analysis.source;
  return {
    role: 'system',
    content: `${SYSTEM_PROMPT}\n\n当前分析语言：${analysis.languageLabel}\n解释深度偏好：${levelLabel}\n\n完整代码：\n\`\`\`\n${code}\n\`\`\`\n${selected}`,
  };
}

/**
 * 调用 OpenAI 兼容接口。
 * @throws Error 带有面向用户的中文错误说明
 */
export async function chatWithAI(
  settings: AISettings,
  messages: AIChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  if (!settings.enabled) {
    throw new Error('AI 功能未启用。请在「AI 设置」中启用并填写接口信息。');
  }
  if (!settings.apiKey.trim()) {
    throw new Error('缺少 API Key。CodeLens 不会内置或伪造任何 AI 密钥，请自行填写。');
  }
  if (!settings.model.trim()) {
    throw new Error('缺少模型名称，请在 AI 设置中填写，例如 gpt-4o-mini。');
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(settings.baseUrl);
  } catch {
    throw new Error('接口地址格式不正确，请填写完整 URL，例如 https://api.openai.com/v1。');
  }
  if (!/^https?:$/.test(baseUrl.protocol)) {
    throw new Error('接口地址必须以 http:// 或 https:// 开头。');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  const abortFromOuter = () => controller.abort();
  signal?.addEventListener('abort', abortFromOuter);

  try {
    const endpoint = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: settings.temperature,
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const detail = text.slice(0, 300);
      throw new Error(`AI 服务返回错误（HTTP ${response.status}）。${detail ? `服务端信息：${detail}` : ''}`);
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    if (data.error?.message) {
      throw new Error(`AI 服务返回错误：${data.error.message}`);
    }
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('AI 服务返回了空内容。可能是模型名称不正确或服务端限制了响应。');
    }
    return content;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('AI 请求超时（45 秒）或已被取消。请检查网络后重试。');
    }
    if (error instanceof TypeError) {
      throw new Error(
        '无法连接 AI 服务。请检查网络、接口地址与 API Key；如果浏览器控制台提示 CORS，请改用支持浏览器跨域的代理地址。',
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromOuter);
  }
}

/**
 * 本地规则解释（不调用网络）。
 * 当 AI 未配置时作为兜底：明确标注为「本地规则解释」，绝不冒充 AI。
 */
export function buildLocalAnswer(explanation: Explanation | null, question: string): string {
  const lines: string[] = ['【本地规则解释 · 非 AI】'];
  if (!explanation) {
    lines.push('请先在代码区点击一段代码。CodeLens 会根据语法树生成本地解释；配置 AI 后还可以针对具体问题继续追问。');
    return lines.join('\n');
  }
  lines.push(`代码类型：${explanation.title}（${explanation.codeType}）`);
  lines.push(`片段：\`${truncate(explanation.snippet, 120)}\``);
  lines.push('');
  lines.push(`整体释义：${explanation.meaning}`);
  if (explanation.purpose) lines.push(`实际用途：${explanation.purpose}`);
  if (explanation.pitfalls.length) lines.push(`初学者重点：${explanation.pitfalls.join(' ')}`);
  if (explanation.advanced) lines.push(`进阶原理：${explanation.advanced}`);
  lines.push('');
  lines.push(`你的问题：${question}`);
  lines.push('当前未配置 AI 服务，因此只能基于本地规则给出上述解释。配置 AI 后可获得针对问题的连续追问能力。');
  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}
