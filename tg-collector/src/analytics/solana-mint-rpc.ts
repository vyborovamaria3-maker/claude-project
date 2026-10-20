/**
 * A Solana Base58 address is NOT evidence that its account is an SPL Mint.
 * Require the RPC's verified parsed account type, correct token program,
 * initialized flag and finite decimals. Do not inspect arbitrary binary
 * account offsets (ordinary SPL token accounts share the same owner).
 */
export const TOKEN_PROGRAM="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export type VerifiedMintAccount={
  decimals:number;
  owner:typeof TOKEN_PROGRAM|typeof TOKEN_2022_PROGRAM;
};

type AccountResponse={
  result?:{
    context?:{slot?:unknown};
    value?:null|{
      owner?:unknown;executable?:unknown;
      data?:{program?:unknown;parsed?:{type?:unknown;info?:{
        isInitialized?:unknown;decimals?:unknown;
      }}};
    };
  };
  error?:unknown;
};

/** Return null only for an absent/nonmint account; throw on bad RPC/transport
 * so caller defers and retries rather than marking an address permanently bad.
 */
export async function readMintAccount(
  rpcUrl:string,mint:string,request:typeof fetch=fetch,
):Promise<VerifiedMintAccount|null>{
  if(typeof mint!=="string"||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint))
    throw new TypeError("invalid_solana_mint_candidate");
  let endpoint:URL;
  try{endpoint=new URL(rpcUrl)}catch{throw new TypeError("invalid_rpc_configuration")}
  if(endpoint.protocol!=="https:"||endpoint.username||endpoint.password||
     endpoint.hash||endpoint.search.length>1024)
    throw new TypeError("invalid_rpc_configuration");
  const response=await request(endpoint.href,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getAccountInfo",
      params:[mint,{encoding:"jsonParsed",commitment:"confirmed"}]}),
    signal:AbortSignal.timeout(12_000),redirect:"error",
  });
  if(!response.ok)throw new Error("mint_rpc_transport_failed");
  const raw=await response.text();
  if(raw.length>131_072)throw new Error("mint_rpc_response_oversized");
  let body:AccountResponse;
  try{body=JSON.parse(raw) as AccountResponse}
  catch{throw new Error("mint_rpc_response_invalid")}
  if(!body||typeof body!=="object"||Array.isArray(body)||
     body.error||!body.result||!Number.isSafeInteger(body.result.context?.slot)||
     Number(body.result.context?.slot)<0){
    throw new Error("mint_rpc_response_invalid");
  }
  const account=body.result.value;
  if(account===null)return null;
  if(!account||typeof account!=="object")throw new Error("mint_rpc_response_invalid");
  if(account.owner!==TOKEN_PROGRAM&&account.owner!==TOKEN_2022_PROGRAM)return null;
  const expected=account.owner===TOKEN_PROGRAM?"spl-token":"spl-token-2022";
  if(account.executable!==false||account.data?.program!==expected||
     account.data.parsed?.type!=="mint"||
     account.data.parsed.info?.isInitialized!==true||
     !Number.isInteger(account.data.parsed.info.decimals)||
     Number(account.data.parsed.info.decimals)<0||
     Number(account.data.parsed.info.decimals)>30)return null;
  return {decimals:account.data.parsed.info.decimals as number,
    owner:account.owner};
}
