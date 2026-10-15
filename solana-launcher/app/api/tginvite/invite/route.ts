import { consumeTGInviteReadPermit, resolveTGInviteClient } from "@/lib/tginvite-vault-client";
import {
  InvalidInviteRequest,
  batchInviteLinkName,
  validateInviteLinkRequest,
  safeInviteError,
} from "@/lib/tginvite-invite-policy";
import { requireTGInviteUser } from "@/lib/tginvite-auth";
import { NextResponse } from "next/server";
import { checkBotInviteRights, createInviteLink, getChatInfo } from "@/lib/telegram";
import { filterMembers, getFilterSummary, FilterConfig, DEFAULT_FILTER_CONFIG } from "@/lib/tginvite-filter";
import { fetchChannelMembers } from "@/lib/tginvite-mtproto";

export async function POST(request: Request) {
  const user = await requireTGInviteUser(request);
  if (user.error) return user.error;
  const ownerId = user.ownerId!;
  const authorization = user.authorization!;
  try {
    const body = await request.json();
    const { action, filterConfig, channelUsernames } = body;

    if (action === "createLink" || action === "batchLinks") {
      // Validate everything before making any Telegram or backend quota request.
      let options;
      try {
        options = validateInviteLinkRequest(body, action);
      } catch (error) {
        const message = error instanceof InvalidInviteRequest ? error.message : "Invalid invite link request";
        return NextResponse.json({ error: message }, { status: 422 });
      }
      const kind = action === "createLink" ? "create_invite_link" : "batch_invite_links";
      const permit = await consumeTGInviteReadPermit(authorization, kind);
      if (!permit.allowed) {
        const limited = permit.status === 429;
        return NextResponse.json(
          { error: limited ? "Too many link creation requests" : "Link creation quota unavailable" },
          {
            status: limited ? 429 : 503,
            headers: permit.retryAfter ? { "Retry-After": permit.retryAfter } : undefined,
          },
        );
      }
      const chatResult = await getChatInfo(options.token, options.chatId);
      if (!chatResult.success) {
        return NextResponse.json(
          { error: safeInviteError(chatResult.error || "Chat not accessible", options.token) },
          {
            status: chatResult.retryAfter ? 429 : 400,
            headers: chatResult.retryAfter ? { "Retry-After": String(chatResult.retryAfter) } : undefined,
          },
        );
      }
      const permission = await checkBotInviteRights(options.token, options.chatId);
      if (!permission.allowed) {
        return NextResponse.json(
          { error: permission.reason || "Bot cannot create invite links" },
          {
            status: permission.retryAfter ? 429 : 403,
            headers: permission.retryAfter ? { "Retry-After": String(permission.retryAfter) } : undefined,
          },
        );
      }

      if (action === "createLink") {
        const result = await createInviteLink(options.token, options.chatId, {
          name: options.name,
          expireDate: options.expireDate,
          memberLimit: options.memberLimit,
          createsJoinRequest: options.createsJoinRequest,
        });
        if (!result.success || !result.inviteLink ||
            (options.createsJoinRequest && result.inviteLink.createsJoinRequest !== true)) {
          return NextResponse.json(
            { error: safeInviteError(result.error || "JOIN_REQUEST_NOT_ENFORCED", options.token) },
            {
              status: result.retryAfter ? 429 : 400,
              headers: result.retryAfter ? { "Retry-After": String(result.retryAfter) } : undefined,
            },
          );
        }
        return NextResponse.json(
          { link: result.inviteLink, chat: chatResult.chat, status: "created" },
          { headers: { "Cache-Control": "private, no-store" } },
        );
      }

      const links: NonNullable<Awaited<ReturnType<typeof createInviteLink>>["inviteLink"]>[] = [];
      let failure: string | undefined;
      let failureRetryAfter: number | undefined;
      for (let i = 0; i < options.count; i++) {
        try {
          const result = await createInviteLink(options.token, options.chatId, {
            name: batchInviteLinkName(options.name, i + 1),
            expireDate: options.expireDate,
            memberLimit: options.createsJoinRequest ? undefined : (options.memberLimit ?? 1),
            createsJoinRequest: options.createsJoinRequest,
          });
          if (!result.success || !result.inviteLink ||
              (options.createsJoinRequest && result.inviteLink.createsJoinRequest !== true)) {
            failure = safeInviteError(result.error || "JOIN_REQUEST_NOT_ENFORCED", options.token);
            failureRetryAfter = result.retryAfter;
            break;
          }
          links.push(result.inviteLink);
        } catch (error) {
          failure = safeInviteError(error, options.token);
          break;
        }
      }
      return NextResponse.json(
        {
          links, count: links.length, requestedCount: options.count,
          status: failure ? (links.length ? "partial" : "failed") : "completed",
          ...(failure ? { error: failure } : {}),
        },
        {
          status: failureRetryAfter && links.length === 0 ? 429 : 200,
          headers: {
            "Cache-Control": "private, no-store",
            ...(failureRetryAfter ? { "Retry-After": String(failureRetryAfter) } : {}),
          },
        },
      );
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
