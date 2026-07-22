"use client";

// data-tag: step3.lbs.wallet_roles
export default function LBSWalletRolesCard({
  bundleCount = 0,
  snipeCount = 0,
  lbsCount = 0,
  dboCount = 0,
}: {
  bundleCount?: number;
  snipeCount?: number;
  lbsCount?: number;
  dboCount?: number;
}) {
  return (
    <div
      data-tag="step3.lbs.wallet_roles"
      className="rounded-xl border border-purple-500/30 bg-purple-500/5 px-4 py-3 flex items-center justify-between gap-4"
    >
      <div className="flex items-start gap-3">
        <span className="mt-1.5 w-2 h-2 rounded-full bg-purple-400" />
        <div>
          <div className="text-white font-semibold text-sm">Wallet Roles</div>
          <p className="text-xs text-white/50 mt-0.5">
            Set each wallet&apos;s role using buttons in the wallet list below
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <RoleBadge tag="step3.lbs.wallet_roles.bundle" color="cyan" label={`${bundleCount} bundle`} />
        <RoleBadge tag="step3.lbs.wallet_roles.snipe" color="green" label={`${snipeCount} snipe`} />
        <RoleBadge tag="step3.lbs.wallet_roles.lbs" color="purple" label={`${lbsCount} LBS`} />
        <RoleBadge tag="step3.lbs.wallet_roles.dbo" color="amber" label={`${dboCount} DBO`} />
      </div>
    </div>
  );
}

function RoleBadge({
  tag,
  color,
  label,
}: {
  tag: string;
  color: "cyan" | "green" | "purple" | "amber";
  label: string;
}) {
  const palette = {
    cyan: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
    green: "bg-neon-green/15 text-neon-green border-neon-green/30",
    purple: "bg-purple-500/15 text-purple-300 border-purple-500/30",
    amber: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  }[color];
  return (
    <span
      data-tag={tag}
      className={`px-2.5 py-1 rounded-md border text-xs font-medium ${palette}`}
    >
      {label}
    </span>
  );
}
