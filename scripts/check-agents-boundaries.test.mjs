import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkAgentsModules} from './check-agents-boundaries.mjs';
function fixture(files,run){const root=mkdtempSync(join(tmpdir(),'agents-modules-'));try{for(const[path,source]of Object.entries(files)){const file=join(root,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,source);}run(checkAgentsModules(root));}finally{rmSync(root,{recursive:true,force:true});}}
test('permits dependency direction and detects type imports and re-exports',()=>{
 fixture({'contracts/id.ts':'export type Id=string;','execution/run.ts':'import type {Id} from "../contracts/id"; export type Run=Id;','composition/main.ts':'export * from "../execution/run";'},result=>assert.deepEqual(result.failures,[]));
 fixture({'product/private.ts':'export type Private=string;','contracts/id.ts':'import type {Private} from "../product/private"; export type Id=Private;'},result=>assert.match(result.failures.join('\n'),/cannot depend/));
 fixture({'product/private.ts':'export const p=1;','capabilities/tool.ts':'export * from "../product/private";'},result=>assert.match(result.failures.join('\n'),/cannot depend/));
});
test('checks dynamic imports and requires, unresolved paths and dependency cycles',()=>{
 for(const source of ['await import("../product/private")','require("../product/private")'])fixture({'product/private.ts':'export const p=1;','capabilities/tool.ts':source},result=>assert.match(result.failures.join('\n'),/cannot depend/));
 fixture({'contracts/a.ts':'export type A=import("./b").B;','contracts/b.ts':'import type {A} from "./a"; export type B=A;'},result=>assert.match(result.failures.join('\n'),/Dependency cycle/));
 fixture({'contracts/a.ts':'import("./missing")'},result=>assert.match(result.failures.join('\n'),/unresolved/));
 fixture({'contracts/a.ts':'import(path)'},result=>assert.match(result.failures.join('\n'),/uncheckable/));
});

test('resolves JSON data modules while preserving their ownership boundary',()=>{
 fixture({'adapters/providers/registry.ts':'import data from "./default-connectors.json"; export {data};','adapters/providers/default-connectors.json':'{"schemaVersion":1}'},result=>assert.deepEqual(result.failures,[]));
 fixture({'contracts/public.ts':'import data from "../product/private.json";','product/private.json':'{}'},result=>assert.match(result.failures.join('\n'),/cannot depend/));
 fixture({'adapters/providers/registry.ts':'import data from "./missing.json";'},result=>assert.match(result.failures.join('\n'),/unresolved/));
});
