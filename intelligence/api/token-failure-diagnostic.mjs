const codes=new Set(['ai_provider_timeout','ai_provider_network_error','ai_provider_auth_failed','ai_provider_http_error','ai_provider_rate_limited','ai_provider_response_invalid','ai_provider_response_too_large','ai_provider_capacity_exhausted','ai_provider_cost_budget_exhausted','ai_request_aborted','57014','ECONNREFUSED','ECONNRESET','ETIMEDOUT']);
export function tokenFailureDiagnostic(error,elapsedMs){
 return {event:'token_analysis_failed',code:codes.has(error?.code)?error.code:'unclassified_failure',elapsedMs:Math.max(0,Math.round(elapsedMs))};
}
