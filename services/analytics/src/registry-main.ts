import {isEntrypoint,runRegistryProcess} from './runtime.js';
if(isEntrypoint(import.meta.url))runRegistryProcess().catch(error=>{process.stderr.write(`Analytics registry command failed: ${error instanceof Error?error.message:'UnknownError'}\n`);process.exitCode=1;});
