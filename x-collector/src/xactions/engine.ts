import { normalizeXActionsProfile, normalizeXActionsTweet, type XActionsHttpProfile, type XActionsHttpTweet } from "./normalize";
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

export class XActionsReadEngine {
  constructor(
    private readonly client: ReadClient,
    private readonly endpoints: ReadEndpoints,
    private readonly parsers: ReadParsers,
  ) {}

  private async graphql(endpoint: GraphqlEndpoint, variables: Record<string, unknown>): Promise<unknown> {
    try {
      const response = await this.client.graphql(endpoint.queryId, endpoint.operationName, variables);
      if (response.errors?.length) {
        // Do not record raw upstream messages, which may contain request details.
        throw new Error(`XActions: GraphQL returned ${response.errors.length} error(s)`);
      }
      return response.data;
    } catch (error) {
      throw toCollectorError(error);
    }
  }

  async profile(username: string): Promise<AccountProfileData> {
    const data = await this.graphql(this.endpoints.userByScreenName, {
      screen_name: username, withSafetyModeUserFields: true,
    });
    const raw = nested(data, ["user", "result"]);
    if (!raw) throw new Error("XActions: user profile missing");
    return normalizeXActionsProfile(this.parsers.parseUserData(raw));
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
    const data = await this.graphql(this.endpoints.userTweets, variables);
    // An API shape change is not a valid end-of-timeline signal.
    const paths = [
      ["user", "result", "timeline", "timeline", "instructions"],
      ["user", "result", "timeline_v2", "timeline", "instructions"],
      ["user", "result", "timeline", "instructions"],
    ];
    if (!paths.some(path => Array.isArray(nested(data, path)))) {
      throw new Error("XActions: user timeline response shape changed");
    }
    const page = this.parsers.parseTimelineInstructions(instructions(this.parsers.userTimelineInstructions(data)));
    return { items: page.tweets.map(tweet => normalizeXActionsTweet(tweet)), nextCursor: page.cursor };
  }

  async listPage(listId: string, cursor: string | null = null): Promise<CursorPage<RawTweet>> {
    if (!/^\d{1,25}$/.test(listId)) throw new Error("XActions: invalid list ID");
    const variables: Record<string, unknown> = { listId, count: 20 };
    if (cursor) variables.cursor = cursor;
    const data = await this.graphql(this.endpoints.listTimeline, variables);
    const rawInstructions = nested(data, ["list", "tweets_timeline", "timeline", "instructions"]);
    if (!Array.isArray(rawInstructions)) throw new Error("XActions: list timeline response shape changed");
    const page = this.parsers.parseTimelineInstructions(rawInstructions);
    return { items: page.tweets.map(tweet => normalizeXActionsTweet(tweet)), nextCursor: page.cursor };
  }
}
