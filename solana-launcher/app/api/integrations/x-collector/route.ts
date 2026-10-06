import { NextRequest, NextResponse } from "next/server";
import { getXCollectorSummary, runXCollectorAction, type XCollectorAction } from "@/lib/xcollector";
import { requireProdAuth } from "@/lib/routeAuth";
import { Pool } from "pg";
import dotenv from "dotenv";

// Load x-collector .env
dotenv.config({ path: process.env.X_COLLECTOR_ENV ? process.env.X_COLLECTOR_ENV : "./x-collector/.env" });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  statement_timeout: 60_000,
});


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");

  if (action === "metrics") {
    try {
      const metrics = await fetchAccountMetrics(searchParams);
      return NextResponse.json(metrics);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to load metrics" },
        { status: 500 },
      );
    }
  }

  try {
    return NextResponse.json(await getXCollectorSummary());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load X Collector summary" },
      { status: 500 },
    );
  }
}

async function fetchAccountMetrics(params: URLSearchParams) {
  const client = await pool.connect();
  try {
    const days = parseInt(params.get("days") || "30");
    const limit = Math.min(parseInt(params.get("limit") || "50"), 100);

    // Get account summary with activity metrics
    const accountsQuery = `
      SELECT 
        a.id,
        a.x_username,
        a.tier,
        a.status,
        COALESCE(stats.total_tweets_replied, 0) as total_tweets_replied,
        COALESCE(stats.total_hours_active, 0) as total_hours_active,
        COUNT(t.id) FILTER (WHERE t.posted_at >= NOW() - INTERVAL '${days} days') as recent_tweets,
        COUNT(t.id) FILTER (WHERE t.posted_at >= NOW() - INTERVAL '24 hours') as tweets_24h
      FROM x_accounts a
      LEFT JOIN author_token_stats stats ON a.x_username = stats.handle
      LEFT JOIN twitter_tweets t ON a.x_username = t.handle
      GROUP BY a.id, a.x_username, a.tier, a.status, stats.total_tweets_replied, stats.total_hours_active
      ORDER BY recent_tweets DESC
      LIMIT $1
    `;

    const accountsResult = await client.query(accountsQuery, [limit]);

    // Get detailed tweets metrics (views, likes, retweets)
    const tweetsQuery = `
      SELECT 
        handle,
        COUNT(*) as total_tweets,
        SUM(views) FILTER (WHERE views IS NOT NULL) as total_views,
        SUM(likes) FILTER (WHERE likes IS NOT NULL) as total_likes,
        SUM(retweets) FILTER (WHERE retweets IS NOT NULL) as total_retweets,
        SUM(replies) FILTER (WHERE replies IS NOT NULL) as total_replies
      FROM twitter_tweets
      WHERE posted_at >= NOW() - INTERVAL '${days} days'
      GROUP BY handle
      ORDER BY total_tweets DESC
      LIMIT $1
    `;

    const tweetsResult = await client.query(tweetsQuery, [limit]);

    // Get alert data (bans, errors)
    const alertsQuery = `
      SELECT 
        a.x_username,
        COUNT(*) FILTER (WHERE a.status = 'banned') as ban_count,
        COUNT(*) FILTER (WHERE a.status = 'paused') as pause_count,
        COUNT(*) FILTER (WHERE a.account_busy_until > EXTRACT(EPOCH FROM NOW()) * 1000) as busy_count,
        COUNT(*) FILTER (WHERE a.cooldown_until > EXTRACT(EPOCH FROM NOW()) * 1000) as cooldown_count
      FROM x_accounts a
      GROUP BY a.x_username
      HAVING COUNT(*) FILTER (WHERE a.status != 'active') > 0
    `;

    const alertsResult = await client.query(alertsQuery);

    // Get time series data for metrics
    const timeseriesQuery = `
      SELECT 
        DATE_TRUNC('hour', posted_at) as hour,
        handle,
        COUNT(*) as tweet_count,
        SUM(views) FILTER (WHERE views IS NOT NULL) as views_count,
        SUM(likes) FILTER (WHERE likes IS NOT NULL) as likes_count,
        SUM(retweets) FILTER (WHERE retweets IS NOT NULL) as retweets_count
      FROM twitter_tweets
      WHERE posted_at >= NOW() - INTERVAL '${days} days'
      GROUP BY DATE_TRUNC('hour', posted_at), handle
      ORDER BY hour DESC, tweet_count DESC
      LIMIT 500
    `;

    const timeseriesResult = await client.query(timeseriesQuery);

    return {
      accounts: accountsResult.rows,
      tweetMetrics: tweetsResult.rows,
      alerts: alertsResult.rows,
      timeseries: timeseriesResult.rows,
      period: days,
      updatedAt: new Date().toISOString(),
    };
  } finally {
    client.release();
  }
}

export async function POST(request: NextRequest) {
  try {
    const authError = await requireProdAuth(request);
    if (authError) return authError;

    const body = await request.json().catch(() => ({}));
    const action = typeof body?.action === "string" ? (body.action as XCollectorAction) : null;
    if (!action) {
      return NextResponse.json({ error: "action is required" }, { status: 400 });
    }

    const result = await runXCollectorAction(action);
    return NextResponse.json({ action, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to run X Collector action" },
      { status: 500 },
    );
  }
}
