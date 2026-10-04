"use client";

import { useState, useCallback } from "react";
import { useToast } from "./Toast";
import {
  FileText,
  Plus,
  Trash2,
  Copy,
  Download,
  Upload,
  Star,
} from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";

interface ConfigTemplate {
  id: string;
  name: string;
  description: string;
  filters: {
    minActivity: number;
    minQuality: number;
    maxAge: number;
    limit: number;
    delay: number;
    stealthMode: boolean;
  };
  schedule?: {
    enabled: boolean;
    interval: string;
    maxPerDay: number;
  };
  createdAt: string;
  lastUsed?: string;
  usageCount: number;
  isFavorite: boolean;
}

export default function TemplatesPanel({ onApply }: { onApply?: (filters: { minActivity: number; minQuality: number; maxAge: number; delay: number; limit: number; stealthMode: boolean }) => void }) {
  const { warning: toastWarning } = useToast();
  const [templates, setTemplates] = useState<ConfigTemplate[]>([
    {
      id: "1",
      name: "Aggressive Growth",
      description: "Fast invite with minimal filters for maximum reach",
      filters: {
        minActivity: 0.2,
        minQuality: 0.3,
        maxAge: 90,
        limit: 5000,
        delay: 50,
        stealthMode: false,
      },
      createdAt: "2026-08-15",
      lastUsed: "2026-09-07",
      usageCount: 12,
      isFavorite: true,
    },
    {
      id: "2",
      name: "Safe & Steady",
      description: "Conservative approach with stealth mode enabled",
      filters: {
        minActivity: 0.5,
        minQuality: 0.6,
        maxAge: 30,
        limit: 500,
        delay: 200,
        stealthMode: true,
      },
      schedule: {
        enabled: true,
        interval: "daily",
        maxPerDay: 50,
      },
      createdAt: "2026-08-20",
      lastUsed: "2026-09-06",
      usageCount: 28,
      isFavorite: true,
    },
    {
      id: "3",
      name: "Quality First",
      description: "Focus on high-quality, active users only",
      filters: {
        minActivity: 0.7,
        minQuality: 0.8,
        maxAge: 14,
        limit: 200,
        delay: 300,
        stealthMode: true,
      },
      createdAt: "2026-09-01",
      lastUsed: "2026-09-05",
      usageCount: 5,
      isFavorite: false,
    },
  ]);

  const [selectedTemplate, setSelectedTemplate] = useState<ConfigTemplate | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTemplate, setNewTemplate] = useState({
    name: "",
    description: "",
  });

  const toggleFavorite = useCallback((id: string) => {
    setTemplates((prev) =>
      prev.map((t) => (t.id === id ? { ...t, isFavorite: !t.isFavorite } : t))
    );
  }, []);

  const deleteTemplate = useCallback((id: string) => {
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const duplicateTemplate = useCallback((template: ConfigTemplate) => {
    const newTemplate: ConfigTemplate = {
      ...template,
      id: Date.now().toString(),
      name: `${template.name} (Copy)`,
      createdAt: new Date().toISOString().split("T")[0],
      lastUsed: undefined,
      usageCount: 0,
      isFavorite: false,
    };
    setTemplates((prev) => [...prev, newTemplate]);
  }, []);

  const createTemplate = useCallback(() => {
    if (!newTemplate.name) return;

    const template: ConfigTemplate = {
      id: Date.now().toString(),
      name: newTemplate.name,
      description: newTemplate.description,
      filters: {
        minActivity: 0.5,
        minQuality: 0.5,
        maxAge: 30,
        limit: 1000,
        delay: 100,
        stealthMode: true,
      },
      createdAt: new Date().toISOString().split("T")[0],
      usageCount: 0,
      isFavorite: false,
    };

    setTemplates((prev) => [...prev, template]);
    setNewTemplate({ name: "", description: "" });
    setShowCreateModal(false);
  }, [newTemplate]);

  const exportTemplate = useCallback((template: ConfigTemplate) => {
    const data = JSON.stringify(template, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `template_${template.name.toLowerCase().replace(/\s+/g, "_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const importTemplate = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const template = JSON.parse(e.target?.result as string);
        setTemplates((prev) => [...prev, { ...template, id: Date.now().toString() }]);
      } catch {
        toastWarning("Invalid file", "The template file could not be parsed");
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  }, [toastWarning]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className={siteDesign.page.panelClassName}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            <FileText className="h-5 w-5 text-[color:var(--theme-primary)]" />
            Configuration Templates
          </h3>
          <div className="flex items-center gap-2">
            <input
              type="file"
              accept=".json"
              onChange={importTemplate}
              className="hidden"
              id="import-template"
            />
            <label
              htmlFor="import-template"
              className={siteDesign.controls.actionButtonClassName + " cursor-pointer"}
            >
              <Upload className="h-4 w-4" />
              Import
            </label>
            <button
              onClick={() => setShowCreateModal(true)}
              className={siteDesign.controls.primaryActionClassName}
            >
              <Plus className="h-4 w-4" />
              Create Template
            </button>
          </div>
        </div>

        <p className="text-sm text-content-muted">
          Save and reuse your import configurations across different campaigns.
        </p>
      </div>

      {/* Template List */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {templates.map((template) => (
          <div
            key={template.id}
            className={`${siteDesign.page.panelClassName} ${
              selectedTemplate?.id === template.id ? "!border-[color:var(--theme-primary)]" : ""
            }`}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggleFavorite(template.id)}
                  className={`p-1 rounded-lg transition ${
                    template.isFavorite ? "text-yellow-400" : "text-content-muted hover:text-yellow-400"
                  }`}
                >
                  <Star className={`h-5 w-5 ${template.isFavorite ? "fill-current" : ""}`} />
                </button>
                <div>
                  <div className="font-medium">{template.name}</div>
                  <div className="text-xs text-content-muted">{template.description}</div>
                </div>
              </div>
            </div>

            <div className="space-y-2 mb-4">
              <div className="flex items-center justify-between text-xs">
                <span className="text-content-muted">Min Activity</span>
                <span>{(template.filters.minActivity * 100).toFixed(0)}%</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-content-muted">Min Quality</span>
                <span>{(template.filters.minQuality * 100).toFixed(0)}%</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-content-muted">Delay</span>
                <span>{template.filters.delay}ms</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-content-muted">Stealth</span>
                <span>{template.filters.stealthMode ? "ON" : "OFF"}</span>
              </div>
              {template.schedule?.enabled && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-content-muted">Schedule</span>
                  <span className="text-green-400">{template.schedule.interval}</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between text-xs text-content-muted mb-3 pt-3 border-t border-bg-border">
              <span>Used {template.usageCount} times</span>
              <span>{template.createdAt}</span>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => {
                  setSelectedTemplate(template);
                  onApply?.(template.filters);
                }}
                className="flex-1 text-xs py-1.5 bg-[color:var(--theme-primary)]/10 text-[color:var(--theme-primary)] rounded-lg hover:bg-[color:var(--theme-primary)]/20 transition"
              >
                Apply
              </button>
              <button
                onClick={() => duplicateTemplate(template)}
                className="text-xs py-1.5 px-2 bg-bg-elevated rounded-lg hover:bg-bg-card transition"
              >
                <Copy className="h-3 w-3" />
              </button>
              <button
                onClick={() => exportTemplate(template)}
                className="text-xs py-1.5 px-2 bg-bg-elevated rounded-lg hover:bg-bg-card transition"
              >
                <Download className="h-3 w-3" />
              </button>
              <button
                onClick={() => deleteTemplate(template.id)}
                className="text-xs py-1.5 px-2 bg-red-500/10 text-red-400 rounded-lg hover:bg-red-500/20 transition"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Create Template Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md bg-bg-card border border-bg-border rounded-2xl p-6 shadow-2xl">
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Create New Template
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-content-muted mb-2">Template Name</label>
                <input
                  type="text"
                  value={newTemplate.name}
                  onChange={(e) => setNewTemplate((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="My Custom Template"
                  className={siteDesign.controls.inputClassName}
                />
              </div>

              <div>
                <label className="block text-sm text-content-muted mb-2">Description</label>
                <textarea
                  value={newTemplate.description}
                  onChange={(e) => setNewTemplate((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder="Describe what this template is for..."
                  className={siteDesign.controls.inputClassName + " min-h-[80px] resize-none"}
                />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 py-2.5 bg-bg-elevated rounded-xl hover:bg-bg-card transition"
                >
                  Cancel
                </button>
                <button
                  onClick={createTemplate}
                  className="flex-1 py-2.5 bg-[color:var(--theme-primary)] text-white rounded-xl hover:brightness-110 transition"
                >
                  Create Template
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
