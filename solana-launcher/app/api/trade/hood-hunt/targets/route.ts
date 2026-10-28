// Protected, local strategy watchlist. No orders are placed by this API.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/trade/db";
import { requireProdAuth } from "@/lib/routeAuth";
import {
  evaluateManagedTarget, type ManagedTargetKind, type ManagedTargetState,
  type ManagedTargetVerdict,
} from "@/lib/trade/hood-hunt-strategy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEV_SETUPS = new Set(["Strict", "Upside", "Fast start", "After bundle", "Dev sell"]);
const STATES = new Set<ManagedTargetState>(["watch", "active", "paused", "removed"]);
const VERDICTS = new Set<ManagedTargetVerdict>([
  "Копировать", "Снайпить", "Следить", "Проверить", "Пропустить",
]);
type Db = ReturnType<typeof getDb>;
type TargetRow = {
  kind: ManagedTargetKind;
  address: string;
  setup: string;
  state: ManagedTargetState;
  favorite: number;
  note: string | null;
  latestVerdict: ManagedTargetVerdict | null;
  pnl7dSol: number | null;
  balanceSol: number | null;
  consecutiveLiveLosses: number | null;
  lastReviewedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

function ensureTables(db: Db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS hood_hunt_targets ("
    + "kind TEXT NOT NULL CHECK(kind IN ('wallet','dev')),"
    + "address TEXT NOT NULL, setup TEXT NOT NULL,"
    + "state TEXT NOT NULL CHECK(state IN ('watch','active','paused','removed')),"
    + "favorite INTEGER NOT NULL DEFAULT 0, note TEXT, latest_verdict TEXT,"
    + "pnl_7d_sol REAL, balance_sol REAL, consecutive_live_losses INTEGER,"
    + "last_reviewed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,"
    + "PRIMARY KEY(kind,address,setup));"
    + "CREATE TABLE IF NOT EXISTS hood_hunt_target_events ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, address TEXT NOT NULL,"
    + "setup TEXT NOT NULL, old_state TEXT, new_state TEXT NOT NULL,"
    + "reason TEXT NOT NULL, changed_at INTEGER NOT NULL);"
    + "CREATE INDEX IF NOT EXISTS idx_hood_hunt_targets_state ON hood_hunt_targets(state,updated_at);"
  );
}
const SELECT = "SELECT kind,address,setup,state,favorite,note,latest_verdict AS latestVerdict,"
  + "pnl_7d_sol AS pnl7dSol,balance_sol AS balanceSol,"
  + "consecutive_live_losses AS consecutiveLiveLosses,"
  + "last_reviewed_at AS lastReviewedAt,created_at AS createdAt,"
  + "updated_at AS updatedAt FROM hood_hunt_targets";

function withDecision(row: TargetRow) {
  return { ...row, favorite: Boolean(row.favorite), decision: evaluateManagedTarget(row) };
}
function isOptionalNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

export async function GET(req: NextRequest) {
  const auth = await requireProdAuth(req);
  if (auth) return auth;
  const db = getDb();
  ensureTables(db);
  const kind = req.nextUrl.searchParams.get("kind");
  if (kind !== null && kind !== "wallet" && kind !== "dev") {
    return NextResponse.json({ error: "invalid kind" }, { status: 400 });
  }
  const rows = (kind
    ? db.prepare(SELECT + " WHERE kind=? ORDER BY favorite DESC,updated_at DESC LIMIT 250").all(kind)
    : db.prepare(SELECT + " ORDER BY favorite DESC,updated_at DESC LIMIT 250").all()) as TargetRow[];
  return NextResponse.json({ items: rows.map(withDecision) });
}

export async function POST(req: NextRequest) {
  const auth = await requireProdAuth(req);
  if (auth) return auth;
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  const kind = body.kind, address = body.address, setup = body.setup;
  if ((kind !== "wallet" && kind !== "dev") || typeof address !== "string" || !ADDR_RE.test(address)
    || typeof setup !== "string" || (kind === "wallet" ? setup !== "copy" : !DEV_SETUPS.has(setup))) {
    return NextResponse.json({ error: "invalid kind/address/setup" }, { status: 400 });
  }
  if (body.state != null && !STATES.has(body.state as ManagedTargetState)) {
    return NextResponse.json({ error: "invalid state" }, { status: 400 });
  }
  if (body.latestVerdict != null && !VERDICTS.has(body.latestVerdict as ManagedTargetVerdict)) {
    return NextResponse.json({ error: "invalid verdict" }, { status: 400 });
  }
  for (const key of ["pnl7dSol", "balanceSol", "consecutiveLiveLosses"]) {
    if (Object.prototype.hasOwnProperty.call(body, key) && !isOptionalNumber(body[key])) {
      return NextResponse.json({ error: "invalid " + key }, { status: 400 });
    }
  }
  if (typeof body.note === "string" && body.note.length > 500) {
    return NextResponse.json({ error: "note too long" }, { status: 400 });
  }
  if (body.consecutiveLiveLosses != null
    && (!Number.isInteger(body.consecutiveLiveLosses) || (body.consecutiveLiveLosses as number) < 0)) {
    return NextResponse.json({ error: "invalid consecutiveLiveLosses" }, { status: 400 });
  }
  if (body.balanceSol != null && (body.balanceSol as number) < 0) {
    return NextResponse.json({ error: "invalid balanceSol" }, { status: 400 });
  }
  const db = getDb();
  ensureTables(db);
  const existing = db.prepare(SELECT + " WHERE kind=? AND address=? AND setup=?")
    .get(kind, address, setup) as TargetRow | undefined;
  const now = Date.now();
  const state = (body.state as ManagedTargetState | undefined) ?? existing?.state ?? "watch";
  const latestVerdict = Object.prototype.hasOwnProperty.call(body, "latestVerdict")
    ? (body.latestVerdict as ManagedTargetVerdict | null) : existing?.latestVerdict ?? null;
  const pnl7dSol = Object.prototype.hasOwnProperty.call(body, "pnl7dSol")
    ? (body.pnl7dSol as number | null) : existing?.pnl7dSol ?? null;
  const balanceSol = Object.prototype.hasOwnProperty.call(body, "balanceSol")
    ? (body.balanceSol as number | null) : existing?.balanceSol ?? null;
  const consecutiveLiveLosses = Object.prototype.hasOwnProperty.call(body, "consecutiveLiveLosses")
    ? (body.consecutiveLiveLosses as number | null) : existing?.consecutiveLiveLosses ?? null;
  const lastReviewedAt = body.reviewed === true ? now : existing?.lastReviewedAt ?? null;
  const decision = evaluateManagedTarget({
    kind, state, latestVerdict, pnl7dSol, balanceSol, consecutiveLiveLosses, lastReviewedAt,
  }, now);
  // A local pause is recorded, but an external Blizz executor must enforce its own stop.
  const effectiveState = decision.suggestedState;
  const favorite = typeof body.favorite === "boolean"
    ? Number(body.favorite) : existing?.favorite ?? 0;
  const note = typeof body.note === "string" ? body.note : existing?.note ?? null;
  const run = db.transaction(() => {
    db.prepare(
      "INSERT INTO hood_hunt_targets(kind,address,setup,state,favorite,note,"
      + "latest_verdict,pnl_7d_sol,balance_sol,consecutive_live_losses,last_reviewed_at,created_at,updated_at)"
      + " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
      + " ON CONFLICT(kind,address,setup) DO UPDATE SET state=excluded.state,"
      + "favorite=excluded.favorite,note=excluded.note,latest_verdict=excluded.latest_verdict,"
      + "pnl_7d_sol=excluded.pnl_7d_sol,balance_sol=excluded.balance_sol,"
      + "consecutive_live_losses=excluded.consecutive_live_losses,"
      + "last_reviewed_at=excluded.last_reviewed_at,updated_at=excluded.updated_at"
    ).run(kind,address,setup,effectiveState,favorite,note,latestVerdict,pnl7dSol,
      balanceSol,consecutiveLiveLosses,lastReviewedAt,existing?.createdAt ?? now,now);
    if (!existing || existing.state !== effectiveState || body.reviewed === true) {
      db.prepare(
        "INSERT INTO hood_hunt_target_events(kind,address,setup,old_state,new_state,reason,changed_at)"
        + " VALUES (?,?,?,?,?,?,?)"
      ).run(kind,address,setup,existing?.state ?? null,effectiveState,
        decision.reasons.join("; ") || "Manual target update",now);
    }
  });
  run();
  const saved = db.prepare(SELECT + " WHERE kind=? AND address=? AND setup=?")
    .get(kind,address,setup) as TargetRow;
  return NextResponse.json({ target: withDecision(saved), advisoryOnly: true });
}
