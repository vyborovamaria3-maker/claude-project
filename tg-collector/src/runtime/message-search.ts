import {Api} from 'telegram';
import {serializeBytes} from 'telegram/tl/generationHelpers.js';
import bigInt from 'big-integer';
/** Current public full-text request; the bundled GramJS only has the old hashtag signature.
 * Never sets allow_paid_stars. Uses the existing connection's negotiated response layer.
 * Schema: https://core.telegram.org/method/channels.searchPosts
 */
export function publicPostRequest(query:string,limit:number,offset={rate:0,id:0,channel:null as string|null,hash:null as string|null},hashtag=false){
 const peer=offset.channel&&offset.hash?new Api.InputPeerChannel({channelId:bigInt(offset.channel),accessHash:bigInt(offset.hash)}):new Api.InputPeerEmpty();
 const request=new Api.channels.SearchPosts({hashtag:query,limit,offsetRate:offset.rate,offsetPeer:peer,offsetId:offset.id});
 request.getBytes=()=>{
  const number=(value:number)=>{const b=Buffer.alloc(4);b.writeInt32LE(value);return b;};
  const constructor=Buffer.alloc(4);constructor.writeUInt32LE(0xf2c4f24d);
  return Buffer.concat([constructor,number(hashtag?1:2),serializeBytes(query),number(offset.rate),peer.getBytes(),number(offset.id),number(limit)]);
 };
 return request;
}
export function matchesSearchTerm(text:string,term:string):boolean{
 if(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(term))return new RegExp('(?<![1-9A-HJ-NP-Za-km-z])'+term+'(?![1-9A-HJ-NP-Za-km-z])').test(text);
 const escaped=term.trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+');
 return new RegExp('(^|[^\\p{L}\\p{N}_])'+escaped+'([^\\p{L}\\p{N}_]|$)','iu').test(text);
}
