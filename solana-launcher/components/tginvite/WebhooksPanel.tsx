"use client";

import { useState, useCallback } from "react";
import {
  Webhook,
  Plus,
  Trash2,
  Copy,
  Send,
  Eye,
  EyeOff,
  Globe,
  Lock,
} from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";

interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  secret?: string;
  events: string[];
  enabled: boolean;
  lastTriggered?: string;
  status: "active" | "failed" | "pending";
  retryCount: number;
}

interface APIKey {
  id: string;
  name: string;
  key: string;
  permissions: string[];
  lastUsed?: string;
  expiresAt?: string;
  createdAt: string;
}

export default function WebhooksPanel() {
  const [webhooks, setWebhooks] = useState<WebhookConfig[]>([
    {
      id: "1",
      name: "Discord Notifications",
      url: "https://discord.com/api/webhooks/123456/abcdef",
      events: ["import.completed", "import.failed"],
      enabled: true,
      lastTriggered: "2 hours ago",
      status: "active",
      retryCount: 0,
    },
    {
      id: "2",
      name: "Slack Alerts",
      url: "https://hooks.slack.com/services/T00/B00/xxx",
      events: ["import.started", "import.completed"],
      enabled: true,
      lastTriggered: "5 hours ago",
      status: "active",
      retryCount: 0,
    },
    {
      id: "3",
      name: "Custom API",
      url: "https://api.example.com/tginvite/webhook",
      secret: "whsec_abc123xyz",
      events: ["*"],
      enabled: false,
      lastTriggered: "3 days ago",
      status: "failed",
      retryCount: 3,
    },
  ]);

  const [apiKeys, setApiKeys] = useState<APIKey[]>([
    {
      id: "1",
      name: "Production API Key",
      key: "tgk_prod_abc123xyz789",
      permissions: ["read", "write", "admin"],
      lastUsed: "1 hour ago",
      createdAt: "2026-08-01",
    },
    {
      id: "2",
      name: "Development Key",
      key: "tgk_dev_def456uvw012",
      permissions: ["read"],
      lastUsed: "Yesterday",
      expiresAt: "2026-12-31",
      createdAt: "2026-08-15",
    },
  ]);

  const [showAddWebhook, setShowAddWebhook] = useState(false);
  const [showAddAPIKey, setShowAddAPIKey] = useState(false);
  const [newWebhook, setNewWebhook] = useState({ name: "", url: "" });
  const [selectedEvents, setSelectedEvents] = useState<string[]>(["import.completed"]);
  const [newAPIKey, setNewAPIKey] = useState({ name: "" });
  const [showSecrets, setShowSecrets] = useState<Set<string>>(new Set());

  const availableEvents = [
    "import.started",
    "import.completed",
    "import.failed",
    "import.paused",
    "channel.added",
    "channel.removed",
    "user.banned",
    "*",
  ];

  const addWebhook = useCallback(() => {
    if (!newWebhook.name || !newWebhook.url) return;

    const webhook: WebhookConfig = {
      id: Date.now().toString(),
      name: newWebhook.name,
      url: newWebhook.url,
      events: selectedEvents.length > 0 ? selectedEvents : ["import.completed"],
      enabled: true,
      status: "pending",
      retryCount: 0,
    };

    setWebhooks((prev) => [...prev, webhook]);
    setNewWebhook({ name: "", url: "" });
    setSelectedEvents(["import.completed"]);
    setShowAddWebhook(false);
  }, [newWebhook, selectedEvents]);

  const deleteWebhook = useCallback((id: string) => {
    setWebhooks((prev) => prev.filter((w) => w.id !== id));
  }, []);

  const toggleWebhook = useCallback((id: string) => {
    setWebhooks((prev) =>
      prev.map((w) => (w.id === id ? { ...w, enabled: !w.enabled } : w))
    );
  }, []);

  const testWebhook = useCallback((id: string) => {
    setWebhooks((prev) =>
      prev.map((w) =>
        w.id === id ? { ...w, lastTriggered: "Just now", status: "active" } : w
      )
    );
  }, []);

  const addAPIKey = useCallback(() => {
    if (!newAPIKey.name) return;

    const key: APIKey = {
      id: Date.now().toString(),
      name: newAPIKey.name,
      key: `tgk_${Math.random().toString(36).substring(2, 15)}`,
      permissions: ["read"],
      createdAt: new Date().toISOString().split("T")[0],
    };

    setApiKeys((prev) => [...prev, key]);
    setNewAPIKey({ name: "" });
    setShowAddAPIKey(false);
  }, [newAPIKey]);

  const deleteAPIKey = useCallback((id: string) => {
    setApiKeys((prev) => prev.filter((k) => k.id !== id));
  }, []);

  const toggleSecretVisibility = useCallback((id: string) => {
    setShowSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
  }, []);

  return (
    <div className="space-y-6">
      {/* Webhooks Section */}
      <div className={siteDesign.page.panelClassName}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Webhook className="h-5 w-5 text-[color:var(--theme-primary)]" />
            Webhooks
          </h3>
          <button
            onClick={() => setShowAddWebhook(true)}
            className={siteDesign.controls.primaryActionClassName}
          >
            <Plus className="h-4 w-4" />
            Add Webhook
          </button>
        </div>

        <div className="space-y-3">
          {webhooks.map((webhook) => (
            <div
              key={webhook.id}
              className={`p-4 bg-bg-elevated rounded-lg border transition ${
                webhook.status === "active"
                  ? "!border-green-500/30"
                  : webhook.status === "failed"
                  ? "!border-red-500/30"
                  : "border-bg-border"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{webhook.name}</span>
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs ${
                      webhook.enabled ? "bg-green-500/20 text-green-400" : "bg-gray-500/20 text-gray-400"
                    }`}
                  >
                    {webhook.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => testWebhook(webhook.id)}
                    className="p-1.5 text-content-muted hover:text-[color:var(--theme-primary)] transition rounded-lg hover:bg-[color:var(--theme-primary)]/10"
                    title="Test webhook"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => toggleWebhook(webhook.id)}
                    className="p-1.5 text-content-muted hover:text-[color:var(--theme-secondary)] transition rounded-lg hover:bg-[color:var(--theme-secondary)]/10"
                  >
                    {webhook.enabled ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                  <button
                    onClick={() => deleteWebhook(webhook.id)}
                    className="p-1.5 text-content-muted hover:text-red-400 transition rounded-lg hover:bg-red-400/10"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2 text-sm text-content-muted mb-2">
                <Globe className="h-3 w-3" />
                <span className="truncate">{webhook.url}</span>
              </div>

              <div className="flex items-center gap-4 text-xs text-content-muted">
                <span>Events: {webhook.events.join(", ")}</span>
                {webhook.lastTriggered && <span>Last: {webhook.lastTriggered}</span>}
                {webhook.retryCount > 0 && (
                  <span className="text-yellow-400">Retries: {webhook.retryCount}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* API Keys Section */}
      <div className={siteDesign.page.panelClassName}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <Lock className="h-5 w-5 text-[color:var(--theme-secondary)]" />
            API Keys
          </h3>
          <button
            onClick={() => setShowAddAPIKey(true)}
            className={siteDesign.controls.primaryActionClassName}
          >
            <Plus className="h-4 w-4" />
            Generate Key
          </button>
        </div>

        <div className="space-y-3">
          {apiKeys.map((apiKey) => (
            <div key={apiKey.id} className="p-4 bg-bg-elevated rounded-lg border border-bg-border">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium">{apiKey.name}</span>
                <button
                  onClick={() => deleteAPIKey(apiKey.id)}
                  className="p-1.5 text-content-muted hover:text-red-400 transition rounded-lg hover:bg-red-400/10"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              <div className="flex items-center gap-2 mb-2">
                <code className="flex-1 p-2 bg-bg-card rounded text-sm font-mono">
                  {showSecrets.has(apiKey.id) ? apiKey.key : "••••••••" + apiKey.key.slice(-4)}
                </code>
                <button
                  onClick={() => toggleSecretVisibility(apiKey.id)}
                  className="p-1.5 text-content-muted hover:text-[color:var(--theme-primary)] transition"
                >
                  {showSecrets.has(apiKey.id) ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
                <button
                  onClick={() => copyToClipboard(apiKey.key)}
                  className="p-1.5 text-content-muted hover:text-[color:var(--theme-primary)] transition"
                >
                  <Copy className="h-4 w-4" />
                </button>
              </div>

              <div className="flex items-center gap-4 text-xs text-content-muted">
                <span>Permissions: {apiKey.permissions.join(", ")}</span>
                {apiKey.lastUsed && <span>Last used: {apiKey.lastUsed}</span>}
                {apiKey.expiresAt && <span>Expires: {apiKey.expiresAt}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Add Webhook Modal */}
      {showAddWebhook && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md bg-bg-card border border-bg-border rounded-2xl p-6 shadow-2xl">
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Webhook className="h-5 w-5" />
              Add Webhook
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-content-muted mb-2">Name</label>
                <input
                  type="text"
                  value={newWebhook.name}
                  onChange={(e) => setNewWebhook((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="My Webhook"
                  className={siteDesign.controls.inputClassName}
                />
              </div>

              <div>
                <label className="block text-sm text-content-muted mb-2">URL</label>
                <input
                  type="url"
                  value={newWebhook.url}
                  onChange={(e) => setNewWebhook((prev) => ({ ...prev, url: e.target.value }))}
                  placeholder="https://example.com/webhook"
                  className={siteDesign.controls.inputClassName}
                />
              </div>

              <div>
                <label className="block text-sm text-content-muted mb-2">Events</label>
                <div className="flex flex-wrap gap-2">
                  {availableEvents.map((event) => (
                    <label key={event} className="flex items-center gap-1 text-sm">
                      <input
                        type="checkbox"
                        className="rounded"
                        checked={selectedEvents.includes(event)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedEvents((prev) => [...prev, event]);
                          } else {
                            setSelectedEvents((prev) => prev.filter((ev) => ev !== event));
                          }
                        }}
                      />
                      <span>{event}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowAddWebhook(false)}
                  className="flex-1 py-2.5 bg-bg-elevated rounded-xl hover:bg-bg-card transition"
                >
                  Cancel
                </button>
                <button
                  onClick={addWebhook}
                  className="flex-1 py-2.5 bg-[color:var(--theme-primary)] text-white rounded-xl hover:brightness-110 transition"
                >
                  Add Webhook
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add API Key Modal */}
      {showAddAPIKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md bg-bg-card border border-bg-border rounded-2xl p-6 shadow-2xl">
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Lock className="h-5 w-5" />
              Generate API Key
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-content-muted mb-2">Key Name</label>
                <input
                  type="text"
                  value={newAPIKey.name}
                  onChange={(e) => setNewAPIKey((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="Production Key"
                  className={siteDesign.controls.inputClassName}
                />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowAddAPIKey(false)}
                  className="flex-1 py-2.5 bg-bg-elevated rounded-xl hover:bg-bg-card transition"
                >
                  Cancel
                </button>
                <button
                  onClick={addAPIKey}
                  className="flex-1 py-2.5 bg-[color:var(--theme-primary)] text-white rounded-xl hover:brightness-110 transition"
                >
                  Generate Key
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
