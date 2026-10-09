import { q, closePool } from "../lib/trade/pg";

interface AccountRow {
  name: string;
  status: string;
  tier: string;
  cooldown_until: string;
  account_busy_until: string;
  last_success_at: string | null;
  last_error_at: string | null;
  weight_used_this_hour: number;
  weight_quota_per_hour: number;
}

const ACTIVE_STATUSES = ["active"];
const DISABLED_STATUSES = ["cooldown", "captcha", "banned"];

function fmtTs(v: string | number | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return `${new Date(n).toISOString().slice(0, 19).replace("T", " ")}Z`;
}

function fmtCooldown(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

async function main() {
  const rows = await q<AccountRow>(
    `SELECT name, status, tier, cooldown_until, account_busy_until,
            last_success_at, last_error_at,
            weight_used_this_hour, weight_quota_per_hour
     FROM x_accounts
     ORDER BY CASE tier WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 WHEN 'new' THEN 2 ELSE 3 END,
              name`
  );

  const now = Date.now();
  const total = rows.length;
  const active = rows.filter((r) => ACTIVE_STATUSES.includes(r.status) && r.tier !== "retired").length;
  const disabled = rows.filter((r) => DISABLED_STATUSES.includes(r.status)).length;
  const retired = rows.filter((r) => r.tier === "retired").length;

  console.log("[x-accounts] counts");
  console.log(`  total:    ${total}`);
  console.log(`  active:   ${active}`);
  console.log(`  disabled: ${disabled}`);
  console.log(`  retired:  ${retired}`);

  if (total === 0) {
    console.log("");
    console.log("[x-accounts] no accounts — зарегистрируй аккаунт: npm run login -- <name>");
    return;
  }

  const statusBreakdown = new Map<string, number>();
  for (const r of rows) statusBreakdown.set(r.status, (statusBreakdown.get(r.status) ?? 0) + 1);
  console.log(`  by status: ${[...statusBreakdown.entries()].map(([s, n]) => `${s}=${n}`).join(" ")}`);

  console.log("");
  console.log("[x-accounts] accounts (session/cookies/secrets не выводятся)");
  for (const r of rows) {
    const cooldownSec = Math.max(0, (Number(r.cooldown_until) || 0) - now) / 1000;
    const busySec = Math.max(0, (Number(r.account_busy_until) || 0) - now) / 1000;
    console.log(`  - ${r.name}`);
    console.log(`      status:        ${r.status}`);
    console.log(`      tier:          ${r.tier}`);
    console.log(`      cooldown:      ${fmtCooldown(cooldownSec)}${busySec > 0 ? ` (busy ${fmtCooldown(busySec)})` : ""}`);
    console.log(`      last_success:  ${fmtTs(r.last_success_at)}`);
    console.log(`      last_error:    ${fmtTs(r.last_error_at)}`);
    console.log(`      quota:         ${r.weight_used_this_hour}/${r.weight_quota_per_hour} per hour`);
  }
}

main()
  .catch((e) => {
    console.error("[x-accounts] failed:", e instanceof Error ? e.message : e);
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
    if (cause) console.error("[x-accounts] cause:", cause);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
