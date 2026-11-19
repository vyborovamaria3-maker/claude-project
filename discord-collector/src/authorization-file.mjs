import {constants} from "node:fs";
import {open} from "node:fs/promises";
import {isAbsolute} from "node:path";

const MAX_AUTHORIZATION_FILE_BYTES=1_048_576;

export async function readAuthorizationFile(path){
  if(typeof path!=="string"||!path.trim()||!isAbsolute(path))
    throw new TypeError("DISCORD_AUTHORIZATION_PATH must be an absolute path");
  if(typeof constants.O_NOFOLLOW!=="number")
    throw new Error("Authorization file no-follow open is unavailable on this platform");
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=await handle.stat();
    if(!stat.isFile())throw new Error("Authorization policy must be a regular file");
    if((stat.mode&0o777)!==0o600)
      throw new Error("Authorization policy file must already have exact mode 0600");
    if(typeof process.getuid==="function"&&stat.uid!==process.getuid())
      throw new Error("Authorization policy file must be owned by the Collector user");
    if(stat.size<1||stat.size>MAX_AUTHORIZATION_FILE_BYTES)
      throw new Error("Authorization policy file size is outside 1 byte..1 MiB");
    const source=await handle.readFile({encoding:"utf8"});
    if(Buffer.byteLength(source,"utf8")>MAX_AUTHORIZATION_FILE_BYTES)
      throw new Error("Authorization policy file exceeds 1 MiB");
    return JSON.parse(source);
  }finally{
    await handle.close();
  }
}
