export function requestTokenAnalysis(mint:string,options?:{env?:Record<string,string|undefined>;fetchImpl?:typeof fetch}):Promise<Record<string,unknown>>;
export function readTokenAnalysisRequest(request:Request):Promise<{mint:string}>;
