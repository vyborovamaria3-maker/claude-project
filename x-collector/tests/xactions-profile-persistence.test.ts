import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { persistProfile } from "../lib/trade/collector-store";

test("partial HTTP profile never clears confirmed verification; rowCount tracks unique links", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE ip_raw_events (
      id uuid PRIMARY KEY, source text NOT NULL, event_type text NOT NULL,
      external_id text NOT NULL, payload jsonb NOT NULL, payload_hash text NOT NULL,
      collector_account text, collected_at timestamptz NOT NULL,
      UNIQUE(source,event_type,external_id,payload_hash,collected_at)
    );
    CREATE TABLE twitter_profiles (
      handle text PRIMARY KEY,display_name text,bio text,followers bigint,
      following bigint,posts_count bigint,is_verified boolean,joined_at bigint,
      avatar_url text,first_seen_at bigint,last_seen_at bigint
    );
    CREATE TABLE x_task_profiles (task_id bigint,handle text,PRIMARY KEY(task_id,handle));
    CREATE TABLE twitter_profile_observations (
      handle text,observed_at timestamptz,raw jsonb,PRIMARY KEY(handle,observed_at)
    );`);
    const client = { query: async (sql: string, params: unknown[] = []) => {
      const result = await db.query(sql, params);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    }} as unknown as PoolClient;
    const profile = {
      handle: "NASA", displayName: "NASA", bio: null,
      followers: 100, following: 0, postsCount: 10,
      isVerified: true, joinedAt: null, avatarUrl: null,
    };
    assert.equal(await persistProfile(profile, 9, "collector", undefined, { client }), 1);
    const sparse = { ...profile, isVerified: false, followers: null, following: null, postsCount: null };
    assert.equal(await persistProfile(sparse, 9, "collector", undefined, { client, transport: "http" }), 0);
    let saved = (await db.query<{ is_verified: boolean; followers: string }>(
      "SELECT is_verified,followers::text FROM twitter_profiles WHERE handle='nasa'",
    )).rows[0];
    assert.equal(saved.is_verified, true);
    assert.equal(saved.followers, "100");
    assert.equal(await persistProfile(sparse, 9, "collector", undefined, { client, transport: "browser" }), 0);
    saved = (await db.query<{ is_verified: boolean; followers: string }>(
      "SELECT is_verified,followers::text FROM twitter_profiles WHERE handle='nasa'",
    )).rows[0];
    assert.equal(saved.is_verified, false);
    assert.equal(saved.followers, "100");
  } finally {
    await db.close();
  }
});
