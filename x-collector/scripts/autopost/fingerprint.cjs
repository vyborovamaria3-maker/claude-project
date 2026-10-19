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
module.exports={fingerprints};
