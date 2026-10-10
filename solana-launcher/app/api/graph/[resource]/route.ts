import {NextRequest,NextResponse} from 'next/server';
import {intelligenceGET} from '@/lib/intelligence-api';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest,context:{params:Promise<{resource:string}>}){
 const {resource}=await context.params;
 if(!['nodes','edges','relations','analytics'].includes(resource))return NextResponse.json({error:'Ресурс не найден'},{status:404});
 return intelligenceGET(request,resource);
}
