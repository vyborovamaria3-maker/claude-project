const PRIORITY=Object.freeze({preflight:0,ingress:1,recovery:2,backfill:3});

export class DiscordRestScheduler {
  constructor({minIntervalMs=25,maxQueue=20_000,now=()=>Date.now(),
    sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
    if(!Number.isInteger(minIntervalMs)||minIntervalMs<0||minIntervalMs>1000)
      throw new RangeError("minIntervalMs must be in 0..1000");
    if(!Number.isInteger(maxQueue)||maxQueue<1||maxQueue>100_000)
      throw new RangeError("maxQueue must be in 1..100000");
    if(typeof now!=="function"||typeof sleep!=="function")
      throw new TypeError("Scheduler clock and sleep functions are required");
    this.minIntervalMs=minIntervalMs;
    this.maxQueue=maxQueue;
    this.now=now;
    this.sleep=sleep;
    this.queue=[];
    this.sequence=0;
    this.running=false;
    this.lastStartedAt=0;
    this.rateLimits=0;
  }

  run(priority,task){
    if(!Object.hasOwn(PRIORITY,priority)||typeof task!=="function")
      throw new TypeError("Unknown Discord REST priority or task");
    if(this.queue.length>=this.maxQueue){
      const error=new Error("Discord REST scheduler queue is full");
      error.code="DISCORD_REST_QUEUE_FULL";
      throw error;
    }
    const promise=new Promise((resolve,reject)=>{
      this.queue.push({priority,rank:PRIORITY[priority],sequence:this.sequence++,task,resolve,reject});
    });
    void this.pump();
    return promise;
  }

  async pump(){
    if(this.running)return;
    this.running=true;
    try{
      while(this.queue.length){
        this.queue.sort((a,b)=>a.rank-b.rank||a.sequence-b.sequence);
        const wait=this.minIntervalMs-(this.now()-this.lastStartedAt);
        if(this.lastStartedAt&&wait>0)await this.sleep(wait);
        const job=this.queue.shift();
        this.lastStartedAt=this.now();
        try{
          const result=await job.task();
          job.resolve(result);
        }catch(error){
          if(error?.status===429||error?.code===429)this.rateLimits++;
          job.reject(error);
        }
      }
    }finally{
      this.running=false;
      // A job can arrive between the final queue check and releasing the pump.
      if(this.queue.length)void this.pump();
    }
  }

  get pendingCount(){return this.queue.length+(this.running?1:0)}
  get rateLimitCount(){return this.rateLimits}
}

export const DISCORD_REST_PRIORITIES=PRIORITY;
