"use client";

// data-tag: step2.buy_mode_card
export default function BuyModeCard({
  tag,
  icon,
  title,
  description,
  selected,
  onSelect,
}: {
  tag: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-tag={tag}
      onClick={onSelect}
      aria-pressed={selected}
      className={[
        "w-full flex items-center gap-4 px-5 py-4 rounded-xl border text-left transition",
        selected
          ? "bg-neon-green/10 border-neon-green shadow-neon-green"
          : "bg-bg-card/60 border-bg-border hover:border-white/20",
      ].join(" ")}
    >
      <div
        className={[
          "w-11 h-11 shrink-0 rounded-lg flex items-center justify-center border transition",
          selected
            ? "bg-neon-green/20 border-neon-green/60 text-neon-green"
            : "bg-bg-soft/60 border-bg-border text-white/70",
        ].join(" ")}
      >
        {icon}
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-white font-semibold">{title}</div>
        <div className="text-xs md:text-sm text-white/50 mt-0.5">{description}</div>
      </div>

      <span
        data-tag={`${tag}.radio`}
        className={[
          "w-5 h-5 shrink-0 rounded-full border flex items-center justify-center transition",
          selected ? "border-neon-green" : "border-white/30",
        ].join(" ")}
      >
        {selected && <span className="w-2.5 h-2.5 rounded-full bg-neon-green" />}
      </span>
    </button>
  );
}
