import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

/** 顶层错误边界：任何渲染异常降级为可重试的错误页，而不是整页白屏 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI crashed:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="boot" style={{ flexDirection: 'column', gap: 16, padding: 24, textAlign: 'center' }}>
          <AlertTriangle size={28} />
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>界面出现异常</h2>
            <p style={{ margin: '8px 0 0', fontSize: 13, opacity: 0.8 }}>{this.state.error.message}</p>
          </div>
          <button
            className="button button-primary"
            onClick={() => { this.setState({ error: undefined }); window.location.reload(); }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <RotateCw size={15} />重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
