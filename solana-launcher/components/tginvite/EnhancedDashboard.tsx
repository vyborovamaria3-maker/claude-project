"use client";

import { useState, useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
} from "recharts";
import {
  Users,
  TrendingUp,
  Activity,
  Clock,
  Target,
  Zap,
  ArrowUpRight,
  Minus,
  Download,
  Globe,
  CheckCircle2,
  BarChart3,
  LineChart as LineChartIcon,
  AreaChart as AreaChartIcon,
} from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";

// Mock data for charts
const seededValue = (seed: number, min: number, range: number) => min + ((seed * 37 + 17) % range);
const chartBaseDate = new Date("2026-01-30T00:00:00.000Z");

const generateDailyData = () => {
  const data = [];
  for (let i = 29; i >= 0; i--) {
    const date = new Date(chartBaseDate);
    date.setDate(date.getDate() - i);
    const seed = 30 - i;
    data.push({
      date: date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      invited: seededValue(seed, 50, 200),
      skipped: seededValue(seed + 11, 10, 50),
      failed: seededValue(seed + 23, 5, 20),
      conversion: seededValue(seed + 31, 60, 30),
    });
  }
  return data;
};

const channelPerformance = [
  { name: "@crypto_signals", invited: 450, quality: 92, engagement: 85 },
  { name: "@solana_alpha", invited: 380, quality: 88, engagement: 91 },
  { name: "@defi_gems", invited: 320, quality: 78, engagement: 72 },
  { name: "@nft_traders", invited: 280, quality: 82, engagement: 78 },
  { name: "@web3_alpha", invited: 240, quality: 85, engagement: 80 },
];

const userFlowData = [
  { name: "Total Scanned", value: 15000, fill: "#6366f1" },
  { name: "Quality Users", value: 8500, fill: "#22c55e" },
  { name: "Invited", value: 4200, fill: "#3b82f6" },
  { name: "Joined", value: 3100, fill: "#10b981" },
  { name: "Active", value: 2400, fill: "#f59e0b" },
];

const hourlyActivity = Array.from({ length: 24 }, (_, i) => ({
  hour: `${i}:00`,
  users: seededValue(i + 5, 20, 100),
  messages: seededValue(i + 9, 100, 500),
}));

const languageDistribution = [
  { name: "English", value: 45, color: "#6366f1" },
  { name: "Russian", value: 25, color: "#22c55e" },
  { name: "Chinese", value: 15, color: "#3b82f6" },
  { name: "Turkish", value: 10, color: "#f59e0b" },
  { name: "Other", value: 5, color: "#94a3b8" },
];

const countryDistribution = [
  { name: "USA", value: 3200, fill: "#3b82f6" },
  { name: "Russia", value: 2100, fill: "#ef4444" },
  { name: "UK", value: 1800, fill: "#22c55e" },
  { name: "Germany", value: 1200, fill: "#f59e0b" },
  { name: "Turkey", value: 900, fill: "#8b5cf6" },
  { name: "UAE", value: 700, fill: "#06b6d4" },
];

interface TimeRange {
  label: string;
  value: "day" | "week" | "month" | "all";
}

const timeRanges: TimeRange[] = [
  { label: "24h", value: "day" },
  { label: "7d", value: "week" },
  { label: "30d", value: "month" },
  { label: "All", value: "all" },
];

export default function EnhancedDashboard() {
  const [timeRange, setTimeRange] = useState<"day" | "week" | "month" | "all">("month");
  const [chartType, setChartType] = useState<"area" | "bar" | "line">("area");

  const allDailyData = useMemo(() => generateDailyData(), []);
  const dailyData = useMemo(() => {
    if (timeRange === "day") return allDailyData.slice(-1);
    if (timeRange === "week") return allDailyData.slice(-7);
    if (timeRange === "month") return allDailyData.slice(-30);
    return allDailyData;
  }, [allDailyData, timeRange]);

  const stats = useMemo(
    () => ({
      totalInvited: dailyData.reduce((acc, d) => acc + d.invited, 0),
      totalSkipped: dailyData.reduce((acc, d) => acc + d.skipped, 0),
      totalFailed: dailyData.reduce((acc, d) => acc + d.failed, 0),
      avgConversion: Math.round(dailyData.reduce((acc, d) => acc + d.conversion, 0) / dailyData.length),
      successRate: Math.round(
        (dailyData.reduce((acc, d) => acc + d.invited, 0) /
          (dailyData.reduce((acc, d) => acc + d.invited, 0) +
            dailyData.reduce((acc, d) => acc + d.failed, 0))) *
          100
      ),
    }),
    [dailyData]
  );

  const customTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ color?: string; name?: string; value?: number }>; label?: string }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-bg-card border border-bg-border rounded-lg p-3 shadow-lg">
          <p className="text-sm font-medium mb-2">{label}</p>
          {payload.map((entry, index) => (
            <div key={index} className="flex items-center gap-2 text-sm">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color ?? "#888" }} />
              <span className="text-content-muted capitalize">{entry.name ?? "value"}:</span>
              <span className="font-medium">{entry.value?.toLocaleString() ?? "0"}</span>
            </div>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Analytics Dashboard</h2>
          <p className="text-content-muted text-sm">Track your import performance and user growth</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex bg-bg-elevated rounded-lg p-1">
            {timeRanges.map((range) => (
              <button
                key={range.value}
                onClick={() => setTimeRange(range.value)}
                className={`px-3 py-1.5 text-sm rounded-md transition ${
                  timeRange === range.value
                    ? "bg-[color:var(--theme-primary)] text-white"
                    : "text-content-muted hover:text-content"
                }`}
              >
                {range.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => {
              const data = JSON.stringify(dailyData, null, 2);
              const blob = new Blob([data], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "dashboard-data.json";
              a.click();
              URL.revokeObjectURL(url);
            }}
            className={siteDesign.controls.iconButtonClassName}
          >
            <Download className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        <div className={siteDesign.page.panelClassName}>
          <div className="flex items-center gap-2 text-content-muted text-xs mb-2">
            <Users className="h-4 w-4" />
            <span>Total Invited</span>
          </div>
          <div className="text-2xl font-bold">{stats.totalInvited.toLocaleString()}</div>
          <div className="flex items-center gap-1 text-xs text-green-400 mt-1">
            <ArrowUpRight className="h-3 w-3" />
            <span>+12.5%</span>
          </div>
        </div>

        <div className={siteDesign.page.panelClassName}>
          <div className="flex items-center gap-2 text-content-muted text-xs mb-2">
            <CheckCircle2 className="h-4 w-4 text-green-400" />
            <span>Success Rate</span>
          </div>
          <div className="text-2xl font-bold text-green-400">{stats.successRate}%</div>
          <div className="flex items-center gap-1 text-xs text-green-400 mt-1">
            <ArrowUpRight className="h-3 w-3" />
            <span>+3.2%</span>
          </div>
        </div>

        <div className={siteDesign.page.panelClassName}>
          <div className="flex items-center gap-2 text-content-muted text-xs mb-2">
            <Target className="h-4 w-4 text-blue-400" />
            <span>Conversion</span>
          </div>
          <div className="text-2xl font-bold text-blue-400">{stats.avgConversion}%</div>
          <div className="flex items-center gap-1 text-xs text-yellow-400 mt-1">
            <Minus className="h-3 w-3" />
            <span>0%</span>
          </div>
        </div>

        <div className={siteDesign.page.panelClassName}>
          <div className="flex items-center gap-2 text-content-muted text-xs mb-2">
            <Activity className="h-4 w-4 text-purple-400" />
            <span>Active Users</span>
          </div>
          <div className="text-2xl font-bold text-purple-400">2,400</div>
          <div className="flex items-center gap-1 text-xs text-green-400 mt-1">
            <ArrowUpRight className="h-3 w-3" />
            <span>+8.7%</span>
          </div>
        </div>

        <div className={siteDesign.page.panelClassName}>
          <div className="flex items-center gap-2 text-content-muted text-xs mb-2">
            <Clock className="h-4 w-4 text-yellow-400" />
            <span>Avg Response</span>
          </div>
          <div className="text-2xl font-bold text-yellow-400">1.8s</div>
          <div className="flex items-center gap-1 text-xs text-green-400 mt-1">
            <ArrowUpRight className="h-3 w-3" />
            <span>-0.3s</span>
          </div>
        </div>

        <div className={siteDesign.page.panelClassName}>
          <div className="flex items-center gap-2 text-content-muted text-xs mb-2">
            <Zap className="h-4 w-4 text-cyan-400" />
            <span>Channels</span>
          </div>
          <div className="text-2xl font-bold text-cyan-400">24</div>
          <div className="flex items-center gap-1 text-xs text-green-400 mt-1">
            <ArrowUpRight className="h-3 w-3" />
            <span>+3</span>
          </div>
        </div>
      </div>

      {/* Main Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Invited Users Chart */}
        <div className="lg:col-span-2">
          <div className={siteDesign.page.panelClassName}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-[color:var(--theme-primary)]" />
                Users Invited Over Time
              </h3>
              <div className="flex bg-bg-elevated rounded-lg p-1">
                <button
                  onClick={() => setChartType("area")}
                  className={`p-1.5 rounded ${chartType === "area" ? "bg-[color:var(--theme-primary)] text-white" : "text-content-muted"}`}
                >
                  <AreaChartIcon className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setChartType("bar")}
                  className={`p-1.5 rounded ${chartType === "bar" ? "bg-[color:var(--theme-primary)] text-white" : "text-content-muted"}`}
                >
                  <BarChart3 className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setChartType("line")}
                  className={`p-1.5 rounded ${chartType === "line" ? "bg-[color:var(--theme-primary)] text-white" : "text-content-muted"}`}
                >
                  <LineChartIcon className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                {chartType === "area" ? (
                  <AreaChart data={dailyData}>
                    <defs>
                      <linearGradient id="invitedGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="skippedGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="failedGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="date" stroke="#64748b" tick={{ fontSize: 12 }} />
                    <YAxis stroke="#64748b" tick={{ fontSize: 12 }} />
                    <Tooltip content={customTooltip} />
                    <Area type="monotone" dataKey="invited" stroke="#6366f1" fillOpacity={1} fill="url(#invitedGrad)" />
                    <Area type="monotone" dataKey="skipped" stroke="#f59e0b" fillOpacity={1} fill="url(#skippedGrad)" />
                    <Area type="monotone" dataKey="failed" stroke="#ef4444" fillOpacity={1} fill="url(#failedGrad)" />
                  </AreaChart>
                ) : chartType === "bar" ? (
                  <BarChart data={dailyData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="date" stroke="#64748b" tick={{ fontSize: 12 }} />
                    <YAxis stroke="#64748b" tick={{ fontSize: 12 }} />
                    <Tooltip content={customTooltip} />
                    <Bar dataKey="invited" fill="#6366f1" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="skipped" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="failed" fill="#ef4444" radius={[4, 4, 0, 0]} />
                  </BarChart>
                ) : (
                  <LineChart data={dailyData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="date" stroke="#64748b" tick={{ fontSize: 12 }} />
                    <YAxis stroke="#64748b" tick={{ fontSize: 12 }} />
                    <Tooltip content={customTooltip} />
                    <Line type="monotone" dataKey="invited" stroke="#6366f1" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="skipped" stroke="#f59e0b" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="failed" stroke="#ef4444" strokeWidth={2} dot={false} />
                  </LineChart>
                )}
              </ResponsiveContainer>
            </div>

            <div className="flex items-center justify-center gap-6 mt-4">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 bg-[#6366f1] rounded" />
                <span className="text-sm text-content-muted">Invited</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 bg-[#f59e0b] rounded" />
                <span className="text-sm text-content-muted">Skipped</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 bg-[#ef4444] rounded" />
                <span className="text-sm text-content-muted">Failed</span>
              </div>
            </div>
          </div>
        </div>

        {/* User Flow Funnel */}
        <div>
          <div className={siteDesign.page.panelClassName}>
            <h3 className="font-semibold mb-4 flex items-center gap-2">
              <Target className="h-5 w-5 text-[color:var(--theme-secondary)]" />
              User Flow Funnel
            </h3>
            <div className="space-y-3">
              {userFlowData.map((item, index) => {
                const percentage = (item.value / userFlowData[0].value) * 100;
                const conversionRate = index > 0 ? ((item.value / userFlowData[index - 1].value) * 100).toFixed(1) : "100";

                return (
                  <div key={item.name}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm text-content-muted">{item.name}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{item.value.toLocaleString()}</span>
                        {index > 0 && (
                          <span className="text-xs text-content-muted">({conversionRate}%)</span>
                        )}
                      </div>
                    </div>
                    <div className="h-8 bg-bg-elevated rounded-lg overflow-hidden relative">
                      <div
                        className="h-full rounded-lg transition-all duration-500"
                        style={{
                          width: `${percentage}%`,
                          backgroundColor: item.fill,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Secondary Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Channel Performance */}
        <div className={siteDesign.page.panelClassName}>
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <Globe className="h-5 w-5 text-[color:var(--theme-tertiary)]" />
            Top Channels
          </h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={channelPerformance} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis type="number" stroke="#64748b" tick={{ fontSize: 12 }} />
                <YAxis dataKey="name" type="category" stroke="#64748b" tick={{ fontSize: 10 }} width={100} />
                <Tooltip content={customTooltip} />
                <Bar dataKey="invited" fill="#6366f1" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Hourly Activity */}
        <div className={siteDesign.page.panelClassName}>
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <Clock className="h-5 w-5 text-yellow-400" />
            Peak Hours
          </h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={hourlyActivity}>
                <defs>
                  <linearGradient id="hourlyGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="hour" stroke="#64748b" tick={{ fontSize: 10 }} />
                <YAxis stroke="#64748b" tick={{ fontSize: 12 }} />
                <Tooltip content={customTooltip} />
                <Area type="monotone" dataKey="users" stroke="#f59e0b" fillOpacity={1} fill="url(#hourlyGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Language Distribution */}
        <div className={siteDesign.page.panelClassName}>
          <h3 className="font-semibold mb-4 flex items-center gap-2">
            <Globe className="h-5 w-5 text-blue-400" />
            Languages
          </h3>
          <div className="h-64 flex items-center justify-center">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={languageDistribution}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {languageDistribution.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-wrap gap-2 justify-center mt-2">
            {languageDistribution.map((lang) => (
              <div key={lang.name} className="flex items-center gap-1 text-xs">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: lang.color }} />
                <span className="text-content-muted">{lang.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Country Distribution */}
      <div className={siteDesign.page.panelClassName}>
        <h3 className="font-semibold mb-4 flex items-center gap-2">
          <Globe className="h-5 w-5 text-green-400" />
          Country Distribution
        </h3>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={countryDistribution}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="name" stroke="#64748b" tick={{ fontSize: 12 }} />
              <YAxis stroke="#64748b" tick={{ fontSize: 12 }} />
              <Tooltip content={customTooltip} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {countryDistribution.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.fill} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
