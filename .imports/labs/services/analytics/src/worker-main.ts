import {isEntrypoint,runWorkerProcess} from './runtime.js';
if(isEntrypoint(import.meta.url))runWorkerProcess().catch(error=>{process.stderr.write(`Analytics worker failed: ${error instanceof Error?error.name:'UnknownError'}\n`);process.exitCode=1;});
