import { NextResponse } from "next/server";
import { createInviteLink, getChatInfo } from "@/lib/telegram";
import { filterMembers, getFilterSummary, FilterConfig, DEFAULT_FILTER_CONFIG } from "@/lib/tginvite-filter";
import { getClient, fetchChannelMembers, inviteUsers } from "@/lib/tginvite-mtproto";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, token, chatId, linkName, expireDays, memberLimit, linkCount, filterConfig, channelUsernames, targetChannel, userIds } = body;

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
      const tgClient = getClient();
      if (!tgClient) {
        return NextResponse.json(
          { error: "MTProto not connected — go to Settings → MTProto Connect" },
          { status: 400 }
        );
      }

      if (!Array.isArray(channelUsernames) || !channelUsernames.length) {
        return NextResponse.json({ error: "channelUsernames must be a non-empty array" }, { status: 400 });
      }

      const config: FilterConfig = { ...DEFAULT_FILTER_CONFIG, ...filterConfig };
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
      // Invite filtered users to target channel
      const tgClient = getClient();
      if (!tgClient) {
        return NextResponse.json(
          { error: "MTProto not connected" },
          { status: 400 }
        );
      }

      if (!targetChannel) {
        return NextResponse.json({ error: "targetChannel required" }, { status: 400 });
      }

      if (!Array.isArray(userIds) || !userIds.length) {
        return NextResponse.json({ error: "userIds must be a non-empty array" }, { status: 400 });
      }

      const typedUserIds = userIds
        .filter((u: { id: number; accessHash?: string }) => u.id && u.accessHash)
        .map((u: { id: number; accessHash: string }) => ({
          id: u.id,
          accessHash: u.accessHash,
        }));

      if (typedUserIds.length === 0) {
        return NextResponse.json({ error: "No valid userIds with accessHash provided" }, { status: 400 });
      }

      const result = await inviteUsers(tgClient, targetChannel, typedUserIds);
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: unknown) {
    const error = err as { message?: string };
    return NextResponse.json({ error: error.message || "Internal error" }, { status: 500 });
  }
}
