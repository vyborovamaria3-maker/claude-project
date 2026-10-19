export function publicReferences(text:string,limit=30):{username:string;messageId:number|null}[]{
 const found=new Map<string,{username:string;messageId:number|null}>();
 const pattern=/(?<![a-zA-Z0-9_.-])(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:s\/)?([a-z][a-z0-9_]{4,31})(?![a-z0-9_])(?:\/(\d+))?/gi;
 for(const m of text.slice(0,524288).matchAll(pattern)){
  const username=m[1].toLowerCase();if(/^(?:joinchat|share|proxy|login|addlist|boost)$/.test(username)||/bot$/.test(username))continue;
  const id=m[2]?Number(m[2]):null;if(id!==null&&(!Number.isSafeInteger(id)||id<1||id>2147483647))continue;
  found.set(username+':'+id,{username,messageId:id});if(found.size>=limit)break;
 }
 return [...found.values()];
}
export function previewMessageIds(html:string,username:string):number[]{
 const ids=new Set<number>();
 for(const m of html.slice(0,524288).matchAll(/data-post=["']([a-z][a-z0-9_]{4,31})\/(\d+)["']/gi)){
  const id=Number(m[2]);if(m[1].toLowerCase()===username.toLowerCase()&&Number.isSafeInteger(id)&&id>0&&id<=2147483647)ids.add(id);
 }
 return [...ids].sort((a,b)=>b-a).slice(0,20);
}
