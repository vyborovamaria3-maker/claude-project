const MAX_PRE_SEND_RETRIES=3;
const RETRY_DELAYS_MS=[30_000,120_000,600_000];

function classifyPreSendError(error){
 const message=String(error&&error.message||error||'');
 if(/SESSION_EXPIRED|AUTH_REQUIRED|auth_token|ct0|session.*(?:expired|decrypt)|MASTER_KEY|\/login/i.test(message))return {retryable:false,code:'SESSION_EXPIRED',message:'Сессия X истекла или недействительна. Обновите авторизацию аккаунта; автоматический повтор отключён.'};
 if(/PROXY_FAILED|ERR_PROXY|ERR_TUNNEL|\bsocks?\b|proxy/i.test(message))return {retryable:false,code:'PROXY_FAILED',message:'Прокси недоступен или настроен неверно. Проверьте прокси аккаунта; автоматический повтор отключён.'};
 if(/RATE_LIMIT|(?:HTTP\s*)?429|rate.?limit|(?:HTTP\s*)?403|captcha|challenge|suspend|access.?denied|X_BLOCKED/i.test(message))return {retryable:false,code:'X_RESTRICTED',message:'X ограничил доступ или запросил проверку. Автоматический повтор отключён; проверьте аккаунт вручную.'};
 if(/Профиль сессии не совпал/i.test(message))return {retryable:false,code:'ACCOUNT_MISMATCH',message:'Сессия открыла другой профиль. Отправка отменена; проверьте ожидаемый username и сохранённую сессию.'};
 if(/Аккаунт неактивен или удалён/i.test(message))return {retryable:false,code:'ACCOUNT_INACTIVE',message:'Аккаунт неактивен или удалён. Включите аккаунт или выберите другой.'};
 if(/Целевой пост не подтверждён|Не удалось подтвердить ID/i.test(message))return {retryable:false,code:'TARGET_NOT_FOUND',message:'Целевой пост или профиль не удалось подтвердить. Отправка отменена; проверьте цель задания.'};
 if(/net::ERR_(?:TIMED_OUT|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|NETWORK_CHANGED|ADDRESS_UNREACHABLE|SOCKET_NOT_CONNECTED|QUIC_PROTOCOL_ERROR)|\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN)\b|socket hang up|Timeout \d+ms exceeded|Target page, context or browser has been closed|frame was detached|Navigation failed because/i.test(message))return {retryable:true,code:'TEMPORARY_NETWORK',message:'X временно недоступен до отправки. Можно безопасно повторить задание.'};
 return {retryable:false,code:'PRE_SEND_FAILED',message:'Не удалось подготовить публикацию до отправки. Проверьте сессию, username, прокси, браузер и доступность X.'};
}

function shouldRetryBeforeSend(error,attempted,retryCount){
 if(attempted)return false;
 const count=Number(retryCount);
 return classifyPreSendError(error).retryable&&Number.isInteger(count)&&count>=0&&count<MAX_PRE_SEND_RETRIES;
}

function retryDelayMs(retryCount){
 const count=Number(retryCount);
 const index=Number.isInteger(count)?Math.max(0,Math.min(count,RETRY_DELAYS_MS.length-1)):0;
 return RETRY_DELAYS_MS[index];
}

module.exports={MAX_PRE_SEND_RETRIES,classifyPreSendError,shouldRetryBeforeSend,retryDelayMs};
