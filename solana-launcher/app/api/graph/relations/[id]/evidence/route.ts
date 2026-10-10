import {NextRequest} from 'next/server';
import {intelligenceGET} from '@/lib/intelligence-api';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest,context:{params:Promise<{id:string}>}){return intelligenceGET(request,'evidence',(await context.params).id);}
