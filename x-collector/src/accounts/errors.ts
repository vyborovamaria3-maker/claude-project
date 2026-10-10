import { createRequire } from 'node:module';
import { q } from '../../lib/trade/pg';
const shared=createRequire(__filename)('../../scripts/account-health.cjs');
export type AccountErrorType='SESSION_EXPIRED'|'PROXY_FAILED'|'X_BLOCKED'|'RATE_LIMIT'|'BROWSER_ERROR'|'OTHER';
export const classifyError:(error:unknown)=>AccountErrorType=shared.classifyError;
export async function recordAccountError(name:string,error:unknown){const type=classifyError(error);await q('INSERT INTO xc_account_errors(account_name,type,message,created_at) VALUES($1,$2,$3,$4)',[name,type,shared.messages[type],Date.now()]);return type;}
