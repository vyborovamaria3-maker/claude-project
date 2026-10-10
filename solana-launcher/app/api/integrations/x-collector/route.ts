import {accountProxyCommand,startAccountCheck,accountCheckStatus} from '@/lib/xcollector-diagnostics';
import {accountErrors,saveAccountSettings,removeAccountProxy} from '@/lib/xcollector-accounts';
import {autopostCommand,publicPublishJob} from '@/lib/xcollector-autopost';
import {startAccountLogin,finishAccountLogin,cancelAccountLogin,loginStatus} from '@/lib/xcollector-login';
import { NextRequest, NextResponse } from 'next/server';
import { getXCollectorSummary, runXCollectorAction, type XCollectorAction } from '@/lib/xcollector';
import { requireProdAuth } from '@/lib/routeAuth';
import { publisherStatistics, savePublisherProfile, changeCollectorAccountRole, AccountError, listCollectorAccounts, addCollectorAccount, deleteCollectorAccount } from '@/lib/xcollector-accounts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof AccountError ? error.message : 'Не удалось выполнить запрос. Проверьте базу X Collector, миграции и настройки.' }, { status: error instanceof AccountError ? error.status : 503 });
}
function localLogin(request: NextRequest) {
  if(!['localhost','127.0.0.1','[::1]'].includes(new URL(request.url).hostname)) throw new AccountError('Вход через браузер доступен на localhost',403);
}
function sameOrigin(request: NextRequest) {
  return request.headers.get('origin') === new URL(request.url).origin;
}
async function body(request: NextRequest) {
  // Read with a bound, including chunked requests without Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new AccountError('Тело запроса отсутствует');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 300000) { await reader.cancel(); throw new AccountError('Слишком большой запрос',413); } chunks.push(part.value); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AccountError('Некорректный JSON запроса'); }
}
export async function GET(request: NextRequest) {
  try {
    const auth = await requireProdAuth(request); if (auth) return auth;
    const action = new URL(request.url).searchParams.get('action');
    if (action === 'autopost-overview' || action === 'autopost-stats') {localLogin(request);return NextResponse.json(await autopostCommand({action:action==='autopost-overview'?'overview':'stats',name:new URL(request.url).searchParams.get('name')}),{headers:{'Cache-Control':'no-store'}});}
    if (action === 'publish-status') {localLogin(request);return NextResponse.json(publicPublishJob(await autopostCommand({action:'status',id:new URL(request.url).searchParams.get('id')})), {headers:{'Cache-Control':'no-store'}});}
    if (action === 'account-login-status') {localLogin(request);return NextResponse.json(loginStatus(new URL(request.url).searchParams.get('id')), {headers:{'Cache-Control':'no-store'}});}
    if (action === 'account-errors') return NextResponse.json(await accountErrors(new URL(request.url).searchParams.get('name')),{headers:{'Cache-Control':'no-store'}});
    if (action === 'publisher-stats') return NextResponse.json(await publisherStatistics(new URL(request.url).searchParams), { headers:{'Cache-Control':'no-store'} });
    if (action === 'accounts' || action === 'metrics') return NextResponse.json(await listCollectorAccounts(), { headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json(await getXCollectorSummary());
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const auth = await requireProdAuth(request); if (auth) return auth;
    if (!sameOrigin(request)) throw new AccountError('Запрос разрешён только со страницы сайта',403);
    const input = await body(request);
    if (['autopost-provider-save','autopost-provider-test','autopost-config-save','autopost-pause','autopost-enqueue','autopost-cancel','autopost-sync'].includes(input?.action)) {localLogin(request);return NextResponse.json(await autopostCommand({...input,action:input.action.slice(9)}));}
    if (input?.action === 'publish-start') {localLogin(request);return NextResponse.json(publicPublishJob(await autopostCommand({...input,action:'enqueue',kind:'post'})),{status:202});}
    if (['account-login-start','account-login-finish','account-login-cancel'].includes(input?.action)) {localLogin(request);return NextResponse.json(input.action==='account-login-start'?startAccountLogin(input):input.action==='account-login-finish'?finishAccountLogin(input.id):cancelAccountLogin(input.id));}
    if (input?.action === 'account-settings-save') return NextResponse.json(await saveAccountSettings(input));
    if (input?.action === 'account-proxy-remove') return NextResponse.json(await removeAccountProxy(input));
    if (['account-proxy-test','account-proxy-save','account-check-start','account-check-status'].includes(input?.action)) {localLogin(request);return NextResponse.json(input.action==='account-check-start'?startAccountCheck(input):input.action==='account-check-status'?accountCheckStatus(input.id):await accountProxyCommand(input),{headers:{'Cache-Control':'no-store'}});}
    if (input?.action === 'publisher-profile') return NextResponse.json(await savePublisherProfile(input));
    if (input?.action === 'account-role') return NextResponse.json(await changeCollectorAccountRole(input));
    if (input?.action === 'account-add') return NextResponse.json(await addCollectorAccount(input), { status: 201 });
    if (typeof input?.action !== 'string') throw new AccountError('action обязателен');
    return NextResponse.json({ action: input.action, ...await runXCollectorAction(input.action as XCollectorAction) });
  } catch (error) { return failure(error); }
}
export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireProdAuth(request); if (auth) return auth;
    if (!sameOrigin(request)) throw new AccountError('Запрос разрешён только со страницы сайта',403);
    return NextResponse.json(await deleteCollectorAccount(await body(request)));
  } catch (error) { return failure(error); }
}
