import { Plus, Download } from "lucide-react";

// data-tag: page.wallets
export default function WalletsPage() {
  return (
    <div data-tag="page.wallets" className="w-full min-w-0 max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-white">Wallets</h1>
          <p className="text-sm text-white/50 mt-1">Manage and monitor your Solana wallets</p>
        </div>
        <div className="flex items-center gap-2">
          <button data-tag="wallets.action.generate" className="flex items-center gap-2 px-3 py-2 rounded-lg border border-neon-green/40 bg-neon-green/10 text-neon-green text-sm hover:bg-neon-green/20 transition">
            <Plus className="w-4 h-4" /> Generate
          </button>
          <button data-tag="wallets.action.import" className="flex items-center gap-2 px-3 py-2 rounded-lg border border-bg-border text-white/70 text-sm hover:border-neon-purple/40 hover:text-neon-purple transition">
            <Download className="w-4 h-4" /> Import
          </button>
        </div>
      </div>

      <div data-tag="wallets.table" className="glass p-5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-widest text-white/40">
              <th className="py-2 pr-4">Address</th>
              <th className="py-2 pr-4">SOL</th>
              <th className="py-2 pr-4">Tokens</th>
              <th className="py-2 pr-4">Last Activity</th>
            </tr>
          </thead>
          <tbody className="text-white/70">
            <tr className="border-t border-bg-border" data-tag="wallets.row">
              <td className="py-3 pr-4 font-mono">No wallets yet</td>
              <td className="py-3 pr-4">—</td>
              <td className="py-3 pr-4">—</td>
              <td className="py-3 pr-4">—</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
