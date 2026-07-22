// data-tag: page.bump_bot
export default function BumpBotPage() {
  return (
    <div data-tag="page.bump_bot" className="w-full min-w-0 max-w-[1200px] mx-auto space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white">Bump Bot</h1>
        <p className="text-sm text-white/50 mt-1">Automated micro-trades to bump token activity</p>
      </div>

      <div data-tag="bump_bot.config" className="glass p-5 space-y-4">
        <Row tag="bump_bot.config.token" label="Target Token" value="—" />
        <Row tag="bump_bot.config.interval" label="Interval (sec)" value="30" />
        <Row tag="bump_bot.config.amount" label="Amount per trade (SOL)" value="0.01" />
        <Row tag="bump_bot.config.status" label="Status" value="Idle" />
      </div>
    </div>
  );
}

function Row({ tag, label, value }: { tag: string; label: string; value: string }) {
  return (
    <div data-tag={tag} className="flex items-center justify-between border-b border-bg-border last:border-0 py-2">
      <span className="text-xs uppercase tracking-widest text-white/50">{label}</span>
      <span className="text-sm text-white/80 font-mono">{value}</span>
    </div>
  );
}
