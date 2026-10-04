"use client";

import { useState, useCallback } from "react";
import {
  Target,
  Plus,
  Trash2,
  CheckCircle2,
  Clock,
  TrendingUp,
  Star,
  Flag,
  Flame,
} from "lucide-react";
import { siteDesign } from "@/lib/siteDesign";

interface Goal {
  id: string;
  name: string;
  type: "daily" | "weekly" | "monthly" | "custom";
  target: number;
  current: number;
  unit: string;
  deadline?: string;
  status: "active" | "completed" | "failed";
  priority: "low" | "medium" | "high";
  rewards?: string[];
}

export default function GoalTracking() {
  const [goals, setGoals] = useState<Goal[]>([
    {
      id: "1",
      name: "Daily Import Target",
      type: "daily",
      target: 500,
      current: 342,
      unit: "users",
      deadline: "End of day",
      status: "active",
      priority: "high",
      rewards: ["+10 XP", "Unlock badge"],
    },
    {
      id: "2",
      name: "Weekly Quality Users",
      type: "weekly",
      target: 2000,
      current: 1450,
      unit: "users",
      deadline: "5 days left",
      status: "active",
      priority: "medium",
      rewards: ["Priority queue access"],
    },
    {
      id: "3",
      name: "Channel Growth",
      type: "monthly",
      target: 10000,
      current: 8500,
      unit: "members",
      deadline: "20 days left",
      status: "active",
      priority: "high",
      rewards: ["Premium features", "Custom badge"],
    },
    {
      id: "4",
      name: "Zero Failed Invites",
      type: "daily",
      target: 0,
      current: 12,
      unit: "failures",
      deadline: "End of day",
      status: "failed",
      priority: "low",
    },
  ]);

  const [showAddModal, setShowAddModal] = useState(false);
  const [newGoal, setNewGoal] = useState({
    name: "",
    type: "daily" as Goal["type"],
    target: 100,
    unit: "users",
    priority: "medium" as Goal["priority"],
  });

  const addGoal = useCallback(() => {
    if (!newGoal.name) return;

    const goal: Goal = {
      id: Date.now().toString(),
      name: newGoal.name,
      type: newGoal.type,
      target: newGoal.target,
      current: 0,
      unit: newGoal.unit,
      status: "active",
      priority: newGoal.priority,
    };

    setGoals((prev) => [...prev, goal]);
    setNewGoal({ name: "", type: "daily", target: 100, unit: "users", priority: "medium" });
    setShowAddModal(false);
  }, [newGoal]);

  const deleteGoal = useCallback((id: string) => {
    setGoals((prev) => prev.filter((g) => g.id !== id));
  }, []);

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case "high":
        return "bg-red-500/20 text-red-400";
      case "medium":
        return "bg-yellow-500/20 text-yellow-400";
      case "low":
        return "bg-green-500/20 text-green-400";
      default:
        return "bg-gray-500/20 text-gray-400";
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle2 className="h-5 w-5 text-green-400" />;
      case "failed":
        return <Target className="h-5 w-5 text-red-400" />;
      default:
        return <Clock className="h-5 w-5 text-yellow-400" />;
    }
  };

  const totalXp = goals
    .filter((g) => g.status === "completed")
    .reduce((acc, g) => acc + g.target * 10, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Target className="h-6 w-6 text-[color:var(--theme-primary)]" />
            Goal Tracking
          </h2>
          <p className="text-content-muted text-sm">Set and track your import goals</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-4 py-2 bg-yellow-500/10 rounded-lg">
            <Star className="h-5 w-5 text-yellow-400" />
            <span className="font-bold text-yellow-400">{totalXp} XP</span>
          </div>
          <button
            onClick={() => setShowAddModal(true)}
            className={siteDesign.controls.primaryActionClassName}
          >
            <Plus className="h-4 w-4" />
            New Goal
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className={siteDesign.page.panelClassName}>
          <div className="flex items-center gap-2 text-content-muted text-sm mb-2">
            <Flag className="h-4 w-4" />
            <span>Active Goals</span>
          </div>
          <div className="text-2xl font-bold">{goals.filter((g) => g.status === "active").length}</div>
        </div>
        <div className={siteDesign.page.panelClassName}>
          <div className="flex items-center gap-2 text-content-muted text-sm mb-2">
            <CheckCircle2 className="h-4 w-4 text-green-400" />
            <span>Completed</span>
          </div>
          <div className="text-2xl font-bold text-green-400">{goals.filter((g) => g.status === "completed").length}</div>
        </div>
        <div className={siteDesign.page.panelClassName}>
          <div className="flex items-center gap-2 text-content-muted text-sm mb-2">
            <TrendingUp className="h-4 w-4 text-blue-400" />
            <span>Total Progress</span>
          </div>
          <div className="text-2xl font-bold text-blue-400">
            {goals.length > 0 ? Math.round(goals.reduce((acc, g) => acc + (g.target > 0 ? (g.current / g.target) * 100 : 0), 0) / goals.length) : 0}%
          </div>
        </div>
        <div className={siteDesign.page.panelClassName}>
          <div className="flex items-center gap-2 text-content-muted text-sm mb-2">
            <Flame className="h-4 w-4 text-orange-400" />
            <span>Streak</span>
          </div>
          <div className="text-2xl font-bold text-orange-400">7 days</div>
        </div>
      </div>

      {/* Goals List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {goals.map((goal) => {
          const progress = goal.target === 0 ? (goal.current === 0 ? 100 : 0) : Math.min((goal.current / goal.target) * 100, 100);
          return (
            <div
              key={goal.id}
              className={`${siteDesign.page.panelClassName} ${
                goal.status === "completed"
                  ? "!border-green-500/30"
                  : goal.status === "failed"
                  ? "!border-red-500/30"
                  : ""
              }`}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  {getStatusIcon(goal.status)}
                  <div>
                    <h4 className="font-medium">{goal.name}</h4>
                    <div className="flex items-center gap-2 text-xs text-content-muted">
                      <span className={`px-2 py-0.5 rounded-full ${getPriorityColor(goal.priority)}`}>
                        {goal.priority}
                      </span>
                      <span className="capitalize">{goal.type}</span>
                      {goal.deadline && <span>• {goal.deadline}</span>}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => deleteGoal(goal.id)}
                  className="p-1 text-content-muted hover:text-red-400 transition"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-content-muted">Progress</span>
                  <span>
                    {goal.current.toLocaleString()} / {goal.target.toLocaleString()} {goal.unit}
                  </span>
                </div>
                <div className="h-3 bg-bg-elevated rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      progress >= 100
                        ? "bg-gradient-to-r from-green-400 to-emerald-500"
                        : progress >= 70
                        ? "bg-gradient-to-r from-blue-400 to-cyan-500"
                        : "bg-gradient-to-r from-yellow-400 to-orange-500"
                    }`}
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{progress.toFixed(0)}%</span>
                  {goal.rewards && goal.rewards.length > 0 && (
                    <div className="flex gap-1">
                      {goal.rewards.map((reward, i) => (
                        <span key={i} className="px-2 py-0.5 bg-[color:var(--theme-primary)]/10 text-[color:var(--theme-primary)] rounded text-xs">
                          {reward}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Goal Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-md bg-bg-card border border-bg-border rounded-2xl p-6 shadow-2xl">
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Target className="h-5 w-5" />
              Create New Goal
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-content-muted mb-2">Goal Name</label>
                <input
                  type="text"
                  value={newGoal.name}
                  onChange={(e) => setNewGoal((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="My Import Goal"
                  className={siteDesign.controls.inputClassName}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-content-muted mb-2">Type</label>
                  <select
                    value={newGoal.type}
                    onChange={(e) => setNewGoal((prev) => ({ ...prev, type: e.target.value as Goal["type"] }))}
                    className={siteDesign.controls.inputClassName}
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-content-muted mb-2">Priority</label>
                  <select
                    value={newGoal.priority}
                    onChange={(e) => setNewGoal((prev) => ({ ...prev, priority: e.target.value as Goal["priority"] }))}
                    className={siteDesign.controls.inputClassName}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-content-muted mb-2">Target</label>
                  <input
                    type="number"
                    value={newGoal.target}
                    onChange={(e) => setNewGoal((prev) => ({ ...prev, target: parseInt(e.target.value) || 100 }))}
                    className={siteDesign.controls.inputClassName}
                  />
                </div>
                <div>
                  <label className="block text-sm text-content-muted mb-2">Unit</label>
                  <select
                    value={newGoal.unit}
                    onChange={(e) => setNewGoal((prev) => ({ ...prev, unit: e.target.value }))}
                    className={siteDesign.controls.inputClassName}
                  >
                    <option value="users">Users</option>
                    <option value="members">Members</option>
                    <option value="channels">Channels</option>
                    <option value="invites">Invites</option>
                  </select>
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
                  onClick={addGoal}
                  className="flex-1 py-2.5 bg-[color:var(--theme-primary)] text-white rounded-xl hover:brightness-110 transition"
                >
                  Create Goal
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
