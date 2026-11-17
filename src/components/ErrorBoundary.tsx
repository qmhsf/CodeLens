/**
 * 错误边界：组件渲染异常时显示可读的恢复界面，而不是整页白屏。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 开发时保留错误细节，便于定位
    console.error('[CodeLens] 界面渲染出错：', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fatal-error">
          <h1>CodeLens 遇到了一个界面错误</h1>
          <p>分析引擎本身可能仍在工作；请刷新页面重试。若问题持续，请查看浏览器控制台错误信息。</p>
          <pre>{this.state.error.message}</pre>
          <button className="button primary" onClick={() => window.location.reload()}>
            刷新页面
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
