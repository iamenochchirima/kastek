import {createRequire} from 'node:module';
import {readFile,writeFile,realpath,cp,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const web=path.resolve(here,'../../products/growth/web/node_modules');
const require=createRequire(await realpath(path.join(web,'vite/package.json')));
const {build}=require('esbuild');
const deps=process.env.EXCALIDRAW_NODE_MODULES || '/tmp/kasitek-excalidraw-build/node_modules';
const result=await build({entryPoints:[path.join(here,'app.jsx')],bundle:true,write:false,outdir:'out',format:'iife',platform:'browser',conditions:['production'],minify:true,jsx:'automatic',nodePaths:[deps],define:{'process.env.NODE_ENV':'"production"'},loader:{'.woff2':'dataurl','.woff':'dataurl','.excalidraw':'json'},legalComments:'inline'});
const js=result.outputFiles.find(f=>f.path.endsWith('.js')).text.replace(/<\/script/gi,'<\\/script');
const css=result.outputFiles.find(f=>f.path.endsWith('.css')).text;
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shared agent system · Architecture draft</title><style>${css}\n*{box-sizing:border-box}body{margin:0;font:14px system-ui,sans-serif;background:#fffdf8;color:#282331}#root{height:100dvh;display:flex;flex-direction:column}header{flex:none;min-height:76px;padding:12px 18px;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid #e5deeb;flex-wrap:wrap}header strong{font-size:17px}.actions a{font-size:12px;color:#6741a5;padding:8px 6px;text-decoration:underline;text-underline-offset:3px}header span{display:block;color:#706477;font-size:11px;margin-top:4px}nav,.actions{display:flex;gap:6px;flex-wrap:wrap}button{font:inherit;font-size:12px;background:white;color:#42334f;border:1px solid #ded5e5;border-radius:7px;padding:8px 12px;cursor:pointer}button.selected{background:#f1e5ff;border-color:#9c71c0}button:focus-visible{outline:2px solid #7950a6;outline-offset:2px}button:disabled{opacity:.5}main{flex:1;min-height:300px}.export-preview{flex:none;max-width:1100px;margin:24px auto;padding:24px;border-top:1px solid #ded5e5}.export-preview>div{display:flex;align-items:center;justify-content:space-between;gap:12px}.export-preview h2{font-size:18px}.export-preview img{display:block;width:100%;height:auto}.export-preview label{display:block;margin:12px 0 6px}.export-preview textarea{width:100%;height:180px;font:12px monospace}.export-preview summary{cursor:pointer;padding:12px 0}footer{flex:none;min-height:40px;border-top:1px solid #e5deeb;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 18px;color:#706477;font-size:11px}@media(max-width:900px){header{gap:10px}footer{gap:8px}}</style><script>window.EXCALIDRAW_ASSET_PATH='./assets/';</script></head><body><div id="root"></div><script>${js}</script></body></html>`;
await writeFile(path.join(here,'index.html'),html);
await mkdir(path.join(here,'assets/fonts'),{recursive:true});
for(const font of ['Virgil','Assistant','Excalifont'])await cp(path.join(deps,'@excalidraw/excalidraw/dist/prod/fonts',font),path.join(here,'assets/fonts',font),{recursive:true});
// Bundled dependency notices remain in the generated script; font licenses accompany assets.
console.log('Built Excalidraw review board: '+path.join(here,'index.html'));
