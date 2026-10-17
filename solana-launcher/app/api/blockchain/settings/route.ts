import { NextRequest,NextResponse } from 'next/server';
import { getBackendBaseUrl } from '@/lib/authProxy';
import { overview,importUpload,runBatch } from '@/lib/blockchain-settings';
import { saveSettings } from '../../../../scripts/blockchain-runtime.cjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=300;

async function authorized(req:NextRequest) {
  if (process.env.NODE_ENV!=='production' && process.env.BLOCKCHAIN_LOCAL_OPERATOR==='1'
      && ['localhost','127.0.0.1','[::1]'].includes(req.nextUrl.hostname)) return true;
  const token=req.headers.get('authorization') || (req.cookies.get('potapoff_access_token')?.value ? 'Bearer '+req.cookies.get('potapoff_access_token')!.value : '');
  if (!token) return false;
  try {
    const response=await fetch(getBackendBaseUrl()+'/api/v1/users/me',{headers:{authorization:token},cache:'no-store',signal:AbortSignal.timeout(5000)});
    return response.ok && (await response.json()).is_superuser===true;
  } catch { return false; }
}
async function bounded(req:NextRequest,max:number) {
  const reader=req.body?.getReader();if (!reader) throw new Error('missing_body');
  const chunks:Uint8Array[]=[];let bytes=0;
  while(true) { const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>max){await reader.cancel();throw new Error('request_too_large');}chunks.push(chunk.value); }
  return Buffer.concat(chunks);
}
export async function GET(req:NextRequest) {
  if (!await authorized(req)) return NextResponse.json({error:'operator_required'},{status:403});
  return NextResponse.json(overview(),{headers:{'Cache-Control':'no-store'}});
}
export async function POST(req:NextRequest) {
  if (!await authorized(req)) return NextResponse.json({error:'operator_required'},{status:403});
  if (req.headers.get('origin')!==req.nextUrl.origin) return NextResponse.json({error:'same_origin_required'},{status:403});
  try {
    if (req.nextUrl.searchParams.get('action')==='import') {
      const category=req.nextUrl.searchParams.get('category')||'';
      const name=req.nextUrl.searchParams.get('name')||'';
      return NextResponse.json(importUpload(category,name,await bounded(req,16*1024*1024)));
    }
    const value=JSON.parse((await bounded(req,10000)).toString('utf8'));
    if (value.action==='run') return NextResponse.json(await runBatch());
    if (value.action!=='save') throw new Error('invalid_action');
    return NextResponse.json({values:saveSettings(value.settings)});
  } catch (error) {
    const message=error instanceof Error ? error.message : '';
    const safe=/^(invalid_|unknown_|duplicate_|rpc_not_configured|xlsx_invalid|request_too_large|collector_already_running)/.test(message) ? message : 'blockchain_action_failed';
    return NextResponse.json({error:safe},{status:message==='collector_already_running'?409:400});
  }
}
