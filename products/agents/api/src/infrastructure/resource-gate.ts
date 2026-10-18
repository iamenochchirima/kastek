import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
const gates = new Map<string, Promise<unknown>>();
const heldGates=new AsyncLocalStorage<ReadonlySet<string>>();
/** Serializes physical transitions on one explicitly owned executor; never holds a DB connection. */
export async function resourceGate<T>(key: string, work: () => Promise<T>, lockFile?: string): Promise<T> {
  if(heldGates.getStore()?.has(key))return work();
  const held=new Set(heldGates.getStore()??[]);held.add(key);
  const previous = gates.get(key) ?? Promise.resolve(), current = previous.catch(() => undefined).then(()=>heldGates.run(held,async()=>{
    if(!lockFile)return work();
    await mkdir(dirname(lockFile),{recursive:true,mode:0o700});
    const guard=spawn("/usr/bin/python3",["-c","import fcntl,sys;f=open(sys.argv[1],'a');fcntl.flock(f,fcntl.LOCK_EX);print('locked',flush=True);sys.stdin.buffer.read()",lockFile],{stdio:["pipe","pipe","ignore"]});
    guard.stdin.on("error",()=>undefined);
    try{
      await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{guard.kill("SIGKILL");reject(new Error("Resource transition lock timed out"));},30000);guard.once("error",error=>{clearTimeout(timer);reject(error);});guard.once("exit",()=>{clearTimeout(timer);reject(new Error("Resource transition lock unavailable"));});guard.stdout.once("data",()=>{clearTimeout(timer);resolve();});});
      return await work();
    }finally{guard.stdin.end();}
  })); gates.set(key, current);
  try { return await current; } finally { if (gates.get(key) === current) gates.delete(key); }
}
