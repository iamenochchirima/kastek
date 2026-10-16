#!/usr/bin/env python3
"""Read Rust registration DSL; never starts services or accesses a database."""
import re,json,hashlib,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'plans/typescript-migration'
BASELINES={
 'growth':('kasitek-growth','abd419c6ae0d84ca19a0a9cb802cc2bb2626d963'),
 'agency':('kasitek-agency','2c7902170a8f75257c0e47b86ffaf38068dd2227'),
 'analytics':('kasitek-labs','4eb66ad'),
}
def git(owner,*args):
 repo,commit=BASELINES[owner]
 return subprocess.check_output(['git','-C',str(ROOT/repo),*args],text=True)
def source_paths(owner,prefix):
 return [p for p in git(owner,'ls-tree','-r','--name-only',BASELINES[owner][1],'--',prefix).splitlines() if p]
def source_text(owner,path):
 try:return git(owner,'show',f'{BASELINES[owner][1]}:{path}')
 except subprocess.CalledProcessError as error:
  raise FileNotFoundError(f'{BASELINES[owner][0]}@{BASELINES[owner][1]}:{path}') from error
def workspace_path(owner,path):return f'{BASELINES[owner][0]}/{path}'
TOKEN=re.compile(r'//[^\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z_0-9]*|::|[^\s]')
rows=[]

def tokens(text):
 return [(m.group(),m.start()) for m in TOKEN.finditer(text) if not m.group().startswith(('//','/*'))]

def balanced(t,i):
 depth=1;j=i+1
 while depth:
  if t[j][0]==t[i][0]:depth+=1
  if t[j][0]=={'(':')','{':'}','[':']','<':'>'}[t[i][0]]:depth-=1
  j+=1
 return j-1

def split(t):
 parts=[];start=0;i=0
 while i<len(t):
  if t[i][0] in ('(','[','{','<'):i=balanced(t,i)
  elif t[i][0]==',':parts.append(t[start:i]);start=i+1
  i+=1
 if start<len(t):parts.append(t[start:])
 return parts

def string(t,const):
 s=''.join(x[0] for x in t)
 return json.loads(s) if s.startswith('"') else const.get(s,s)

def fn_body(text,name):
 t=tokens(text)
 for i in range(len(t)-2):
  if t[i][0]=='fn' and t[i+1][0]==name:
   j=i+2
   while j<len(t) and t[j][0]!='{':j+=1
   end=balanced(t,j)
   return t[j+1:end]
 return []

def signature_parameters(signature):
 t=tokens(signature)
 for i in range(len(t)-2):
  if t[i][0]!='fn':continue
  j=i+2
  while j<len(t) and t[j][0]!='(':j+=1
  if j==len(t):return []
  result=[]
  for part in split(t[j+1:balanced(t,j)]):
   colon=next((n for n,item in enumerate(part) if item[0]==':'),None)
   if colon is not None:
    result.append((''.join(item[0] for item in part[:colon]),''.join(item[0] for item in part[colon+1:])))
  return result
 return []

def generic_inner(value,wrapper):
 t=tokens(value)
 for i in range(len(t)-1):
  if t[i][0]==wrapper and t[i+1][0]=='<':
   end=balanced(t,i+1)
   return ''.join(item[0] for item in t[i+2:end])
 return None

def request_inputs(signature,body=''):
 out=[]
 for name,rust_type in signature_parameters(signature):
  kind=None;schema=None
  for wrapper,candidate in (('Json','json'),('Query','query'),('Path','path'),('Form','form')):
   if generic_inner(rust_type,wrapper) is not None:
    kind=candidate;schema=generic_inner(rust_type,wrapper);break
  if kind is None:
   if 'HttpRequest' in rust_type:kind='http-request'
   elif 'Multipart' in rust_type:kind='multipart'
   elif 'Payload' in rust_type:kind='stream-payload'
   elif 'Bytes' in rust_type:kind='byte-body'
  if kind:out.append({'name':name,'kind':kind,'rustType':rust_type,'schemaType':schema})
 # Some handlers parse web::Query manually from HttpRequest rather than declaring
 # Query<T> in their signature. Keep those boundaries in the route manifest too.
 t=tokens(body)
 for i in range(len(t)-4):
  if t[i][0]!='Query':continue
  j=i+1
  if j<len(t) and t[j][0]=='::':j+=1
  if j>=len(t) or t[j][0]!='<':continue
  end=balanced(t,j)
  if end+2>=len(t) or t[end+1][0]!='::' or t[end+2][0]!='from_query':continue
  schema=''.join(item[0] for item in t[j+1:end])
  out.append({'name':'query','kind':'query','rustType':f'web::Query::<{schema}>::from_query','schemaType':schema,'extractionMode':'manual handler parse'})
 return out

def declared_types(owner):
 pattern=r'^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(struct|enum|type)\s+([A-Za-z_][A-Za-z_0-9]*)\b'
 grep_pattern=r'^[[:space:]]*(pub([[:space:]]*\([^)]*\))?[[:space:]]+)?(struct|enum|type)[[:space:]]+[A-Za-z_][A-Za-z_0-9]*([[:space:]]|<|;|=)'
 try:output=git(owner,'grep','-n','-E',grep_pattern,BASELINES[owner][1],'--','*.rs')
 except subprocess.CalledProcessError as error:
  if error.returncode==1:return {}
  raise
 declarations={}
 for record in output.splitlines():
  try:_,path,line,source_line=record.split(':',3)
  except ValueError:continue
  match=re.match(pattern,source_line)
  if not match:continue
  kind,name=match.groups()
  declarations.setdefault(name,[]).append({'kind':kind,'source':workspace_path(owner,path),'line':int(line)})
 return declarations

def parse_expr(t,prefix,resource,path,owner,boundary,condition,const,text):
 i=0
 while i<len(t):
  val=t[i][0]
  if val in ('scope','resource','service','route') and i+1<len(t) and t[i+1][0]=='(':
   end=balanced(t,i+1);args=split(t[i+2:end])
   if val=='scope':prefix+=string(args[0],const);resource=None
   elif val=='resource':resource=prefix+string(args[0],const)
   elif val=='service':parse_expr(args[0],prefix,None,path,owner,boundary,condition,const,text)
   elif val=='route':
    if len(args)==2:full=prefix+string(args[0],const);expr=args[1]
    elif len(args)==1:full=resource;expr=args[0]
    else:raise ValueError(('route arguments',path,t[i]))
    s=''.join(x[0] for x in expr)
    m=re.search(r'web::(get|post|patch|put|delete|head|options)\(\)',s)
    if m:method=m.group(1).upper()
    else:
     m=re.search(r'web::method\(Method::([A-Z]+)\)',s)
     if not m:raise ValueError(('route method',path,s))
     method=m.group(1)
    handler=re.search(r'\.to\(([^)]+)\)',s).group(1)
    rows.append({'owner':owner,'boundary':boundary,'method':method,'path':full,'handler':handler,'registrationSource':workspace_path(owner,path),'registrationLine':text[:t[i][1]].count('\n')+1,'condition':condition,'status':'TypeScript route exists; behavior evidence and remaining gaps are in PARITY.md'})
   i=end+1;continue
  if val==';':prefix='';resource=None
  if val in ('(','['):i=balanced(t,i)+1;continue
  # Braces are condition/function bodies; walk them with same prefix.
  if val=='{':
   end=balanced(t,i);parse_expr(t[i+1:end],prefix,resource,path,owner,boundary,condition,const,text);i=end+1;continue
  i+=1

def registry(owner,path,boundary,condition='always'):
 text=source_text(owner,path);const={};parent=Path(path).parent.as_posix()
 for source in source_paths(owner,parent):
  if Path(source).parent.as_posix()!=parent or not source.endswith('.rs'):continue
  for name,value in re.findall(r'(?:pub\s+)?const\s+(\w+)\s*:\s*&str\s*=\s*("[^"]*")',source_text(owner,source)):
   const[name]=json.loads(value);const[Path(source).stem+'::'+name]=json.loads(value)
 parse_expr(fn_body(text,'configure'),'',None,path,owner,boundary,condition,const,text)

for source in sorted(source_paths('growth','server/kasitek-core/src/api')):
 if Path(source).parent.as_posix()=='server/kasitek-core/src/api' and source.endswith('.rs') and Path(source).name!='mod.rs':registry('growth',source,Path(source).stem)
registry('agency','server/kasitek-tenants/src/routes.rs','tenant')
for module in ('app','health','reporting','scope_resolution','rollout'):
 registry('analytics',f'services/analytics/src/{module}.rs',module,'API runtime; health::configure accepts Worker but actual worker starts no HTTP server' if module=='health' else 'API only')
# app's metrics is not inside the API conditional.
for row in rows:
 if row['owner']=='analytics' and row['path']=='/internal/metrics':row['condition']='API only (worker has no HTTP server)'

# Resolve handler bodies and preserve direct guard evidence rather than guessing a route-group permission.
DECLARED_TYPES={owner:declared_types(owner) for owner in BASELINES}
ALL_DECLARED_TYPES={}
for source_owner,types in DECLARED_TYPES.items():
 for name,locations in types.items():
  ALL_DECLARED_TYPES.setdefault(name,[]).extend({'owner':source_owner,**location} for location in locations)
HTTP_STATUS={'Ok':200,'Created':201,'Accepted':202,'NoContent':204,'MovedPermanently':301,'Found':302,'SeeOther':303,'TemporaryRedirect':307,'PermanentRedirect':308,'BadRequest':400,'Unauthorized':401,'Forbidden':403,'NotFound':404,'MethodNotAllowed':405,'Conflict':409,'Gone':410,'PayloadTooLarge':413,'UnprocessableEntity':422,'TooManyRequests':429,'InternalServerError':500,'NotImplemented':501,'BadGateway':502,'ServiceUnavailable':503,'GatewayTimeout':504}
for row in rows:
 owner=row['owner'];parts=row['handler'].split('::');name=parts[-1];module=parts[-2] if len(parts)>1 else row['boundary']
 if owner=='growth':base='server/kasitek-core/src/controllers'
 elif owner=='agency':base='server/kasitek-tenants/src/controllers'
 else:base='services/analytics/src'
 candidates=[f'{base}/{module}.rs',f'{base}/{module}/mod.rs']
 source=None;text=None
 for candidate in candidates:
  try:text=source_text(owner,candidate);source=candidate;break
  except FileNotFoundError:pass
 if source:
  body=fn_body(text,name);start=body[0][1] if body else 0;end=body[-1][1] if body else 0;snippet=text[start:end]
  row['handlerSource']=workspace_path(owner,source);row['handlerLine']=text[:start].count('\n')+1
  row['directAuthorizationEvidence']=list(dict.fromkeys(re.findall(r'\b(?:require_\w+|extract_\w+|authenticate\w*|authorize\w*|ensure_\w+|verify_\w+|resolve_\w+|validate_\w+)\s*\(',snippet)))
  row['directAuthorizationEvidence']=[s[:-1].strip() for s in row['directAuthorizationEvidence']]
  signature_match=re.search(r'\bfn\s+'+re.escape(name)+r'\b',text)
  signature=text[signature_match.start():start] if signature_match else ''
  row['handlerSignature']=signature.rstrip().removesuffix('{').rstrip()
  inputs=request_inputs(row['handlerSignature'],snippet)
  for item in inputs:
   if item['schemaType']:
    names=sorted(set(re.findall(r'\b[A-Z][A-Za-z_0-9]*\b',item['schemaType'])))
    item['schemaDeclarations']={name:ALL_DECLARED_TYPES[name] for name in names if name in ALL_DECLARED_TYPES}
    item['schemaDeclarationScope']='name-matched candidates across pinned repos; imports, aliases and field constraints are not resolved'
  row['requestInputs']=inputs
  row['directEffectEvidence']=list(dict.fromkeys(re.findall(r'\b(?:sqlx::\w+|\.begin\(|\.execute\(|\.fetch_\w+\(|\.send\(|\.streaming\(|Multipart|NamedFile)',snippet)))
  row['handlerBodySha256']=hashlib.sha256(snippet.encode()).hexdigest()
  row['delegatedCalls']=list(dict.fromkeys(re.findall(r'\b(?:[a-z_]+::)+[a-z_]+\s*\(',snippet)))
  row['delegatedCalls']=[call[:-1].strip() for call in row['delegatedCalls']]
  row['authorizationCallSites']=[{'line':text[:start+match.start()].count('\n')+1,'expression':match.group()[:1400]} for match in re.finditer(r'\b(?:require_\w+|extract_\w+|authenticate\w*|authorize\w*|ensure_\w+|verify_\w+|resolve_\w+|validate_\w+)\s*\([^;]*?;',snippet)]
  row['directHttpResponseConstructors']=list(dict.fromkeys(re.findall(r'HttpResponse::[A-Z][A-Za-z]+',snippet)))
  row['directStatusCodeConstructors']=list(dict.fromkeys(re.findall(r'(?:StatusCode|http::StatusCode)::[A-Z_]+',snippet)))
  row['directHttpStatusCodes']=sorted(set(HTTP_STATUS[name] for name in re.findall(r'HttpResponse::([A-Z][A-Za-z]+)',snippet) if name in HTTP_STATUS))
  row['directAppErrorConstructors']=list(dict.fromkeys(re.findall(r'AppError::([A-Z][A-Za-z]+)',snippet)))
  row['transportEvidence']=list(dict.fromkeys(re.findall(r'(?:Multipart|web::Payload|Bytes|streaming|text/event-stream|text/javascript|text/html|application/[^\s\";]+|cookie|insert_header|append_header)',signature+'\n'+snippet)))
  row['authorizationBoundary']='handler and called services; direct evidence is not a complete transitive authorization proof'
  row['responseErrorEvidenceBoundary']='direct handler only; propagated AppError and service/provider failure mappings require parity fixtures'
 else:row['handlerSource']=None;row['authorizationBoundary']='unresolved handler source; inspect manually'
 if owner=='growth' and row['boundary']=='public_v1':row['scopeMiddleware']='crate::services::public_api::middleware'
 row['tsDestination']= {'growth':'kasitek-growth/server/kasitek-core/src','agency':'kasitek-agency/server/kasitek-tenants/src','analytics':'kasitek-labs/services/analytics/src'}[owner]
 row['caller']={'growth':{'product':'Growth customer app','admin':'Labs admin-site','website':'Labs site and embedded website widgets','internal':'Agents workers or Growth product agent UI (route-dependent)','provider_webhooks':'External providers','public_v1':'API-key consumers'}.get(row['boundary']),'agency':'Agency portal/API client or Labs admin (route-dependent)','analytics':'Growth, Agency, Agents producer/reporting clients; internal operators'}[owner]

# Registration order is significant within each source. Never sort by path.
for n,row in enumerate(rows,1):row['id']=f'R{n:04}'
counts={owner:sum(r['owner']==owner for r in rows) for owner in ('growth','agency','analytics')}
expected_counts={'growth':537,'agency':81,'analytics':15}
if counts!=expected_counts:raise RuntimeError(f'route inventory changed: expected {expected_counts}, found {counts}')
manual_query_inputs={
 (row['owner'],row['path'],item.get('schemaType'))
 for row in rows for item in row.get('requestInputs',[])
 if item.get('extractionMode')=='manual handler parse'
}
expected_manual_query_inputs={
 ('growth','/api/agents','AgentListQuery'),
 ('agency','/api/client-auth/invite','std::collections::HashMap<String,String>'),
}
if manual_query_inputs!=expected_manual_query_inputs:raise RuntimeError(f'manual query inventory changed: expected {expected_manual_query_inputs}, found {manual_query_inputs}')
unresolved=[row['id'] for row in rows if row.get('handlerSource') is None]
if unresolved:raise RuntimeError(f'unresolved handler source for routes: {unresolved[:20]}')
report={'formatVersion':1,'generatedFrom':'Preserved Rust source baselines; not runtime proof','baselineCommits':{owner:commit for owner,(_,commit) in BASELINES.items()},'rows':rows,'counts':counts,'sourceSha256':{row['registrationSource']:hashlib.sha256(source_text(row['owner'],row['registrationSource'].split('/',1)[1]).encode()).hexdigest() for row in rows}}
(OUT/'ROUTES.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report['counts']))

# Process, migration and consumer evidence stays separate from HTTP operations.
def relative(owner,path=None):return str(owner.relative_to(ROOT)) if path is None else workspace_path(owner,path)
def source_evidence(owner,path):
 text=source_text(owner,path)
 return {'source':relative(owner,path),'sha256':hashlib.sha256(text.encode()).hexdigest(),'environmentNames':sorted(set(re.findall(r'(?:env::var|std::env::var|env_string|env_i64|env_u64|env_bool|env_flag)\(\s*"([A-Z][A-Z_0-9]*)"',text))), 'workerCalls':sorted(set(re.findall(r'(?:workers::)?([a-z_]+)::(?:run|run_once|process_once)\(',text))), 'shutdownEvidence':sorted(set(re.findall(r'(?:ctrl_c|ctrl_c_signal|terminate|shutdown|tokio::select!)',text))),'transactionMechanisms':sorted(set(re.findall(r'(?:FOR UPDATE(?: SKIP LOCKED)?|pg_advisory_[a-z_]+|ON CONFLICT|BEGIN|COMMIT|SAVEPOINT)',text)))}
processes=[]
for owner,p in [('growth','server/kasitek-core/src/main.rs'),('agency','server/kasitek-tenants/src/main.rs')]:
 text=source_text(owner,p); modes=re.findall(r'Some\("([a-z-]+)"\) =>',text)
 for mode in ['api']+modes:
  entry={'owner':owner,'mode':mode,'selection':'KASITEK_PROCESS='+mode if mode!='api' else 'KASITEK_PROCESS unset or unrecognized','source':relative(owner,p),'status':'TypeScript process exists; behavior evidence and remaining gaps are in PARITY.md'}
  if mode!='api':
   block=text.split('Some("'+mode+'") =>',1)[1].split('Some(',1)[0]
   entry['workers']=list(dict.fromkeys(re.findall(r'(?:workers::)?([a-z_]+)::run\(',block)))
  elif owner=='growth':entry['workers']=['whatsapp_inbox','email_inbox','social_publishing','social_insights','whatsapp_campaigns','public_webhooks','billing_reconciliation'];entry['workerCondition']='unless KASITEK_DISABLE_BACKGROUND_WORKERS is truthy';entry['migration']='API does not execute Prisma migrations'
  else:entry['workers']=[]
  if owner=='agency':entry['migration']='sqlx::migrate!("./migrations") runs before every process-mode dispatch'
  processes.append(entry)
for p in sorted(source_paths('analytics','services/analytics/src/bin')):
 if p.endswith('.rs'):
  stem=Path(p).stem
  processes.append({'owner':'analytics','mode':stem,'source':relative('analytics',p),'flags':['--check','--write'] if stem=='analytics-registry' else [],'status':'TypeScript process exists; behavior evidence and remaining gaps are in PARITY.md','httpServer':stem=='analytics-api','migration':stem=='analytics-migrate','worker':stem=='analytics-worker'})
workerfiles=[('growth',p) for p in source_paths('growth','server/kasitek-core/src/workers') if p.endswith('.rs') and Path(p).name!='mod.rs']+[('agency',p) for p in ('server/kasitek-tenants/src/analytics_publisher.rs','server/kasitek-tenants/src/analytics_backfill.rs')]+[('analytics',f'services/analytics/src/{s}.rs') for s in ('projections','maintenance','worker')]
databases=[]
for owner,directory,ledger in [('growth','client/packages/database/prisma/migrations','_prisma_migrations'),('agency','server/kasitek-tenants/migrations','_sqlx_migrations'),('analytics','services/analytics/migrations','_sqlx_migrations')]:
 files=sorted(p for p in source_paths(owner,directory) if p.endswith('.sql'));migrations=[]
 for p in files:
  text=source_text(owner,p)
  migrations.append({'source':relative(owner,p),'sha256':hashlib.sha256(text.encode()).hexdigest(),'sqlxSha384':hashlib.sha384(text.encode()).hexdigest() if ledger=='_sqlx_migrations' else None,'declaredTables':re.findall(r'CREATE TABLE(?: IF NOT EXISTS)?\s+([\w."\-]+)',text,re.I),'declaredIndexes':re.findall(r'CREATE(?: UNIQUE)? INDEX(?: IF NOT EXISTS)?\s+([\w."\-]+)',text,re.I),'declaredFunctions':re.findall(r'CREATE(?: OR REPLACE)? FUNCTION\s+([\w."\-]+)',text,re.I),'declaredTriggers':re.findall(r'CREATE TRIGGER\s+([\w."\-]+)',text,re.I),'declaredPolicies':re.findall(r'CREATE POLICY\s+([\w."\-]+)',text,re.I),'rlsStatements':re.findall(r'ALTER TABLE[^;]*?(?:ENABLE|FORCE) ROW LEVEL SECURITY',text,re.I)})
 databases.append({'owner':owner,'ledger':ledger,'migrationCount':len(files),'migrations':migrations,'evidenceScope':'source only; applied versions/checksums in live database not queried'})
consumers=[]
for label,directory in [('Growth customer app',ROOT/'kasitek-growth/client/apps/client'),('Labs Admin',ROOT/'kasitek-labs/apps/admin-site'),('Labs site',ROOT/'kasitek-labs/apps/labs-site'),('Agency portal',ROOT/'kasitek-agency/client/apps/tenant-portal'),('Agency API client',ROOT/'kasitek-agency/client/packages/api-client-react'),('Agents',ROOT/'kasitek-agents/src')]:
 matches=[]
 if directory.exists():
  for p in directory.rglob('*'):
   if p.suffix not in ('.ts','.tsx','.js','.json') or any(x in p.parts for x in ('node_modules','.next','dist','.git')):continue
   text=p.read_text(errors='replace')
   refs=sorted(set(re.findall(r'["\x27`]((?:/api/|/v1/|/internal/)[^"\x27`\s]*)',text)))
   if refs:matches.append({'source':relative(p),'literalPathReferences':refs})
 consumers.append({'name':label,'directory':relative(directory),'references':matches,'limitations':'literal references only; interpolated/configured URLs and imported clients require semantic review'})
repos=[]
for name in ('kasitek-growth','kasitek-labs','kasitek-agency','kasitek-agents'):
 p=ROOT/name
 run=lambda args:subprocess.check_output(['git','-C',str(p)]+args,text=True).strip()
 repos.append({'repo':name,'branch':run(['branch','--show-current']),'head':run(['rev-parse','HEAD']),'localChanges':run(['status','--short']).splitlines()})
report={'formatVersion':1,'baselineCommits':{owner:commit for owner,(_,commit) in BASELINES.items()},'repositories':repos,'processes':processes,'workerSourceEvidence':[source_evidence(owner,p) for owner,p in workerfiles if Path(p).name!='mod.rs'],'databases':databases,'consumers':consumers,'limitations':['No process startup/shutdown or database mutation performed.','Source inventory is not runtime parity evidence.','Environment names include directly named variables; dynamically passed helper variable names need configuration review.','Database declaration regex is supplemental; original SQL hashes and paths are canonical.']}
expected_migrations={'growth':82,'agency':12,'analytics':23}
actual_migrations={item['owner']:item['migrationCount'] for item in databases}
if actual_migrations!=expected_migrations:raise RuntimeError(f'migration inventory changed: expected {expected_migrations}, found {actual_migrations}')
if len(processes)!=18:raise RuntimeError(f'process inventory changed: expected 18 modes, found {len(processes)}')
(OUT/'processes.json').write_text(json.dumps(report,indent=2)+'\n')
print('Processes:',len(processes),'Migrations:',[(d['owner'],d['migrationCount']) for d in databases])
