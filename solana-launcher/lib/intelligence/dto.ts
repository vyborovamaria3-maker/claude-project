import {AccountError} from '../xcollector-accounts';

export type Page={limit:number;offset:number};
export type EntityFilter={type:string|null;q:string};
export type RelationFilter={entity:string|null;at:string|null};
export type SimilarQuery={entity:string;model:string};
export type WalletQuery={chain:string;address:string};

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertUuid(id:string,label='ID'):string{
 if(!UUID.test(id))throw new AccountError(`Некорректный ${label}`);
 return id;
}

export function parsePage(url:URL):Page{
 const rawLimit=url.searchParams.get('limit')??'50',rawOffset=url.searchParams.get('offset')??'0';
 if(!/^\d{1,3}$/.test(rawLimit)||!/^\d{1,7}$/.test(rawOffset))throw new AccountError('Некорректная пагинация');
 return{limit:Math.min(200,Math.max(1,Number(rawLimit))),offset:Number(rawOffset)};
}

export function parseEntityFilter(url:URL):EntityFilter{
 const q=url.searchParams.get('q')??'',type=url.searchParams.get('type');
 if(q.length>200)throw new AccountError('Слишком длинный запрос');
 if(type!==null&&type.length>50)throw new AccountError('Некорректный тип');
 return{type,q};
}

export function parseRelationFilter(url:URL):RelationFilter{
 const entity=url.searchParams.get('entity'),at=url.searchParams.get('at');
 if(entity!==null)assertUuid(entity,'сущность');
 if(at!==null&&!Number.isFinite(Date.parse(at)))throw new AccountError('Некорректная дата');
 return{entity,at};
}

export function requireEntity(url:URL):string{
 const entity=url.searchParams.get('entity');
 if(!entity)throw new AccountError('Укажите entity');
 return assertUuid(entity,'сущность');
}

export function parseSimilarQuery(url:URL):SimilarQuery{
 const entity=requireEntity(url),model=url.searchParams.get('model');
 if(!model||model.length>200)throw new AccountError('Нужны entity и model');
 return{entity,model};
}

export function parseWalletQuery(url:URL,address:string):WalletQuery{
 const chain=url.searchParams.get('chain');
 if(!chain||chain.length>50||address.length>200)throw new AccountError('Укажите chain и адрес кошелька');
 return{chain,address};
}
