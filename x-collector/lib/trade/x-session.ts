/** Structural readiness only; X remains the authority on validity/revocation. */
export function hasXSession(state:unknown,now=Date.now()):boolean {
 if(typeof state!=="object"||state===null||!("cookies" in state)||!Array.isArray(state.cookies))return false;
 return state.cookies.some(c=>typeof c==="object"&&c!==null&&c.name==="auth_token"&&typeof c.value==="string"&&c.value.length>0&&typeof c.domain==="string"&&/^(\.)?(x\.com|twitter\.com)$/.test(c.domain)&&(c.expires===-1||(typeof c.expires==="number"&&c.expires>now/1000)));
}
