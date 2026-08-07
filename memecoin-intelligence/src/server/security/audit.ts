
export function auditEvent(event:string, data:Record<string,unknown>={}){
  console.log(JSON.stringify({
    type:"audit",
    event,
    time:new Date().toISOString(),
    ...data
  }));
}
