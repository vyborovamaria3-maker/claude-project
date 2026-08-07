import { readFile } from 'node:fs/promises';
import { pool, withTransaction } from '@/server/db/pool.js';
import { env } from '@/server/config/env.js';

const rows = JSON.parse(await readFile(env.FIXTURE_PATH, 'utf8')) as any[];
await withTransaction(async (client) => {
  for (const row of rows) {
    const handle=String(row.author.handle).toLowerCase();
    const account=await client.query<{id:string}>(`INSERT INTO x_accounts(handle,display_name,profile_url,avatar_url,followers,following,posts_count,verified,verified_type,joined_at,last_seen_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()) ON CONFLICT ((lower(handle))) DO UPDATE SET display_name=EXCLUDED.display_name,followers=EXCLUDED.followers,last_seen_at=now() RETURNING id`,
      [handle,row.author.name,row.author.profileUrl??`https://x.com/${handle}`,row.author.avatarUrl??null,row.author.followers??0,row.author.following??0,row.author.posts??0,row.author.isVerified??false,row.author.verifiedType??null,row.author.joinedAt??null]);
    await client.query(`INSERT INTO x_posts(id,created_at,author_id,text,url,likes,reposts,replies,quotes,views,raw) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(id,created_at) DO NOTHING`,[row.id,row.createdAt,account.rows[0]!.id,row.text,row.url,row.likes??0,row.retweets??0,row.replies??0,row.quotes??0,row.views??0,row]);
  }
});
console.log(`Seeded ${rows.length} fixture posts`); await pool.end();
