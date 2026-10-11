import {NextRequest} from 'next/server';
import {intelligenceGET} from '@/lib/intelligence/controllers';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:NextRequest){return intelligenceGET(request,'similar');}
