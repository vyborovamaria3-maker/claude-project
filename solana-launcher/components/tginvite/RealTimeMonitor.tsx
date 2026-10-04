"use client";

import { useState, useEffect } from "react";
import {
  Activity,
  Users,
  Zap,
  Clock,
  RefreshCw,
  Wifi,
  CheckCircle2,
  Pause,
  Play,
  ArrowUpRight,
  ArrowDownRight,
  Radio,
  Signal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";

interface LiveMetric {
  label: string;
  value: number;
  change: number;
  icon: LucideIcon;
  color: string;
}

interface ActivityLog {
  id: string;
  time: string;
  type: "success" | "failed" | "skipped" | "info";
  message: string;
  channel?: string;
}

export default function RealTimeMonitor() {
  const [isLive, setIsLive] = useState(true);
  const [metrics, setMetrics] = useState<LiveMetric[]>([
    { label: "Online Users", value: 1247, change: 5.2, icon: Users, color: "text-green-400" },
    { label: "Invites/min", value: 42, change: 12.8, icon: Zap, color: "text-blue-400" },
    { label: "Success Rate", value: 94, change: 2.1, icon: CheckCircle2, color: "text-purple-400" },
    { label: "Avg Response", value: 1.2, change: -0.3, icon: Clock, color: "text-yellow-400" },
  ]);

  const [logs, setLogs] = useState<ActivityLog[]>([
    { id: "1", time: "12:34:56", type: "success", message: "User @john_doe invited to @channel", channel: "@channel" },
    { id: "2", time: "12:34:55", type: "skipped", message: "User @bot_account skipped (bot detected)" },
    { id: "3", time: "12:34:54", type: "success", message: "User @crypto_trader joined @channel", channel: "@channel" },
    { id: "4", time: "12:34:53", type: "failed", message: "Flood wait: 30 seconds", channel: "@channel" },
    { id: "5", time: "12:34:52", type: "info", message: "Switching to backup account" },
    { id: "6", time: "12:34:51", type: "success", message: "User @web3_user invited to @channel", channel: "@channel" },
    { id: "7", time: "12:34:50", type: "success", message: "User @solana_fan invited to @channel", channel: "@channel" },
    { id: "8", time: "12:34:49", type: "skipped", message: "User @low_quality skipped (quality filter)" },
  ]);

  const [activeAccounts] = useState([
    { id: "1", name: "@admin_main", status: "active", invites: 45, limit: 100 },
    { id: "2", name: "@helper_bot", status: "active", invites: 32, limit: 100 },
    { id: "3", name: "@backup_acc", status: "cooldown", invites: 98, limit: 100 },
  ]);

  const [importProgress, setImportProgress] = useState({
    current: 1247,
    total: 5000,
    percentage: 24.9,
    eta: "~15 min",
  });

  // Simulate live updates
  useEffect(() => {
    if (!isLive) return;

    const interval = setInterval(() => {
      setMetrics((prev) =>
        prev.map((m) => {
          let newValue = m.value;
          if (m.label === "Success Rate") {
            newValue = Math.min(100, Math.max(80, m.value + (Math.random() - 0.5) * 2));
          } else if (m.label === "Avg Response") {
            newValue = Math.max(0.5, m.value + (Math.random() - 0.5) * 0.2);
          } else {
            newValue = Math.max(0, m.value + (Math.random() > 0.5 ? 1 : -1) * Math.floor(Math.random() * 5));
          }
          const change = m.value > 0 ? ((newValue - m.value) / m.value) * 100 : 0;
          return { ...m, value: newValue, change };
        })
      );

      setImportProgress((prev) => {
        const increment = Math.floor(Math.random() * 3);
        const newCurrent = Math.min(prev.current + increment, prev.total);
        return {
          ...prev,
          current: newCurrent,
          percentage: prev.total > 0 ? Math.min((newCurrent / prev.total) * 100, 100) : 0,
        };
      });
    }, 2000);

    return () => clearInterval(interval);
  }, [isLive]);

  const getLogColor = (type: string) => {
    switch (type) {
      case "success":
        return "text-green-400 bg-green-500/10";
      case "failed":
        return "text-red-400 bg-red-500/10";
      case "skipped":
        return "text-yellow-400 bg-yellow-500/10";
      case "info":
        return "text-blue-400 bg-blue-500/10";
      default:
        return "text-content-muted bg-bg-elevated";
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-green-500/20 text-green-400">
            <Radio className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-2xl font-bold">Real-Time Monitor</h2>
            <p className="text-content-muted text-sm">Live import monitoring</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${isLive ? "bg-green-500/20 text-green-400" : "bg-content-muted/20 text-content-muted"}`}>
            <Signal className={`h-3.5 w-3.5 ${isLive ? "animate-pulse" : ""}`} />
            {isLive ? "LIVE" : "PAUSED"}
          </div>
          <button
            onClick={() => setIsLive(!isLive)}
            className={siteDesign.controls.actionButtonClassName}
          >
            {isLive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {isLive ? "Pause" : "Resume"}
          </button>
          <button
            onClick={() => {
              setMetrics((prev) => prev.map((m) => ({ ...m, value: m.value, change: 0 })));
              setImportProgress((prev) => ({ ...prev, current: 0, percentage: 0 }));
            }}
            className={siteDesign.controls.iconButtonClassName}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Live Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div key={metric.label} className={siteDesign.page.panelClassName}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-content-muted text-sm">{metric.label}</span>
                <Icon className={`h-4 w-4 ${metric.color}`} />
              </div>
              <div className="text-2xl font-bold">{typeof metric.value === "number" && metric.value % 1 !== 0 ? metric.value.toFixed(1) : metric.value.toLocaleString()}</div>
              <div className={`flex items-center gap-1 text-xs mt-1 ${metric.change >= 0 ? "text-green-400" : "text-red-400"}`}>
                {metric.change >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                <span>{Math.abs(metric.change).toFixed(1)}%</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Import Progress */}
      <div className={siteDesign.page.panelClassName}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold flex items-center gap-2">
            <Activity className="h-5 w-5 text-[color:var(--theme-primary)]" />
            Import Progress
          </h3>
          <span className="text-sm text-content-muted">ETA: {importProgress.eta}</span>
        </div>
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-content-muted">
              {importProgress.current.toLocaleString()} / {importProgress.total.toLocaleString()} users
            </span>
            <span className="font-medium">{importProgress.percentage.toFixed(1)}%</span>
          </div>
          <div className="h-4 bg-bg-elevated rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-[color:var(--theme-primary)] via-[color:var(--theme-secondary)] to-[color:var(--theme-tertiary)] transition-all duration-500 relative"
              style={{ width: `${importProgress.percentage}%` }}
            >
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Activity Log */}
        <div className={siteDesign.page.panelClassName}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold flex items-center gap-2">
              <Zap className="h-5 w-5 text-yellow-400" />
              Live Activity
            </h3>
            <div className="flex items-center gap-2">
              <span className="text-xs text-content-muted">{logs.length} events</span>
              <button
                onClick={() => setLogs([])}
                className="text-xs text-[color:var(--theme-primary)] hover:underline"
              >
                Clear
              </button>
            </div>
          </div>
          <div className="h-80 overflow-y-auto space-y-2">
            {logs.map((log) => (
              <div
                key={log.id}
                className={`flex items-start gap-3 p-2 rounded-lg ${getLogColor(log.type)}`}
              >
                <span className="text-xs font-mono opacity-70">{log.time}</span>
                <span className="text-sm flex-1">{log.message}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Active Accounts */}
        <div className={siteDesign.page.panelClassName}>
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <Users className="h-5 w-5 text-[color:var(--theme-secondary)]" />
            Active Accounts
          </h3>
          <div className="space-y-3">
            {activeAccounts.map((account) => (
              <div
                key={account.id}
                className={`p-3 bg-bg-elevated rounded-lg border ${
                  account.status === "active" ? "border-green-500/30" : "border-yellow-500/30"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${account.status === "active" ? "bg-green-400" : "bg-yellow-400"}`} />
                    <span className="font-medium">{account.name}</span>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${account.status === "active" ? "bg-green-500/20 text-green-400" : "bg-yellow-500/20 text-yellow-400"}`}>
                    {account.status}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-content-muted">Invites today</span>
                  <span>{account.invites}/{account.limit}</span>
                </div>
                <div className="mt-2 h-1.5 bg-bg-card rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${account.invites / account.limit > 0.9 ? "bg-red-400" : "bg-green-400"}`}
                    style={{ width: `${(account.invites / account.limit) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Connection Status */}
          <div className="mt-4 pt-4 border-t border-bg-border">
            <div className="flex items-center justify-between">
              <span className="text-sm text-content-muted">Telegram Connection</span>
              <div className="flex items-center gap-2 text-green-400">
                <Wifi className="h-4 w-4" />
                <span className="text-sm">Connected</span>
              </div>
            </div>
            <div className="flex items-center justify-between mt-2">
              <span className="text-sm text-content-muted">Last Ping</span>
              <span className="text-sm">12:34:56 (2s ago)</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
