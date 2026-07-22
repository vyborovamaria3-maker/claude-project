import { ReactNode } from "react";
import clsx from "clsx";

type Props = {
  title: string;
  value: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  accent?: "green" | "purple" | "blue";
  tag?: string;
};

const ACCENT: Record<NonNullable<Props["accent"]>, string> = {
  green: "from-neon-green/10 to-transparent border-neon-green/20",
  purple: "from-neon-purple/10 to-transparent border-neon-purple/20",
  blue: "from-neon-blue/10 to-transparent border-neon-blue/20",
};

export default function StatCard({ title, value, subtitle, icon, accent = "green", tag }: Props) {
  return (
    <div
      data-tag={tag}
      className={clsx(
        "glass glass-hover p-5 relative overflow-hidden bg-gradient-to-br",
        ACCENT[accent]
      )}
    >
      <div className="flex items-start justify-between">
        <div className="text-xs uppercase tracking-widest text-white/50">{title}</div>
        {icon && <div className="text-white/40">{icon}</div>}
      </div>
      <div className="mt-3 text-2xl font-bold text-white">{value}</div>
      {subtitle && <div className="mt-1 text-xs text-white/50">{subtitle}</div>}
    </div>
  );
}
