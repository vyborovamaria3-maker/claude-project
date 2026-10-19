import type { XCookie } from "./client";
import {decryptBufferWithKeys} from "../../lib/trade/crypto";

/** Legacy and versioned X storage state; external explicit key contract preserved. */
export function decryptSession(encrypted:Buffer,key:Buffer,keys:Record<string,Buffer>={}):string{
 return decryptBufferWithKeys(encrypted,key,keys).toString("utf8");
}
export function extractCookies(decrypted:Buffer):XCookie[]{
 let parsed:unknown;
 try{parsed=JSON.parse(decrypted.toString("utf8"));}catch{throw Error("AUTH_REQUIRED: invalid session format");}
 if(Array.isArray(parsed))return parsed as XCookie[];
 const state=parsed as {cookies?:unknown};
 if(Array.isArray(state?.cookies)&&state.cookies.length>0)return state.cookies as XCookie[];
 throw Error("AUTH_REQUIRED: session has no cookies");
}
