import assert from "node:assert/strict";
import {test} from "node:test";
import {decodeMintAccount,TOKEN_PROGRAM,TOKEN_2022_PROGRAM} from "../src/analytics/solana-mint-layout.js";

function sample(): Buffer { const b=Buffer.alloc(82); b[44]=9; b[45]=1; return b; }

test("SPL requires a valid 82-byte mint layout",()=>{
  assert.equal(decodeMintAccount(TOKEN_PROGRAM,sample())?.decimals,9);
  const tokenAccount=Buffer.alloc(165);tokenAccount[44]=9;tokenAccount[45]=1;
  assert.equal(decodeMintAccount(TOKEN_PROGRAM,tokenAccount),null);
  assert.equal(decodeMintAccount(TOKEN_PROGRAM,Buffer.alloc(82)),null);
});

test("Token-2022 mints require the extension account-type marker",()=>{
  const extended=Buffer.alloc(166);sample().copy(extended);extended[165]=1;
  assert.equal(decodeMintAccount(TOKEN_2022_PROGRAM,extended)?.decimals,9);
  assert.equal(decodeMintAccount(TOKEN_2022_PROGRAM,Buffer.concat([extended,Buffer.alloc(2)]))?.decimals,9,
    "zero-padded extension capacity is valid");
  const tokenAccount=Buffer.from(extended);tokenAccount[165]=2;
  assert.equal(decodeMintAccount(TOKEN_2022_PROGRAM,tokenAccount),null);
  const padding=Buffer.from(extended);padding[100]=5;
  assert.equal(decodeMintAccount(TOKEN_2022_PROGRAM,padding),null);
  assert.equal(decodeMintAccount(TOKEN_2022_PROGRAM,Buffer.alloc(165)),null);
});
