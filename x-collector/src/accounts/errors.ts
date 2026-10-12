import { createRequire } from 'node:module';
import { q } from '../../lib/trade/pg';
import { taskFailure } from '../../lib/trade/task-errors';
const shared=createRequire(__filename)('../../scripts/account-health.cjs');
export type AccountErrorType='SESSION_EXPIRED'|'PROXY_FAILED'|'X_BLOCKED'|'RATE_LIMIT'|'BROWSER_ERROR'|'OTHER';
export const classifyError=(error:unknown):AccountErrorType=>{
 const code=taskFailure(error).code;
 if(code==='AUTH_EXPIRED')return 'SESSION_EXPIRED';
 if(code==='RATE_LIMIT')return 'RATE_LIMIT';
 if(code==='ACCESS_REQUIRED')return 'X_BLOCKED';
 return shared.classifyError(error);
};
export async function recordAccountError(name:string,error:unknown){const type=classifyError(error);await q('INSERT INTO xc_account_errors(account_name,type,message,created_at) VALUES($1,$2,$3,$4)',[name,type,shared.messages[type],Date.now()]);return type;}
