/**
 * Strict, key-order-independent JSON value comparison for PostgreSQL JSONB
 * outbox payloads. JSONB does not preserve object insertion order; arrays,
 * explicit presence/absence, and scalar types must still match exactly.
 *
 * Kept dependency-free because contracts is a portable Node/browser package.
 * Non-JSON objects (Date, Map, prototypes, symbol keys) are rejected.
 */
export function jsonStructurallyEqual(left:unknown,right:unknown,depth=0):boolean {
  if(depth>64)return false;
  if(left===null||right===null)return left===right;
  if(typeof left!=="object"||typeof right!=="object"){
    return left===right;
  }
  const leftArray=Array.isArray(left),rightArray=Array.isArray(right);
  if(leftArray!==rightArray)return false;
  if(leftArray&&rightArray){
    if(left.length!==right.length)return false;
    return left.every((item,index)=>
      Object.hasOwn(left,index)===Object.hasOwn(right,index) &&
      jsonStructurallyEqual(item,right[index],depth+1));
  }
  const plain=(value:object)=>{
    const proto=Object.getPrototypeOf(value);
    return (proto===Object.prototype||proto===null) &&
      Object.getOwnPropertySymbols(value).length===0;
  };
  if(!plain(left)||!plain(right))return false;
  const a=left as Record<string,unknown>;
  const b=right as Record<string,unknown>;
  const keys=Object.keys(a),other=Object.keys(b);
  if(keys.length!==other.length)return false;
  return keys.every(key=>Object.hasOwn(b,key) &&
    jsonStructurallyEqual(a[key],b[key],depth+1));
}
