import fs from 'node:fs';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';

/** Native Pi RPC with strict LF framing, continuous stdout draining, correlated responses.
 * Unlike --session print restarts, the one long-lived process also preserves orche's worker pool.
 */
export class PiRpc {
 child:ChildProcessWithoutNullStreams;
 exit:Promise<{code:number|null;signal:string|null}>;
 private serial=0;
 private pending=new Map<string,{resolve:(value:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 private listeners=new Set<(event:any)=>void>();
 private failure:Error|undefined;
 constructor(args:string[],cwd:string,env:NodeJS.ProcessEnv,eventsFile:string,stderrFile:string){
  this.child=spawn(process.execPath,args,{cwd,env,detached:true,stdio:['pipe','pipe','pipe']});
  const decoder=new StringDecoder('utf8');let buffer='';
  this.exit=new Promise(resolve=>{
   this.child.once('close',(code,signal)=>{this.fail(new Error(`Pi RPC exited ${code}/${signal??'none'}`));resolve({code,signal});});
  });
  this.child.once('error',e=>this.fail(e));
  this.child.stdin.on('error',e=>this.fail(e));
  this.child.stderr.on('data',chunk=>fs.appendFileSync(stderrFile,chunk));
  this.child.stdout.on('data',chunk=>{
   fs.appendFileSync(eventsFile,chunk);
   buffer+=decoder.write(chunk);
   let end:number;
   while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);
    if(!line)continue;
    try{
     const event=JSON.parse(line);
     if(['compaction_start','compaction_end'].includes(event.type)){
      const {summary,...result}=event.result??{};void summary;
      fs.appendFileSync(eventsFile.replace(/\.jsonl$/,'-timing.jsonl'),JSON.stringify({timestamp:Date.now(),type:event.type,reason:event.reason,result,aborted:event.aborted,willRetry:event.willRetry,error:!!event.errorMessage})+'\n');
     }
     this.dispatch(event);
    }catch(e){this.fail(new Error(`Invalid RPC frame: ${String(e)}`));}
   }
  });
 }
 private fail(error:Error){
  this.failure??=error;
  for(const {reject,timer} of this.pending.values()){clearTimeout(timer);reject(this.failure);}
  this.pending.clear();
  for(const fn of this.listeners)fn({type:'rpc_exit',error:this.failure.message});
 }
 private dispatch(event:any){
  if(event.type==='response'){
   const p=this.pending.get(event.id);if(p){this.pending.delete(event.id);clearTimeout(p.timer);event.success?p.resolve(event.data):p.reject(new Error(`RPC ${event.command}: ${event.error}`));}
  }
  // Do not let an unexpected interactive dialog stall a headless run.
  if(event.type==='extension_ui_request'&&['select','confirm','input','editor'].includes(event.method)){
   this.child.stdin.write(JSON.stringify({type:'extension_ui_response',id:event.id,cancelled:true})+'\n');
  }
  for(const fn of this.listeners)fn(event);
 }
 command(type:string,data:any={},timeoutMs=60_000):Promise<any>{
  if(this.failure)return Promise.reject(this.failure);
  const id=`rpc-${++this.serial}`;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`RPC ${type} response timed out`));},timeoutMs);
   this.pending.set(id,{resolve,reject,timer});
   this.child.stdin.write(JSON.stringify({id,type,...data})+'\n');
  });
 }
 async prompt(message:string):Promise<any[]>{
  const events:any[]=[];
  const settled=Promise.withResolvers<void>();
  const listener=(e:any)=>{events.push(e);if(e.type==='agent_settled')settled.resolve();if(e.type==='rpc_exit')settled.reject(new Error(e.error));};
  this.listeners.add(listener);
  // Avoid an unhandled rejection when the child dies before its prompt response.
  void settled.promise.catch(()=>{});
  try{
   const accepted=await this.command('prompt',{message});
   if(accepted?.disposition==='handled')throw new Error('Benchmark prompt consumed without agent run');
   if(accepted?.disposition!=='started')throw new Error(`Unexpected prompt disposition ${accepted?.disposition}`);
   await settled.promise;
   return events;
  }finally{this.listeners.delete(listener);}
 }
 kill(){try{if(this.child.pid)process.kill(-this.child.pid,'SIGKILL');}catch{}}
 async stop(){
  if(this.child.exitCode!==null||this.child.signalCode!==null)return this.exit;
  this.child.stdin.end();
  const timer=setTimeout(()=>this.kill(),15_000);
  try{return await this.exit;}finally{clearTimeout(timer);}
 }
}
