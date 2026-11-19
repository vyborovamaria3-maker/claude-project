/**
 * Bounded priority scheduler for Discord REST maintenance calls.
 * Higher-priority work is selected first between requests/pages; an in-flight
 * REST operation is never interrupted.
 */
export class RestScheduler{
  constructor({maxPending=100}={}){
    if(!Number.isInteger(maxPending)||maxPending<1||maxPending>10_000)
      throw new RangeError("maxPending must be in 1..10000");
    this.maxPending=maxPending;
    this.queue=[];
    this.running=false;
    this.sequence=0;
  }

  run(task,{priority=2,label="rest"}={}){
    if(typeof task!=="function")throw new TypeError("REST task must be a function");
    if(!Number.isInteger(priority)||priority<0||priority>3)
      throw new RangeError("REST task priority must be in 0..3");
    if(this.queue.length>=this.maxPending)
      return Promise.reject(new Error("discord_rest_scheduler_queue_full"));
    return new Promise((resolve,reject)=>{
      this.queue.push({task,priority,label,sequence:this.sequence++,resolve,reject});
      this.queue.sort((a,b)=>a.priority-b.priority||a.sequence-b.sequence);
      void this.pump();
    });
  }

  async pump(){
    if(this.running)return;
    this.running=true;
    try{
      while(this.queue.length){
        const item=this.queue.shift();
        try{item.resolve(await item.task())}
        catch(error){item.reject(error)}
      }
    }finally{
      this.running=false;
      if(this.queue.length)void this.pump();
    }
  }

  get pendingCount(){return this.queue.length+(this.running?1:0)}
}
