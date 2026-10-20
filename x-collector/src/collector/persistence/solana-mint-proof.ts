import {validMint} from "../../../lib/archive/model";

export const TOKEN_PROGRAM="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export type MintAccountProof={
  tokenProgram:typeof TOKEN_PROGRAM|typeof TOKEN_2022_PROGRAM;
  provider:"alchemy-solana-rpc";
  checkedAt:Date;
  slot:number;
};
type FetchLike=typeof fetch;

/**
 * A Base58 public key or a local archive-token row is NOT a token proof.
 * Require a remote Solana mainnet account parsed by the RPC as initialized
 * Mint (not TokenAccount), owned by the correct SPL Token program.
 *
 * No URLs, request bodies, provider errors or raw response are logged. A
 * failure in transport/parsing is deferred, not treated as "not a mint".
 */
export async function verifySolanaMintViaAlchemy(
  rpcUrl:string,mint:string,request:FetchLike=fetch,
):Promise<MintAccountProof|null>{
  if(!validMint(mint))throw new TypeError("invalid candidate Solana public key");
  let endpoint:URL;
  try{endpoint=new URL(rpcUrl)}catch{throw new TypeError("invalid mint RPC configuration")}
  if(endpoint.protocol!=="https:"||endpoint.username||endpoint.password||
     endpoint.hash||endpoint.search.length>1024)throw new TypeError("invalid mint RPC endpoint");
  const response=await request(endpoint.href,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getAccountInfo",
      params:[mint,{encoding:"jsonParsed",commitment:"confirmed"}]}),
    signal:AbortSignal.timeout(12_000),
    redirect:"error",
  });
  if(!response.ok)throw new Error("mint_rpc_transport_failed");
  const raw=await response.text();
  if(raw.length>131_072)throw new Error("mint_rpc_response_oversized");
  let body:unknown;
  try{body=JSON.parse(raw)}catch{throw new Error("mint_rpc_response_invalid")}
  if(!body||typeof body!=="object"||Array.isArray(body))throw new Error("mint_rpc_response_invalid");
  const data=body as {result?:{context?:{slot?:unknown};value?:{
    owner?:unknown;executable?:unknown;
    data?:{program?:unknown;parsed?:{type?:unknown;info?:{isInitialized?:unknown;decimals?:unknown}}}
  }|null};error?:unknown};
  if(data.error||!data.result||typeof data.result.context?.slot!=="number"||
     !Number.isSafeInteger(data.result.context.slot)||data.result.context.slot<0){
    throw new Error("mint_rpc_response_invalid");
  }
  const account=data.result.value;
  if(account===null)return null;
  if(!account||typeof account!=="object")throw new Error("mint_rpc_response_invalid");
  const owner=account.owner;
  if(owner!==TOKEN_PROGRAM && owner!==TOKEN_2022_PROGRAM)return null;
  const expectedProgram=owner===TOKEN_PROGRAM?"spl-token":"spl-token-2022";
  if(account.executable!==false||account.data?.program!==expectedProgram||
     account.data.parsed?.type!=="mint"||
     account.data.parsed.info?.isInitialized!==true||
     !Number.isInteger(account.data.parsed.info.decimals)||
     (account.data.parsed.info.decimals as number)<0||
     (account.data.parsed.info.decimals as number)>30)return null;
  return {
    tokenProgram:owner,provider:"alchemy-solana-rpc",
    checkedAt:new Date(),slot:data.result.context.slot,
  };
}
