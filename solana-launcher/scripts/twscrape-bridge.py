#!/usr/bin/env python3
import argparse
import base64
import asyncio
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

os.environ.setdefault("TWS_TELEMETRY", "0")

from twscrape import API, set_log_level  # noqa: E402

set_log_level("WARNING")

RETRY_CURSOR = "__potapoff_retry__"


def to_ms(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return int(value.timestamp() * 1000)
    try:
        return int(value)
    except Exception:
        return None


def load_cookie_string(auth_path: str) -> str:
    path = Path(auth_path)
    if not path.is_file():
        raise RuntimeError("X storage-state file is missing")
    state = json.loads(path.read_text(encoding="utf-8"))
    cookies = state.get("cookies") or []
    pairs = []
    names = set()
    for cookie in cookies:
        name = str(cookie.get("name") or "").strip()
        value = str(cookie.get("value") or "")
        domain = str(cookie.get("domain") or "").lower()
        if not name or not value:
            continue
        if "x.com" not in domain and "twitter.com" not in domain:
            continue
        names.add(name)
        pairs.append(f"{name}={value}")
    if "auth_token" not in names or "ct0" not in names:
        raise RuntimeError("X storage-state must contain auth_token and ct0 cookies")
    return "; ".join(pairs)


def user_payload(user):
    if user is None:
        return None
    return {
        "id": getattr(user, "id_str", None),
        "username": getattr(user, "username", ""),
        "displayName": getattr(user, "displayname", ""),
        "description": getattr(user, "rawDescription", ""),
        "createdAt": to_ms(getattr(user, "created", None)),
        "followers": int(getattr(user, "followersCount", 0) or 0),
        "following": int(getattr(user, "friendsCount", 0) or 0),
        "postsCount": int(getattr(user, "statusesCount", 0) or 0),
        "favouritesCount": int(getattr(user, "favouritesCount", 0) or 0),
        "listedCount": int(getattr(user, "listedCount", 0) or 0),
        "mediaCount": int(getattr(user, "mediaCount", 0) or 0),
        "location": getattr(user, "location", "") or "",
        "profileImageUrl": getattr(user, "profileImageUrl", "") or "",
        "profileBannerUrl": getattr(user, "profileBannerUrl", None),
        "protected": bool(getattr(user, "protected", False) or False),
        "verified": bool(getattr(user, "verified", False) or False),
        "blue": bool(getattr(user, "blue", False) or False),
        "blueType": getattr(user, "blueType", None),
    }


def tweet_payload(tweet):
    user = user_payload(getattr(tweet, "user", None))
    raw_views = getattr(tweet, "viewCount", None)
    return {
        "id": getattr(tweet, "id_str", str(getattr(tweet, "id", ""))),
        "url": getattr(tweet, "url", "") or "",
        "date": to_ms(getattr(tweet, "date", None)),
        "lang": getattr(tweet, "lang", "") or "",
        "text": getattr(tweet, "rawContent", "") or "",
        "views": int(raw_views) if raw_views is not None else None,
        "viewsKnown": raw_views is not None,
        "likes": int(getattr(tweet, "likeCount", 0) or 0),
        "retweets": int(getattr(tweet, "retweetCount", 0) or 0),
        "replies": int(getattr(tweet, "replyCount", 0) or 0),
        "quotes": int(getattr(tweet, "quoteCount", 0) or 0),
        "bookmarks": int(getattr(tweet, "bookmarkedCount", 0) or 0),
        "conversationId": str(getattr(tweet, "conversationIdStr", "") or ""),
        "hashtags": list(getattr(tweet, "hashtags", []) or []),
        "cashtags": list(getattr(tweet, "cashtags", []) or []),
        "sourceLabel": getattr(tweet, "sourceLabel", None),
        "possiblySensitive": bool(getattr(tweet, "possibly_sensitive", False) or False),
        "isQuote": bool(getattr(tweet, "isQuoteStatus", False) or False),
        "isReply": getattr(tweet, "inReplyToTweetId", None) is not None,
        "author": user,
    }


def dedupe(items):
    out = []
    seen = set()
    for item in items:
        tid = item.get("id")
        if not tid or tid in seen:
            continue
        seen.add(tid)
        out.append(item)
    return out


def split_queries(query: str):
    parts = [part.strip() for part in re.split(r"\s+OR\s+", query, flags=re.IGNORECASE) if part.strip()]
    return list(dict.fromkeys(parts)) or [query]


def per_query_page_limit(total_limit: int, query_count: int) -> int:
    """Keep the first page close to the requested UI size without losing cursor state."""
    query_count = max(1, int(query_count or 1))
    total_limit = max(1, int(total_limit or 1))
    fair_share = (total_limit + query_count - 1) // query_count
    return max(6, min(20, fair_share + 2))


def decode_cursor_state(token: str, queries: list[str]):
    if not token:
        return None

    try:
        padding = "=" * (-len(token) % 4)
        raw = base64.urlsafe_b64decode((token + padding).encode("ascii"))
        payload = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise RuntimeError("Invalid X pagination cursor") from exc

    if not isinstance(payload, dict) or payload.get("v") != 1:
        raise RuntimeError("Invalid X pagination cursor version")

    if payload.get("queries") != queries:
        raise RuntimeError("X pagination cursor does not match this query")

    raw_cursors = payload.get("cursors")
    if not isinstance(raw_cursors, dict):
        raise RuntimeError("Invalid X pagination cursor state")

    cursors = {}
    for query in queries:
        if query not in raw_cursors:
            raise RuntimeError("Incomplete X pagination cursor state")

        value = raw_cursors.get(query)
        if value is not None and not isinstance(value, str):
            raise RuntimeError("Invalid X pagination cursor value")

        cursors[query] = value

    return cursors


def encode_cursor_state(queries: list[str], cursors: dict):
    payload = {
        "v": 1,
        "queries": queries,
        "cursors": cursors,
    }

    raw = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")

    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def is_transient_search_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return (
        "no account available for queue searchtimeline" in message
        or "rate limit" in message
        or "locked" in message
        or "temporarily" in message
    )


async def with_search_retry(factory, *, label: str, retries: int, base_delay: float):
    attempt = 0
    while True:
        try:
            return await factory()
        except Exception as exc:
            if attempt >= retries or not is_transient_search_error(exc):
                raise
            delay = base_delay * (2 ** attempt)
            sys.stderr.write(
                f"Transient SearchTimeline error for {label}; retrying in {delay:.1f}s\n",
            )
            await asyncio.sleep(delay)
            attempt += 1


async def collect(args):
    api = API(
        args.db,
        raise_when_no_account=True,
        wait_timeout=args.wait_timeout,
        wait_interval=1,
    )

    # X_SESSION_POOL_V10_32
    # LRU among currently-unlocked active accounts. Queue-specific rate-limit
    # locks remain owned by twscrape and are never reset here.
    api.pool._order_by = 'CASE WHEN last_used IS NULL THEN 0 ELSE 1 END, last_used ASC, username ASC'

    # Persistent DB is authoritative after first bootstrap. Re-importing the
    # same bootstrap cookies on every request would reactivate a session that
    # QueueClient intentionally marked inactive after an auth failure.
    bootstrap_account = await api.pool.get_account(args.account)
    if bootstrap_account is None:
        cookie_string = load_cookie_string(args.auth)
        await api.pool.add_account_cookies(args.account, cookie_string)

    # TWITTER_USER_TIMELINE_V10_1
    # Prefer UserTweets GraphQL for author history. SearchTimeline from:<handle>
    # remains a fallback because X search can legitimately under-return.
    if args.user_timeline:
        login = str(args.user_timeline).strip().lstrip("@")
        if not re.fullmatch(r"[A-Za-z0-9_]{1,30}", login):
            raise RuntimeError("Invalid X user timeline handle")

        tweets = []
        history_mode = "user-tweets"

        user = await api.user_by_login(login)

        if user is not None:
            uid = getattr(user, "id", None)

            if uid is not None and hasattr(api, "user_tweets"):
                try:
                    async for tweet in api.user_tweets(uid, limit=args.limit):
                        tweets.append(tweet_payload(tweet))
                except Exception:
                    tweets = []
                    history_mode = "search-fallback"

        if not tweets:
            history_mode = "search-fallback"
            async for tweet in api.search(
                f"from:{login}",
                limit=args.limit,
                kv={"product": "Latest"},
            ):
                tweets.append(tweet_payload(tweet))

        rows = dedupe(tweets)
        rows.sort(
            key=lambda item: int(item.get("date") or 0),
            reverse=True,
        )
        rows = rows[: args.limit]

        return {
            "provider": "twscrape",
            "queryMode": "user-timeline",
            "historyMode": history_mode,
            "timelineLogin": login,
            "requestedLimit": args.limit,
            "returned": len(rows),
            "hasMore": False,
            "nextCursor": None,
            "tweets": rows,
        }


    queries = split_queries(args.query) if args.split_or else [args.query]
    tweets = []
    counts = {}
    query_errors = {}

    per_query_limit = per_query_page_limit(args.limit, len(queries))

    # Cursor pagination mode.
    # Each split query owns its own SearchTimeline cursor.
    # Do NOT slice the merged page here: doing so would discard tweets
    # that the returned cursors have already moved past.
    if args.paged:
        cursor_state = decode_cursor_state(args.cursor, queries) if args.cursor else None
        next_state = {}

        for query in queries:
            # None inside an existing state means this query reached EOF.
            if cursor_state is not None and cursor_state[query] is None:
                counts[query] = 0
                next_state[query] = None
                continue

            current_cursor = (
                cursor_state[query]
                if cursor_state is not None
                else None
            )
            if current_cursor == RETRY_CURSOR:
                current_cursor = None

            try:
                page, next_cursor = await with_search_retry(
                    lambda q=query, c=current_cursor: api.search_page(
                        q,
                        cursor=c,
                        limit=per_query_limit,
                        kv={"product": "Latest"},
                    ),
                    label=query,
                    retries=args.retries,
                    base_delay=args.retry_base_delay,
                )
            except Exception as exc:
                message = str(exc)
                if tweets and is_transient_search_error(exc):
                    counts[query] = 0
                    query_errors[query] = message
                    next_state[query] = current_cursor if current_cursor is not None else RETRY_CURSOR
                    continue
                raise

            for tweet in page:
                tweets.append(tweet_payload(tweet))

            counts[query] = len(page)
            next_state[query] = next_cursor

        if not tweets and query_errors:
            raise RuntimeError("; ".join(query_errors.values()))

        rows = dedupe(tweets)
        rows.sort(
            key=lambda item: int(item.get("date") or 0),
            reverse=True,
        )

        has_more = any(
            value is not None
            for value in next_state.values()
        ) or bool(query_errors)

        next_cursor_token = (
            encode_cursor_state(queries, next_state)
            if has_more
            else None
        )

        return {
            "provider": "twscrape",
            "queryMode": "latest",
            "paginationMode": "cursor",
            "query": args.query,
            "queries": queries,
            "queryCounts": counts,
            "queryErrors": query_errors,
            "requestedLimit": args.limit,
            "perQueryLimit": per_query_limit,
            "returned": len(rows),
            "hasMore": has_more,
            "nextCursor": next_cursor_token,
            "tweets": rows,
        }

    # Existing synchronous mode remains unchanged.
    for query in queries:
        before = len(tweets)

        try:
            page_tweets = await with_search_retry(
                lambda q=query: collect_search_tweets(
                    api,
                    q,
                    per_query_limit,
                ),
                label=query,
                retries=args.retries,
                base_delay=args.retry_base_delay,
            )
        except Exception as exc:
            message = str(exc)
            if tweets and is_transient_search_error(exc):
                counts[query] = 0
                query_errors[query] = message
                continue
            raise

        for tweet in page_tweets:
            tweets.append(tweet_payload(tweet))

        counts[query] = len(tweets) - before

    rows = dedupe(tweets)
    rows.sort(
        key=lambda item: int(item.get("date") or 0),
        reverse=True,
    )
    rows = rows[: args.limit]

    return {
        "provider": "twscrape",
        "queryMode": "latest",
        "paginationMode": "bounded",
        "query": args.query,
        "queries": queries,
        "queryCounts": counts,
        "queryErrors": query_errors,
        "requestedLimit": args.limit,
        "perQueryLimit": per_query_limit,
        "returned": len(rows),
        "hasMore": False,
        "nextCursor": None,
        "tweets": rows,
    }


async def collect_search_tweets(api, query: str, limit: int):
    tweets = []
    async for tweet in api.search(
        query,
        limit=limit,
        kv={"product": "Latest"},
    ):
        tweets.append(tweet)
    return tweets

def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--query", required=True)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--auth", required=True)
    parser.add_argument("--db", default="/tmp/potapoff-twscrape.db")
    parser.add_argument("--account", default="browser-session")
    parser.add_argument("--wait-timeout", type=int, default=30)
    parser.add_argument("--split-or", action="store_true")
    parser.add_argument("--user-timeline")
    parser.add_argument("--paged", action="store_true")
    parser.add_argument("--cursor")
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--retry-base-delay", type=float, default=5.0)
    return parser.parse_args()


def main():
    args = parse_args()
    args.limit = max(1, min(int(args.limit), 2000))
    try:
        result = asyncio.run(collect(args))
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    except Exception as exc:
        # Never include cookie values in errors.
        message = re.sub(r"(?i)(auth_token|ct0)=[^;\s]+", r"\1=<redacted>", str(exc))
        sys.stderr.write(message + "\n")
        sys.exit(2)


if __name__ == "__main__":
    main()
