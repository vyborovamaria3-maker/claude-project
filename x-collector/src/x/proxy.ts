import { createRequire } from "node:module";
export interface PlaywrightProxy { server: string; username?: string; password?: string; }
const shared=createRequire(__filename)("../../scripts/account-health.cjs");
/** Legacy formats and canonical type/host/port, without credentials in server. */
export function parseProxy(input:string|null|undefined):PlaywrightProxy|undefined {
 try{return shared.playwrightProxy(input);}catch{return undefined;}
}
