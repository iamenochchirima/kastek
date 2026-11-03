// Design revision 2. Logical responsibilities and proposed contracts, not shipped behavior.
export function makeBoard() {
  const elements = [], groups = { overview: [], runtime: [], delegation: [], contracts: [] };
  let scene = 'overview', ox = 0;
  const colors = {
    shared: ['#f3e8ff', '#6741a5'], product: ['#e7f0ff', '#245b9d'],
    config: ['#fff4d6', '#9a6700'], data: ['#e5f5eb', '#26734d'], neutral: ['#ffffff', '#495057'],
  };
  const add = e => {
    e.customData = { scene, designRevision: 2 };
    elements.push(e); groups[scene].push(e.id); return e.id;
  };
  function text(id, x, y, value, size = 24, color = '#343a40') {
    return add({ id, type: 'text', x: x + ox, y, text: value, fontSize: size, fontFamily: 1, strokeColor: color });
  }
  function box(id, x, y, w, h, value, kind = 'neutral') {
    const [bg, stroke] = colors[kind];
    return add({ id, type: 'rectangle', x: x + ox, y, width: w, height: h,
      backgroundColor: bg, strokeColor: stroke, fillStyle: 'solid', strokeWidth: 1.6,
      roughness: 1, roundness: { type: 3 },
      label: { text: value, fontSize: scene === 'runtime' ? 18 : 22, fontFamily: 1, textAlign: 'center', verticalAlign: 'middle' } });
  }
  function boundary(id, x, y, w, h, name, kind = 'shared') {
    const [, stroke] = colors[kind];
    add({ id, type: 'rectangle', x: x + ox, y, width: w, height: h, backgroundColor: 'transparent',
      strokeColor: stroke, strokeStyle: 'dashed', strokeWidth: 2, roughness: 1 });
    text(id + '-title', x + 20, y + 15, name, 28, stroke);
  }
  function arrow(id, from, to, x, y, dx, dy, label = '', points, both = false) {
    return add({ id, type: 'arrow', x: x + ox, y, width: Math.abs(dx), height: Math.abs(dy),
      points: points || [[0, 0], [dx, dy]], start: { id: from }, end: { id: to }, endArrowhead: 'arrow',
      ...(both ? { startArrowhead: 'arrow' } : {}), strokeColor: '#495057', strokeWidth: 1.7, roughness: 1,
      ...(label ? { label: { text: label, fontSize: scene === 'runtime' ? 16 : 18, fontFamily: 1 } } : {}) });
  }

  text('o-title', 40, 0, '1. WHOLE SYSTEM / design revision 2 / under review', 38);
  text('o-sub', 40, 60, 'Separate saved configuration, durable execution, current authority and authorized disclosure.', 24);
  boundary('growth', 40, 140, 600, 1670, 'GROWTH: business authority', 'product');
  boundary('platform', 740, 140, 1320, 1670, 'AGENTS: shared execution protocol');
  boundary('agencies', 2160, 140, 600, 1670, 'AGENCIES: client authority', 'product');
  box('g-config', 90, 230, 500, 180, 'Growth configuration\nPurpose + instructions + model\nSkills, tools and source bindings\nMemory and delegation policies', 'config');
  box('a-config', 2210, 230, 500, 180, 'Agency configuration\nPurpose + instructions + model\nClient tools, skills and sources\nMemory and delegation policies', 'config');
  box('definitions', 790, 230, 1220, 180, 'Definition registry / immutable execution snapshot\nPin configuration, runtime release, tool schemas, skill revisions and model policy\nA saved revision is not continuing permission to act', 'config');
  arrow('g-def', 'g-config', 'definitions', 590, 310, 200, 0, 'configure');
  arrow('a-def', 'a-config', 'definitions', 2210, 350, -200, 0, 'configure');
  box('g-request', 90, 530, 500, 150, 'Growth request\nVerified person or automation\nOrganization + resource scope', 'product');
  box('a-request', 2210, 530, 500, 150, 'Agency request\nVerified person or automation\nAgency + workspace + client scope', 'product');
  box('admission', 790, 530, 600, 150, 'Admission\nIdentity + selected revision\nAction AND information envelopes', 'shared');
  box('accepted', 1450, 530, 560, 150, 'Durable accepted task + outbox\nStable request / work / task IDs\nExact retries return this task', 'data');
  arrow('g-admit', 'g-request', 'admission', 590, 580, 200, 0, 'authorized request');
  arrow('a-admit', 'a-request', 'admission', 2210, 615, -820, 0, 'authorized request', [[0, 0], [-110, 0], [-110, -155], [-1120, -155], [-1120, -85]]);
  arrow('def-admit', 'definitions', 'admission', 1090, 410, 0, 120, 'selected revision');
  arrow('admit-record', 'admission', 'accepted', 1390, 605, 60, 0, 'atomic acceptance');
  box('scheduler', 790, 810, 600, 180, 'Scheduler + whole-work capacity\nFair tenant/work claims\nWaiting parents release compute slots\nChildren cannot reset shared limits', 'shared');
  box('instance', 1450, 810, 560, 180, 'Agent runtime instance\nSame protocol for every definition\nModel chooses useful actions\nMay delegate when configured', 'shared');
  arrow('dispatch', 'accepted', 'scheduler', 1730, 680, -640, 130, 'recoverable dispatch', [[0, 0], [0, 65], [-640, 65], [-640, 130]]);
  arrow('worker', 'scheduler', 'instance', 1390, 890, 60, 0, 'claim / wake');
  text('g-facts', 90, 800, 'Growth supplies:\nBusiness instructions and skills\nPermitted Growth adapters\nRelevant organization context\nContent / Campaigns / Research\nas ordinary agent definitions', 24, '#245b9d');
  text('a-facts', 2210, 800, 'Agencies supplies:\nAgency-specific configurations\nClient tools and source policy\nIts own specialist catalogue\n\nNo inherited Growth access', 24, '#245b9d');
  box('product-adapter', 1450, 1120, 560, 150, 'Execution gateway + adapter\nCurrent authority + exact approval\nClaim intent before physical dispatch', 'shared');
  box('journal', 790, 1120, 600, 150, 'Operation / work journal\nIntent + exact payload + resource revision\nReceipts, pending and unknown effects', 'data');
  arrow('instance-adapter', 'instance', 'product-adapter', 1730, 990, 0, 130, 'validated request');
  arrow('intent', 'product-adapter', 'journal', 1450, 1220, -60, 0, 'claim / receipt', undefined, true);
  arrow('runtime-events', 'instance', 'journal', 1450, 900, -60, 290, 'task events', [[0, 0], [-35, 0], [-35, 290], [-60, 290]]);
  box('g-api', 90, 1120, 500, 180, 'Growth API + current policy\nMembership, resources and reviews\nVersion preconditions / idempotency\nEffect reconciliation', 'product');
  box('a-api', 2210, 1120, 500, 180, 'Agencies API + current policy\nClient access and exact approvals\nVersion preconditions / idempotency\nEffect reconciliation', 'product');
  arrow('adapter-g', 'product-adapter', 'g-api', 1730, 1120, -1140, 75, 'Growth call / receipt', [[0, 0], [0, -65], [-1050, -65], [-1050, 75], [-1140, 75]], true);
  arrow('adapter-a', 'product-adapter', 'a-api', 2010, 1200, 200, 0, 'Agency call / receipt', undefined, true);
  box('projection', 790, 1430, 1220, 160, 'Authorized observation + result projection\nRecheck audience, current source rights and conversation ownership\nTask events / child status / receipts / outcomes; never private reasoning\nCursor reconnect follows the same task, never resubmits it', 'shared');
  box('g-ui', 90, 1430, 500, 160, 'Growth backend → interface\nCurrent session and permissions\nResponse, reviews and live activity', 'product');
  box('a-ui', 2210, 1430, 500, 160, 'Agencies backend → interface\nCurrent client scope and session\nResponse, reviews and live activity', 'product');
  arrow('projection-source', 'journal', 'projection', 1090, 1270, 0, 160, 'authorized projection');
  arrow('projection-g', 'projection', 'g-ui', 790, 1500, -200, 0, 'read / reconnect');
  arrow('projection-a', 'projection', 'a-ui', 2010, 1550, 200, 0, 'read / reconnect');
  box('g-data', 90, 1680, 500, 90, 'Growth-owned records and connections', 'data');
  box('a-data', 2210, 1680, 500, 90, 'Agency/client-owned records and connections', 'data');
  arrow('g-record', 'g-api', 'g-data', 340, 1300, 0, 380, '', [[0, 0], [-280, 0], [-280, 425], [-250, 425]]);
  arrow('a-record', 'a-api', 'a-data', 2460, 1300, 0, 380, '', [[0, 0], [280, 0], [280, 425], [250, 425]]);
  text('o-storage', 790, 1660, 'State contracts remain separate:\nConversation continuity | accepted memory | knowledge references | effect receipts', 23, '#26734d');
  text('o-rule', 40, 1880, 'Three independent concerns: what a run may do, what information it may disclose, and what effects it has attempted.', 26, '#6741a5');
  text('o-live', 40, 1940, 'Pinned configuration does not restore revoked rights. In-flight external effects cannot be recalled by cancelling a task.', 24, '#9a6700');

  scene = 'runtime'; ox = 3000;
  text('r-title', 40, 0, '2. ANY AGENT INSTANCE / the shared runtime contract', 38);
  text('r-sub', 40, 60, 'Modules may share one service/database. The model does not become an authorization principal.', 24);
  boundary('r-boundary', 490, 140, 1910, 1290, 'SHARED RUNTIME: pinned semantics + current checks');
  box('r-config', 40, 220, 350, 180, 'Effective configuration\nPinned definition and digests\nSelected capabilities\nDelegatable authority', 'config');
  box('r-admit', 900, 220, 580, 120, 'Admitted task / wake / replay\nSame scope, lineage and operation identities', 'shared');
  box('r-authority', 2010, 220, 350, 150, 'Current policy check\nProduct / principal / audience\nSource and connection generations\nRevocation is live, not pinned', 'shared');
  arrow('r-policy', 'r-config', 'r-admit', 390, 280, 510, 0, 'snapshot + bounded envelope');
  box('r-history', 40, 500, 350, 150, 'Conversation continuity\nOrdered messages + corrections\nRevision-checked summary coverage', 'data');
  box('r-context', 560, 500, 410, 170, 'Context manager\nExact request manifest\nLatest constraints + true receipts\nPack / compact / recover references', 'shared');
  box('r-model', 1100, 500, 410, 170, 'Model loop\nChoose answer or capability call\nNarrative cannot establish authority\nor claim an effect succeeded', 'shared');
  box('r-provider', 2540, 500, 350, 170, 'Approved model provider\nCheck permitted data destination\nNo credentials in model context\nAlready-sent bytes cannot be recalled', 'product');
  arrow('r-admitcontext', 'r-admit', 'r-context', 1050, 340, -285, 160, 'admitted request');
  arrow('r-historycontext', 'r-history', 'r-context', 390, 575, 170, 0, 'eligible history / constraints');
  arrow('r-request', 'r-context', 'r-model', 970, 560, 130, 0, 'request + manifest');
  arrow('r-provider-call', 'r-model', 'r-provider', 1510, 575, 1030, 0, 'authorized model request / response');
  box('r-skills', 560, 840, 410, 170, 'Skill manager\nExact reviewed instruction revision\nReferences remain data\nScripts need separate execution rights', 'shared');
  box('r-memory', 1100, 840, 410, 170, 'Memory manager\nFilter scope before relevance\nCandidate ≠ accepted ≠ true\nExact acceptance / correction / forget', 'shared');
  box('r-catalogue', 1100, 1180, 410, 170, 'Tool catalogue\nScoped progressive discovery\nExact binding/schema/generation\nChild tools are not flattened here', 'shared');
  box('r-gateway', 2010, 840, 350, 190, 'Execution gateway\nValidate exact handle and arguments\nCheck current action AND data scope\nExact review + intent + preconditions\nClaim dispatch or reject', 'shared');
  arrow('r-modelcall', 'r-model', 'r-gateway', 1510, 630, 500, 270, 'requested capability');
  arrow('r-livecheck', 'r-authority', 'r-gateway', 2185, 370, 0, 470, 'adjacent-to-dispatch check', [[0, 0], [220, 0], [220, 560], [175, 560]]);
  arrow('r-livecontext', 'r-authority', 'r-context', 2010, 295, -1040, 245, 'eligibility before reuse / model call', [[0, 0], [-360, 0], [-360, 120], [-1245, 120], [-1245, 205]]);
  arrow('r-catalogue-call', 'r-model', 'r-catalogue', 1510, 640, 0, 625, 'discover permitted tools', [[0, 0], [120, 0], [120, 625], [0, 625]]);
  arrow('r-schema', 'r-catalogue', 'r-context', 1100, 1240, -130, -570, 'schema references', [[0, 0], [-80, 0], [-80, -510], [-335, -510], [-335, -570]]);
  arrow('r-skillsload', 'r-skills', 'r-context', 765, 840, 0, -170, 'procedures + provenance');
  arrow('r-memoryload', 'r-memory', 'r-context', 1100, 900, -130, -230, 'eligible memory evidence', [[0, 0], [-65, 0], [-65, -180], [-335, -180], [-335, -230]]);
  box('r-skillstore', 40, 840, 350, 170, 'Reviewed skill packages\nInstructions / data / executables\nImmutable digests\nCompatible loading limits', 'config');
  arrow('r-skillfiles', 'r-skillstore', 'r-skills', 390, 915, 170, 0, 'selected files');
  box('r-memorystore', 40, 1180, 350, 170, 'Memory namespace\nRequired owner + subject + audience\nScope and provenance revisions\nExact acceptance record', 'data');
  arrow('r-memoryio', 'r-memorystore', 'r-memory', 390, 1255, 710, -245, 'scope-filtered retrieval');
  arrow('r-memorytool', 'r-gateway', 'r-memory', 2010, 960, -500, 0, 'memory command');
  arrow('r-skilltool', 'r-gateway', 'r-skills', 2010, 990, -1040, 0, 'skill activation / read', [[0, 0], [-350, 0], [-350, 90], [-1245, 90], [-1245, 20]]);
  box('r-adapters', 2010, 1180, 350, 170, 'Trusted adapters\nProduct / provider / isolated tools\nDelegation returns through admission\nCredential and egress restrictions', 'product');
  arrow('r-dispatch', 'r-gateway', 'r-adapters', 2185, 1030, 0, 150, 'claimed operation');
  arrow('r-result', 'r-gateway', 'r-context', 2010, 880, -1040, -210, 'result + dependencies + outcome', [[0, 0], [-80, 0], [-80, -490], [-1245, -490], [-1245, -380]]);
  box('r-state1', 40, 1540, 530, 200, 'Conversation continuity\nImmutable coverage versions + CAS pointer\nOriginal corrections stay ordered\nLLM narrative is disposable', 'data');
  box('r-state2', 630, 1540, 530, 200, 'Accepted memory\nExplicit namespace and acceptance owner\nCorrection, expiry and forgetting\nApproved persistence is not fact verification', 'data');
  box('r-state3', 1220, 1540, 530, 200, 'Knowledge / evidence references\nProduct remains source of business truth\nEligibility of sources AND derivatives\nNo cross-client retrieval or caches', 'data');
  box('r-state4', 1810, 1540, 530, 200, 'Operation / work journal\nPending, confirmed, failed or unknown\nStable intent + payload + attempt\nReconciliation survives cancellation', 'data');
  arrow('r-continuity-read', 'r-state1', 'r-history', 305, 1540, -90, -890, 'versioned coverage', [[0, 0], [-300, 0], [-300, -965], [-265, -965]]);
  arrow('r-memory-record', 'r-state2', 'r-memorystore', 895, 1540, -680, -190, 'accepted record', [[0, 0], [0, -90], [-680, -90], [-680, -190]]);
  arrow('r-evidence-read', 'r-state3', 'r-context', 1485, 1540, -560, -870, 'eligible evidence references', [[0, 0], [255, 0], [255, -780], [-560, -780], [-560, -870]]);
  arrow('r-journal-read', 'r-state4', 'r-gateway', 2075, 1540, 110, -510, 'claim / reconcile', [[0, 0], [390, 0], [390, -605], [285, -605]], true);
  text('r-contract', 40, 1850, 'Source withdrawal invalidates derived context. Recheck before subsequent use, effects and disclosure.', 27, '#6741a5');
  text('r-separate', 40, 1910, 'Never merge history, memory, operational truth, summaries and credentials into one undifferentiated state store.', 24, '#26734d');

  scene = 'delegation'; ox = 6100;
  text('d-title', 40, 0, '3. DELEGATION / every child uses admission again', 38);
  text('d-sub', 40, 60, 'Configured ability at any depth. Same runtime, narrower scope, one shared work identity.', 24);
  box('d-growth', 830, 180, 650, 180, 'Growth assistant\nShared runtime + Growth configuration\nDelegation enabled', 'shared');
  box('d-gate', 830, 470, 650, 170, 'Child admission + shared scheduler\nImmediate-parent delegatable scope\nChild ceiling + live policy + requested subset\nWhole-work capacity and lineage', 'shared');
  arrow('d-submit', 'd-growth', 'd-gate', 1155, 360, 0, 110, 'submit child request');
  box('d-content', 80, 850, 550, 190, 'Content agent\nSame runtime + content configuration\nDelegation enabled in this example', 'shared');
  box('d-research', 880, 850, 550, 190, 'Research agent\nSame runtime + research configuration\nIts own admitted delegation policy', 'shared');
  box('d-campaign', 1680, 850, 550, 190, 'Campaign agent\nSame runtime + campaign configuration\nIts own admitted delegation policy', 'shared');
  arrow('d-gc', 'd-gate', 'd-content', 930, 640, -575, 210, 'admitted child');
  arrow('d-gr', 'd-gate', 'd-research', 1155, 640, 0, 210, 'admitted child');
  arrow('d-gp', 'd-gate', 'd-campaign', 1380, 640, 575, 210, 'admitted child');
  box('d-childgate', 80, 1200, 550, 170, 'The same child admission protocol\nRecheck ancestor validity and data audience\nNo new independent root allowance', 'shared');
  box('d-child', 80, 1510, 550, 190, 'Another permitted child\nThe same runtime\nMay delegate if configured', 'shared');
  arrow('d-nested-request', 'd-content', 'd-childgate', 355, 1040, 0, 160, 'submit child request');
  arrow('d-nested-admit', 'd-childgate', 'd-child', 355, 1370, 0, 140, 'admitted descendant');
  arrow('d-return', 'd-child', 'd-content', 630, 1590, 0, -660, 'checked result + evidence', [[0, 0], [100, 0], [100, -660], [0, -660]]);
  arrow('d-parent-return', 'd-content', 'd-growth', 630, 930, 200, -660, 'checked contribution', [[0, 0], [100, 0], [100, -660], [200, -660]]);
  box('d-envelopes', 880, 1170, 1350, 190, 'Keep three envelopes separate\n1. Actions the child may execute or delegate\n2. Sources it may use; model/provider and output audiences\n3. Exact effects already claimed, attempted or still unknown', 'config');
  box('d-work', 880, 1460, 1350, 240, 'Whole-tree execution control\nOne work ID + parent/child lineage + shared capacity + effect intents\nWaiting parents release active compute slots\nCancel/revoke prevents future descendant dispatch, not past remote effects\nRepeated specialist review is allowed; unchanged non-progress is detected', 'data');
  text('d-key', 80, 1820, 'A child cannot launder private context through a summary or use its own definition to recover revoked parent rights.', 26, '#6741a5');
  text('d-open', 80, 1880, 'Still under review: default depth/capacity policy, namespace acceptance rules and retention. No hidden role-based cutoffs.', 24, '#9a6700');

  scene = 'contracts'; ox = 8600;
  text('c-title', 40, 0, '4. FAILURE CONTRACTS / what must hold when things go wrong', 38);
  text('c-sub', 40, 65, 'Design review findings. These are proposed acceptance cases, not newly passed implementation tests.', 24);
  text('c-h1', 60, 150, 'Failure scenario', 27, '#245b9d');
  text('c-h2', 730, 150, 'Required contract', 27, '#6741a5');
  text('c-h3', 1610, 150, 'Evidence required', 27, '#26734d');
  const cases = [
    ['An old summarizer finishes\nafter a newer user correction.', 'Immutable coverage + compare-and-swap.\nKeep current instructions and receipts\noutside the narrative summary.', 'Race summary completions both ways.\nCoverage never regresses; latest\nconstraints reach the next model call.'],
    ['A source or connection is revoked\nwhile a child/model call is running.', 'Recheck current generations at reuse,\ndispatch, return and disclosure.\nQuarantine invalid-derived output.', 'Revoke at each boundary. No new\nunauthorized use; already-started\neffects retain truthful receipts.'],
    ['A provider accepted the action,\nbut the worker lost its response.', 'Stable effect intent + exact payload.\nProvider idempotency or reconciliation.\nUnknown is not failed or safe to retry.', 'Crash after remote acceptance.\nResume the same intent and receipt\nwithout a duplicate physical effect.'],
    ['Two parallel agents change\nthe same business record.', 'Product resource preconditions and\nwork-scoped effect claims. Different\noperation IDs do not solve conflicts.', 'Attempt stale concurrent writes.\nReject conflicts and require an\nexplicit revised action/review.'],
    ['A child can read private data\nthat its parent must not receive.', 'Separate action and information scopes.\nRestrict child inputs to allowed output\naudiences; no LLM-only declassification.', 'Use inaccessible child memory and\na different provider/audience.\nReject indirect disclosure.'],
    ['Parents occupy all compute slots\nwhile waiting for their children.', 'Waiting work releases active slots.\nChildren use shared work/tenant claims.\nEvery depth passes through admission.', 'Saturate capacity and resume waits.\nChildren still progress fairly;\nno runaway allowance multiplication.'],
    ['A tool changes schema or a skill\nchanges its executable file.', 'Pin digests and connection generations.\nExact review applies to exact semantics.\nNo silent more-privileged fallback.', 'Mutate handles and approval payloads.\nOld references fail or rediscover;\nno changed effect is executed.'],
    ['An inferred fact is accepted\nafter its source was corrected.', 'Explicit memory namespace and owner.\nAccept exact content + provenance\natomically under current policy.', 'Race correction with acceptance.\nReject stale candidates; forgetting\ninvalidates affected derivatives.'],
  ];
  cases.forEach((row, i) => {
    const y = 230 + i * 245;
    box(`c-${i}-scenario`, 40, y, 600, 180, row[0], 'product');
    box(`c-${i}-contract`, 700, y, 820, 180, row[1], 'shared');
    box(`c-${i}-evidence`, 1580, y, 750, 180, row[2], 'data');
  });
  text('c-hard', 40, 2250, 'Deterministic isolation/recovery checks and model-quality evaluations are different evidence. Neither certifies the other.', 26, '#6741a5');
  text('c-unsettled', 40, 2320, 'Open owner decisions: memory acceptance classes, depth/capacity defaults, retention/provider policy and measured quality thresholds.', 24, '#9a6700');
  return { elements, groups };
}
