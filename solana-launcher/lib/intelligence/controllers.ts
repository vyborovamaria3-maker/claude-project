import {NextRequest,NextResponse} from 'next/server';
import {requireProdAuth} from '../routeAuth';
import {AccountError,collectorDatabase} from '../xcollector-accounts';
import {assertUuid,parseEntityFilter,parsePage,parseRelationFilter,parseSimilarQuery,parseWalletQuery,requireEntity} from './dto';
import {findSimilar,getAnalytics,getEntityBundle,getOverview,getTagTaxonomy,getWallet,listClusters,listEntities,listEvidence,listRelations} from './services';

export type IntelligenceResource=
 |'overview'|'entities'|'nodes'|'entity'|'edges'|'relations'|'analytics'
 |'evidence'|'tags'|'clusters'|'similar'|'wallet';

const KINDS=new Set<IntelligenceResource>([
 'overview','entities','nodes','entity','edges','relations','analytics',
 'evidence','tags','clusters','similar','wallet']);

export async function intelligenceGET(request:NextRequest,resource:string,id?:string){
 const kind=KINDS.has(resource as IntelligenceResource)?resource as IntelligenceResource:null;
 try{
  const auth=await requireProdAuth(request);if(auth)return auth;
  const db=collectorDatabase(),url=new URL(request.url),page=parsePage(url);
  let data:unknown;
  if(kind==='entities'||kind==='nodes'){
   data=await listEntities(db,parseEntityFilter(url),page);
  }else if(kind==='entity'&&id){
   const bundle=await getEntityBundle(db,assertUuid(id),page.limit);
   if(!bundle)throw new AccountError('Сущность не найдена',404);
   data=bundle;
  }else if(kind==='edges'||kind==='relations'){
   data=await listRelations(db,parseRelationFilter(url),page);
  }else if(kind==='analytics'){
   data=await getAnalytics(db,requireEntity(url),page.limit);
  }else if(kind==='evidence'&&id){
   data=await listEvidence(db,assertUuid(id),page);
  }else if(kind==='tags'){
   data=await getTagTaxonomy(db);
  }else if(kind==='clusters'){
   data=await listClusters(db,page);
  }else if(kind==='similar'){
   data=await findSimilar(db,parseSimilarQuery(url),page.limit);
  }else if(kind==='wallet'&&id){
   const {chain,address}=parseWalletQuery(url,id);
   const wallet=await getWallet(db,chain,address);
   if(!wallet)throw new AccountError('Кошелёк не найден',404);
   data=wallet;
  }else if(kind==='overview'){
   data=await getOverview(db);
  }else throw new AccountError('Ресурс не найден',404);
  return NextResponse.json({data,limit:page.limit,offset:page.offset},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return NextResponse.json({error:error instanceof AccountError?error.message:'Intelligence недоступен. Проверьте миграции и базу.'},{status:error instanceof AccountError?error.status:503});}
}
