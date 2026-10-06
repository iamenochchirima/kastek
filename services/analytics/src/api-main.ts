import {isEntrypoint,runApi} from './runtime.js';
if(isEntrypoint(import.meta.url))runApi().catch(error=>{process.stderr.write(`Analytics API failed to start: ${error instanceof Error?error.name:'UnknownError'}\n`);process.exitCode=1;});
