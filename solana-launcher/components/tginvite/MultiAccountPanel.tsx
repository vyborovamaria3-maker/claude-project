"use client";

import { useState, useCallback } from "react";
import {
  User,
  Plus,
  Trash2,
  XCircle,
  RefreshCw,
  Shield,
  Wifi,
  WifiOff,
  Clock,
  Activity,
  Settings,
  Smartphone,
} from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";

interface TelegramAccount {
  id: string;
  phone: string;
  username: string;
  status: "active" | "inactive" | "banned" | "cooldown";
  sessions: number;
  lastActive: string;
  invitesToday: number;
  invitesLimit: number;
  proxy?: string;
}

export default function MultiAccountPanel() {
  const [accounts, setAccounts] = useState<TelegramAccount[]>([
    {
      id: "1",
      phone: "+1234567890",
      username: "@admin_main",
      status: "active",
      sessions: 3,
      lastActive: "2 min ago",
      invitesToday: 45,
      invitesLimit: 100,
    },
    {
      id: "2",
      phone: "+0987654321",
      username: "@helper_bot",
      status: "active",
      sessions: 2,
      lastActive: "15 min ago",
      invitesToday: 32,
      invitesLimit: 100,
    },
    {
      id: "3",
      phone: "+1122334455",
      username: "@backup_acc",
      status: "cooldown",
      sessions: 1,
      lastActive: "1 hour ago",
      invitesToday: 98,
      invitesLimit: 100,
      proxy: "socks5://1.2.3.4:1080",
    },
  ]);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newPhone, setNewPhone] = useState("");
  const [newProxy, setNewProxy] = useState("");

  const addAccount = useCallback(() => {
    if (!newPhone) return;

    const newAccount: TelegramAccount = {
      id: Date.now().toString(),
      phone: newPhone,
      username: `@user_${Date.now()}`,
      status: "inactive",
      sessions: 0,
      lastActive: "Never",
      invitesToday: 0,
      invitesLimit: 100,
      proxy: newProxy || undefined,
    };

    setAccounts((prev) => [...prev, newAccount]);
    setNewPhone("");
    setNewProxy("");
    setShowAddModal(false);
  }, [newPhone, newProxy]);

  const removeAccount = useCallback((id: string) => {
    setAccounts((prev) => prev.filter((acc) => acc.id !== id));
  }, []);

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active":
        return "bg-green-500/20 text-green-400";
      case "inactive":
        return "bg-gray-500/20 text-gray-400";
      case "banned":
        return "bg-red-500/20 text-red-400";
      case "cooldown":
        return "bg-yellow-500/20 text-yellow-400";
      default:
        return "bg-gray-500/20 text-gray-400";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "active":
        return <Wifi className="h-4 w-4" />;
      case "inactive":
        return <WifiOff className="h-4 w-4" />;
      case "banned":
        return <XCircle className="h-4 w-4" />;
      case "cooldown":
        return <Clock className="h-4 w-4" />;
      default:
        return <WifiOff className="h-4 w-4" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className={siteDesign.page.panelClassName}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <User className="h-5 w-5 text-[color:var(--theme-primary)]" />
            Multi-Account Manager
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAccounts((prev) => prev.map((a) => ({ ...a, lastActive: new Date().toISOString() })))}
              className={siteDesign.controls.actionButtonClassName}
            >
              <RefreshCw className="h-4 w-4" />
              Refresh All
            </button>
            <button
              onClick={() => setShowAddModal(true)}
              className={siteDesign.controls.primaryActionClassName}
            >
              <Plus className="h-4 w-4" />
              Add Account
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <div className="p-3 bg-bg-elevated rounded-lg text-center">
            <div className="text-2xl font-bold">{accounts.length}</div>
            <div className="text-xs text-content-muted">Total Accounts</div>
          </div>
          <div className="p-3 bg-bg-elevated rounded-lg text-center">
            <div className="text-2xl font-bold text-green-400">
              {accounts.filter((a) => a.status === "active").length}
            </div>
            <div className="text-xs text-content-muted">Active</div>
          </div>
          <div className="p-3 bg-bg-elevated rounded-lg text-center">
            <div className="text-2xl font-bold text-yellow-400">
              {accounts.reduce((acc, a) => acc + a.invitesToday, 0)}
            </div>
            <div className="text-xs text-content-muted">Invites Today</div>
          </div>
          <div className="p-3 bg-bg-elevated rounded-lg text-center">
            <div className="text-2xl font-bold text-blue-400">
              {accounts.reduce((acc, a) => acc + a.sessions, 0)}
            </div>
            <div className="text-xs text-content-muted">Active Sessions</div>
          </div>
        </div>
      </div>

      {/* Account List */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {accounts.map((account) => (
          <div
            key={account.id}
            className={`${siteDesign.page.panelClassName} ${
              account.status === "active"
                ? "!border-green-500/30"
                : account.status === "cooldown"
                ? "!border-yellow-500/30"
                : account.status === "banned"
                ? "!border-red-500/30"
                : ""
            }`}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[color:var(--theme-primary)] to-[color:var(--theme-secondary)] flex items-center justify-center text-white font-bold">
                  {account.phone.slice(-2)}
                </div>
                <div>
                  <div className="font-medium">{account.username}</div>
                  <div className="text-xs text-content-muted">{account.phone}</div>
                </div>
              </div>
              <span className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs ${getStatusColor(account.status)}`}>
                {getStatusIcon(account.status)}
                {account.status}
              </span>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-content-muted">Sessions</span>
                <span>{account.sessions}</span>
              </div>

              <div className="flex items-center justify-between text-sm">
                <span className="text-content-muted">Last Active</span>
                <span>{account.lastActive}</span>
              </div>

              <div>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="text-content-muted">Invites Today</span>
                  <span>
                    {account.invitesToday}/{account.invitesLimit}
                  </span>
                </div>
                <div className="h-1.5 bg-bg-elevated rounded-full">
                  <div
                    className={`h-full rounded-full ${
                      account.invitesToday / account.invitesLimit > 0.9
                        ? "bg-red-400"
                        : account.invitesToday / account.invitesLimit > 0.7
                        ? "bg-yellow-400"
                        : "bg-green-400"
                    }`}
                    style={{ width: `${(account.invitesToday / account.invitesLimit) * 100}%` }}
                  />
                </div>
              </div>

              {account.proxy && (
                <div className="flex items-center gap-2 text-xs text-content-muted">
                  <Shield className="h-3 w-3" />
                  <span className="truncate">{account.proxy}</span>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => alert(`Sessions for ${account.username} (placeholder)`)}
                  className="flex-1 text-xs py-1.5 px-2 bg-bg-elevated rounded-lg hover:bg-bg-card transition"
                >
                  <Activity className="h-3 w-3 inline mr-1" />
                  Sessions
                </button>
                <button
                  onClick={() => alert(`Config for ${account.username} (placeholder)`)}
                  className="flex-1 text-xs py-1.5 px-2 bg-bg-elevated rounded-lg hover:bg-bg-card transition"
                >
                  <Settings className="h-3 w-3 inline mr-1" />
                  Config
                </button>
                <button
                  onClick={() => removeAccount(account.id)}
                  className="text-xs py-1.5 px-2 bg-red-500/10 text-red-400 rounded-lg hover:bg-red-500/20 transition"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Add Account Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md bg-bg-card border border-bg-border rounded-2xl p-6 shadow-2xl">
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Smartphone className="h-5 w-5" />
              Add Telegram Account
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-content-muted mb-2">Phone Number</label>
                <input
                  type="tel"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  placeholder="+1234567890"
                  className={siteDesign.controls.inputClassName}
                />
              </div>

              <div>
                <label className="block text-sm text-content-muted mb-2">Proxy (Optional)</label>
                <input
                  type="text"
                  value={newProxy}
                  onChange={(e) => setNewProxy(e.target.value)}
                  placeholder="socks5://user:pass@host:port"
                  className={siteDesign.controls.inputClassName}
                />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 py-2.5 bg-bg-elevated rounded-xl hover:bg-bg-card transition"
                >
                  Cancel
                </button>
                <button onClick={addAccount} className="flex-1 py-2.5 bg-[color:var(--theme-primary)] text-white rounded-xl hover:brightness-110 transition">
                  Add Account
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
