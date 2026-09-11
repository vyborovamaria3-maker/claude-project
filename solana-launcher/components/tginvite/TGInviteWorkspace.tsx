"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  Users,
  Upload,
  Settings,
  Play,
  Pause,
  RotateCcw,
  CheckCircle2,
  XCircle,
  Globe,
  FileText,
  Filter,
  Activity,
  Zap,
  Shield,
  Download,
  Trash2,
  Plus,
  Search,
  Calendar,
  BarChart3,
  Eye,
  EyeOff,
  Copy,
  Save,
  FolderOpen,
  Star,
  Target,
  Layers,
  ArrowUpRight,
  Minus,
  Bot,
  Lock,
  Unlock,
  FileJson,
  FileSpreadsheet,
  Brain,
  UserCheck,
  User,
  Webhook,
  Radio,
  FlaskConical,
  Loader2,
  Link,
} from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";
import { ToastProvider, useToast } from "@/components/tginvite/Toast";
import { useApi } from "@/components/tginvite/useApi";
import { storage, channelsStorage, jobsStorage, settingsStorage } from "@/lib/tginvite-storage";
import { parseUsername, StealthDelayer } from "@/lib/tginvite-stealth";
import AIAnalysisPanel from "@/components/tginvite/AIAnalysisPanel";
import MultiAccountPanel from "@/components/tginvite/MultiAccountPanel";
import TemplatesPanel from "@/components/tginvite/TemplatesPanel";
import WebhooksPanel from "@/components/tginvite/WebhooksPanel";
import UserProfilingPanel from "@/components/tginvite/UserProfilingPanel";
import EnhancedDashboard from "@/components/tginvite/EnhancedDashboard";
import RealTimeMonitor from "@/components/tginvite/RealTimeMonitor";
import GoalTracking from "@/components/tginvite/GoalTracking";
import ABTesting from "@/components/tginvite/ABTesting";
import { tgInviteService, ImportJobConfig, ImportProgress } from "@/lib/tginvite-service";
import { tginviteEvents, TGEvent } from "@/lib/tginvite-events";
import TeraGramInviteSource from "@/components/tginvite/TeraGramInviteSource";
import TeraGramScannerControl from "@/components/tginvite/TeraGramScannerControl";
import { TeraGramLiveValidation } from "@/components/tginvite/TeraGramLiveValidation";

interface Channel {
  id: string;
  name: string;
  username: string;
  members: number;
  selected: boolean;
  group?: string;
  activity?: number;
  quality?: number;
  lastImport?: string;
  status?: "active" | "inactive" | "banned";
  type?: string;
  verified?: boolean;
  inviteLink?: string;
  addedAt?: string;
}

interface ChannelGroup {
  id: string;
  name: string;
  color: string;
  channelIds: string[];
}

interface ImportJob {
  id: string;
  targetChannel: string;
  sources: string[];
  status: "pending" | "running" | "paused" | "completed" | "failed";
  progress: number;
  total: number;
  invited: number;
  skipped: number;
  failed: number;
  startTime: string;
  endTime?: string;
  logs: string[];
  inviteLinks: { url: string; used: boolean; username?: string }[];
}

interface ScheduleConfig {
  enabled: boolean;
  interval: "hourly" | "daily" | "weekly" | "custom";
  customCron?: string;
  maxPerDay: number;
  startTime?: string;
  endTime?: string;
  timezone: string;
}

interface Filters {
  minActivity: number;
  maxAge: number;
  minQuality: number;
  limit: number;
  delay: number;
  stealthMode: boolean;
  blacklist: string[];
  whitelist: string[];
  minFollowers: number;
  maxFollowers: number;
  verifiedOnly: boolean;
  hasAvatar: boolean;
  language?: string;
}

interface BotInfo {
  id: number;
  username: string;
  firstName: string;
}

interface AnalyticsData {
  totalInvited: number;
  successRate: number;
  avgResponseTime: number;
  topChannels: { name: string; count: number }[];
  dailyStats: { date: string; invited: number; failed: number; skipped: number }[];
}

type ParserActivityMode = "all" | "active" | "inactive";

interface ParsedMember {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  isBot: boolean;
  isPremium?: boolean;
  isScam?: boolean;
  isFake?: boolean;
  isRestricted?: boolean;
  langCode?: string;
  accessHash?: string;
  lastSeen?: string;
  createdAt?: string;
}

interface ParsedMemberScore {
  userId: number;
  score: number;
  reasons: string[];
  isBot: boolean;
  isActive: boolean;
  riskLevel: "low" | "medium" | "high" | "critical";
}

interface ParserResult {
  channel: string;
  total: number;
  bots: number;
  humans: number;
  active: number;
  inactive: number;
  members: ParsedMember[];
  filtered: ParsedMember[];
  scores: ParsedMemberScore[];
  summary: string[];
  partial?: boolean;
  source?: "participants" | "visible_history";
  warning?: string;
}

interface TGInviteSourceCandidate {
  username: string;
  title?: string;
  n_subscribers?: number;
  relevance_score?: number;
  essence_score?: number;
  parser_priority?: "high" | "medium" | "low" | "skip";
  parser_access_status?: string;
  invite_policy?: string;
  classifications?: string[];
  signals?: {
    unique_solana_mints?: number;
    explicit_call_messages?: number;
    memecoin_messages?: number;
    pumpfun_messages?: number;
    recent_100?: {
      unique_solana_mints?: number;
      explicit_call_messages?: number;
      memecoin_messages?: number;
      pumpfun_messages?: number;
      contract_messages?: number;
    };
  };
}

interface RecentChannelAnalysis {
  channel: string;
  messagesAnalyzed: number;
  signalMessages: number;
  solanaMessages: number;
  memecoinMessages: number;
  callMessages: number;
  contractMessages: number;
  pumpfunMessages: number;
  solanaContracts: string[];
  evmContracts: string[];
  essenceScore: number;
  verdict: "strong" | "medium" | "weak" | "reject";
  reasons: string[];
}

const GROUP_COLORS = [
  "bg-blue-500",
  "bg-green-500",
  "bg-purple-500",
  "bg-yellow-500",
  "bg-red-500",
  "bg-cyan-500",
  "bg-pink-500",
  "bg-orange-500",
];

function formatLastSeen(value?: string): string {
  if (!value) return "hidden";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "hidden";
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

function riskClassName(risk?: ParsedMemberScore["riskLevel"]): string {
  if (risk === "low") return "bg-green-500/15 text-green-400 border-green-500/25";
  if (risk === "medium") return "bg-yellow-500/15 text-yellow-300 border-yellow-500/25";
  if (risk === "high") return "bg-red-500/15 text-red-300 border-red-500/25";
  if (risk === "critical") return "bg-red-500/25 text-red-200 border-red-500/35";
  return "bg-content-muted/15 text-content-muted border-bg-border";
}

export default function TGInvitePage() {
  return (
    <ToastProvider>
      <TGInvitePageInner />
    </ToastProvider>
  );
}

function TGInvitePageInner() {
  const { success, error: toastError, warning, info } = useToast();
  const { call } = useApi();
  const [activeTab, setActiveTab] = useState<"dashboard" | "data" | "parser" | "import" | "channels" | "schedule" | "analytics" | "settings" | "ai" | "users" | "goals" | "abtest" | "templates" | "accounts" | "webhooks" | "monitor">("dashboard");
  const [channels, setChannels] = useState<Channel[]>(() => channelsStorage.getAll().map(ch => ({ ...ch, selected: ch.selected ?? false })));
  const [channelGroups, setChannelGroups] = useState<ChannelGroup[]>(() =>
    storage.get<ChannelGroup[]>("channelGroups", [])
  );
  const [sourceInput, setSourceInput] = useState("");
  const [currentJob, setCurrentJob] = useState<ImportJob | null>(null);
  const [filters, setFilters] = useState<Filters>(() => {
    const saved = settingsStorage.get();
    return {
      minActivity: saved.filterMinActivity ?? 0.3,
      maxAge: saved.filterMaxAge ?? 30,
      minQuality: saved.filterMinQuality ?? 0.5,
      limit: saved.filterLimit ?? 1000,
      delay: saved.delay,
      stealthMode: saved.stealthMode,
      blacklist: saved.filterBlacklist ?? [],
      whitelist: saved.filterWhitelist ?? [],
      minFollowers: saved.filterMinFollowers ?? 0,
      maxFollowers: saved.filterMaxFollowers ?? 1000000,
      verifiedOnly: saved.filterVerifiedOnly ?? false,
      hasAvatar: saved.filterHasAvatar ?? true,
    };
  });
  const [schedule, setSchedule] = useState<ScheduleConfig>(() => {
    const saved = settingsStorage.get();
    return {
      enabled: saved.scheduleEnabled ?? false,
      interval: (saved.scheduleInterval as ScheduleConfig["interval"]) ?? "daily",
      maxPerDay: saved.maxPerDay ?? 100,
      timezone: saved.scheduleTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      startTime: saved.scheduleStartTime,
      endTime: saved.scheduleEndTime,
      customCron: saved.scheduleCustomCron,
    };
  });
  const [isRunning, setIsRunning] = useState(false);
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [showBlacklist, setShowBlacklist] = useState(false);
  const [showWhitelist, setShowWhitelist] = useState(false);
  const [newBlacklistItem, setNewBlacklistItem] = useState("");
  const [newWhitelistItem, setNewWhitelistItem] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [targetChannel, setTargetChannel] = useState(() => settingsStorage.get().targetChannel);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [batchSize, setBatchSize] = useState(() => settingsStorage.get().batchSize || 10);
  const [batchPause, setBatchPause] = useState(() => settingsStorage.get().batchPause || 60);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const isRunningRef = useRef(false);

  // Bot state
  const [botToken, setBotToken] = useState(() => settingsStorage.get().botToken);
  const [botInfo, setBotInfo] = useState<BotInfo | null>(null);
  const [botVerifying, setBotVerifying] = useState(false);
  const [channelVerifying, setChannelVerifying] = useState(false);
  const [parserInput, setParserInput] = useState("");
  const [parserLimit, setParserLimit] = useState(() => filters.limit || 1000);
  const [parserActivityMode, setParserActivityMode] = useState<ParserActivityMode>("active");
  const [parserSearch, setParserSearch] = useState("");
  const [parserLoading, setParserLoading] = useState(false);
  const [parserResult, setParserResult] = useState<ParserResult | null>(null);
  const [recentAnalysis, setRecentAnalysis] = useState<RecentChannelAnalysis | null>(null);
  const [recentAnalysisLoading, setRecentAnalysisLoading] = useState(false);
  const [sourceCandidates, setSourceCandidates] = useState<TGInviteSourceCandidate[]>([]);
  const [sourceCandidatesLoading, setSourceCandidatesLoading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // Persist settings on change
  useEffect(() => {
    settingsStorage.set({
      botToken,
      targetChannel,
      delay: filters.delay,
      batchSize,
      batchPause,
      stealthMode: filters.stealthMode,
      maxPerDay: schedule.maxPerDay,
      minDelay: filters.delay,
      maxDelay: filters.delay * 3,
      scheduleEnabled: schedule.enabled,
      scheduleInterval: schedule.interval,
      scheduleTimezone: schedule.timezone,
      scheduleStartTime: schedule.startTime,
      scheduleEndTime: schedule.endTime,
      scheduleCustomCron: schedule.customCron,
      filterMinActivity: filters.minActivity,
      filterMaxAge: filters.maxAge,
      filterMinQuality: filters.minQuality,
      filterLimit: filters.limit,
      filterMinFollowers: filters.minFollowers,
      filterMaxFollowers: filters.maxFollowers,
      filterVerifiedOnly: filters.verifiedOnly,
      filterHasAvatar: filters.hasAvatar,
      filterBlacklist: filters.blacklist,
      filterWhitelist: filters.whitelist,
    });
  }, [botToken, targetChannel, filters.delay, batchSize, batchPause, filters.stealthMode, schedule.maxPerDay, schedule.enabled, schedule.interval, schedule.timezone, schedule.startTime, schedule.endTime, schedule.customCron, filters.minActivity, filters.maxAge, filters.minQuality, filters.limit, filters.minFollowers, filters.maxFollowers, filters.verifiedOnly, filters.hasAvatar, filters.blacklist, filters.whitelist]);

  // Persist channels on change
  useEffect(() => {
    channelsStorage.set(channels);
  }, [channels]);

  // Persist channel groups on change
  useEffect(() => {
    storage.set("channelGroups", channelGroups);
  }, [channelGroups]);

  // Analytics data
  const analytics: AnalyticsData = useMemo(() => {
    const jobs = jobsStorage.getAll();
    const totalInvited = jobs.reduce((sum, j) => sum + (j.invited || 0), 0);
    const totalFailed = jobs.reduce((sum, j) => sum + (j.failed || 0), 0);
    const total = totalInvited + totalFailed;
    return {
      totalInvited,
      successRate: total > 0 ? Math.round((totalInvited / total) * 100 * 10) / 10 : 94.2,
      avgResponseTime: 2.5,
      topChannels: [...channels]
        .sort((a, b) => (b.members || 0) - (a.members || 0))
        .slice(0, 5)
        .map((ch) => ({ name: ch.name, count: ch.members || 0 })),
      dailyStats: Array.from({ length: 7 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 0, 24 + i)).toLocaleDateString("en-US"),
        invited: 50 + ((i * 37 + 17) % 100),
        failed: 2 + ((i * 11 + 3) % 10),
        skipped: 3 + ((i * 13 + 5) % 15),
      })).reverse(),
    };
  }, [channels]);

  // Filter channels based on search
  const filteredChannels = useMemo(() => {
    return channels.filter(
      (ch) =>
        ch.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        ch.username.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [channels, searchQuery]);

  const parserScoreByUserId = useMemo(() => {
    const map = new Map<number, ParsedMemberScore>();
    parserResult?.scores.forEach((score) => map.set(score.userId, score));
    return map;
  }, [parserResult]);

  const parserVisibleMembers = useMemo(() => {
    if (!parserResult) return [];
    const query = parserSearch.trim().toLowerCase();
    if (!query) return parserResult.members;

    return parserResult.members.filter((member) => {
      const fullName = `${member.firstName || ""} ${member.lastName || ""}`.trim().toLowerCase();
      return (
        String(member.id).includes(query) ||
        (member.username || "").toLowerCase().includes(query) ||
        fullName.includes(query)
      );
    });
  }, [parserResult, parserSearch]);

  // Add channel — verifies via Telegram API if bot token is set
  const addChannel = useCallback(async () => {
    if (!sourceInput.trim()) return;
    const usernames = sourceInput
      .split(/[\n,;]+/)
      .map((u) => parseUsername(u.trim()))
      .filter((u): u is string => !!u && !channels.some((ch) => ch.username === u));

    if (usernames.length === 0) {
      warning("No valid channels", "Enter valid @username or t.me links");
      return;
    }

    if (botToken) {
      // Real verification via API — verify each username
      setChannelVerifying(true);
      try {
        const newChannels: Channel[] = [];
        const errors: string[] = [];

        for (const username of usernames) {
          const result = await call<{ chat?: { id: number; title: string; username?: string; type: string; memberCount?: number }; error?: string }>(
            "/api/tginvite/channels",
            { body: { action: "verify", token: botToken, chatId: username } }
          );

          if (result?.chat) {
            newChannels.push({
              id: result.chat.id.toString(),
              name: result.chat.title,
              username: result.chat.username || username,
              members: result.chat.memberCount || 0,
              selected: true,
              type: result.chat.type,
              verified: true,
              status: "active",
            });
          } else {
            errors.push(`@${username}: ${result?.error || "Not found"}`);
          }
        }

        if (newChannels.length > 0) {
          setChannels((prev) => [...prev, ...newChannels]);
          setSelectedChannels((prev) => {
            const next = new Set(prev);
            newChannels.forEach((ch) => next.add(ch.id));
            return next;
          });
          success("Channels verified", `${newChannels.length} channels added`);
        }
        if (errors.length > 0) {
          toastError("Some verifications failed", errors.join("; "));
        }
        setSourceInput("");
      } catch {
        toastError("API Error", "Failed to verify channels");
      } finally {
        setChannelVerifying(false);
      }
    } else {
      // Fallback: add without verification
      const newChannels: Channel[] = usernames.map((username) => ({
        id: Date.now().toString() + Math.random().toString(36).substring(2, 11),
        name: `@${username}`,
        username,
        members: 0,
        selected: true,
        status: "active" as const,
      }));
      setChannels((prev) => [...prev, ...newChannels]);
      setSelectedChannels((prev) => {
        const next = new Set(prev);
        newChannels.forEach((ch) => next.add(ch.id));
        return next;
      });
      setSourceInput("");
      info("Channels added", `${newChannels.length} channels added (no bot token — unverified)`);
    }
  }, [sourceInput, channels, botToken, call, success, toastError, warning, info]);

  // Remove channel
  const removeChannel = useCallback((id: string) => {
    setChannels((prev) => prev.filter((ch) => ch.id !== id));
    setSelectedChannels((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Toggle channel selection
  const toggleChannel = useCallback((id: string) => {
    setSelectedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Select all channels
  const selectAllChannels = useCallback(() => {
    const allFilteredSelected = filteredChannels.every((ch) => selectedChannels.has(ch.id));
    if (allFilteredSelected) {
      setSelectedChannels((prev) => {
        const next = new Set(prev);
        filteredChannels.forEach((ch) => next.delete(ch.id));
        return next;
      });
    } else {
      setSelectedChannels((prev) => {
        const next = new Set(prev);
        filteredChannels.forEach((ch) => next.add(ch.id));
        return next;
      });
    }
  }, [filteredChannels, selectedChannels]);

  // Handle file import
  const handleFileImport = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        let usernames: string[] = [];

        if (file.name.endsWith(".json")) {
          try {
            const data = JSON.parse(content);
            usernames = Array.isArray(data) ? data : data.channels || [];
          } catch {
            return;
          }
        } else if (file.name.endsWith(".csv")) {
          const lines = content.split("\n");
          usernames = lines
            .slice(1)
            .map((line) => line.split(",")[0]?.trim())
            .filter(Boolean);
        } else {
          usernames = content.split("\n").filter((line) => line.trim());
        }

        const newChannels: Channel[] = usernames
          .map((u) => u.replace(/@/g, "").replace(/https?:\/\/t\.me\//g, "").trim())
          .filter((username) => username && !channels.some((ch) => ch.username === username))
          .map((username) => ({
            id: Date.now().toString() + Math.random().toString(36).substring(2, 11),
            name: `@${username}`,
            username,
            members: 0,
            selected: true,
            activity: Math.random(),
            quality: Math.random(),
            status: "active" as const,
          }));

        setChannels((prev) => [...prev, ...newChannels]);
        setSelectedChannels((prev) => {
          const next = new Set(prev);
          newChannels.forEach((ch) => next.add(ch.id));
          return next;
        });
      };
      reader.readAsText(file);
      event.target.value = "";
    },
    [channels]
  );

  // Export channels
  const exportChannels = useCallback(
    (format: "json" | "csv" | "txt") => {
      const selected = channels.filter((ch) => selectedChannels.has(ch.id));
      const dataToExport = selected.length > 0 ? selected : channels;

      let content: string;
      let filename: string;
      let mimeType: string;

      if (format === "json") {
        content = JSON.stringify(dataToExport, null, 2);
        filename = `channels_${Date.now()}.json`;
        mimeType = "application/json";
      } else if (format === "csv") {
        const escapeCsv = (v: string | number | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const headers = "name,username,members,activity,quality,status\n";
        const rows = dataToExport
          .map((ch) => [escapeCsv(ch.name), escapeCsv(ch.username), ch.members ?? 0, ch.activity ?? "", ch.quality ?? "", ch.status ?? ""].join(","))
          .join("\n");
        content = headers + rows;
        filename = `channels_${Date.now()}.csv`;
        mimeType = "text/csv";
      } else {
        content = dataToExport.map((ch) => ch.username).join("\n");
        filename = `channels_${Date.now()}.txt`;
        mimeType = "text/plain";
      }

      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);

      setShowExportMenu(false);
    },
    [channels, selectedChannels]
  );

  const parseMembers = useCallback(async () => {
    if (!parserInput.trim()) {
      warning("No channel", "Paste a Telegram link or channel username");
      return;
    }

    setParserLoading(true);
    try {
      const response = await fetch("/api/tginvite/mtproto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "fetchMembers",
          channelUsername: parserInput.trim(),
          limit: parserLimit,
          activityMode: parserActivityMode,
          filterConfig: {
            removeBots: true,
            removeScam: true,
            removeFake: true,
            removeRestricted: true,
            minActivityScore: filters.minActivity,
            maxAccountAgeDays: filters.maxAge,
            minLastSeenDays: parserActivityMode === "inactive" ? 0 : 30,
            requireAvatar: filters.hasAvatar,
            requireUsername: false,
            blacklistUsernames: filters.blacklist.map((item) => item.toLowerCase()),
            whitelistUsernames: filters.whitelist.map((item) => item.toLowerCase()),
            maxResults: parserLimit,
          },
        }),
      });
      const result = (await response.json()) as (ParserResult & { error?: string; status?: string });

      if (!response.ok) {
        if (result.status === "session_expired") {
          settingsStorage.set({ ...settingsStorage.get(), mtprotoSession: "" });
          setActiveTab("settings");
          toastError("MTProto session expired", result.error || "Reconnect your Telegram account");
        } else if (result.status === "not_connected" || result.status === "login_not_started") {
          setActiveTab("settings");
          toastError("MTProto not connected", result.error || "Connect your Telegram account first");
        } else {
          toastError("Parser failed", result.error || `HTTP ${response.status}`);
        }
        return;
      }

      if (result) {
        setParserResult(result);
        setParserSearch("");
        if (result.partial) {
          warning("Partial parser result", result.warning || `${result.members.length.toLocaleString()} visible users found`);
        } else {
          success("Members parsed", `${result.members.length.toLocaleString()} shown from ${result.total.toLocaleString()} found`);
        }
      }
    } catch (err: unknown) {
      const error = err as { message?: string };
      toastError("Parser failed", error.message || "Request failed");
    } finally {
      setParserLoading(false);
    }
  }, [filters.blacklist, filters.hasAvatar, filters.maxAge, filters.minActivity, filters.whitelist, parserActivityMode, parserInput, parserLimit, success, toastError, warning]);

  const loadSourceCandidates = useCallback(async () => {
    setSourceCandidatesLoading(true);
    try {
      const response = await fetch("/api/tginvite/source-candidates");
      const result = (await response.json()) as { candidates?: TGInviteSourceCandidate[]; error?: string };
      if (!response.ok) {
        toastError("Sources not ready", result.error || "Build TGDataset candidates first");
        return;
      }
      const candidates = result.candidates || [];
      setSourceCandidates(candidates);
      success("Sources loaded", `${candidates.length.toLocaleString()} Solana meme candidates`);
    } catch {
      toastError("Sources failed", "Could not load TGDataset candidates");
    } finally {
      setSourceCandidatesLoading(false);
    }
  }, [success, toastError]);

  const analyzeRecentMessages = useCallback(async () => {
    if (!parserInput.trim()) {
      warning("No channel", "Paste a Telegram link or channel username");
      return;
    }

    setRecentAnalysisLoading(true);
    try {
      const response = await fetch("/api/tginvite/mtproto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "analyzeRecentMessages",
          channelUsername: parserInput.trim(),
        }),
      });
      const result = (await response.json()) as { analysis?: RecentChannelAnalysis; error?: string; status?: string };
      if (!response.ok || !result.analysis) {
        if (result.status === "not_connected" || result.status === "login_not_started" || result.status === "session_expired") {
          setActiveTab("settings");
        }
        toastError("Analysis failed", result.error || "Could not analyze last 100 messages");
        return;
      }
      setRecentAnalysis(result.analysis);
      const tone = result.analysis.verdict === "strong" || result.analysis.verdict === "medium" ? success : warning;
      tone("Recent 100 analyzed", `${result.analysis.verdict}: ${result.analysis.essenceScore.toFixed(1)} essence score`);
    } catch {
      toastError("Analysis failed", "Could not analyze last 100 messages");
    } finally {
      setRecentAnalysisLoading(false);
    }
  }, [parserInput, success, toastError, warning]);

  const addSourceCandidate = useCallback((candidate: TGInviteSourceCandidate) => {
    const username = candidate.username?.replace(/^@/, "").trim();
    if (!username) return;
    if (channels.some((channel) => channel.username.toLowerCase() === username.toLowerCase())) {
      warning("Already added", `@${username} is already in Source Channels`);
      return;
    }

    const newChannel: Channel = {
      id: Date.now().toString(),
      name: candidate.title || `@${username}`,
      username,
      members: candidate.n_subscribers || 0,
      selected: true,
      activity: Math.min(1, (candidate.relevance_score || 0) / 100),
      quality: Math.min(1, (candidate.essence_score || candidate.relevance_score || 0) / 100),
      status: "active",
      type: "solana_memecoin_candidate",
      addedAt: new Date().toISOString(),
    };
    const updated = [...channels, newChannel];
    setChannels(updated);
    channelsStorage.set(updated);
    success("Source added", `@${username} added to TGInvite sources`);
  }, [channels, success, warning]);

  const importTeraGramSources = useCallback(
    async (usernames: string[]) => {
      const normalized = Array.from(
        new Set(
          usernames
            .map((value) => parseUsername(value) || value.replace(/^@/, "").trim())
            .filter(Boolean)
            .map((value) => value.toLowerCase())
        )
      );

      if (normalized.length === 0) {
        warning("No TeraGram sources", "TeraGram did not return valid source channels");
        return;
      }

      const added: Channel[] = [];

      setChannels((prev) => {
        const existing = new Set(
          prev.map((channel) => channel.username.replace(/^@/, "").trim().toLowerCase())
        );

        const fresh = normalized
          .filter((username) => !existing.has(username))
          .map((username, index): Channel => {
            const channel = {
              id: `teragram-${Date.now()}-${index}`,
              name: `@${username}`,
              username,
              members: 0,
              selected: true,
              status: "active",
              type: "teragram_candidate",
              addedAt: new Date().toISOString(),
            } satisfies Channel;

            added.push(channel);
            return channel;
          });

        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });

      if (added.length > 0) {
        setSelectedChannels((prev) => {
          const next = new Set(prev);
          added.forEach((channel) => next.add(channel.id));
          return next;
        });

        success(
          "TeraGram sources added",
          `${added.length.toLocaleString()} source channels added to TG Invite`
        );
      } else {
        info("TeraGram sources", "All returned source channels are already in TG Invite");
      }
    },
    [info, success, warning]
  );

  const exportParsedMembers = useCallback((format: "json" | "csv") => {
    if (!parserResult) return;
    const members = parserVisibleMembers;
    const filename = `tginvite-members-${parserResult.channel.replace(/[^a-z0-9_-]+/gi, "-")}-${Date.now()}.${format}`;
    const content =
      format === "json"
        ? JSON.stringify(members, null, 2)
        : [
            "id,username,firstName,lastName,lastSeen,isBot,isPremium,activityScore,riskLevel",
            ...members.map((member) => {
              const score = parserScoreByUserId.get(member.id);
              const values = [
                member.id,
                member.username || "",
                member.firstName || "",
                member.lastName || "",
                member.lastSeen || "",
                member.isBot ? "true" : "false",
                member.isPremium ? "true" : "false",
                score ? Math.round(score.score * 100) : "",
                score?.riskLevel || "",
              ];
              return values.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",");
            }),
          ].join("\n");

    const blob = new Blob([content], { type: format === "json" ? "application/json" : "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, [parserResult, parserScoreByUserId, parserVisibleMembers]);

  const addParsedChannelToSources = useCallback(() => {
    if (!parserResult) return;
    const username = parseUsername(parserResult.channel) || parserResult.channel.replace(/^@/, "");
    if (!username || channels.some((channel) => channel.username === username)) {
      warning("Already added", "This channel is already in Source Channels");
      return;
    }

    const channel: Channel = {
      id: `parsed-${Date.now()}`,
      name: username.startsWith("http") ? username : `@${username}`,
      username,
      members: parserResult.total,
      selected: true,
      activity: parserResult.total > 0 ? parserResult.active / parserResult.total : 0,
      quality: parserResult.total > 0 ? parserResult.humans / parserResult.total : 0,
      status: parserResult.active > 0 ? "active" : "inactive",
      verified: true,
    };

    setChannels((prev) => [...prev, channel]);
    setSelectedChannels((prev) => {
      const next = new Set(prev);
      next.add(channel.id);
      return next;
    });
    success("Source added", `${channel.name} added to Source Channels`);
  }, [channels, parserResult, success, warning]);

  // Create channel group
  const createGroup = useCallback(() => {
    if (!newGroupName.trim()) return;

    const newGroup: ChannelGroup = {
      id: Date.now().toString(),
      name: newGroupName,
      color: GROUP_COLORS[channelGroups.length % GROUP_COLORS.length],
      channelIds: Array.from(selectedChannels),
    };

    setChannelGroups((prev) => [...prev, newGroup]);
    setNewGroupName("");
  }, [newGroupName, selectedChannels, channelGroups]);

  // Add to blacklist
  const addBlacklistItem = useCallback(() => {
    if (!newBlacklistItem.trim()) return;
    setFilters((prev) => ({
      ...prev,
      blacklist: [...prev.blacklist, newBlacklistItem.trim()],
    }));
    setNewBlacklistItem("");
  }, [newBlacklistItem]);

  // Add to whitelist
  const addWhitelistItem = useCallback(() => {
    if (!newWhitelistItem.trim()) return;
    setFilters((prev) => ({
      ...prev,
      whitelist: [...prev.whitelist, newWhitelistItem.trim()],
    }));
    setNewWhitelistItem("");
  }, [newWhitelistItem]);

  // Refs for import simulation
  const importChannelsRef = useRef<Channel[]>([]);
  const importIndexRef = useRef(0);
  const importDelayerRef = useRef<StealthDelayer | null>(null);
  const importJobIdRef = useRef("");

  // Start import — generates real invite links via Telegram API
  const startImport = useCallback(async () => {
    const selected = channels.filter((ch) => selectedChannels.has(ch.id));
    if (selected.length === 0) {
      warning("No channels selected", "Select at least one source channel");
      return;
    }
    if (!targetChannel) {
      warning("No target channel", "Enter a target channel username");
      return;
    }

    const importConfig: ImportJobConfig = {
      targetChannel,
      sources: selected.map((ch) => ch.username),
      botToken: botToken || undefined,
      batchSize,
      batchPause,
      minDelay: filters.delay,
      maxDelay: filters.delay * 3,
      filters: {
        removeBots: true,
        removeScam: true,
        removeFake: true,
        removeRestricted: true,
        minActivityScore: filters.minActivity,
        maxAccountAgeDays: filters.maxAge,
        minLastSeenDays: 30,
        requireAvatar: filters.hasAvatar,
        requireUsername: false,
        blacklistUsernames: filters.blacklist,
        whitelistUsernames: filters.whitelist,
        maxResults: filters.limit,
      },
    };

    // Preview the import
    const preview = tgInviteService.previewImport(importConfig);
    info(
      "Import Preview",
      `Estimated time: ${preview.estimatedTime}, ~${preview.estimatedInvited} invites, ~${preview.estimatedFailed} failures`
    );

    // Start the import
    const jobId = tgInviteService.startImport(importConfig);
    importJobIdRef.current = jobId;

    setCurrentJob({
      id: jobId,
      targetChannel,
      sources: selected.map((ch) => ch.username),
      status: "running",
      progress: 0,
      total: selected.length,
      invited: 0,
      skipped: 0,
      failed: 0,
      startTime: new Date().toISOString(),
      logs: [],
      inviteLinks: [],
    });
    setIsRunning(true);
    isRunningRef.current = true;
  }, [channels, selectedChannels, targetChannel, botToken, filters.delay, batchSize, batchPause, filters.minActivity, filters.maxAge, filters.hasAvatar, filters.blacklist, filters.whitelist, filters.limit, warning, info]);

  // Pause import
  const pauseImport = useCallback(() => {
    if (importJobIdRef.current) {
      tgInviteService.pauseImport(importJobIdRef.current);
    }
    isRunningRef.current = false;
    if (intervalRef.current) {
      clearTimeout(intervalRef.current);
      intervalRef.current = null;
    }
    setIsRunning(false);
    setCurrentJob((prev) => {
      if (prev) {
        jobsStorage.update(prev.id, { status: "paused" });
        return { ...prev, status: "paused" };
      }
      return null;
    });
  }, []);

  // Resume import
  const resumeImport = useCallback(async () => {
    if (intervalRef.current) {
      clearTimeout(intervalRef.current);
      intervalRef.current = null;
    }

    if (importJobIdRef.current) {
      tgInviteService.resumeImport(importJobIdRef.current);
    }

    isRunningRef.current = true;
    setIsRunning(true);
    setCurrentJob((prev) => {
      if (prev) {
        jobsStorage.update(prev.id, { status: "running" });
        return { ...prev, status: "running" };
      }
      return null;
    });
  }, []);

  // Reset import
  const resetImport = useCallback(() => {
    if (importJobIdRef.current) {
      tgInviteService.cancelImport(importJobIdRef.current);
    }
    isRunningRef.current = false;
    if (intervalRef.current) {
      clearTimeout(intervalRef.current);
      intervalRef.current = null;
    }
    importChannelsRef.current = [];
    importIndexRef.current = 0;
    importDelayerRef.current = null;
    importJobIdRef.current = "";
    setCurrentJob(null);
    setIsRunning(false);
  }, []);

  // Event listeners for TgInviteService
  useEffect(() => {
    const unsubProgress = tginviteEvents.on<{ jobId: string; progress: ImportProgress }>(
      TGEvent.IMPORT_PROGRESS,
      ({ jobId, progress }) => {
        setCurrentJob((prev) => {
          if (prev && prev.id === jobId) {
            return {
              ...prev,
              progress: progress.progress,
              invited: progress.invited,
              skipped: progress.skipped,
              failed: progress.failed,
            };
          }
          return prev;
        });
      }
    );

    const unsubComplete = tginviteEvents.on<{ jobId: string; progress: ImportProgress }>(
      TGEvent.IMPORT_COMPLETE,
      ({ jobId, progress }) => {
        setCurrentJob((prev) => {
          if (prev && prev.id === jobId) {
            return {
              ...prev,
              status: "completed",
              progress: 100,
              invited: progress.invited,
              skipped: progress.skipped,
              failed: progress.failed,
              endTime: new Date().toISOString(),
            };
          }
          return prev;
        });
        setIsRunning(false);
        isRunningRef.current = false;
        success("Import completed", `${progress.invited + progress.skipped + progress.failed} channels processed`);
      }
    );

    const unsubError = tginviteEvents.on<{ jobId: string; error: string }>(
      TGEvent.IMPORT_ERROR,
      ({ jobId, error }) => {
        setCurrentJob((prev) => {
          if (prev && prev.id === jobId) {
            return { ...prev, status: "failed", endTime: new Date().toISOString() };
          }
          return prev;
        });
        setIsRunning(false);
        isRunningRef.current = false;
        toastError("Import failed", error);
      }
    );

    const unsubFlood = tginviteEvents.on<{ jobId: string; retryIn: number }>(
      TGEvent.FLOOD_WAIT,
      ({ retryIn }) => {
        warning("Rate limited", `Retrying in ${Math.ceil(retryIn / 1000)}s...`);
      }
    );

    return () => {
      unsubProgress();
      unsubComplete();
      unsubError();
      unsubFlood();
    };
  }, [success, toastError, warning]);

  // Resume on reload — restore last running/paused job
  useEffect(() => {
    const jobs = jobsStorage.getAll();
    const lastActive = jobs.find((j) => j.status === "running" || j.status === "paused");
    if (lastActive && lastActive.progress < 100) {
      setCurrentJob({
        id: lastActive.id,
        targetChannel: lastActive.targetChannel,
        sources: lastActive.sources,
        status: lastActive.status,
        progress: lastActive.progress,
        total: lastActive.total,
        invited: lastActive.invited,
        skipped: lastActive.skipped,
        failed: lastActive.failed,
        startTime: lastActive.startTime,
        logs: lastActive.logs,
        inviteLinks: lastActive.inviteLinks,
      });
      importJobIdRef.current = lastActive.id;
      if (lastActive.status === "running") {
        setIsRunning(true);
        isRunningRef.current = true;
        tgInviteService.resumeImport(lastActive.id);
      }
    }
  }, []);

  // Copy channel username
  const copyUsername = useCallback((username: string) => {
    navigator.clipboard.writeText(`@${username}`);
  }, []);

  const verifyTargetChannel = useCallback(async () => {
    if (!botToken || !targetChannel) {
      warning("Missing info", "Enter bot token and target channel");
      return;
    }
    setChannelVerifying(true);
    try {
      const result = await call<{ chat?: { id: number; title: string; memberCount?: number }; error?: string }>(
        "/api/tginvite/channels",
        { body: { action: "verify", token: botToken, chatId: targetChannel } }
      );
      if (result?.chat) {
        success("Target verified", `${result.chat.title} (${result.chat.memberCount?.toLocaleString() || 0} members)`);
      } else {
        toastError("Verification failed", result?.error || "Channel not found");
      }
    } catch {
      toastError("API Error", "Failed to verify channel");
    } finally {
      setChannelVerifying(false);
    }
  }, [botToken, targetChannel, call, success, toastError, warning]);

  // Click outside to close export menu
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setShowExportMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Cleanup interval on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearTimeout(intervalRef.current);
      }
    };
  }, []);

  return (
    <div className={siteDesign.page.containerClassName}>
      {/* Hero Header */}
      <div className={siteDesign.page.heroClassName}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-[color:var(--theme-tertiary)] to-[color:var(--theme-secondary)] text-white shadow-lg">
              <Users className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">TGInvite</h1>
              <p className="text-content-muted">Smart member import with anti-detection</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {botInfo ? (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-green-500/20 text-green-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                @{botInfo.username}
              </div>
            ) : (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-content-muted/20 text-content-muted">
                <Bot className="h-3.5 w-3.5" />
                No bot connected
              </div>
            )}
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${schedule.enabled ? "bg-green-500/20 text-green-400" : "bg-content-muted/20 text-content-muted"}`}>
              <div className={`w-2 h-2 rounded-full ${schedule.enabled ? "bg-green-400" : "bg-content-muted"}`} />
              Auto-Invite: {schedule.enabled ? "ON" : "OFF"}
            </div>
            <button
              onClick={() => setSchedule((prev) => ({ ...prev, enabled: !prev.enabled }))}
              className={`${siteDesign.controls.iconButtonClassName} ${schedule.enabled ? "!border-green-500/50 !text-green-400" : ""}`}
            >
              <Zap className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className={siteDesign.tabsShared.listClassName}>
        {(["dashboard", "data", "parser", "analytics", "monitor", "import", "channels", "ai", "users", "goals", "abtest", "schedule", "templates", "accounts", "webhooks", "settings"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`${siteDesign.tabsShared.tabClassName} ${
              activeTab === tab ? siteDesign.tabsShared.activeClassName : siteDesign.tabsShared.inactiveClassName
            }`}
          >
            {tab === "dashboard" && <Activity className="h-3.5 w-3.5" />}
            {tab === "data" && <Layers className="h-3.5 w-3.5" />}
            {tab === "parser" && <Search className="h-3.5 w-3.5" />}
            {tab === "analytics" && <BarChart3 className="h-3.5 w-3.5" />}
            {tab === "monitor" && <Radio className="h-3.5 w-3.5" />}
            {tab === "import" && <Upload className="h-3.5 w-3.5" />}
            {tab === "channels" && <Globe className="h-3.5 w-3.5" />}
            {tab === "ai" && <Brain className="h-3.5 w-3.5" />}
            {tab === "users" && <UserCheck className="h-3.5 w-3.5" />}
            {tab === "goals" && <Target className="h-3.5 w-3.5" />}
            {tab === "abtest" && <FlaskConical className="h-3.5 w-3.5" />}
            {tab === "schedule" && <Calendar className="h-3.5 w-3.5" />}
            {tab === "templates" && <FileText className="h-3.5 w-3.5" />}
            {tab === "accounts" && <User className="h-3.5 w-3.5" />}
            {tab === "webhooks" && <Webhook className="h-3.5 w-3.5" />}
            {tab === "settings" && <Settings className="h-3.5 w-3.5" />}
            <span className="capitalize">
              {tab === "data" ? "Data Set TG" : tab}
            </span>
          </button>
        ))}
      </div>

      {/* Dashboard Tab - EnhancedDashboard */}
      {activeTab === "dashboard" && <EnhancedDashboard />}

      {/* Data Set TG Tab */}
      {activeTab === "data" && (
        <div className="space-y-6">
          <div className={siteDesign.page.panelClassName}>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Layers className="h-5 w-5 text-[color:var(--theme-primary)]" />
                  <h2 className="text-xl font-bold text-content">Data Set TG</h2>
                </div>
                <p className="mt-2 max-w-3xl text-sm text-content-muted">
                  Telegram source intelligence database. Find Solana, memecoin and caller
                  channels, review dataset signals and send selected sources directly into
                  the TG Invite pipeline.
                </p>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-xl border border-bg-border bg-bg-elevated px-3 py-2">
                  <div className="font-semibold text-content">TeraGram</div>
                  <div className="text-content-muted">Dataset</div>
                </div>
                <div className="rounded-xl border border-bg-border bg-bg-elevated px-3 py-2">
                  <div className="font-semibold text-content">DuckDB</div>
                  <div className="text-content-muted">Scanner</div>
                </div>
                <div className="rounded-xl border border-bg-border bg-bg-elevated px-3 py-2">
                  <div className="font-semibold text-content">TG Invite</div>
                  <div className="text-content-muted">Sources</div>
                </div>
              </div>
            </div>
          </div>

          <TeraGramScannerControl />


          <TeraGramInviteSource onImportSources={importTeraGramSources} />

          <TeraGramLiveValidation onAddSources={importTeraGramSources} />

          <div className={siteDesign.page.panelClassName}>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="text-lg font-semibold text-content">Solana Meme Source Candidates</h3>
                <p className="text-sm text-content-muted">Sorted TGDataset matches. Revalidate each source with MTProto before parsing or opt-in campaigns.</p>
              </div>
              <button
                type="button"
                onClick={() => void loadSourceCandidates()}
                disabled={sourceCandidatesLoading}
                className={`${siteDesign.controls.actionButtonClassName} disabled:opacity-50`}
              >
                {sourceCandidatesLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {sourceCandidatesLoading ? "Loading..." : "Load Sources"}
              </button>
            </div>

            {sourceCandidates.length > 0 && (
              <div className="mt-4 overflow-hidden rounded-xl border border-bg-border">
                <div className="max-h-80 divide-y divide-bg-border overflow-y-auto">
                  {sourceCandidates.slice(0, 50).map((candidate) => {
                    const username = candidate.username.replace(/^@/, "");
                    return (
                      <div key={username} className="grid gap-3 bg-bg-elevated p-3 md:grid-cols-[1fr_auto] md:items-center">
                        <button
                          type="button"
                          onClick={() => {
                            setParserInput(`@${username}`);
                            setActiveTab("parser");
                          }}
                          className="min-w-0 text-left"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-content">@{username}</span>
                            <span className="rounded-full border border-green-500/30 px-2 py-0.5 text-xs text-green-300">
                              {candidate.parser_priority || "medium"}
                            </span>
                            <span className="text-xs text-content-muted">
                              essence {Number(candidate.essence_score || 0).toFixed(1)}
                            </span>
                          </div>
                          <div className="mt-1 truncate text-sm text-content-muted">{candidate.title || "Untitled source"}</div>
                          <div className="mt-2 flex flex-wrap gap-3 text-xs text-content-muted">
                            <span>{Number(candidate.n_subscribers || 0).toLocaleString()} subs</span>
                            <span>{candidate.signals?.recent_100?.unique_solana_mints || 0} recent SOL mints</span>
                            <span>{candidate.signals?.recent_100?.explicit_call_messages || 0} recent calls</span>
                            <span>{candidate.signals?.recent_100?.memecoin_messages || 0} recent meme msgs</span>
                          </div>
                        </button>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setParserInput(`@${username}`);
                              setActiveTab("parser");
                            }}
                            className={siteDesign.controls.actionButtonClassName}
                          >
                            <Search className="h-4 w-4" />
                            Parse
                          </button>
                          <button
                            type="button"
                            onClick={() => addSourceCandidate(candidate)}
                            className={siteDesign.controls.primaryActionClassName}
                          >
                            <Plus className="h-4 w-4" />
                            Add
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className={siteDesign.page.panelClassName}>
            <h3 className="text-lg font-semibold text-content">Dataset pipeline</h3>

            <div className="mt-4 grid gap-3 md:grid-cols-4">
              {[
                ["01", "TeraGram", "Telegram dataset"],
                ["02", "Scanner", "Crypto / SOL / meme signals"],
                ["03", "Sources", "Qualified TG channels"],
                ["04", "TG Invite", "Parse & invite workflow"],
              ].map(([step, title, description]) => (
                <div
                  key={step}
                  className="rounded-xl border border-bg-border bg-bg-elevated p-4"
                >
                  <div className="text-xs font-bold text-[color:var(--theme-primary)]">
                    {step}
                  </div>
                  <div className="mt-2 font-semibold text-content">{title}</div>
                  <div className="mt-1 text-xs text-content-muted">{description}</div>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-xl border border-bg-border bg-bg-elevated p-4">
              <div className="flex items-start gap-3">
                <Shield className="mt-0.5 h-5 w-5 text-green-400" />
                <div>
                  <div className="font-semibold text-content">Scanner execution</div>
                  <p className="mt-1 text-sm text-content-muted">
                    Dataset scans run as a backend job. The browser reads scan status and
                    results instead of processing the full Telegram dataset in memory.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === "parser" && (
        <div className="space-y-6">
          <div className={siteDesign.page.panelClassName}>
            <div className="flex flex-col gap-4 xl:flex-row xl:items-end">
              <div className="flex-1">
                <label className="block text-sm text-content-muted mb-2">Channel link or username</label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-muted" />
                  <input
                    type="text"
                    value={parserInput}
                    onChange={(e) => setParserInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !parserLoading) void parseMembers();
                    }}
                    placeholder="@channel, channel_name, https://t.me/channel"
                    className={`${siteDesign.controls.inputClassName} pl-10`}
                  />
                </div>
              </div>
              <div className="w-full xl:w-40">
                <label className="block text-sm text-content-muted mb-2">Limit</label>
                <input
                  type="number"
                  min={1}
                  max={100000}
                  value={parserLimit}
                  onChange={(e) => setParserLimit(Math.max(1, parseInt(e.target.value, 10) || 1000))}
                  className={siteDesign.controls.inputClassName}
                />
              </div>
              <div className="flex rounded-xl border border-bg-border bg-bg-elevated p-1">
                {(["active", "inactive", "all"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setParserActivityMode(mode)}
                    className={`rounded-lg px-3 py-2 text-sm font-semibold capitalize transition ${
                      parserActivityMode === mode
                        ? "bg-[color:var(--theme-primary)] text-primary-foreground"
                        : "text-content-muted hover:text-content"
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void parseMembers()}
                disabled={parserLoading || !parserInput.trim()}
                className={`${siteDesign.controls.primaryActionClassName} disabled:opacity-50`}
              >
                {parserLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
                {parserLoading ? "Parsing..." : "Parse Members"}
              </button>
              <button
                type="button"
                onClick={() => void analyzeRecentMessages()}
                disabled={recentAnalysisLoading || !parserInput.trim()}
                className={`${siteDesign.controls.actionButtonClassName} disabled:opacity-50`}
              >
                {recentAnalysisLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                {recentAnalysisLoading ? "Analyzing..." : "Analyze 100"}
              </button>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 text-sm text-content-muted md:grid-cols-3">
              <div className="rounded-xl border border-bg-border bg-bg-elevated px-3 py-2">
                Uses current Smart Filters: min activity {Math.round(filters.minActivity * 100)}%, avatar {filters.hasAvatar ? "required" : "optional"}.
              </div>
              <div className="rounded-xl border border-bg-border bg-bg-elevated px-3 py-2">
                Active mode removes bots, risky profiles, hidden or stale last-seen users.
              </div>
              <div className="rounded-xl border border-bg-border bg-bg-elevated px-3 py-2">
                Requires MTProto connection in TGInvite Settings.
              </div>
            </div>
          </div>

          {recentAnalysis && (
            <div className={siteDesign.page.panelClassName}>
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-content">Recent 100 Essence</h3>
                  <p className="text-sm text-content-muted">
                    {recentAnalysis.messagesAnalyzed} messages analyzed from {recentAnalysis.channel}
                  </p>
                </div>
                <div className={`rounded-full border px-3 py-1 text-sm font-semibold ${
                  recentAnalysis.verdict === "strong"
                    ? "border-green-500/30 text-green-300"
                    : recentAnalysis.verdict === "medium"
                    ? "border-yellow-500/30 text-yellow-200"
                    : "border-red-500/30 text-red-300"
                }`}>
                  {recentAnalysis.verdict} · {recentAnalysis.essenceScore.toFixed(1)}
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-6">
                {[
                  ["Signals", recentAnalysis.signalMessages],
                  ["SOL Msgs", recentAnalysis.solanaMessages],
                  ["Meme Msgs", recentAnalysis.memecoinMessages],
                  ["Calls", recentAnalysis.callMessages],
                  ["Contracts", recentAnalysis.contractMessages],
                  ["Pumpfun", recentAnalysis.pumpfunMessages],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-xl border border-bg-border bg-bg-elevated p-3">
                    <div className="text-xs text-content-muted">{label}</div>
                    <div className="mt-1 text-xl font-bold text-content">{Number(value).toLocaleString()}</div>
                  </div>
                ))}
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                <div className="rounded-xl border border-bg-border bg-bg-elevated p-3">
                  <div className="text-sm font-semibold text-content">Reasons</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {recentAnalysis.reasons.map((reason) => (
                      <span key={reason} className="rounded-full border border-bg-border px-2 py-1 text-xs text-content-muted">
                        {reason}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-bg-border bg-bg-elevated p-3">
                  <div className="text-sm font-semibold text-content">Solana Contracts</div>
                  <div className="mt-2 max-h-24 overflow-y-auto text-xs text-content-muted">
                    {recentAnalysis.solanaContracts.length
                      ? recentAnalysis.solanaContracts.slice(0, 12).map((address) => <div key={address} className="truncate">{address}</div>)
                      : "No Solana contracts found in last 100 messages"}
                  </div>
                </div>
              </div>
            </div>
          )}

          {parserResult && (
            <>
              {parserResult.partial && (
                <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-100">
                  {parserResult.warning || "Telegram blocked the full member list. Showing visible users only."}
                </div>
              )}
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
                {[
                  ["Total", parserResult.total, "text-content"],
                  ["Shown", parserResult.members.length, "text-[color:var(--theme-primary)]"],
                  ["Active", parserResult.active, "text-green-400"],
                  ["Inactive", parserResult.inactive, "text-yellow-300"],
                  ["Humans", parserResult.humans, "text-blue-300"],
                  ["Bots", parserResult.bots, "text-red-300"],
                ].map(([label, value, color]) => (
                  <div key={String(label)} className="rounded-xl border border-bg-border bg-bg-elevated p-4">
                    <div className="text-xs uppercase tracking-[0.16em] text-content-muted">{label}</div>
                    <div className={`mt-1 text-2xl font-bold ${color}`}>{Number(value).toLocaleString()}</div>
                  </div>
                ))}
              </div>

              <div className={siteDesign.page.panelClassName}>
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h3 className="text-lg font-semibold">Parsed users from {parserResult.channel}</h3>
                    <p className="text-sm text-content-muted">
                      {parserResult.summary.join(" · ")}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-64 flex-1 lg:flex-none">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-content-muted" />
                      <input
                        type="text"
                        value={parserSearch}
                        onChange={(e) => setParserSearch(e.target.value)}
                        placeholder="Search users..."
                        className={`${siteDesign.controls.inputClassName} pl-10`}
                      />
                    </div>
                    <button type="button" onClick={addParsedChannelToSources} className={siteDesign.controls.actionButtonClassName}>
                      <Plus className="h-4 w-4" />
                      Add Source
                    </button>
                    <button type="button" onClick={() => exportParsedMembers("csv")} className={siteDesign.controls.actionButtonClassName}>
                      <FileSpreadsheet className="h-4 w-4" />
                      CSV
                    </button>
                    <button type="button" onClick={() => exportParsedMembers("json")} className={siteDesign.controls.actionButtonClassName}>
                      <FileJson className="h-4 w-4" />
                      JSON
                    </button>
                  </div>
                </div>

                <div className="mt-4 overflow-hidden rounded-xl border border-bg-border">
                  <div className="grid grid-cols-[minmax(180px,1.4fr)_minmax(160px,1fr)_110px_110px_120px] gap-3 border-b border-bg-border bg-bg-card px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-content-muted">
                    <span>User</span>
                    <span>Name</span>
                    <span>Last seen</span>
                    <span>Activity</span>
                    <span>Risk</span>
                  </div>
                  <div className="max-h-[560px] overflow-y-auto">
                    {parserVisibleMembers.length === 0 ? (
                      <div className="py-10 text-center text-content-muted">No users match current parser filters</div>
                    ) : (
                      parserVisibleMembers.map((member) => {
                        const score = parserScoreByUserId.get(member.id);
                        const displayName = `${member.firstName || ""} ${member.lastName || ""}`.trim() || "-";
                        return (
                          <div
                            key={`${member.id}-${member.accessHash || ""}`}
                            className="grid grid-cols-[minmax(180px,1.4fr)_minmax(160px,1fr)_110px_110px_120px] items-center gap-3 border-b border-bg-border bg-bg-elevated px-4 py-3 text-sm last:border-b-0"
                          >
                            <div className="min-w-0">
                              <div className="truncate font-semibold text-content">
                                {member.username ? `@${member.username}` : `id:${member.id}`}
                              </div>
                              <div className="mt-1 flex flex-wrap gap-1 text-xs">
                                {member.isBot && <span className="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-red-300">bot</span>}
                                {member.isPremium && <span className="rounded border border-yellow-500/30 bg-yellow-500/10 px-1.5 py-0.5 text-yellow-300">premium</span>}
                                {member.langCode && <span className="rounded border border-bg-border bg-bg-card px-1.5 py-0.5 text-content-muted">{member.langCode}</span>}
                              </div>
                            </div>
                            <div className="truncate text-content-muted">{displayName}</div>
                            <div className="text-content-muted">{formatLastSeen(member.lastSeen)}</div>
                            <div className="font-semibold">
                              {score ? `${Math.round(score.score * 100)}%` : "-"}
                            </div>
                            <div className={`inline-flex w-fit rounded-full border px-2 py-1 text-xs font-semibold capitalize ${riskClassName(score?.riskLevel)}`}>
                              {score?.isActive ? "active" : score?.riskLevel || "unknown"}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Real-Time Monitor Tab */}
      {activeTab === "monitor" && <RealTimeMonitor />}
      {activeTab === "import" && (
        <div className="space-y-6">
          {/* Target Channel */}
          <div className={siteDesign.page.panelClassName}>
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Target className="h-5 w-5 text-[color:var(--theme-primary)]" />
              Target Channel
            </h3>
            <div className="flex gap-2">
              <input
                type="text"
                value={targetChannel}
                onChange={(e) => setTargetChannel(e.target.value)}
                placeholder="@your_channel or https://t.me/your_channel"
                className={siteDesign.controls.inputClassName}
              />
              <button
                onClick={verifyTargetChannel}
                disabled={channelVerifying}
                className={siteDesign.controls.actionButtonClassName}
              >
                <Search className="h-4 w-4" />
                {channelVerifying ? "Verifying..." : "Verify"}
              </button>
            </div>
          </div>

          {/* Source Channels */}
          <div className={siteDesign.page.panelClassName}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <Globe className="h-5 w-5 text-[color:var(--theme-secondary)]" />
                Source Channels
              </h3>
              <div className="flex items-center gap-2">
                <div className="relative" ref={exportMenuRef}>
                  <button
                    onClick={() => setShowExportMenu(!showExportMenu)}
                    className={siteDesign.controls.actionButtonClassName}
                  >
                    <Download className="h-4 w-4" />
                    Export
                  </button>
                  {showExportMenu && (
                    <div className="absolute right-0 top-full mt-2 w-40 bg-bg-card border border-bg-border rounded-lg shadow-lg z-10">
                      <button
                        onClick={() => exportChannels("json")}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-bg-elevated rounded-t-lg"
                      >
                        <FileJson className="h-4 w-4" />
                        Export JSON
                      </button>
                      <button
                        onClick={() => exportChannels("csv")}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-bg-elevated"
                      >
                        <FileSpreadsheet className="h-4 w-4" />
                        Export CSV
                      </button>
                      <button
                        onClick={() => exportChannels("txt")}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-bg-elevated rounded-b-lg"
                      >
                        <FileText className="h-4 w-4" />
                        Export TXT
                      </button>
                    </div>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.csv,.json"
                  onChange={handleFileImport}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className={siteDesign.controls.actionButtonClassName}
                >
                  <Upload className="h-4 w-4" />
                  Import File
                </button>
              </div>
            </div>

            {/* Search and Add */}
            <div className="flex gap-2 mb-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-content-muted" />
                <input
                  type="text"
                  value={sourceInput}
                  onChange={(e) => setSourceInput(e.target.value)}
                  placeholder="Add channels: @username, @channel2, https://t.me/channel3"
                  className={`${siteDesign.controls.inputClassName} pl-10`}
                  onKeyDown={(e) => e.key === "Enter" && addChannel()}
                />
              </div>
              <button onClick={addChannel} className={siteDesign.controls.primaryActionClassName}>
                <Plus className="h-4 w-4" />
                Add
              </button>
            </div>

            {/* Search Filter */}
            <div className="relative mb-4">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-content-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search channels..."
                className={`${siteDesign.controls.inputClassName} pl-10`}
              />
            </div>

            {/* Channel List */}
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {filteredChannels.length === 0 ? (
                <div className="text-center py-8 text-content-muted">
                  <Globe className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p>No channels added yet</p>
                  <p className="text-sm mt-1">Add channels manually or import from file</p>
                </div>
              ) : (
                filteredChannels.map((channel) => (
                  <div
                    key={channel.id}
                    className={`flex items-center gap-3 p-3 rounded-lg border transition-all ${
                      selectedChannels.has(channel.id)
                        ? "bg-[color:var(--theme-primary)]/10 border-[color:var(--theme-primary)]/30"
                        : "bg-bg-elevated border-bg-border hover:border-bg-border"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedChannels.has(channel.id)}
                      onChange={() => toggleChannel(channel.id)}
                      className="h-4 w-4 rounded border-bg-border"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{channel.name}</span>
                        {channel.status === "active" && (
                          <span className="px-1.5 py-0.5 text-xs bg-green-500/20 text-green-400 rounded">Active</span>
                        )}
                        {channel.group && (
                          <span className="px-1.5 py-0.5 text-xs bg-purple-500/20 text-purple-400 rounded">
                            {channelGroups.find((g) => g.id === channel.group)?.name}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-4 text-xs text-content-muted mt-1">
                        <span>{channel.members.toLocaleString()} members</span>
                        {channel.activity !== undefined && (
                          <span className="flex items-center gap-1">
                            <Activity className="h-3 w-3" />
                            {(channel.activity * 100).toFixed(0)}%
                          </span>
                        )}
                        {channel.quality !== undefined && (
                          <span className="flex items-center gap-1">
                            <Star className="h-3 w-3" />
                            {(channel.quality * 100).toFixed(0)}%
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => copyUsername(channel.username)}
                        className="p-1.5 text-content-muted hover:text-[color:var(--theme-primary)] transition rounded-lg hover:bg-[color:var(--theme-primary)]/10"
                        title="Copy username"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => removeChannel(channel.id)}
                        className="p-1.5 text-content-muted hover:text-red-400 transition rounded-lg hover:bg-red-400/10"
                        title="Remove channel"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Bulk Actions */}
            {channels.length > 0 && (
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-bg-border">
                <div className="flex items-center gap-2">
                  <button
                    onClick={selectAllChannels}
                    className="text-sm text-content-muted hover:text-[color:var(--theme-primary)] transition"
                  >
                    {selectedChannels.size === filteredChannels.length ? "Deselect All" : "Select All"}
                  </button>
                  <span className="text-content-muted">|</span>
                  <span className="text-sm text-content-muted">
                    {selectedChannels.size} of {filteredChannels.length} selected
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    placeholder="Group name"
                    className={`${siteDesign.controls.inputClassName} w-40`}
                  />
                  <button
                    onClick={createGroup}
                    disabled={selectedChannels.size === 0 || !newGroupName}
                    className={siteDesign.controls.actionButtonClassName}
                  >
                    <Layers className="h-4 w-4" />
                    Create Group
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Filters */}
          <div className={siteDesign.page.panelClassName}>
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Filter className="h-5 w-5 text-[color:var(--theme-tertiary)]" />
              Smart Filters
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm text-content-muted mb-2">Min Activity Score</label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={filters.minActivity}
                  onChange={(e) => setFilters((prev) => ({ ...prev, minActivity: parseFloat(e.target.value) }))}
                  className="w-full accent-[color:var(--theme-primary)]"
                />
                <div className="flex justify-between text-xs text-content-muted mt-1">
                  <span>0</span>
                  <span className="font-medium text-[color:var(--theme-primary)]">{filters.minActivity}</span>
                  <span>1</span>
                </div>
              </div>
              <div>
                <label className="block text-sm text-content-muted mb-2">Min Quality Score</label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={filters.minQuality}
                  onChange={(e) => setFilters((prev) => ({ ...prev, minQuality: parseFloat(e.target.value) }))}
                  className="w-full accent-[color:var(--theme-secondary)]"
                />
                <div className="flex justify-between text-xs text-content-muted mt-1">
                  <span>0</span>
                  <span className="font-medium text-[color:var(--theme-secondary)]">{filters.minQuality}</span>
                  <span>1</span>
                </div>
              </div>
              <div>
                <label className="block text-sm text-content-muted mb-2">Max Account Age (days)</label>
                <input
                  type="number"
                  value={filters.maxAge}
                  onChange={(e) => setFilters((prev) => ({ ...prev, maxAge: parseInt(e.target.value) || 30 }))}
                  className={siteDesign.controls.inputClassName}
                />
              </div>
              <div>
                <label className="block text-sm text-content-muted mb-2">Member Limit</label>
                <input
                  type="number"
                  value={filters.limit}
                  onChange={(e) => setFilters((prev) => ({ ...prev, limit: parseInt(e.target.value) || 1000 }))}
                  className={siteDesign.controls.inputClassName}
                />
              </div>
              <div>
                <label className="block text-sm text-content-muted mb-2">Delay (ms)</label>
                <input
                  type="number"
                  value={filters.delay}
                  onChange={(e) => setFilters((prev) => ({ ...prev, delay: parseInt(e.target.value) || 100 }))}
                  className={siteDesign.controls.inputClassName}
                />
              </div>
              <div>
                <label className="block text-sm text-content-muted mb-2">Followers Range</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    value={filters.minFollowers}
                    onChange={(e) => setFilters((prev) => ({ ...prev, minFollowers: parseInt(e.target.value) || 0 }))}
                    className={siteDesign.controls.inputClassName}
                    placeholder="Min"
                  />
                  <input
                    type="number"
                    value={filters.maxFollowers}
                    onChange={(e) => setFilters((prev) => ({ ...prev, maxFollowers: parseInt(e.target.value) || 1000000 }))}
                    className={siteDesign.controls.inputClassName}
                    placeholder="Max"
                  />
                </div>
              </div>
            </div>

            {/* Toggle Filters */}
            <div className="flex flex-wrap gap-4 mt-4 pt-4 border-t border-bg-border">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.stealthMode}
                  onChange={(e) => setFilters((prev) => ({ ...prev, stealthMode: e.target.checked }))}
                  className="h-4 w-4 rounded border-bg-border"
                />
                <Shield className="h-4 w-4 text-[color:var(--theme-tertiary)]" />
                <span className="text-sm">Stealth Mode</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.verifiedOnly}
                  onChange={(e) => setFilters((prev) => ({ ...prev, verifiedOnly: e.target.checked }))}
                  className="h-4 w-4 rounded border-bg-border"
                />
                <CheckCircle2 className="h-4 w-4 text-blue-400" />
                <span className="text-sm">Verified Only</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.hasAvatar}
                  onChange={(e) => setFilters((prev) => ({ ...prev, hasAvatar: e.target.checked }))}
                  className="h-4 w-4 rounded border-bg-border"
                />
                <Eye className="h-4 w-4 text-green-400" />
                <span className="text-sm">Has Avatar</span>
              </label>
            </div>

            {/* Blacklist/Whitelist */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 pt-4 border-t border-bg-border">
              {/* Blacklist */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <Lock className="h-4 w-4 text-red-400" />
                    Blacklist
                  </label>
                  <button
                    onClick={() => setShowBlacklist(!showBlacklist)}
                    className="text-xs text-content-muted hover:text-[color:var(--theme-primary)]"
                  >
                    {showBlacklist ? "Hide" : "Show"} ({filters.blacklist.length})
                  </button>
                </div>
                {showBlacklist && (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newBlacklistItem}
                        onChange={(e) => setNewBlacklistItem(e.target.value)}
                        placeholder="Add username to blacklist"
                        className={siteDesign.controls.inputClassName}
                        onKeyDown={(e) => e.key === "Enter" && addBlacklistItem()}
                      />
                      <button onClick={addBlacklistItem} className={siteDesign.controls.iconButtonClassName}>
                        <Plus className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                      {filters.blacklist.map((item, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 px-2 py-1 bg-red-500/10 text-red-400 rounded text-xs"
                        >
                          {item}
                          <button
                            onClick={() =>
                              setFilters((prev) => ({
                                ...prev,
                                blacklist: prev.blacklist.filter((_, idx) => idx !== i),
                              }))
                            }
                            className="hover:text-red-300"
                          >
                            <XCircle className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Whitelist */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <Unlock className="h-4 w-4 text-green-400" />
                    Whitelist
                  </label>
                  <button
                    onClick={() => setShowWhitelist(!showWhitelist)}
                    className="text-xs text-content-muted hover:text-[color:var(--theme-primary)]"
                  >
                    {showWhitelist ? "Hide" : "Show"} ({filters.whitelist.length})
                  </button>
                </div>
                {showWhitelist && (
                  <div className="space-y-2">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newWhitelistItem}
                        onChange={(e) => setNewWhitelistItem(e.target.value)}
                        placeholder="Add username to whitelist"
                        className={siteDesign.controls.inputClassName}
                        onKeyDown={(e) => e.key === "Enter" && addWhitelistItem()}
                      />
                      <button onClick={addWhitelistItem} className={siteDesign.controls.iconButtonClassName}>
                        <Plus className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                      {filters.whitelist.map((item, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 px-2 py-1 bg-green-500/10 text-green-400 rounded text-xs"
                        >
                          {item}
                          <button
                            onClick={() =>
                              setFilters((prev) => ({
                                ...prev,
                                whitelist: prev.whitelist.filter((_, idx) => idx !== i),
                              }))
                            }
                            className="hover:text-green-300"
                          >
                            <XCircle className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Import Control */}
          <div className={siteDesign.page.panelClassName}>
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Zap className="h-5 w-5 text-[color:var(--theme-primary)]" />
              Import Control
            </h3>
            <div className="flex flex-wrap gap-3">
              {!isRunning && !currentJob && (
                <button
                  onClick={startImport}
                  className={siteDesign.controls.primaryActionClassName}
                  disabled={selectedChannels.size === 0 || !targetChannel}
                >
                  <Play className="h-4 w-4" />
                  Start Import ({selectedChannels.size} channels)
                </button>
              )}
              {isRunning && (
                <button onClick={pauseImport} className={siteDesign.controls.actionButtonClassName}>
                  <Pause className="h-4 w-4" />
                  Pause
                </button>
              )}
              {!isRunning && currentJob?.status === "paused" && (
                <button onClick={resumeImport} className={siteDesign.controls.primaryActionClassName}>
                  <Play className="h-4 w-4" />
                  Resume
                </button>
              )}
              {currentJob && (
                <button onClick={resetImport} className={siteDesign.controls.actionButtonClassName}>
                  <RotateCcw className="h-4 w-4" />
                  Reset
                </button>
              )}
              <button
                onClick={() => {
                  const config = {
                    channels,
                    filters,
                    schedule,
                    targetChannel,
                    batchSize,
                    batchPause,
                  };
                  const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `tginvite-config-${Date.now()}.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                  success("Config exported", "Configuration saved to file");
                }}
                className={siteDesign.controls.actionButtonClassName}
              >
                <Save className="h-4 w-4" />
                Save Config
              </button>
              <button
                onClick={() => {
                  const input = document.createElement("input");
                  input.type = "file";
                  input.accept = ".json";
                  input.onchange = (e) => {
                    const file = (e.target as HTMLInputElement).files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                      try {
                        const config = JSON.parse(ev.target?.result as string);
                        if (config.channels) setChannels(config.channels.map((ch: Channel) => ({ ...ch, selected: ch.selected ?? false })));
                        if (config.filters) setFilters(config.filters);
                        if (config.schedule) setSchedule(config.schedule);
                        if (config.targetChannel) setTargetChannel(config.targetChannel);
                        if (config.batchSize) setBatchSize(config.batchSize);
                        if (config.batchPause) setBatchPause(config.batchPause);
                        success("Config loaded", "Configuration restored from file");
                      } catch {
                        toastError("Load failed", "Invalid config file");
                      }
                    };
                    reader.readAsText(file);
                  };
                  input.click();
                }}
                className={siteDesign.controls.actionButtonClassName}
              >
                <FolderOpen className="h-4 w-4" />
                Load Config
              </button>
            </div>
          </div>

          {/* Invite Links (after job completion) */}
          {currentJob?.inviteLinks && currentJob.inviteLinks.length > 0 && (
            <div className={siteDesign.page.panelClassName}>
              <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Link className="h-5 w-5 text-green-400" />
                Generated Invite Links
                <span className="ml-2 px-2 py-0.5 text-xs bg-green-500/20 text-green-400 rounded-full">
                  {currentJob.inviteLinks.length}
                </span>
              </h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {currentJob.inviteLinks.map((link, i) => (
                  <div key={i} className="flex items-center gap-3 p-2 bg-bg-elevated rounded-lg">
                    <div className="w-6 h-6 rounded-full bg-green-500/20 flex items-center justify-center text-green-400 text-xs font-bold">
                      {i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-mono truncate">{link.url}</div>
                    </div>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(link.url);
                        success("Copied", "Invite link copied to clipboard");
                      }}
                      className="p-1.5 text-content-muted hover:text-[color:var(--theme-primary)] transition rounded-lg hover:bg-[color:var(--theme-primary)]/10"
                      title="Copy link"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-3 pt-3 border-t border-bg-border flex gap-2">
                <button
                  onClick={() => {
                    const allLinks = currentJob.inviteLinks!.map((l) => l.url).join("\n");
                    navigator.clipboard.writeText(allLinks);
                    success("All copied", `${currentJob.inviteLinks!.length} links copied`);
                  }}
                  className={siteDesign.controls.actionButtonClassName}
                >
                  <Copy className="h-4 w-4" />
                  Copy All
                </button>
                <button
                  onClick={() => {
                    const blob = new Blob(
                      [currentJob.inviteLinks!.map((l) => l.url).join("\n")],
                      { type: "text/plain" }
                    );
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `invite-links-${currentJob.id}.txt`;
                    a.click();
                    URL.revokeObjectURL(url);
                    success("Downloaded", "Links saved to file");
                  }}
                  className={siteDesign.controls.actionButtonClassName}
                >
                  <Download className="h-4 w-4" />
                  Download
                </button>
              </div>
            </div>
          )}

          {/* Job Progress */}
          {currentJob && (
            <div className={siteDesign.page.panelClassName}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold flex items-center gap-2">
                  {currentJob.status === "running" && <Loader2 className="h-5 w-5 animate-spin text-green-400" />}
                  {currentJob.status === "completed" && <CheckCircle2 className="h-5 w-5 text-green-400" />}
                  {currentJob.status === "failed" && <XCircle className="h-5 w-5 text-red-400" />}
                  {currentJob.status === "paused" && <Pause className="h-5 w-5 text-yellow-400" />}
                  Import Progress
                </h3>
                <div className={`px-2 py-1 rounded-full text-xs font-medium ${
                  currentJob.status === "running" ? "bg-green-500/20 text-green-400" :
                  currentJob.status === "completed" ? "bg-green-500/20 text-green-400" :
                  currentJob.status === "paused" ? "bg-yellow-500/20 text-yellow-400" :
                  currentJob.status === "failed" ? "bg-red-500/20 text-red-400" :
                  "bg-content-muted/20 text-content-muted"
                }`}>
                  {currentJob.status.toUpperCase()}
                </div>
              </div>
              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="text-content-muted">Progress</span>
                  <span className="font-medium">{Math.round(currentJob.progress)}%</span>
                </div>
                <div className="h-3 bg-bg-elevated rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${
                      currentJob.status === "running" ? "animate-pulse " : ""
                    }bg-gradient-to-r from-[color:var(--theme-primary)] via-[color:var(--theme-secondary)] to-[color:var(--theme-tertiary)]`}
                    style={{ width: `${currentJob.progress}%` }}
                  />
                </div>
                <div className="grid grid-cols-4 gap-4 text-sm">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-400" />
                    <span className="text-content-muted">Invited:</span>
                    <span className="font-medium text-green-400">{currentJob.invited}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-yellow-400" />
                    <span className="text-content-muted">Skipped:</span>
                    <span className="font-medium text-yellow-400">{currentJob.skipped}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-red-400" />
                    <span className="text-content-muted">Failed:</span>
                    <span className="font-medium text-red-400">{currentJob.failed}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-blue-400" />
                    <span className="text-content-muted">Links:</span>
                    <span className="font-medium text-blue-400">{currentJob.inviteLinks?.length || 0}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {activeTab === "channels" && (
        <div className="space-y-6">
          {/* Channel Groups */}
          <div className={siteDesign.page.panelClassName}>
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Layers className="h-5 w-5 text-purple-400" />
              Channel Groups
            </h3>
            {channelGroups.length === 0 ? (
              <div className="text-center py-8 text-content-muted">
                <Layers className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p>No groups created yet</p>
                <p className="text-sm mt-1">Select channels and create a group to organize them</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {channelGroups.map((group) => (
                  <div key={group.id} className="p-4 bg-bg-elevated rounded-lg border border-bg-border">
                    <div className="flex items-center gap-2 mb-2">
                      <div className={`w-3 h-3 rounded-full ${group.color}`} />
                      <span className="font-medium">{group.name}</span>
                    </div>
                    <div className="text-sm text-content-muted">
                      {group.channelIds.length} channels
                    </div>
                    <div className="flex gap-2 mt-3">
                      <button
                        onClick={() => setSelectedChannels(new Set(group.channelIds))}
                        className="text-xs text-[color:var(--theme-primary)] hover:underline"
                      >
                        Select All
                      </button>
                      <button
                        onClick={() => setChannelGroups((prev) => prev.filter((g) => g.id !== group.id))}
                        className="text-xs text-red-400 hover:underline"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Channel Statistics */}
          <div className={siteDesign.page.panelClassName}>
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-[color:var(--theme-secondary)]" />
              Channel Statistics
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 bg-bg-elevated rounded-lg text-center">
                <div className="text-3xl font-bold text-[color:var(--theme-primary)]">
                  {channels.filter((ch) => ch.status === "active").length}
                </div>
                <div className="text-sm text-content-muted mt-1">Active</div>
              </div>
              <div className="p-4 bg-bg-elevated rounded-lg text-center">
                <div className="text-3xl font-bold text-yellow-400">
                  {channels.filter((ch) => ch.status === "inactive").length}
                </div>
                <div className="text-sm text-content-muted mt-1">Inactive</div>
              </div>
              <div className="p-4 bg-bg-elevated rounded-lg text-center">
                <div className="text-3xl font-bold text-red-400">
                  {channels.filter((ch) => ch.status === "banned").length}
                </div>
                <div className="text-sm text-content-muted mt-1">Banned</div>
              </div>
              <div className="p-4 bg-bg-elevated rounded-lg text-center">
                <div className="text-3xl font-bold text-green-400">
                  {channels.reduce((acc, ch) => acc + (ch.members || 0), 0).toLocaleString()}
                </div>
                <div className="text-sm text-content-muted mt-1">Total Members</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Schedule Tab */}
      {activeTab === "schedule" && (
        <div className={siteDesign.page.panelClassName}>
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Calendar className="h-5 w-5 text-cyan-400" />
            Auto-Invite Schedule
          </h3>
          <div className="space-y-4">
            <label className="flex items-center gap-3 p-4 bg-bg-elevated rounded-lg cursor-pointer">
              <input
                type="checkbox"
                checked={schedule.enabled}
                onChange={(e) => setSchedule((prev) => ({ ...prev, enabled: e.target.checked }))}
                className="h-5 w-5 rounded border-bg-border"
              />
              <div>
                <div className="font-medium">Enable Scheduled Imports</div>
                <div className="text-sm text-content-muted">Automatically run imports on schedule</div>
              </div>
            </label>

            {schedule.enabled && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4">
                <div>
                  <label className="block text-sm text-content-muted mb-2">Interval</label>
                  <select
                    value={schedule.interval}
                    onChange={(e) => setSchedule((prev) => ({ ...prev, interval: e.target.value as ScheduleConfig["interval"] }))}
                    className={siteDesign.controls.inputClassName}
                  >
                    <option value="hourly">Every Hour</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="custom">Custom (Cron)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-content-muted mb-2">Max Invites per Day</label>
                  <input
                    type="number"
                    value={schedule.maxPerDay}
                    onChange={(e) => setSchedule((prev) => ({ ...prev, maxPerDay: parseInt(e.target.value) || 100 }))}
                    className={siteDesign.controls.inputClassName}
                  />
                </div>
                {schedule.interval === "custom" && (
                  <div className="md:col-span-2">
                    <label className="block text-sm text-content-muted mb-2">Cron Expression</label>
                    <input
                      type="text"
                      value={schedule.customCron || ""}
                      onChange={(e) => setSchedule((prev) => ({ ...prev, customCron: e.target.value }))}
                      placeholder="0 9 * * * (every day at 9am)"
                      className={siteDesign.controls.inputClassName}
                    />
                  </div>
                )}
                <div>
                  <label className="block text-sm text-content-muted mb-2">Start Time</label>
                  <input
                    type="time"
                    value={schedule.startTime || ""}
                    onChange={(e) => setSchedule((prev) => ({ ...prev, startTime: e.target.value }))}
                    className={siteDesign.controls.inputClassName}
                  />
                </div>
                <div>
                  <label className="block text-sm text-content-muted mb-2">End Time</label>
                  <input
                    type="time"
                    value={schedule.endTime || ""}
                    onChange={(e) => setSchedule((prev) => ({ ...prev, endTime: e.target.value }))}
                    className={siteDesign.controls.inputClassName}
                  />
                </div>
                <div>
                  <label className="block text-sm text-content-muted mb-2">Timezone</label>
                  <select
                    value={schedule.timezone}
                    onChange={(e) => setSchedule((prev) => ({ ...prev, timezone: e.target.value }))}
                    className={siteDesign.controls.inputClassName}
                  >
                    <option value="UTC">UTC</option>
                    <option value="America/New_York">Eastern Time</option>
                    <option value="America/Chicago">Central Time</option>
                    <option value="America/Denver">Mountain Time</option>
                    <option value="America/Los_Angeles">Pacific Time</option>
                    <option value="Europe/London">London</option>
                    <option value="Europe/Paris">Paris</option>
                    <option value="Asia/Dubai">Dubai</option>
                    <option value="Asia/Tokyo">Tokyo</option>
                  </select>
                </div>
              </div>
            )}

            <div className="pt-4">
              <button
                onClick={() => {
                  settingsStorage.set({
                    ...settingsStorage.get(),
                    maxPerDay: schedule.maxPerDay,
                  });
                  success("Schedule saved", `Interval: ${schedule.interval}, Max/day: ${schedule.maxPerDay}`);
                }}
                className={siteDesign.controls.primaryActionClassName}
              >
                <Save className="h-4 w-4" />
                Save Schedule
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Analytics Tab */}
      {activeTab === "analytics" && (
        <div className="space-y-6">
          {/* Overview Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className={siteDesign.page.panelClassName}>
              <div className="text-sm text-content-muted">Total Invited</div>
              <div className="text-3xl font-bold mt-2">{analytics.totalInvited}</div>
              <div className="flex items-center gap-1 text-xs text-green-400 mt-1">
                <ArrowUpRight className="h-3 w-3" />
                <span>+15% this week</span>
              </div>
            </div>
            <div className={siteDesign.page.panelClassName}>
              <div className="text-sm text-content-muted">Success Rate</div>
              <div className="text-3xl font-bold mt-2">{analytics.successRate.toFixed(1)}%</div>
              <div className="flex items-center gap-1 text-xs text-green-400 mt-1">
                <ArrowUpRight className="h-3 w-3" />
                <span>+5% this week</span>
              </div>
            </div>
            <div className={siteDesign.page.panelClassName}>
              <div className="text-sm text-content-muted">Avg Response Time</div>
              <div className="text-3xl font-bold mt-2">{analytics.avgResponseTime}s</div>
              <div className="flex items-center gap-1 text-xs text-yellow-400 mt-1">
                <Minus className="h-3 w-3" />
                <span>No change</span>
              </div>
            </div>
            <div className={siteDesign.page.panelClassName}>
              <div className="text-sm text-content-muted">Active Channels</div>
              <div className="text-3xl font-bold mt-2">{channels.length}</div>
              <div className="flex items-center gap-1 text-xs text-green-400 mt-1">
                <ArrowUpRight className="h-3 w-3" />
                <span>+3 new</span>
              </div>
            </div>
          </div>

          {/* Daily Chart */}
          <div className={siteDesign.page.panelClassName}>
            <h3 className="text-lg font-semibold mb-4">Daily Activity</h3>
            <div className="h-64 flex items-end gap-2">
              {(() => {
                const maxVal = Math.max(...analytics.dailyStats.map((s) => Math.max(s.invited, s.failed)), 1);
                return analytics.dailyStats.map((stat, i) => (
                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                  <div className="w-full flex gap-1 items-end justify-center" style={{ height: "200px" }}>
                    <div
                      className="w-1/2 bg-green-400 rounded-t"
                      style={{ height: `${Math.min((stat.invited / maxVal) * 100, 100)}%` }}
                    />
                    <div
                      className="w-1/2 bg-red-400 rounded-t"
                      style={{ height: `${Math.min((stat.failed / maxVal) * 100, 100)}%` }}
                    />
                  </div>
                  <div className="text-xs text-content-muted">{stat.date}</div>
                </div>
                ));
              })()}
            </div>
            <div className="flex items-center justify-center gap-6 mt-4">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 bg-green-400 rounded" />
                <span className="text-sm text-content-muted">Invited</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 bg-red-400 rounded" />
                <span className="text-sm text-content-muted">Failed</span>
              </div>
            </div>
          </div>

          {/* Export Analytics */}
          <div className={siteDesign.page.panelClassName}>
            <h3 className="text-lg font-semibold mb-4">Export Analytics</h3>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  const lines = [
                    "TGInvite Analytics Report",
                    "========================",
                    "",
                    `Total Invited: ${analytics.totalInvited}`,
                    `Success Rate: ${analytics.successRate}%`,
                    `Avg Response Time: ${analytics.avgResponseTime}s`,
                    "",
                    "Daily Stats:",
                    ...analytics.dailyStats.map((s) => `  ${s.date}: Invited=${s.invited}, Failed=${s.failed}, Skipped=${s.skipped}`),
                  ];
                  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "analytics-report.txt";
                  a.click();
                  URL.revokeObjectURL(url);
                  success("Exported", "Analytics exported as text report");
                }}
                className={siteDesign.controls.actionButtonClassName}
              >
                <Download className="h-4 w-4" />
                Export Report
              </button>
              <button
                onClick={() => {
                  const escapeCsv = (v: string | number | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
                  const rows = [["Date", "Invited", "Failed", "Skipped"], ...analytics.dailyStats.map((s) => [escapeCsv(s.date), String(s.invited), String(s.failed), String(s.skipped)])];
                  const csv = rows.map((r) => r.join(",")).join("\n");
                  const blob = new Blob([csv], { type: "text/csv" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "analytics.csv";
                  a.click();
                  URL.revokeObjectURL(url);
                  success("Exported", "Analytics exported as CSV");
                }}
                className={siteDesign.controls.actionButtonClassName}
              >
                <FileSpreadsheet className="h-4 w-4" />
                Export as CSV
              </button>
              <button
                onClick={() => {
                  const data = JSON.stringify(analytics, null, 2);
                  const blob = new Blob([data], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "analytics.json";
                  a.click();
                  URL.revokeObjectURL(url);
                  success("Exported", "Analytics exported as JSON");
                }}
                className={siteDesign.controls.actionButtonClassName}
              >
                <FileJson className="h-4 w-4" />
                Export as JSON
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings Tab */}
      {activeTab === "settings" && (
        <div className="space-y-6">
          {/* Telegram Bot */}
          <div className={siteDesign.page.panelClassName}>
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Bot className="h-5 w-5 text-[color:var(--theme-primary)]" />
              Telegram Bot
            </h3>
            <div className="space-y-4">
              {botInfo ? (
                <div className="flex items-center gap-3 p-3 bg-green-500/10 border border-green-500/30 rounded-xl">
                  <CheckCircle2 className="h-5 w-5 text-green-400" />
                  <div>
                    <div className="text-sm font-medium">@{botInfo.username}</div>
                    <div className="text-xs text-content-muted">ID: {botInfo.id} | {botInfo.firstName}</div>
                  </div>
                  <button
                    onClick={() => { setBotToken(""); setBotInfo(null); }}
                    className="ml-auto text-xs text-red-400 hover:text-red-300"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-sm text-content-muted mb-2">Bot Token (from @BotFather)</label>
                    <input
                      type="password"
                      value={botToken}
                      onChange={(e) => setBotToken(e.target.value)}
                      placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
                      className={siteDesign.controls.inputClassName}
                    />
                    <p className="text-xs text-content-muted mt-1">
                      Get a token from <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-[color:var(--theme-primary)] hover:underline">@BotFather</a> on Telegram
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      if (!botToken.trim()) return;
                      setBotVerifying(true);
                      try {
                        const result = await call<{ bot?: BotInfo; error?: string }>(
                          "/api/tginvite/bot",
                          { body: { action: "verify", token: botToken } }
                        );
                        if (result?.bot) {
                          setBotInfo(result.bot);
                          success("Bot connected", `@${result.bot.username} is ready`);
                        } else {
                          toastError("Invalid token", result?.error || "Could not verify bot token");
                        }
                      } catch {
                        toastError("Verification failed", "Could not connect to Telegram");
                      } finally {
                        setBotVerifying(false);
                      }
                    }}
                    disabled={botVerifying || !botToken.trim()}
                    className={siteDesign.controls.primaryActionClassName + " disabled:opacity-50"}
                  >
                    {botVerifying ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Shield className="h-4 w-4" />
                    )}
                    {botVerifying ? "Verifying..." : "Connect Bot"}
                  </button>
                </>
              )}
              <div>
                <label className="block text-sm text-content-muted mb-2">Target Channel</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={targetChannel}
                    onChange={(e) => setTargetChannel(e.target.value)}
                    placeholder="@your_channel or chat ID"
                    className={siteDesign.controls.inputClassName}
                  />
                  <button
                    onClick={async () => {
                      if (!targetChannel.trim() || !botToken) return;
                      setChannelVerifying(true);
                      try {
                        const result = await call<{ chat?: { title: string; memberCount?: number }; error?: string }>(
                          "/api/tginvite/channels",
                          { body: { action: "verify", token: botToken, chatId: targetChannel } }
                        );
                        if (result?.chat) {
                          success("Channel verified", `${result.chat.title} (${result.chat.memberCount?.toLocaleString() || "?"} members)`);
                        } else {
                          toastError("Verification failed", result?.error || "Channel not found");
                        }
                      } catch {
                        toastError("Verification failed", "Could not verify channel");
                      } finally {
                        setChannelVerifying(false);
                      }
                    }}
                    disabled={channelVerifying || !targetChannel.trim() || !botToken}
                    className={siteDesign.controls.actionButtonClassName + " disabled:opacity-50"}
                  >
                    {channelVerifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                    Verify
                  </button>
                </div>
                <p className="text-xs text-content-muted mt-1">Bot must be admin in this channel/group</p>
              </div>
            </div>
          </div>

          {/* MTProto Connection (for real member fetching) */}
          <div className={siteDesign.page.panelClassName}>
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Globe className="h-5 w-5 text-cyan-400" />
              MTProto Connection
              <span className="ml-2 px-2 py-0.5 text-xs bg-cyan-500/20 text-cyan-400 rounded-full">Advanced</span>
            </h3>
            <p className="text-sm text-content-muted mb-4">
              For real member fetching with activity filtering. Requires API credentials from{" "}
              <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer" className="text-[color:var(--theme-primary)] hover:underline">
                my.telegram.org
              </a>
            </p>
            <MTProtoSettings call={call} success={success} toastError={toastError} warning={warning} />
          </div>

          {/* Stealth Settings */}
          <div className={siteDesign.page.panelClassName}>
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <EyeOff className="h-5 w-5 text-[color:var(--theme-tertiary)]" />
              Stealth Settings
            </h3>
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-content-muted mb-2">Min Delay (ms)</label>
                  <input
                    type="number"
                    value={filters.delay}
                    onChange={(e) => setFilters((prev) => ({ ...prev, delay: parseInt(e.target.value) || 50 }))}
                    className={siteDesign.controls.inputClassName}
                  />
                </div>
                <div>
                  <label className="block text-sm text-content-muted mb-2">Max Delay (ms)</label>
                  <input
                    type="number"
                    value={filters.delay * 3}
                    disabled
                    className={siteDesign.controls.inputClassName + " opacity-60 cursor-not-allowed"}
                  />
                </div>
                <div>
                  <label className="block text-sm text-content-muted mb-2">Batch Size</label>
                  <input
                    type="number"
                    value={batchSize}
                    onChange={(e) => setBatchSize(parseInt(e.target.value) || 10)}
                    className={siteDesign.controls.inputClassName}
                  />
                </div>
                <div>
                  <label className="block text-sm text-content-muted mb-2">Batch Pause (s)</label>
                  <input
                    type="number"
                    value={batchPause}
                    onChange={(e) => setBatchPause(parseInt(e.target.value) || 60)}
                    className={siteDesign.controls.inputClassName}
                  />
                </div>
              </div>
              <div className="pt-4">
                <button
                  onClick={() => {
                    settingsStorage.set({
                      botToken,
                      targetChannel,
                      delay: filters.delay,
                      batchSize,
                      batchPause,
                      stealthMode: filters.stealthMode,
                      maxPerDay: schedule.maxPerDay,
                      minDelay: filters.delay,
                      maxDelay: filters.delay * 3,
                    });
                    success("Settings saved", "Stealth settings updated");
                  }}
                  className={siteDesign.controls.primaryActionClassName}
                >
                  <Save className="h-4 w-4" />
                  Save Stealth Settings
                </button>
              </div>
            </div>
          </div>

          {/* Backup & Restore */}
          <div className={siteDesign.page.panelClassName}>
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Save className="h-5 w-5 text-green-400" />
              Backup & Restore
            </h3>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  const allData = {
                    settings: settingsStorage.get(),
                    channels: channelsStorage.getAll(),
                    jobs: jobsStorage.getAll(),
                  };
                  const blob = new Blob([JSON.stringify(allData, null, 2)], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `tginvite-backup-${Date.now()}.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                  success("Backup exported", "All settings saved to file");
                }}
                className={siteDesign.controls.actionButtonClassName}
              >
                <Download className="h-4 w-4" />
                Export All Settings
              </button>
              <button
                onClick={() => {
                  const input = document.createElement("input");
                  input.type = "file";
                  input.accept = ".json";
                  input.onchange = (e) => {
                    const file = (e.target as HTMLInputElement).files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                      try {
                        const data = JSON.parse(ev.target?.result as string);
                        if (data.settings) settingsStorage.set(data.settings);
                        if (data.channels) channelsStorage.set(data.channels);
                        if (data.jobs) jobsStorage.set(data.jobs);
                        window.location.reload();
                      } catch {
                        toastError("Import failed", "Invalid backup file");
                      }
                    };
                    reader.readAsText(file);
                  };
                  input.click();
                }}
                className={siteDesign.controls.actionButtonClassName}
              >
                <Upload className="h-4 w-4" />
                Import Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Component Tabs */}
      {activeTab === "ai" && <AIAnalysisPanel />}
      {activeTab === "users" && <UserProfilingPanel />}
      {activeTab === "goals" && <GoalTracking />}
      {activeTab === "abtest" && <ABTesting />}
      {activeTab === "templates" && (
        <TemplatesPanel onApply={(f) => setFilters((prev) => ({ ...prev, ...f }))} />
      )}
      {activeTab === "accounts" && <MultiAccountPanel />}
      {activeTab === "webhooks" && <WebhooksPanel />}
    </div>
  );
}

function MTProtoSettings({
  call,
  success,
  toastError,
  warning,
}: {
  call: <T>(url: string, opts?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown }) => Promise<T | null>;
  success: (title: string, msg?: string) => void;
  toastError: (title: string, msg?: string) => void;
  warning: (title: string, msg?: string) => void;
}) {
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [twoFactorPassword, setTwoFactorPassword] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [needsPhone, setNeedsPhone] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [codeDelivery, setCodeDelivery] = useState<"app" | "sms" | null>(null);

  const handleConnect = async () => {
    if (!apiId.trim() || !apiHash.trim()) return;
    setConnecting(true);
    try {
      const savedSession = settingsStorage.get().mtprotoSession || "";
      const result = await call<{ status?: string; error?: string; sessionString?: string }>(
        "/api/tginvite/mtproto",
        { body: { action: "connect", apiId: apiId.trim(), apiHash: apiHash.trim(), sessionString: savedSession } }
      );
      if (result?.status === "connected") {
        setConnected(true);
        success("MTProto connected", "Real member fetching enabled");
      } else if (result?.status === "needs_phone") {
        setNeedsPhone(true);
        warning("Phone required", "Enter your phone number to authenticate");
      } else {
        toastError("Connection failed", result?.error || "Could not connect");
      }
    } catch {
      toastError("Connection failed", "Could not reach MTProto service");
    } finally {
      setConnecting(false);
    }
  };

  const handleStart = async () => {
    if (!apiId.trim() || !apiHash.trim() || !phoneNumber.trim()) return;
    setConnecting(true);
    try {
      const result = await call<{ status?: string; error?: string; isCodeViaApp?: boolean; message?: string }>(
        "/api/tginvite/mtproto",
        { body: { action: "sendCode", apiId: apiId.trim(), apiHash: apiHash.trim(), phoneNumber: phoneNumber.trim() } }
      );
      if (result?.status === "code_sent") {
        setCodeSent(true);
        setCodeDelivery(result.isCodeViaApp ? "app" : "sms");
        success("Telegram code sent", result.message || "Enter the code below");
      } else {
        toastError("Code failed", result?.error || "Could not send Telegram code");
      }
    } catch {
      toastError("Code failed", "Could not send Telegram code");
    } finally {
      setConnecting(false);
    }
  };

  const handleCompleteLogin = async () => {
    if (!passwordRequired && !phoneCode.trim()) return;
    if (passwordRequired && !twoFactorPassword.trim()) return;
    setConnecting(true);
    try {
      const response = await fetch("/api/tginvite/mtproto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "completeLogin",
          phoneCode: passwordRequired ? undefined : phoneCode.trim(),
          password: passwordRequired ? twoFactorPassword : undefined,
        }),
      });
      const result = (await response.json()) as { status?: string; error?: string; sessionString?: string };
      if (result?.status === "authenticated") {
        setConnected(true);
        setNeedsPhone(false);
        setCodeSent(false);
        setPasswordRequired(false);
        if (result.sessionString) {
          settingsStorage.set({ ...settingsStorage.get(), mtprotoSession: result.sessionString });
        }
        success("MTProto authenticated", "Real member fetching enabled");
      } else if (result?.status === "password_required") {
        setPasswordRequired(true);
        warning("2FA password required", "Enter your Telegram cloud password");
      } else if (result?.status === "password_invalid") {
        setPasswordRequired(true);
        setTwoFactorPassword("");
        toastError("Invalid 2FA password", result?.error || "Check your Telegram cloud password and try again");
      } else if (result?.status === "login_not_started") {
        setCodeSent(false);
        setPasswordRequired(false);
        setNeedsPhone(true);
        toastError("Login expired", "Send a new Telegram code and try again");
      } else if (result?.status === "code_invalid" || result?.status === "code_expired") {
        toastError("Code failed", result?.error || "Send a new Telegram code and try again");
      } else {
        toastError("Auth failed", result?.error || "Authentication failed");
      }
    } catch {
      toastError("Auth failed", "Could not authenticate");
    } finally {
      setConnecting(false);
    }
  };

  if (connected) {
    return (
      <div className="flex items-center gap-3 p-3 bg-green-500/10 border border-green-500/30 rounded-xl">
        <CheckCircle2 className="h-5 w-5 text-green-400" />
        <div>
          <div className="text-sm font-medium text-green-400">MTProto Connected</div>
          <div className="text-xs text-content-muted">Real member fetching with activity filtering is available</div>
        </div>
      </div>
    );
  }

  if (needsPhone) {
    return (
      <div className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="block text-sm text-content-muted mb-2">API ID</label>
            <input
              type="text"
              value={apiId}
              onChange={(e) => setApiId(e.target.value)}
              placeholder="12345678"
              className={siteDesign.controls.inputClassName}
            />
          </div>
          <div>
            <label className="block text-sm text-content-muted mb-2">API Hash</label>
            <input
              type="password"
              value={apiHash}
              onChange={(e) => setApiHash(e.target.value)}
              placeholder="abcdef1234567890abcdef"
              className={siteDesign.controls.inputClassName}
            />
          </div>
        </div>
        <div>
          <label className="block text-sm text-content-muted mb-2">Phone Number</label>
          <input
            type="tel"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="+79001234567"
            className={siteDesign.controls.inputClassName}
          />
        </div>
        {codeSent && !passwordRequired && (
          <div>
            <label className="block text-sm text-content-muted mb-2">
              Telegram Code {codeDelivery ? `(${codeDelivery})` : ""}
            </label>
            <input
              type="text"
              value={phoneCode}
              onChange={(e) => setPhoneCode(e.target.value)}
              placeholder="12345"
              className={siteDesign.controls.inputClassName}
            />
          </div>
        )}
        {passwordRequired && (
          <div>
            <label className="block text-sm text-content-muted mb-2">Telegram 2FA Password</label>
            <input
              type="password"
              value={twoFactorPassword}
              onChange={(e) => setTwoFactorPassword(e.target.value)}
              placeholder="Cloud password"
              className={siteDesign.controls.inputClassName}
            />
          </div>
        )}
        <button
          onClick={codeSent ? handleCompleteLogin : handleStart}
          disabled={
            connecting ||
            !apiId.trim() ||
            !apiHash.trim() ||
            !phoneNumber.trim() ||
            (codeSent && !passwordRequired && !phoneCode.trim()) ||
            (passwordRequired && !twoFactorPassword.trim())
          }
          className={siteDesign.controls.primaryActionClassName + " disabled:opacity-50"}
        >
          {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
          {connecting ? "Working..." : codeSent ? "Authenticate" : "Send Telegram Code"}
        </button>
        {codeSent && (
          <button
            type="button"
            onClick={() => {
              setCodeSent(false);
              setPasswordRequired(false);
              setPhoneCode("");
              setTwoFactorPassword("");
            }}
            className="text-xs text-content-muted hover:text-content"
          >
            Change phone or resend code
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm text-content-muted mb-2">API ID</label>
        <input
          type="text"
          value={apiId}
          onChange={(e) => setApiId(e.target.value)}
          placeholder="12345678"
          className={siteDesign.controls.inputClassName}
        />
      </div>
      <div>
        <label className="block text-sm text-content-muted mb-2">API Hash</label>
        <input
          type="password"
          value={apiHash}
          onChange={(e) => setApiHash(e.target.value)}
          placeholder="abcdef1234567890abcdef"
          className={siteDesign.controls.inputClassName}
        />
      </div>
      <button
        onClick={handleConnect}
        disabled={connecting || !apiId.trim() || !apiHash.trim()}
        className={siteDesign.controls.primaryActionClassName + " disabled:opacity-50"}
      >
        {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
        {connecting ? "Connecting..." : "Connect MTProto"}
      </button>
    </div>
  );
}
