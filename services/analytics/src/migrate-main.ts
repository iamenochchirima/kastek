import {isEntrypoint,runMigrationsProcess} from './runtime.js';
if(isEntrypoint(import.meta.url))runMigrationsProcess().catch(error=>{process.stderr.write(`Analytics migrations failed: ${error instanceof Error?error.name:'UnknownError'}\n`);process.exitCode=1;});
