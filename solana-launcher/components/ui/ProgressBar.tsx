interface ProgressBarProps {
  value: number; // 0-100
  color?: string;
}

export default function ProgressBar({ value, color = "bg-[color:var(--theme-secondary)]" }: ProgressBarProps) {
  return (
    <div className="w-full h-2 bg-white/10 rounded-full overflow-hidden">
      <div
        className={`h-full ${color} transition-all duration-300`}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}
