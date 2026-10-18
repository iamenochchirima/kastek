import {readFileSync,readdirSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const allowed={
 contracts:['contracts'],infrastructure:['contracts','infrastructure'],
 adapters:['contracts','infrastructure','adapters','observability'],
 execution:['contracts','infrastructure','execution','capabilities','adapters','workflows','observability'],
 capabilities:['contracts','infrastructure','execution','capabilities','adapters','observability'],
 workflows:['contracts','infrastructure','execution','capabilities','adapters','workflows','observability'],
 product:['contracts','infrastructure','execution','capabilities','adapters','workflows','programs','product','observability'],
 programs:['contracts','execution','capabilities','workflows','programs'],
 observability:['contracts','infrastructure','observability'],composition:null,
};
export function checkAgentsModules(root){
 const files=[];const walk=directory=>{for(const entry of readdirSync(directory,{withFileTypes:true})){const path=resolve(directory,entry.name);if(entry.isDirectory())walk(path);else if(entry.name.endsWith('.ts'))files.push(path);}};walk(root);
 const graph=new Map(files.map(file=>[file,[]])),failures=[];
 for(const file of files){
  const owner=relative(root,file).split('/')[0];if(owner==='acceptance')continue;
  if(!Object.hasOwn(allowed,owner)){failures.push(`${relative(root,file)} has no module ownership rule`);continue;}
  const syntax=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
  const references=[];
  function visit(node){
   if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier)references.push(node.moduleSpecifier);
   else if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument))references.push(node.argument.literal);
   else if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require')){
    if(node.arguments.length!==1||!ts.isStringLiteralLike(node.arguments[0]))failures.push(`${relative(root,file)} uses an uncheckable dynamic module reference`);
    else references.push(node.arguments[0]);
   }
   ts.forEachChild(node,visit);
  }visit(syntax);
  for(const reference of references){
   if(!ts.isStringLiteralLike(reference))continue;
   const specifier=reference.text;if(!specifier.startsWith('.'))continue;
   const base=resolve(dirname(file),specifier),target=[base+'.ts',resolve(base,'index.ts')].find(path=>graph.has(path));
   if(!target){failures.push(`${relative(root,file)} has unresolved internal reference ${specifier}`);continue;}
   const dependency=relative(root,target).split('/')[0];
   if(allowed[owner]&&!allowed[owner].includes(dependency))failures.push(`${relative(root,file)} cannot depend on ${relative(root,target)}`);
   graph.get(file).push(target);
  }
 }
 const visiting=new Set(),visited=new Set();
 function cycle(file,path){
  if(visiting.has(file)){failures.push(`Dependency cycle: ${[...path.slice(path.indexOf(file)),file].map(item=>relative(root,item)).join(' -> ')}`);return;}
  if(visited.has(file))return;
  visiting.add(file);for(const target of graph.get(file))cycle(target,[...path,file]);visiting.delete(file);visited.add(file);
 }
 for(const file of files)cycle(file,[]);
 return {files:files.length,failures:[...new Set(failures)]};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../products/agents/api/src');
 const result=checkAgentsModules(root);
 if(result.failures.length){console.error(result.failures.join('\n'));process.exitCode=1;}
 else console.log(`Agents internal module boundaries and dependency cycles passed for ${result.files} files`);
}
