// The old pre-V2 hash is NOT the daily V2 content hash.
// Match both at queueing and at the irreversible send boundary.
const {digest}=require('./runtime.cjs');
function fingerprints(job){
 const kind=job.kind||'post',name=job.account_name||job.name;
 const raw=(job.content??job.text??'').trim().normalize('NFKC').toLowerCase().replace(/\s+/g,' ');
 const stripped=raw.replace(/https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/(?:i\/status\/\d+|[A-Za-z0-9_]{1,15}\/status\/\d+)(?:\?[^\s]*)?/gi,' ').replace(/\s+/g,' ').trim();
 const contentHash=digest(kind==='post'?[name,kind,stripped||raw].join('|'):[name,kind,job.target_id||''].join('|'));
 const legacyDedup=digest([name,kind,job.target_id||'',kind==='post'?raw:''].join('|'));
 return {contentHash,legacyDedup};
}

/** The pre-V2 dedup hash includes the exact source URL, unlike V2 hashes.
 * Check only legacy rows and compare their normalized content in memory;
 * do not log text, candidate identifiers or the legacy ciphertext.
 */
async function findHistoricalPostCollision(c,job,{day=null,excludeId=null}={}){
 if((job.kind||'post')!=='post')return null;
 const expected=fingerprints(job).contentHash;
 const rows=(await c.query(`SELECT id,account_name,kind,content,target_id,status,attempted,created_at
 FROM xc_auto_jobs WHERE account_name=$1 AND kind='post'
 AND (content_hash=dedup OR content_hash IS NULL)
 AND ((attempted AND status IN ('running','uncertain')) OR ($2::date IS NOT NULL AND dedup_day=$2::date))
 AND ($3::text IS NULL OR id<>$3)
 ORDER BY CASE WHEN attempted AND status IN ('running','uncertain') THEN 0 ELSE 1 END,created_at`,
 [job.account_name||job.name,day,excludeId])).rows;
 return rows.find(row=>fingerprints(row).contentHash===expected)||null;
}
module.exports={fingerprints,findHistoricalPostCollision};
