import { NextResponse } from "next/server";
import { analyzeChannelRecentMessages, clearClient, completeLogin, createClient, fetchChannelMembers, fetchVisibleMembersFromHistory, getClient, isAuthorized, isConnected, sendLoginCode, setClient, startClient } from "@/lib/tginvite-mtproto";
import { DEFAULT_FILTER_CONFIG, filterMembers, getFilterSummary, type FilterConfig } from "@/lib/tginvite-filter";

function parserError(message: string): { status: number; body: { error: string; status: string } } {
  if (message.includes("AUTH_KEY_UNREGISTERED")) {
    return { status: 401, body: { error: "MTProto session expired. Reconnect your Telegram account in TGInvite Settings.", status: "session_expired" } };
  }
  if (message.includes("USERNAME_INVALID") || message.includes("USERNAME_NOT_OCCUPIED") || message.includes("ValueError")) {
    return { status: 404, body: { error: "Channel username/link was not found. Check the @username or t.me link.", status: "channel_not_found" } };
  }
  if (message.includes("INVITE_HASH_INVALID") || message.includes("INVITE_HASH_EXPIRED")) {
    return { status: 404, body: { error: "Invite link is invalid or expired. Generate a fresh Telegram invite link and try again.", status: "invite_invalid" } };
  }
  if (message.includes("CHANNEL_PRIVATE") || message.includes("USER_NOT_PARTICIPANT")) {
    return { status: 403, body: { error: "Channel is private or your Telegram account is not a member/admin.", status: "channel_private" } };
  }
  if (message.includes("CHAT_ADMIN_REQUIRED")) {
    return { status: 403, body: { error: "Telegram requires admin access to list members for this channel.", status: "admin_required" } };
  }
  if (message.includes("FLOOD_WAIT")) {
    const wait = message.match(/FLOOD_WAIT_?(\d+)/)?.[1];
    return { status: 429, body: { error: `Telegram flood wait${wait ? `: wait ${wait}s` : ""}. Try later.`, status: "flood_wait" } };
  }
  if (message.includes("No pending Telegram login")) {
    return { status: 400, body: { error: "No pending Telegram login. Send code first.", status: "login_not_started" } };
  }
  return { status: 500, body: { error: message || "Internal error", status: "unknown" } };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, apiId, apiHash, phoneNumber, sessionString, channelUsername, limit, filterConfig, activityMode, phoneCode, password } = body;

    if (action === "connect") {
      if (!apiId || !apiHash) {
        return NextResponse.json({ error: "apiId and apiHash required" }, { status: 400 });
      }

      const tgClient = await createClient({
        apiId: Number(apiId),
        apiHash,
        sessionString,
        phoneNumber,
      });

      if (sessionString) {
        const client = tgClient as { connect: () => Promise<void> };
        try {
          await client.connect();
          const authorized = await isAuthorized(tgClient);
          if (!authorized) {
            await clearClient();
            return NextResponse.json(
              { error: "MTProto session expired. Clear saved session and authenticate again.", status: "session_expired" },
              { status: 401 }
            );
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          await clearClient();
          if (message.includes("AUTH_KEY_UNREGISTERED")) {
            return NextResponse.json(
              { error: "MTProto session expired. Clear saved session and authenticate again.", status: "session_expired" },
              { status: 401 }
            );
          }
          throw err;
        }
        setClient(tgClient);
        return NextResponse.json({ status: "connected", hasSession: true });
      }

      // Need phone verification
      setClient(tgClient);
      return NextResponse.json({ status: "needs_phone", message: "Call start with phoneNumber" });
    }

    if (action === "sendCode") {
      if (!apiId || !apiHash || !phoneNumber) {
        return NextResponse.json({ error: "apiId, apiHash, and phoneNumber required" }, { status: 400 });
      }

      const result = await sendLoginCode({
        apiId: Number(apiId),
        apiHash,
        phoneNumber,
      });

      return NextResponse.json({
        status: "code_sent",
        isCodeViaApp: result.isCodeViaApp,
        message: result.isCodeViaApp ? "Code sent to Telegram app" : "Code sent by SMS",
      });
    }

    if (action === "completeLogin") {
      try {
        const completedSessionString = await completeLogin({ phoneCode, password });
        return NextResponse.json({ status: "authenticated", sessionString: completedSessionString });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "TWO_FACTOR_PASSWORD_REQUIRED") {
          return NextResponse.json({ error: "Two-factor password required", status: "password_required" }, { status: 401 });
        }
        if (message.includes("PASSWORD_HASH_INVALID")) {
          return NextResponse.json({ error: "Telegram 2FA password is invalid", status: "password_invalid" }, { status: 400 });
        }
        if (message.includes("PHONE_CODE_INVALID")) {
          return NextResponse.json({ error: "Telegram code is invalid", status: "code_invalid" }, { status: 400 });
        }
        if (message.includes("PHONE_CODE_EXPIRED")) {
          return NextResponse.json({ error: "Telegram code expired. Send a new code.", status: "code_expired" }, { status: 400 });
        }
        const mapped = parserError(message);
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
    }

    if (action === "start") {
      if (!phoneNumber) {
        return NextResponse.json({ error: "phoneNumber required" }, { status: 400 });
      }

      const existingClient = getClient();
      if (!existingClient) {
        return NextResponse.json({ error: "No client — call connect first" }, { status: 400 });
      }

      const sessionString = await startClient(existingClient, phoneNumber);
      return NextResponse.json({ status: "authenticated", sessionString });
    }

    if (action === "fetchMembers") {
      if (!channelUsername) {
        return NextResponse.json({ error: "channelUsername required" }, { status: 400 });
      }

      const existingClient = getClient();
      if (!existingClient) {
        return NextResponse.json(
          { error: "MTProto is not connected. Connect your Telegram account in TGInvite Settings first.", status: "not_connected" },
          { status: 400 }
        );
      }

      let members;
      let partial = false;
      let source = "participants";
      try {
        members = await fetchChannelMembers(existingClient, channelUsername, {
          limit: limit || 5000,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("AUTH_KEY_UNREGISTERED")) {
          await clearClient();
          const mapped = parserError(message);
          return NextResponse.json(mapped.body, { status: mapped.status });
        }
        if (message.includes("CHAT_ADMIN_REQUIRED")) {
          try {
            members = await fetchVisibleMembersFromHistory(existingClient, channelUsername, {
              limit: limit || 1000,
            });
            if (members.length > 0) {
              partial = true;
              source = "visible_history";
            } else {
              const mapped = parserError(message);
              return NextResponse.json(mapped.body, { status: mapped.status });
            }
          } catch {
            const mapped = parserError(message);
            return NextResponse.json(mapped.body, { status: mapped.status });
          }
        } else {
          const mapped = parserError(message);
          return NextResponse.json(mapped.body, { status: mapped.status });
        }
      }
      const config: FilterConfig = { ...DEFAULT_FILTER_CONFIG, ...(filterConfig || {}) };
      const parsed = filterMembers(members, config);
      const inactive = parsed.allScores.filter((score) => !score.isActive && !score.isBot).length;
      const visibleMembers =
        activityMode === "active"
          ? parsed.filtered
          : activityMode === "inactive"
          ? members.filter((member) => {
              const score = parsed.allScores.find((item) => item.userId === member.id);
              return score ? !score.isActive && !score.isBot : false;
            })
          : members;

      return NextResponse.json({
        channel: channelUsername,
        total: members.length,
        bots: members.filter((m) => m.isBot).length,
        humans: members.filter((m) => !m.isBot).length,
        active: parsed.filtered.length,
        inactive,
        filtered: parsed.filtered,
        scores: parsed.allScores,
        stats: parsed.stats,
        summary: getFilterSummary(parsed.stats),
        members: visibleMembers,
        partial,
        source,
        warning: partial
          ? "Telegram blocked the full member list because this account is not an admin. Showing users visible in accessible chat history."
          : undefined,
      });
    }

    if (action === "analyzeRecentMessages") {
      if (!channelUsername) {
        return NextResponse.json({ error: "channelUsername required" }, { status: 400 });
      }

      const existingClient = getClient();
      if (!existingClient) {
        return NextResponse.json(
          { error: "MTProto is not connected. Connect your Telegram account in TGInvite Settings first.", status: "not_connected" },
          { status: 400 }
        );
      }

      try {
        const analysis = await analyzeChannelRecentMessages(existingClient, channelUsername, { limit: 100 });
        return NextResponse.json({ status: "analyzed", analysis });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("AUTH_KEY_UNREGISTERED")) {
          await clearClient();
        }
        const mapped = parserError(message);
        return NextResponse.json(mapped.body, { status: mapped.status });
      }
    }

    if (action === "validateCandidates") {
      const existingClient = getClient();

      if (!existingClient) {
        return NextResponse.json(
          {
            error: "MTProto client is not connected",
            code: "NOT_CONNECTED",
          },
          { status: 400 }
        );
      }

      const rawCandidates = Array.isArray(body.candidates)
        ? body.candidates
        : [];

      const candidates = rawCandidates
        .map((candidate: unknown) => {
          if (!candidate || typeof candidate !== "object") {
            return null;
          }

          const row = candidate as {
            username?: unknown;
            historicalDiscoveryScore?: unknown;
          };

          const username = String(row.username || "").trim().replace(/^@/, "");
          if (!username) return null;

          const historicalDiscoveryScore =
            typeof row.historicalDiscoveryScore === "number"
              ? row.historicalDiscoveryScore
              : Number(row.historicalDiscoveryScore || 0);

          return {
            username,
            historicalDiscoveryScore: Number.isFinite(historicalDiscoveryScore)
              ? historicalDiscoveryScore
              : 0,
          };
        })
        .filter(
          (candidate: { username: string; historicalDiscoveryScore: number } | null): candidate is { username: string; historicalDiscoveryScore: number } =>
            Boolean(candidate)
        );

      if (!candidates.length) {
        return NextResponse.json(
          { error: "No valid candidates supplied", code: "NO_CANDIDATES" },
          { status: 400 }
        );
      }

      const MAX_CANDIDATES = 100;
      if (candidates.length > MAX_CANDIDATES) {
        return NextResponse.json(
          {
            error: `Too many candidates. Maximum is ${MAX_CANDIDATES}.`,
            code: "TOO_MANY_CANDIDATES",
          },
          { status: 400 }
        );
      }

      const results: Array<{
        username: string;
        historicalDiscoveryScore: number;
        alive: boolean;
        accepted: boolean;
        review: boolean;
        disposition: "accepted" | "review" | "discarded" | "failed";
        analysis?: Awaited<ReturnType<typeof analyzeChannelRecentMessages>>;
        error?: string;
      }> = [];

      let checked = 0;
      let alive = 0;
      let accepted = 0;
      let review = 0;
      let discarded = 0;
      let failed = 0;

      for (const candidate of candidates) {
        try {
          const analysis = await analyzeChannelRecentMessages(
            existingClient,
            candidate.username,
            { limit: 100 }
          );

          checked += 1;
          alive += 1;

          const isAccepted = analysis.verdict === "strong" || analysis.verdict === "medium";
          const needsReview = analysis.verdict === "weak";

          if (isAccepted) accepted += 1;
          else if (needsReview) review += 1;
          else discarded += 1;

          results.push({
            username: candidate.username,
            historicalDiscoveryScore: candidate.historicalDiscoveryScore,
            alive: true,
            accepted: isAccepted,
            review: needsReview,
            disposition: isAccepted ? "accepted" : needsReview ? "review" : "discarded",
            analysis,
          });
        } catch (error: unknown) {
          checked += 1;
          failed += 1;

          const message = error instanceof Error ? error.message : String(error);
          const mapped = parserError(message);

          results.push({
            username: candidate.username,
            historicalDiscoveryScore: candidate.historicalDiscoveryScore,
            alive: false,
            accepted: false,
            review: false,
            disposition: "failed",
            error: mapped.body.error,
          });

          if (mapped.body.status === "flood_wait") {
            return NextResponse.json(
              {
                status: "rate_limited",
                total: candidates.length,
                checked,
                alive,
                accepted,
                review,
                discarded,
                failed,
                results,
                error: mapped.body.error,
                code: mapped.body.status,
              },
              { status: 429 }
            );
          }
        }

        // Small spacing between Telegram history requests.
        await new Promise((resolve) => setTimeout(resolve, 750));
      }

      return NextResponse.json({
        status: "validated",
        total: candidates.length,
        checked,
        alive,
        accepted,
        review,
        discarded,
        failed,
        results,
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: unknown) {
    const error = err as { message?: string };
    const mapped = parserError(error.message || "Internal error");
    return NextResponse.json(mapped.body, { status: mapped.status });
  }
}

export async function GET() {
  const existingClient = getClient();
  return NextResponse.json({
    connected: isConnected(),
    clientReady: existingClient !== null,
    hasSession: existingClient?.connected || false,
  });
}
