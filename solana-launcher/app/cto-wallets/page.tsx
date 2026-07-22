"use client";

import { useState, useRef } from "react";
import { Plus, Trash2, Copy, Check, RefreshCw, Clock, Square, FolderPlus, Pencil, ChevronDown, ChevronRight } from "lucide-react";
import { Keypair } from "@solana/web3.js";

interface WalletEntry {
  id: string;
  publicKey: string;
  secretKey: string;
  copied: boolean;
}

function generateWallet(): WalletEntry {
  const kp = Keypair.generate();
  return {
    id: crypto.randomUUID(),
    publicKey: kp.publicKey.toBase58(),
    secretKey: Buffer.from(kp.secretKey).toString("hex"),
    copied: false,
  };
}

function fmtDuration(min: number) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

interface WalletGroup {
  id: string;
  name: string;
  walletIds: string[];
  expanded: boolean;
}

// data-tag: page.cto_wallets
export default function CTOWalletsPage() {
  const [activeTab, setActiveTab] = useState<"all" | "groups">("all");
  const [wallets, setWallets] = useState<WalletEntry[]>([]);
  const [count, setCount] = useState(5);
  const [groups, setGroups] = useState<WalletGroup[]>([]);
  const [newGroupName, setNewGroupName] = useState("");
  const [selectedForGroup, setSelectedForGroup] = useState<Set<string>>(new Set());
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");

  const [schedOpen, setSchedOpen] = useState(false);
  const [schedTotal, setSchedTotal] = useState(20);
  const [schedDurationMin, setSchedDurationMin] = useState(1);
  const [schedRandomize, setSchedRandomize] = useState(false);
  const [schedRunning, setSchedRunning] = useState(false);
  const [schedDone, setSchedDone] = useState(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const addOne = () => setWallets((w) => [...w, generateWallet()]);

  const generateMany = () => {
    const batch = Array.from({ length: count }, generateWallet);
    setWallets((w) => [...w, ...batch]);
  };

  const remove = (id: string) => setWallets((w) => w.filter((x) => x.id !== id));
  const clearAll = () => setWallets([]);

  const copyKey = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setWallets((w) => w.map((x) => (x.id === id ? { ...x, copied: true } : x)));
    setTimeout(() => setWallets((w) => w.map((x) => (x.id === id ? { ...x, copied: false } : x))), 1500);
  };

  const stopScheduled = () => {
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    setSchedRunning(false);
  };

  const startScheduled = () => {
    if (schedRunning) return;
    setSchedRunning(true);
    setSchedDone(0);
    const totalMs = schedDurationMin * 60 * 1000;
    let generated = 0;
    const walletsNeeded = schedTotal;

    const scheduleNext = () => {
      if (generated >= walletsNeeded) { stopScheduled(); return; }
      const remaining = walletsNeeded - generated;
      const batch = schedRandomize ? Math.max(1, Math.floor(Math.random() * Math.min(3, remaining)) + 1) : 1;
      const safeBatch = Math.min(batch, remaining);
      const newWallets = Array.from({ length: safeBatch }, generateWallet);
      setWallets((w) => [...w, ...newWallets]);
      generated += safeBatch;
      setSchedDone(generated);
      if (generated < walletsNeeded) {
        const msLeft = totalMs * (1 - generated / walletsNeeded);
        const delay = schedRandomize
          ? Math.random() * (msLeft / (walletsNeeded - generated)) * 2
          : msLeft / (walletsNeeded - generated);
        timeoutRef.current = setTimeout(scheduleNext, Math.max(300, delay));
      } else {
        stopScheduled();
      }
    };
    scheduleNext();
  };

  const toggleSelectWallet = (id: string) =>
    setSelectedForGroup((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const createGroup = () => {
    const name = newGroupName.trim() || `Group ${groups.length + 1}`;
    if (selectedForGroup.size === 0) return;
    setGroups((g) => [...g, { id: crypto.randomUUID(), name, walletIds: [...selectedForGroup], expanded: true }]);
    setNewGroupName("");
    setSelectedForGroup(new Set());
  };

  const deleteGroup = (id: string) => setGroups((g) => g.filter((x) => x.id !== id));

  const toggleGroupExpand = (id: string) =>
    setGroups((g) => g.map((x) => (x.id === id ? { ...x, expanded: !x.expanded } : x)));

  const saveGroupName = (id: string) => {
    setGroups((g) => g.map((x) => (x.id === id ? { ...x, name: editingGroupName || x.name } : x)));
    setEditingGroupId(null);
  };

  return (
    <div data-tag="page.cto_wallets" className="w-full px-4 py-10 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Wallets</h1>
      </div>

      {/* Controls */}
      <div className="surface-panel p-5 rounded-2xl space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={addOne}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[color-mix(in_srgb,var(--theme-primary)_10%,transparent)] border border-[color-mix(in_srgb,var(--theme-primary)_40%,transparent)] text-[color:var(--theme-primary)] text-sm font-semibold hover:bg-[color-mix(in_srgb,var(--theme-primary)_20%,transparent)] transition"
          >
            <Plus className="w-4 h-4" /> Add One
          </button>

          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={100}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(100, Number(e.target.value))))}
              className="w-16 bg-bg-soft/60 border border-bg-border rounded-lg px-3 py-2 text-sm text-white text-center focus:outline-none focus:border-[color-mix(in_srgb,var(--theme-primary)_50%,transparent)]"
            />
            <button
              type="button"
              onClick={generateMany}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[color-mix(in_srgb,var(--theme-primary)_10%,transparent)] border border-[color-mix(in_srgb,var(--theme-primary)_40%,transparent)] text-[color:var(--theme-primary)] text-sm font-semibold hover:bg-[color-mix(in_srgb,var(--theme-primary)_20%,transparent)] transition"
            >
              <RefreshCw className="w-4 h-4" /> Generate {count}
            </button>
          </div>

          <button
            type="button"
            onClick={() => setSchedOpen((v) => !v)}
            title="Scheduled generation"
            className={[
              "flex items-center gap-2 px-4 py-2.5 rounded-lg border text-sm font-semibold transition",
              schedOpen
                ? "bg-[color-mix(in_srgb,var(--theme-primary)_20%,transparent)] border-[color:var(--theme-primary)] text-[color:var(--theme-primary)]"
                : "border-bg-border bg-bg-soft/40 text-white/60 hover:text-white hover:border-white/20",
            ].join(" ")}
          >
            <Clock className="w-4 h-4" /> Schedule
          </button>

          {wallets.length > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="ml-auto flex items-center gap-2 px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm font-semibold hover:bg-red-500/20 transition"
            >
              <Trash2 className="w-4 h-4" /> Clear All
            </button>
          )}
        </div>

        {schedOpen && (
          <div className="rounded-xl border border-[color-mix(in_srgb,var(--theme-primary)_20%,transparent)] bg-[color-mix(in_srgb,var(--theme-primary)_5%,transparent)] p-4 space-y-5">
            <div className="text-sm font-semibold text-white flex items-center gap-2">
              <Clock className="w-4 h-4 text-[color:var(--theme-primary)]" /> Scheduled Generation
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-white/50">Duration</span>
                <span className="text-[color:var(--theme-primary)] font-semibold">{fmtDuration(schedDurationMin)}</span>
              </div>
              <input
                type="range" min={1} max={480} step={1}
                value={schedDurationMin}
                disabled={schedRunning}
                onChange={(e) => setSchedDurationMin(Number(e.target.value))}
                className="w-full accent-[color:var(--theme-primary)] h-1.5 rounded-full cursor-pointer disabled:opacity-40"
              />
              <div className="flex justify-between text-xs text-white/30">
                <span>1 min</span><span>1h</span><span>2h</span><span>4h</span><span>8h</span>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-white/50">Total wallets</span>
                <span className="text-[color:var(--theme-primary)] font-semibold">{schedTotal}</span>
              </div>
              <input
                type="range" min={1} max={99} step={1}
                value={schedTotal}
                disabled={schedRunning}
                onChange={(e) => setSchedTotal(Number(e.target.value))}
                className="w-full accent-neon-green h-1.5 rounded-full cursor-pointer disabled:opacity-40"
              />
              <div className="flex justify-between text-xs text-white/30">
                <span>1</span><span>25</span><span>50</span><span>75</span><span>99</span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-white font-medium">Random intervals</p>
                <p className="text-[10px] text-white/40">Generates at random moments within the duration</p>
              </div>
              <button
                type="button"
                disabled={schedRunning}
                onClick={() => setSchedRandomize((v) => !v)}
                className={["w-10 h-5 rounded-full transition relative disabled:opacity-40", schedRandomize ? "bg-neon-green" : "bg-bg-border"].join(" ")}
              >
                <span className={["absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all", schedRandomize ? "left-[22px]" : "left-0.5"].join(" ")} />
              </button>
            </div>

            {(schedRunning || schedDone > 0) && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-white/50">
                  <span>Progress</span>
                  <span>{Math.min(schedDone, schedTotal)} / {schedTotal}</span>
                </div>
                <div className="h-1.5 rounded-full bg-bg-border overflow-hidden">
                  <div
                    className="h-full bg-neon-green transition-all duration-500"
                    style={{ width: `${Math.min(100, (schedDone / schedTotal) * 100)}%` }}
                  />
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={startScheduled}
                disabled={schedRunning}
                className="flex-1 py-2 rounded-lg bg-neon-green text-bg text-sm font-semibold hover:shadow-neon-green disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {schedRunning ? "Running..." : "Start"}
              </button>
              {schedRunning && (
                <button
                  type="button"
                  onClick={stopScheduled}
                  className="px-4 py-2 rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 text-sm font-semibold hover:bg-red-500/20 transition flex items-center gap-1"
                >
                  <Square className="w-3 h-3" /> Stop
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-bg-soft/40 rounded-xl border border-bg-border w-fit">
        {(["all", "groups"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={[
              "px-5 py-2 rounded-lg text-sm font-semibold transition",
              activeTab === tab
                ? "bg-neon-green/15 text-neon-green border border-neon-green/30"
                : "text-white/50 hover:text-white",
            ].join(" ")}
          >
            {tab === "all" ? "All Wallets" : "Groups"}
            {tab === "all" && wallets.length > 0 && (
              <span className="ml-1.5 text-xs text-white/30">{wallets.length}</span>
            )}
            {tab === "groups" && groups.length > 0 && (
              <span className="ml-1.5 text-xs text-white/30">{groups.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* All Wallets tab */}
      {activeTab === "all" && (
        wallets.length === 0 ? (
          <div className="glass rounded-2xl p-10 text-center text-white/30 text-sm">
            No wallets yet. Click "Add One" or "Generate N" to create wallets.
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-white/40 uppercase tracking-widest">{wallets.length} wallet{wallets.length !== 1 ? "s" : ""}</p>
            {wallets.map((w, i) => (
              <div key={w.id} className="glass rounded-xl p-4 flex items-center gap-3">
                <span className="text-xs text-white/30 font-mono w-6 text-right shrink-0">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-white/50 mb-0.5">Public Key</p>
                  <p className="text-sm font-mono text-white truncate">{w.publicKey}</p>
                </div>
                <button type="button" onClick={() => copyKey(w.id, w.publicKey)}
                  className="shrink-0 p-2 rounded-lg text-white/40 hover:text-neon-green hover:bg-neon-green/10 transition" aria-label="Copy">
                  {w.copied ? <Check className="w-4 h-4 text-neon-green" /> : <Copy className="w-4 h-4" />}
                </button>
                <button type="button" onClick={() => remove(w.id)}
                  className="shrink-0 p-2 rounded-lg text-white/40 hover:text-red-400 hover:bg-red-500/10 transition" aria-label="Remove">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )
      )}

      {/* Groups tab */}
      {activeTab === "groups" && (
        <div className="space-y-4">
          {/* Create group panel */}
          <div className="glass rounded-2xl p-5 space-y-4">
            <p className="text-sm font-semibold text-white flex items-center gap-2">
              <FolderPlus className="w-4 h-4 text-neon-green" /> Create Group
            </p>

            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Group name..."
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createGroup()}
                className="flex-1 bg-bg-soft/60 border border-bg-border rounded-lg px-4 py-2.5 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-neon-green/50"
              />
              <button type="button" onClick={createGroup}
                disabled={selectedForGroup.size === 0}
                className="px-4 py-2.5 rounded-lg bg-neon-green text-bg text-sm font-semibold hover:shadow-neon-green disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center gap-2">
                <Plus className="w-4 h-4" /> Create ({selectedForGroup.size})
              </button>
            </div>

            {wallets.length === 0 ? (
              <p className="text-xs text-white/30 text-center py-4">No wallets yet — generate some first.</p>
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                <p className="text-xs text-white/40 uppercase tracking-widest">Select wallets</p>
                {wallets.map((w, i) => {
                  const sel = selectedForGroup.has(w.id);
                  return (
                    <button key={w.id} type="button" onClick={() => toggleSelectWallet(w.id)}
                      className={[
                        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition",
                        sel
                          ? "border-neon-green/40 bg-neon-green/10"
                          : "border-bg-border bg-bg-soft/30 hover:border-white/20",
                      ].join(" ")}>
                      <div className={["w-4 h-4 rounded border flex items-center justify-center shrink-0 transition",
                        sel ? "bg-neon-green border-neon-green" : "border-white/30"].join(" ")}>
                        {sel && <Check className="w-2.5 h-2.5 text-bg" />}
                      </div>
                      <span className="text-xs text-white/40 font-mono w-5 shrink-0">{i + 1}</span>
                      <span className="text-sm font-mono text-white truncate">{w.publicKey}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Groups list */}
          {groups.length === 0 ? (
            <div className="glass rounded-2xl p-10 text-center text-white/30 text-sm">
              No groups yet. Select wallets above and click Create.
            </div>
          ) : (
            <div className="space-y-3">
              {groups.map((g) => {
                const groupWallets = wallets.filter((w) => g.walletIds.includes(w.id));
                return (
                  <div key={g.id} className="glass rounded-xl overflow-hidden">
                    <div className="flex items-center gap-3 px-4 py-3">
                      <button type="button" onClick={() => toggleGroupExpand(g.id)}
                        className="text-white/40 hover:text-white transition shrink-0">
                        {g.expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      </button>
                      {editingGroupId === g.id ? (
                        <input autoFocus type="text" value={editingGroupName}
                          onChange={(e) => setEditingGroupName(e.target.value)}
                          onBlur={() => saveGroupName(g.id)}
                          onKeyDown={(e) => e.key === "Enter" && saveGroupName(g.id)}
                          className="flex-1 bg-bg-soft/60 border border-neon-green/40 rounded-lg px-3 py-1 text-sm text-white focus:outline-none" />
                      ) : (
                        <span className="flex-1 text-sm font-semibold text-white">{g.name}</span>
                      )}
                      <span className="text-xs text-white/30">{groupWallets.length} wallet{groupWallets.length !== 1 ? "s" : ""}</span>
                      <button type="button" onClick={() => { setEditingGroupId(g.id); setEditingGroupName(g.name); }}
                        className="p-1.5 rounded-lg text-white/30 hover:text-white hover:bg-white/5 transition">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button type="button" onClick={() => deleteGroup(g.id)}
                        className="p-1.5 rounded-lg text-white/30 hover:text-red-400 hover:bg-red-500/10 transition">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {g.expanded && groupWallets.length > 0 && (
                      <div className="border-t border-bg-border divide-y divide-bg-border">
                        {groupWallets.map((w, i) => (
                          <div key={w.id} className="flex items-center gap-3 px-4 py-2.5">
                            <span className="text-xs text-white/30 font-mono w-5 shrink-0">{i + 1}</span>
                            <p className="flex-1 text-sm font-mono text-white/80 truncate">{w.publicKey}</p>
                            <button type="button" onClick={() => copyKey(w.id, w.publicKey)}
                              className="shrink-0 p-1.5 rounded-lg text-white/30 hover:text-neon-green hover:bg-neon-green/10 transition">
                              {w.copied ? <Check className="w-3.5 h-3.5 text-neon-green" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
