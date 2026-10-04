"use client";

import { useState, useCallback } from "react";
import {
  Beaker,
  Plus,
  Trash2,
  Trophy,
  Users,
  BarChart3,
  Play,
  Pause,
} from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";

interface ABTest {
  id: string;
  name: string;
  status: "running" | "paused" | "completed";
  variants: Variant[];
  startDate: string;
  endDate?: string;
  totalParticipants: number;
  confidence: number;
}

interface Variant {
  id: string;
  name: string;
  description: string;
  participants: number;
  conversions: number;
  conversionRate: number;
  isControl: boolean;
}

export default function ABTesting() {
  const [tests, setTests] = useState<ABTest[]>([
    {
      id: "1",
      name: "Invite Message Style",
      status: "running",
      startDate: "2026-09-01",
      totalParticipants: 1200,
      confidence: 87,
      variants: [
        {
          id: "1a",
          name: "Formal",
          description: "Professional welcome message",
          participants: 600,
          conversions: 180,
          conversionRate: 30,
          isControl: true,
        },
        {
          id: "1b",
          name: "Casual",
          description: "Friendly, informal message",
          participants: 600,
          conversions: 228,
          conversionRate: 38,
          isControl: false,
        },
      ],
    },
    {
      id: "2",
      name: "Delay Timing",
      status: "completed",
      startDate: "2026-08-15",
      endDate: "2026-08-30",
      totalParticipants: 2000,
      confidence: 95,
      variants: [
        {
          id: "2a",
          name: "Fast (50ms)",
          description: "Quick succession invites",
          participants: 1000,
          conversions: 320,
          conversionRate: 32,
          isControl: true,
        },
        {
          id: "2b",
          name: "Slow (200ms)",
          description: "Slower, more natural timing",
          participants: 1000,
          conversions: 410,
          conversionRate: 41,
          isControl: false,
        },
      ],
    },
  ]);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newTest, setNewTest] = useState({
    name: "",
    variantA: "",
    variantB: "",
  });

  const addTest = useCallback(() => {
    if (!newTest.name || !newTest.variantA || !newTest.variantB) return;

    const test: ABTest = {
      id: Date.now().toString(),
      name: newTest.name,
      status: "running",
      startDate: new Date().toISOString().split("T")[0],
      totalParticipants: 0,
      confidence: 0,
      variants: [
        {
          id: `${Date.now()}a`,
          name: newTest.variantA,
          description: "Control group",
          participants: 0,
          conversions: 0,
          conversionRate: 0,
          isControl: true,
        },
        {
          id: `${Date.now()}b`,
          name: newTest.variantB,
          description: "Test group",
          participants: 0,
          conversions: 0,
          conversionRate: 0,
          isControl: false,
        },
      ],
    };

    setTests((prev) => [...prev, test]);
    setNewTest({ name: "", variantA: "", variantB: "" });
    setShowAddModal(false);
  }, [newTest]);

  const deleteTest = useCallback((id: string) => {
    setTests((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toggleTestStatus = useCallback((id: string) => {
    setTests((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, status: t.status === "completed" ? "completed" : t.status === "running" ? "paused" : "running" }
          : t
      )
    );
  }, []);

  const getWinner = (test: ABTest) => {
    const sorted = [...test.variants].sort((a, b) => b.conversionRate - a.conversionRate);
    return sorted[0];
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Beaker className="h-6 w-6 text-[color:var(--theme-primary)]" />
            A/B Testing
          </h2>
          <p className="text-content-muted text-sm">Test and optimize your import strategies</p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className={siteDesign.controls.primaryActionClassName}
        >
          <Plus className="h-4 w-4" />
          New Test
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className={siteDesign.page.panelClassName}>
          <div className="flex items-center gap-2 text-content-muted text-sm mb-2">
            <Beaker className="h-4 w-4" />
            <span>Active Tests</span>
          </div>
          <div className="text-2xl font-bold">{tests.filter((t) => t.status === "running").length}</div>
        </div>
        <div className={siteDesign.page.panelClassName}>
          <div className="flex items-center gap-2 text-content-muted text-sm mb-2">
            <Trophy className="h-4 w-4 text-yellow-400" />
            <span>Completed</span>
          </div>
          <div className="text-2xl font-bold text-yellow-400">{tests.filter((t) => t.status === "completed").length}</div>
        </div>
        <div className={siteDesign.page.panelClassName}>
          <div className="flex items-center gap-2 text-content-muted text-sm mb-2">
            <Users className="h-4 w-4 text-blue-400" />
            <span>Total Participants</span>
          </div>
          <div className="text-2xl font-bold text-blue-400">{tests.reduce((acc, t) => acc + t.totalParticipants, 0).toLocaleString()}</div>
        </div>
        <div className={siteDesign.page.panelClassName}>
          <div className="flex items-center gap-2 text-content-muted text-sm mb-2">
            <BarChart3 className="h-4 w-4 text-green-400" />
            <span>Avg Confidence</span>
          </div>
          <div className="text-2xl font-bold text-green-400">
            {tests.length > 0 ? Math.round(tests.reduce((acc, t) => acc + t.confidence, 0) / tests.length) : 0}%
          </div>
        </div>
      </div>

      {/* Tests List */}
      <div className="space-y-4">
        {tests.map((test) => {
          const winner = getWinner(test);
          return (
            <div
              key={test.id}
              className={`${siteDesign.page.panelClassName} ${
                test.status === "completed" ? "!border-green-500/30" : ""
              }`}
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="flex items-center gap-3">
                    <h3 className="text-lg font-semibold">{test.name}</h3>
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        test.status === "running"
                          ? "bg-green-500/20 text-green-400"
                          : test.status === "paused"
                          ? "bg-yellow-500/20 text-yellow-400"
                          : "bg-blue-500/20 text-blue-400"
                      }`}
                    >
                      {test.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-content-muted mt-1">
                    <span>Started: {test.startDate}</span>
                    {test.endDate && <span>Ended: {test.endDate}</span>}
                    <span>Participants: {test.totalParticipants.toLocaleString()}</span>
                    <span>Confidence: {test.confidence}%</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toggleTestStatus(test.id)}
                    className={siteDesign.controls.iconButtonClassName}
                  >
                    {test.status === "running" ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  </button>
                  <button
                    onClick={() => deleteTest(test.id)}
                    className={siteDesign.controls.iconButtonClassName}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* Variants */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {test.variants.map((variant) => (
                  <div
                    key={variant.id}
                    className={`p-4 bg-bg-elevated rounded-lg border ${
                      variant.id === winner?.id && test.status === "completed"
                        ? "border-green-500/50"
                        : "border-bg-border"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{variant.name}</span>
                        {variant.isControl && (
                          <span className="px-2 py-0.5 bg-content-muted/20 text-content-muted rounded text-xs">
                            Control
                          </span>
                        )}
                        {variant.id === winner?.id && test.status === "completed" && (
                          <span className="px-2 py-0.5 bg-green-500/20 text-green-400 rounded text-xs flex items-center gap-1">
                            <Trophy className="h-3 w-3" />
                            Winner
                          </span>
                        )}
                      </div>
                      <span className="text-sm text-content-muted">{variant.description}</span>
                    </div>

                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <div className="text-lg font-bold">{variant.participants.toLocaleString()}</div>
                        <div className="text-xs text-content-muted">Participants</div>
                      </div>
                      <div>
                        <div className="text-lg font-bold text-green-400">{variant.conversions.toLocaleString()}</div>
                        <div className="text-xs text-content-muted">Conversions</div>
                      </div>
                      <div>
                        <div className="text-lg font-bold text-blue-400">{variant.conversionRate}%</div>
                        <div className="text-xs text-content-muted">Conv. Rate</div>
                      </div>
                    </div>

                    <div className="mt-3 h-2 bg-bg-card rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          variant.id === winner?.id && test.status === "completed"
                            ? "bg-green-400"
                            : "bg-blue-400"
                        }`}
                        style={{ width: `${variant.conversionRate}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              {/* Confidence Meter */}
              <div className="mt-4 pt-4 border-t border-bg-border">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-content-muted">Statistical Confidence</span>
                  <span className={`text-sm font-medium ${test.confidence >= 95 ? "text-green-400" : test.confidence >= 80 ? "text-yellow-400" : "text-red-400"}`}>
                    {test.confidence}%
                  </span>
                </div>
                <div className="h-2 bg-bg-elevated rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      test.confidence >= 95 ? "bg-green-400" : test.confidence >= 80 ? "bg-yellow-400" : "bg-red-400"
                    }`}
                    style={{ width: `${test.confidence}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-content-muted mt-1">
                  <span>0%</span>
                  <span>95% threshold</span>
                  <span>100%</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Test Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md bg-bg-card border border-bg-border rounded-2xl p-6 shadow-2xl">
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Beaker className="h-5 w-5" />
              Create A/B Test
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-content-muted mb-2">Test Name</label>
                <input
                  type="text"
                  value={newTest.name}
                  onChange={(e) => setNewTest((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="Invite Message Test"
                  className={siteDesign.controls.inputClassName}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-content-muted mb-2">Variant A (Control)</label>
                  <input
                    type="text"
                    value={newTest.variantA}
                    onChange={(e) => setNewTest((prev) => ({ ...prev, variantA: e.target.value }))}
                    placeholder="Formal"
                    className={siteDesign.controls.inputClassName}
                  />
                </div>
                <div>
                  <label className="block text-sm text-content-muted mb-2">Variant B (Test)</label>
                  <input
                    type="text"
                    value={newTest.variantB}
                    onChange={(e) => setNewTest((prev) => ({ ...prev, variantB: e.target.value }))}
                    placeholder="Casual"
                    className={siteDesign.controls.inputClassName}
                  />
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 py-2.5 bg-bg-elevated rounded-xl hover:bg-bg-card transition"
                >
                  Cancel
                </button>
                <button
                  onClick={addTest}
                  className="flex-1 py-2.5 bg-[color:var(--theme-primary)] text-white rounded-xl hover:brightness-110 transition"
                >
                  Create Test
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
