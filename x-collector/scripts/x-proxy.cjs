const {playwrightProxy}=require('./account-health.cjs');
function parseProxy(input){try{return playwrightProxy(input);}catch{return undefined;}}
module.exports={parseProxy};
