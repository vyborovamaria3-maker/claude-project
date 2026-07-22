"use client";
// data-tag: components.chart.error_boundary
// Error boundary for chart components - prevents crashes from breaking the whole UI

import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ChartErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[ChartErrorBoundary] Chart crashed:", error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: undefined });
  };

  override render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="w-full h-[360px] sm:h-[420px] lg:h-[520px] flex flex-col items-center justify-center gap-4 bg-[#0a0a0f] border border-[#1a1a2e] rounded-xl p-6">
          <div className="w-12 h-12 rounded-full bg-[#ef5350]/10 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-[#ef5350]" />
          </div>
          <div className="text-center">
            <h3 className="text-sm font-semibold text-white mb-1">График временно недоступен</h3>
            <p className="text-xs text-[#d1d4dc]/40 max-w-xs">
              {this.state.error?.message || "Произошла ошибка при загрузке графика"}
            </p>
          </div>
          <button
            onClick={this.handleReset}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#1a1a2e] text-[#d1d4dc] text-xs hover:bg-[#2a2a4a] transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Попробовать снова
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

// Hook version for functional components
export function useChartErrorHandler() {
  const [error, setError] = React.useState<Error | null>(null);

  const handleError = React.useCallback((err: Error) => {
    console.error("[Chart] Error caught:", err);
    setError(err);
  }, []);

  const clearError = React.useCallback(() => {
    setError(null);
  }, []);

  return { error, handleError, clearError };
}
