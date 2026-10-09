// Copy this file to your-provider.cjs, implement its API, then select custom in the UI.
// Do not log apiKey, prompts, headers or complete error responses.
// Return a STRING containing {"actions":[...]} ; signal must cancel the request.
exports.generate=async function(_options){
 throw Error('Настройте собственный адаптер по API вашего провайдера');
};
