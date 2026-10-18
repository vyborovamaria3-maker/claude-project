import { normalizeXActionsProfile, normalizeXActionsTweet, explicitVerificationEvidence, type XActionsNormalizedProfile, type XActionsHttpProfile, type XActionsHttpTweet } from "./normalize";
import { toCollectorError } from "./errors";
import type { AccountProfileData, RawTweet } from "../../lib/trade/twitter-scraper";
import type { CursorPage } from "./pagination";

export interface GraphqlEndpoint {
  queryId: string;
  operationName: string;
}

export interface ReadEndpoints {
  userByScreenName: GraphqlEndpoint;
  userTweets: GraphqlEndpoint;
  listTimeline: GraphqlEndpoint;
  listMembers?: GraphqlEndpoint;
  /** Search is used only by the separately enabled legacy search bridge. */
  searchTimeline?: GraphqlEndpoint;
}

export interface ReadClient {
  graphql(queryId: string, operationName: string, variables: Record<string, unknown>): Promise<{
    data?: unknown;
    errors?: Array<{ message?: string }>;
  }>;
}

export interface ReadParsers {
  parseUserData(raw: unknown): XActionsHttpProfile;
  parseTimelineInstructions(instructions: unknown[]): { tweets: XActionsHttpTweet[]; cursor: string | null };
  userTimelineInstructions(data: unknown): unknown[];
  parseUserList?(instructions: unknown[]): { users: XActionsHttpProfile[]; cursor: string | null };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nested(root: unknown, path: string[]): unknown {
  return path.reduce<unknown>((value, key) => record(value)[key], root);
}

function instructions(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Pinned SDK ignores replacement entries used by live paginated searches. */
export function normalizeTimelineInstructions(rows: unknown[]): unknown[] {
  return rows.map(row => {
    const instruction = record(row);
    if (instruction.type !== "TimelineReplaceEntry") return row;
    const entry = record(instruction.entry);
    if (!Object.keys(entry).length) return row;
    const content = record(entry.content);
    const id = entry.entryId ?? entry.entry_id ?? instruction.entry_id_to_replace;
    const entryId = typeof id === "string" ? id
      : content.cursorType === "Bottom" ? "cursor-bottom-replacement"
      : content.cursorType === "Top" ? "cursor-top-replacement" : undefined;
    return { type: "TimelineAddEntries", entries: [{ ...entry, ...(entryId ? { entryId } : {}) }] };
  });
}

/** Measured SearchTimeline exhaustion: only a top/bottom cursor replacement pair.
 * This means the search returned no more indexed matches, not complete X coverage. */
export function isSearchCursorOnlyEnd(rows: unknown[], count: number): boolean {
  if (count !== 0 || rows.length !== 2) return false;
  const directions = new Set<string>();
  for (const row of rows) {
    const instruction = record(row);
    const content = record(record(instruction.entry).content);
    if (instruction.type !== "TimelineReplaceEntry" || content.__typename !== "TimelineTimelineCursor" ||
        (content.cursorType !== "Top" && content.cursorType !== "Bottom") ||
        typeof content.value !== "string" || !content.value || content.itemContent || content.items) return false;
    directions.add(content.cursorType);
  }
  return directions.size === 2;
}

/** Absence of a bottom cursor is NOT proof of exhaustion: GraphQL can return
 * truncated modules, a changed entry shape, or temporarily empty pages.
 * Only the explicit terminal instruction may close a checkpoint. */
export function verifyHttpPageEnd(rows: unknown[], count: number, cursor: string | null): void {
  if (cursor !== null) return;
  const terminal = rows.some(row => {
    const parsed = record(row);
    return parsed.type === "TimelineTerminateTimeline" || parsed.__typename === "TimelineTerminateTimeline";
  });
  if (!terminal) throw new Error("XActions: ambiguous timeline end without terminal instruction");
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("XActions: invalid parsed page count");
}

export class XActionsReadEngine {
  constructor(
    private readonly client: ReadClient,
    private readonly endpoints: ReadEndpoints,
    private readonly parsers: ReadParsers,
  ) {}

  private async graphqlWithRaw(endpoint: GraphqlEndpoint, variables: Record<string, unknown>): Promise<{ data: unknown; rawResponse: unknown }> {
    try {
      const response = await this.client.graphql(endpoint.queryId, endpoint.operationName, variables);
      if (response.errors?.length) {
        // Do not record raw upstream messages, which may contain request details.
        throw new Error(`XActions: GraphQL returned ${response.errors.length} error(s)`);
      }
      return {
        data: response.data,
        rawResponse: {
          endpoint: endpoint.operationName,
          queryId: endpoint.queryId,
          variables,
          response,
        },
      };
    } catch (error) {
      throw toCollectorError(error);
    }
  }

  private async graphql(endpoint: GraphqlEndpoint, variables: Record<string, unknown>): Promise<unknown> {
    return (await this.graphqlWithRaw(endpoint, variables)).data;
  }

  async profile(username: string): Promise<XActionsNormalizedProfile> {
    const data = await this.graphql(this.endpoints.userByScreenName, {
      screen_name: username, withSafetyModeUserFields: true,
    });
    const raw = nested(data, ["user", "result"]);
    if (!raw) throw new Error("XActions: user profile missing");
    return normalizeXActionsProfile(this.parsers.parseUserData(raw), explicitVerificationEvidence(raw));
  }

  async resolveUserId(username: string): Promise<string> {
    const data = await this.graphql(this.endpoints.userByScreenName, {
      screen_name: username, withSafetyModeUserFields: true,
    });
    const id = nested(data, ["user", "result", "rest_id"]);
    if (typeof id !== "string" || !/^\d{1,25}$/.test(id)) {
      throw new Error("XActions: user ID missing");
    }
    return id;
  }

  async timelinePage(userId: string, cursor: string | null = null): Promise<CursorPage<RawTweet>> {
    if (!/^\d{1,25}$/.test(userId)) throw new Error("XActions: invalid user ID");
    const variables: Record<string, unknown> = {
      userId, count: 20, includePromotedContent: false,
      withQuickPromoteEligibilityTweetFields: true, withVoice: true, withV2Timeline: true,
    };
    if (cursor) variables.cursor = cursor;
    const { data, rawResponse } = await this.graphqlWithRaw(this.endpoints.userTweets, variables);
    // An API shape change is not a valid end-of-timeline signal.
    const paths = [
      ["user", "result", "timeline", "timeline", "instructions"],
      ["user", "result", "timeline_v2", "timeline", "instructions"],
      ["user", "result", "timeline", "instructions"],
    ];
    if (!paths.some(path => Array.isArray(nested(data, path)))) {
      throw new Error("XActions: user timeline response shape changed");
    }
    const rows = instructions(this.parsers.userTimelineInstructions(data));
    const page = this.parsers.parseTimelineInstructions(normalizeTimelineInstructions(rows));
    verifyHttpPageEnd(rows, page.tweets.length, page.cursor);
    return { items: page.tweets.map(tweet => normalizeXActionsTweet(tweet)), nextCursor: page.cursor, rawResponse };
  }

  /**
   * GraphQL SearchTimeline read. XActions 3.5.0's HTTP client
   * uses POST for this operation, unlike the older GET-based scraper.
   * The legacy search bridge preserves its own historical/numeric checkpoints.
   */
  async diagnosticSearchPage(
    query: string,
    sort: "top" | "latest" = "latest",
    cursor: string | null = null,
  ): Promise<CursorPage<RawTweet>> {
    if (!this.endpoints.searchTimeline) throw new Error("XActions: SearchTimeline endpoint unavailable");
    if (typeof query !== "string" || !query.trim() || query.length > 500) {
      throw new Error("XActions: invalid diagnostic search query");
    }
    const variables: Record<string, unknown> = {
      rawQuery: query,
      count: 20,
      querySource: "typed_query",
      product: sort === "latest" ? "Latest" : "Top",
    };
    if (cursor) variables.cursor = cursor;
    const { data, rawResponse } = await this.graphqlWithRaw(this.endpoints.searchTimeline, variables);
    const rawInstructions = nested(data, ["search_by_raw_query", "search_timeline", "timeline", "instructions"]);
    if (!Array.isArray(rawInstructions)) {
      throw new Error("XActions: SearchTimeline response shape changed");
    }
    const page = this.parsers.parseTimelineInstructions(normalizeTimelineInstructions(rawInstructions));
    if (isSearchCursorOnlyEnd(rawInstructions, page.tweets.length)) return { items: [], nextCursor: null, rawResponse };
    verifyHttpPageEnd(rawInstructions, page.tweets.length, page.cursor);
    return { items: page.tweets.map(tweet => normalizeXActionsTweet(tweet)), nextCursor: page.cursor, rawResponse };
  }

  /** One page of X List members, with the opaque bottom cursor exposed. */
  async listMembersPage(listId: string, cursor: string | null = null): Promise<CursorPage<AccountProfileData>> {
    if (!/^\d{1,25}$/.test(listId)) throw new Error("XActions: invalid list ID");
    if (!this.endpoints.listMembers || !this.parsers.parseUserList) {
      throw new Error("XActions: ListMembers parser or endpoint unavailable");
    }
    const variables: Record<string, unknown> = { listId, count: 20 };
    if (cursor) variables.cursor = cursor;
    const data = await this.graphql(this.endpoints.listMembers, variables);
    const rawInstructions = nested(data, ["list", "members_timeline", "timeline", "instructions"]);
    if (!Array.isArray(rawInstructions)) throw new Error("XActions: list members response shape changed");
    const page = this.parsers.parseUserList(normalizeTimelineInstructions(rawInstructions));
    verifyHttpPageEnd(rawInstructions, page.users.length, page.cursor);
    return { items: page.users.map(user => normalizeXActionsProfile(user)), nextCursor: page.cursor };
  }

  async listPage(listId: string, cursor: string | null = null): Promise<CursorPage<RawTweet>> {
    if (!/^\d{1,25}$/.test(listId)) throw new Error("XActions: invalid list ID");
    const variables: Record<string, unknown> = { listId, count: 20 };
    if (cursor) variables.cursor = cursor;
    const { data, rawResponse } = await this.graphqlWithRaw(this.endpoints.listTimeline, variables);
    const rawInstructions = nested(data, ["list", "tweets_timeline", "timeline", "instructions"]);
    if (!Array.isArray(rawInstructions)) throw new Error("XActions: list timeline response shape changed");
    const page = this.parsers.parseTimelineInstructions(normalizeTimelineInstructions(rawInstructions));
    verifyHttpPageEnd(rawInstructions, page.tweets.length, page.cursor);
    return { items: page.tweets.map(tweet => normalizeXActionsTweet(tweet)), nextCursor: page.cursor, rawResponse };
  }
}
