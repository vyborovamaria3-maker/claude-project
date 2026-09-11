"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import Image from "next/image";
import { List } from "react-window";
import {
  UserCheck,
  Search,
  Download,
  RefreshCw,
  MapPin,
  Globe,
  Clock,
  Bot,
  Shield,
  CheckCircle2,
  Zap,
} from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";

interface UserProfile {
  id: string;
  username: string;
  firstName: string;
  lastName?: string;
  language?: string;
  country?: string;
  lastSeen: string;
  isBot: boolean;
  isVerified: boolean;
  isPremium: boolean;
  avatarUrl?: string;
  activityScore: number;
  qualityScore: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  tags: string[];
  joinedDate?: string;
  messagesCount?: number;
  mediaCount?: number;
}

interface UserRowProps {
  users: UserProfile[];
  selectedUsers: Set<string>;
  toggleUserSelection: (id: string) => void;
}

interface UserListItemProps extends UserRowProps {
  ariaAttributes: {
    "aria-posinset": number;
    "aria-setsize": number;
    role: "listitem";
  };
  index: number;
  style: React.CSSProperties;
}

function getRiskColor(risk: string): string {
  switch (risk) {
    case "low": return "bg-green-500/20 text-green-400";
    case "medium": return "bg-yellow-500/20 text-yellow-400";
    case "high": return "bg-red-500/20 text-red-400";
    case "critical": return "bg-red-500/30 text-red-300";
    default: return "bg-content-muted/20 text-content-muted";
  }
}

function UserListItem({ index, style, users, selectedUsers, toggleUserSelection }: UserListItemProps) {
  const user = users[index];

  return (
    <div
      style={style}
      className={`flex items-center gap-4 p-4 bg-bg-elevated border-b border-bg-border transition ${
        selectedUsers.has(user.id)
          ? "!border-[color:var(--theme-primary)]/30 bg-[color:var(--theme-primary)]/5"
          : ""
      }`}
    >
      <input
        type="checkbox"
        checked={selectedUsers.has(user.id)}
        onChange={() => toggleUserSelection(user.id)}
        className="h-4 w-4 rounded"
      />

      {/* Avatar */}
      <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[color:var(--theme-primary)] to-[color:var(--theme-secondary)] flex items-center justify-center text-white font-bold">
        {user.avatarUrl ? (
          <Image src={user.avatarUrl} alt="" width={48} height={48} className="w-full h-full rounded-full object-cover" unoptimized />
        ) : (
          user.firstName[0]
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">@{user.username}</span>
          {user.isBot && <Bot className="h-3.5 w-3.5 text-red-400" />}
          {user.isVerified && <CheckCircle2 className="h-3.5 w-3.5 text-blue-400" />}
          {user.isPremium && <Zap className="h-3.5 w-3.5 text-yellow-400" />}
        </div>
        <div className="text-sm text-content-muted">
          {user.firstName} {user.lastName}
        </div>
        <div className="flex items-center gap-4 text-xs text-content-muted mt-1">
          {user.country && (
            <span className="flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {user.country}
            </span>
          )}
          {user.language && (
            <span className="flex items-center gap-1">
              <Globe className="h-3 w-3" />
              {user.language}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {user.lastSeen}
          </span>
        </div>
      </div>

      {/* Scores */}
      <div className="flex items-center gap-6">
        <div className="text-center">
          <div className="text-xs text-content-muted mb-1">Activity</div>
          <div className={`text-sm font-bold ${
            user.activityScore >= 0.7 ? "text-green-400" : user.activityScore >= 0.4 ? "text-yellow-400" : "text-red-400"
          }`}>
            {(user.activityScore * 100).toFixed(0)}%
          </div>
        </div>
        <div className="text-center">
          <div className="text-xs text-content-muted mb-1">Quality</div>
          <div className={`text-sm font-bold ${
            user.qualityScore >= 0.7 ? "text-green-400" : user.qualityScore >= 0.4 ? "text-yellow-400" : "text-red-400"
          }`}>
            {(user.qualityScore * 100).toFixed(0)}%
          </div>
        </div>
        <div className={`px-2 py-1 rounded-full text-xs ${getRiskColor(user.riskLevel)}`}>
          {user.riskLevel}
        </div>
      </div>

      {/* Tags */}
      <div className="flex flex-wrap gap-1 max-w-[150px]">
        {user.tags.slice(0, 2).map((tag, i) => (
          <span key={i} className="px-1.5 py-0.5 bg-bg-card rounded text-xs text-content-muted">
            {tag}
          </span>
        ))}
        {user.tags.length > 2 && (
          <span className="px-1.5 py-0.5 bg-bg-card rounded text-xs text-content-muted">
            +{user.tags.length - 2}
          </span>
        )}
      </div>
    </div>
  );
};

export default function UserProfilingPanel() {
  const [users] = useState<UserProfile[]>([
    {
      id: "1",
      username: "john_crypto",
      firstName: "John",
      lastName: "Doe",
      language: "en",
      country: "US",
      lastSeen: "2 hours ago",
      isBot: false,
      isVerified: true,
      isPremium: true,
      activityScore: 0.92,
      qualityScore: 0.88,
      riskLevel: "low",
      tags: ["crypto", "trader", "active"],
      messagesCount: 1250,
      mediaCount: 45,
    },
    {
      id: "2",
      username: "crypto_bot_2024",
      firstName: "Crypto",
      lastName: "Bot",
      lastSeen: "5 min ago",
      isBot: true,
      isVerified: false,
      isPremium: false,
      activityScore: 0.99,
      qualityScore: 0.15,
      riskLevel: "high",
      tags: ["bot", "spam"],
      messagesCount: 50000,
      mediaCount: 0,
    },
    {
      id: "3",
      username: "sarah_trader",
      firstName: "Sarah",
      lastName: "Smith",
      language: "en",
      country: "UK",
      lastSeen: "1 hour ago",
      isBot: false,
      isVerified: false,
      isPremium: true,
      activityScore: 0.78,
      qualityScore: 0.85,
      riskLevel: "low",
      tags: ["trader", "solana", "nft"],
      messagesCount: 890,
      mediaCount: 120,
    },
  ]);

  const [searchQuery, setSearchQuery] = useState("");
  const [filters, setFilters] = useState({
    hideBots: true,
    hideLowQuality: false,
    minActivity: 0,
    maxActivity: 1,
    countries: [] as string[],
    languages: [] as string[],
  });
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [scanStatus, setScanStatus] = useState<"idle" | "scanning" | "completed">("idle");
  const [scanProgress, setScanProgress] = useState(0);
  const scanIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
    };
  }, []);

  const filteredUsers = users.filter((user) => {
    if (searchQuery && !user.username.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !user.firstName.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }
    if (filters.hideBots && user.isBot) return false;
    if (filters.hideLowQuality && user.qualityScore < 0.5) return false;
    if (user.activityScore < filters.minActivity || user.activityScore > filters.maxActivity) return false;
    return true;
  });

  const startScan = useCallback(() => {
    setScanStatus("scanning");
    setScanProgress(0);

    const interval = setInterval(() => {
      setScanProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          scanIntervalRef.current = null;
          setScanStatus("completed");
          return 100;
        }
        return Math.min(prev + Math.random() * 10, 100);
      });
    }, 200);
    scanIntervalRef.current = interval;
  }, []);

  const toggleUserSelection = useCallback((id: string) => {
    setSelectedUsers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectAllUsers = useCallback(() => {
    const allFilteredSelected = filteredUsers.every((u) => selectedUsers.has(u.id));
    if (allFilteredSelected) {
      setSelectedUsers((prev) => {
        const next = new Set(prev);
        filteredUsers.forEach((u) => next.delete(u.id));
        return next;
      });
    } else {
      setSelectedUsers((prev) => {
        const next = new Set(prev);
        filteredUsers.forEach((u) => next.add(u.id));
        return next;
      });
    }
  }, [filteredUsers, selectedUsers]);

  const exportUsers = useCallback(() => {
    const selected = users.filter((u) => selectedUsers.has(u.id));
    const data = JSON.stringify(selected.length > 0 ? selected : filteredUsers, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `users_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [users, selectedUsers, filteredUsers]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className={siteDesign.page.panelClassName}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <UserCheck className="h-5 w-5 text-[color:var(--theme-primary)]" />
            User Profiling & Analysis
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={startScan}
              disabled={scanStatus === "scanning"}
              className={siteDesign.controls.actionButtonClassName}
            >
              {scanStatus === "scanning" ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Zap className="h-4 w-4" />
              )}
              {scanStatus === "scanning" ? "Scanning..." : "Scan Channel"}
            </button>
            <button onClick={exportUsers} className={siteDesign.controls.actionButtonClassName}>
              <Download className="h-4 w-4" />
              Export
            </button>
          </div>
        </div>

        {/* Scan Progress */}
        {scanStatus === "scanning" && (
          <div className="mb-4">
            <div className="flex justify-between text-sm mb-1">
              <span className="text-content-muted">Scanning users...</span>
              <span>{Math.round(scanProgress)}%</span>
            </div>
            <div className="h-2 bg-bg-elevated rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-[color:var(--theme-primary)] to-[color:var(--theme-secondary)] transition-all duration-300"
                style={{ width: `${scanProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="p-3 bg-bg-elevated rounded-lg text-center">
            <div className="text-2xl font-bold">{users.length}</div>
            <div className="text-xs text-content-muted">Total Users</div>
          </div>
          <div className="p-3 bg-bg-elevated rounded-lg text-center">
            <div className="text-2xl font-bold text-green-400">
              {users.filter((u) => !u.isBot).length}
            </div>
            <div className="text-xs text-content-muted">Real Users</div>
          </div>
          <div className="p-3 bg-bg-elevated rounded-lg text-center">
            <div className="text-2xl font-bold text-red-400">
              {users.filter((u) => u.isBot).length}
            </div>
            <div className="text-xs text-content-muted">Bots</div>
          </div>
          <div className="p-3 bg-bg-elevated rounded-lg text-center">
            <div className="text-2xl font-bold text-blue-400">
              {users.filter((u) => u.isVerified).length}
            </div>
            <div className="text-xs text-content-muted">Verified</div>
          </div>
          <div className="p-3 bg-bg-elevated rounded-lg text-center">
            <div className="text-2xl font-bold text-purple-400">
              {users.filter((u) => u.isPremium).length}
            </div>
            <div className="text-xs text-content-muted">Premium</div>
          </div>
        </div>
      </div>

      {/* Search and Filters */}
      <div className={siteDesign.page.panelClassName}>
        <div className="flex flex-col md:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-content-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search users by username or name..."
              className={`${siteDesign.controls.inputClassName} pl-10`}
            />
          </div>
          <div className="flex gap-2">
            <label className="flex items-center gap-2 px-3 py-2 bg-bg-elevated rounded-lg cursor-pointer">
              <input
                type="checkbox"
                checked={filters.hideBots}
                onChange={(e) => setFilters((prev) => ({ ...prev, hideBots: e.target.checked }))}
                className="rounded"
              />
              <Bot className="h-4 w-4 text-content-muted" />
              <span className="text-sm">Hide Bots</span>
            </label>
            <label className="flex items-center gap-2 px-3 py-2 bg-bg-elevated rounded-lg cursor-pointer">
              <input
                type="checkbox"
                checked={filters.hideLowQuality}
                onChange={(e) => setFilters((prev) => ({ ...prev, hideLowQuality: e.target.checked }))}
                className="rounded"
              />
              <Shield className="h-4 w-4 text-content-muted" />
              <span className="text-sm">Quality Only</span>
            </label>
          </div>
        </div>

        {/* Activity Range */}
        <div className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-content-muted mb-2">
              Min Activity: {(filters.minActivity * 100).toFixed(0)}%
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={filters.minActivity}
              onChange={(e) => setFilters((prev) => ({ ...prev, minActivity: parseFloat(e.target.value) }))}
              className="w-full accent-[color:var(--theme-primary)]"
            />
          </div>
          <div>
            <label className="block text-sm text-content-muted mb-2">
              Max Activity: {(filters.maxActivity * 100).toFixed(0)}%
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={filters.maxActivity}
              onChange={(e) => setFilters((prev) => ({ ...prev, maxActivity: parseFloat(e.target.value) }))}
              className="w-full accent-[color:var(--theme-secondary)]"
            />
          </div>
        </div>
      </div>

      {/* User List */}
      <div className={siteDesign.page.panelClassName}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-medium">Users ({filteredUsers.length})</h3>
          <button onClick={selectAllUsers} className="text-sm text-[color:var(--theme-primary)] hover:underline">
            {selectedUsers.size === filteredUsers.length ? "Deselect All" : "Select All"}
          </button>
        </div>

        {filteredUsers.length === 0 ? (
          <div className="text-center py-8 text-content-muted">
            <UserCheck className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>No users found</p>
          </div>
        ) : (
          <List<UserRowProps>
            defaultHeight={500}
            rowCount={filteredUsers.length}
            rowHeight={80}
            className="border border-bg-border rounded-lg"
            rowComponent={UserListItem}
            rowProps={{
              users: filteredUsers,
              selectedUsers,
              toggleUserSelection,
            }}
          />
        )}

        {/* Bulk Actions */}
        {selectedUsers.size > 0 && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-bg-border">
            <span className="text-sm text-content-muted">{selectedUsers.size} users selected</span>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const selected = filteredUsers.filter((u) => selectedUsers.has(u.id));
                  alert(`Inviting ${selected.length} users (placeholder)`);
                }}
                className="px-3 py-1.5 bg-green-500/10 text-green-400 rounded-lg text-sm hover:bg-green-500/20"
              >
                Invite Selected
              </button>
              <button
                onClick={() => {
                  const selected = filteredUsers.filter((u) => selectedUsers.has(u.id));
                  alert(`Added ${selected.length} users to whitelist (placeholder)`);
                }}
                className="px-3 py-1.5 bg-yellow-500/10 text-yellow-400 rounded-lg text-sm hover:bg-yellow-500/20"
              >
                Add to Whitelist
              </button>
              <button
                onClick={() => {
                  const selected = filteredUsers.filter((u) => selectedUsers.has(u.id));
                  alert(`Added ${selected.length} users to blacklist (placeholder)`);
                }}
                className="px-3 py-1.5 bg-red-500/10 text-red-400 rounded-lg text-sm hover:bg-red-500/20"
              >
                Add to Blacklist
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
