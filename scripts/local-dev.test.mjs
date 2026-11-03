import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {validatePorts,portFree} from './local-dev.mjs';
test('rejects duplicate assigned ports',()=>assert.throws(()=>validatePorts({labs:3050,agents:3050}),/unique/));
test('reports an occupied assigned port instead of choosing another',async()=>{const server=createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));try{assert.equal(await portFree(server.address().port),false);}finally{await new Promise(done=>server.close(done));}});
