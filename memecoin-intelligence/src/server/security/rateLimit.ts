
const buckets = new Map<string, {count:number, reset:number}>();

export function checkRateLimit(
  key:string,
  limit=60,
  windowMs=60000
){
  const now=Date.now();
  const current=buckets.get(key);

  if(!current || current.reset < now){
    buckets.set(key,{count:1,reset:now+windowMs});
    return true;
  }

  if(current.count >= limit) return false;
  current.count++;
  return true;
}
