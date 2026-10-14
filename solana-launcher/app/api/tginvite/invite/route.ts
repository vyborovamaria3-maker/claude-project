import { consumeTGInviteReadPermit, resolveTGInviteClient } from "@/lib/tginvite-vault-client";
import { requireTGInviteUser } from "@/lib/tginvite-auth";
import { NextResponse } from "next/server";
import { createInviteLink, getChatInfo } from "@/lib/telegram";
import { filterMembers, getFilterSummary, FilterConfig, DEFAULT_FILTER_CONFIG } from "@/lib/tginvite-filter";
import { fetchChannelMembers } from "@/lib/tginvite-mtproto";

export async function POST(request: Request) {
  const user = await requireTGInviteUser(request);
  if (user.error) return user.error;
  const ownerId = user.ownerId!;
  const authorization = user.authorization!;
  try {
    const body = await request.json();
    const { action, token, chatId, linkName, expireDays, memberLimit, linkCount, filterConfig, channelUsernames } = body;

    if (action === "createLink") {
      if (!token || !chatId) {
        return NextResponse.json({ error: "Token and chatId required" }, { status: 400 });
      }

      const chatResult = await getChatInfo(token, chatId);
      if (!chatResult.success) {
        return NextResponse.json({ error: chatResult.error }, { status: 400 });
      }

      const result = await createInviteLink(token, chatId, {
        name: linkName || `Invite ${Date.now()}`,
        expireDate: expireDays ? Math.floor(Date.now() / 1000) + expireDays * 86400 : undefined,
        memberLimit,
      });

      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }

      return NextResponse.json({
        link: result.inviteLink,
        chat: chatResult.chat,
      });
    }

    if (action === "batchLinks") {
      if (!token || !chatId) {
        return NextResponse.json({ error: "Token and chatId required" }, { status: 400 });
      }

      const count = Math.min(linkCount || memberLimit || 1, 10);
      const links = [];
      for (let i = 0; i < count; i++) {
        const result = await createInviteLink(token, chatId, {
          name: `${linkName || "Link"} #${i + 1}`,
          expireDate: expireDays ? Math.floor(Date.now() / 1000) + expireDays * 86400 : undefined,
          memberLimit: 1,
        });
        if (result.success && result.inviteLink) {
          links.push(result.inviteLink);
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      return NextResponse.json({ links, count: links.length });
    }

    if (action === "fetchAndFilter") {
      // MTProto mode — fetch real members from channels and filter
      const tgClient = await resolveTGInviteClient(ownerId, authorization);
      if (!tgClient) {
        return NextResponse.json(
          { error: "MTProto not connected — go to Settings → MTProto Connect" },
          { status: 400 }
        );
      }

      if (!Array.isArray(channelUsernames) || !channelUsernames.length ||
          channelUsernames.length > 5 ||
          channelUsernames.some((value: unknown) => typeof value !== "string" || value.length > 256)) {
        return NextResponse.json({ error: "Provide 1 to 5 valid channels" }, { status: 422 });
      }

      const permit = await consumeTGInviteReadPermit(authorization, "fetch_members");
      if (!permit.allowed) {
        const rateLimited = permit.status === 429;
        return NextResponse.json(
          { error: rateLimited ? "Too many Telegram read requests" : "Telegram read protection unavailable" },
          {
            status: rateLimited ? 429 : 503,
            headers: permit.retryAfter ? { "Retry-After": permit.retryAfter } : undefined,
          },
        );
      }

      const config: FilterConfig = { ...DEFAULT_FILTER_CONFIG, ...filterConfig };
      config.maxResults = Number.isInteger(config.maxResults)
        ? Math.max(1, Math.min(Number(config.maxResults), 2000))
        : 1000;
      const allResults: {
        channel: string;
        total: number;
        filtered: number;
        bots: number;
        stats: ReturnType<typeof getFilterSummary>;
        members: ReturnType<typeof filterMembers>["filtered"];
      }[] = [];

      for (const channel of channelUsernames) {
        try {
          const rawMembers = await fetchChannelMembers(tgClient, channel, {
            limit: config.maxResults || 5000,
          });

          const { filtered, stats } = filterMembers(rawMembers, config);
          const summary = getFilterSummary(stats);

          allResults.push({
            channel,
            total: rawMembers.length,
            filtered: filtered.length,
            bots: rawMembers.filter((m) => m.isBot).length,
            stats: summary,
            members: filtered,
          });
        } catch (err: unknown) {
          const error = err as { message?: string };
          allResults.push({
            channel,
            total: 0,
            filtered: 0,
            bots: 0,
            stats: [error.message || "Failed to fetch"],
            members: [],
          });
        }
      }

      const totalFiltered = allResults.reduce((acc, r) => acc + r.filtered, 0);
      const totalBots = allResults.reduce((acc, r) => acc + r.bots, 0);
      const totalRaw = allResults.reduce((acc, r) => acc + r.total, 0);

      return NextResponse.json({
        results: allResults,
        summary: {
          totalRaw,
          totalBots,
          totalFiltered,
          channels: allResults.length,
        },
      });
    }

    if (action === "inviteFromFetched") {
      // Client-provided booleans are not proof of recipient consent.
      // This operation must remain disabled until server-owned consent records
      // and a durable result ledger are available.
      return NextResponse.json(
        { error: "Direct invitations require a consent-verified server job workflow" },
        { status: 501 }
      );
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: unknown) {
    return NextResponse.json({ error: "TGInvite service error" }, { status: 500 });
  }
}
