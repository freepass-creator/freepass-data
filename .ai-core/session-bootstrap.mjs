import{spawnSync}from'node:child_process';
import{readFile}from'node:fs/promises';
import{dirname,resolve,join}from'node:path';
import{fileURLToPath}from'node:url';
const core=dirname(fileURLToPath(import.meta.url)),root=resolve(core,'..'),sync=process.argv.includes('--sync');
const generatedAuthority={core_revision:"2ca825b4bdad366fad42afc9eacf5a36ac698381",target_revision:"5e1be5f3244be6472ce3693fef100c960c227be6"};
const run=(cmd,args=[])=>{const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8',windowsHide:true,shell:false});return{ok:!r.error&&r.status===0,status:r.status,stdout:(r.stdout??'').trim(),error:r.error?.code??null}};
const kit=JSON.parse(await readFile(join(core,'kit.json'),'utf8'));
const knowledge=JSON.parse(await readFile(join(core,'OPERATING_KNOWLEDGE.json'),'utf8'));
const gitVersion=run('git',['--version']),nodeVersion={ok:true,stdout:process.version};
const remote=run('git',['remote','get-url','origin']),branch=run('git',['branch','--show-current']);
let head=run('git',['rev-parse','HEAD']),dirty=run('git',['status','--porcelain']);
const ghVersion=run('gh',['--version']),ghAuth=ghVersion.ok?run('gh',['auth','status']):{ok:false,error:'GH_NOT_FOUND'},ghUser=ghAuth.ok?run('gh',['api','user','--jq','.login']):{ok:false,error:'GH_AUTH_UNAVAILABLE'};
const repo=kit.target?.repository??null,repoAccess=ghUser.ok&&repo?run('gh',['repo','view',repo,'--json','nameWithOwner','--jq','.nameWithOwner']):{ok:false,error:'GH_IDENTITY_OR_REPO_MISSING'};
const expected=knowledge.platforms?.find(x=>x.id==='platform.github')?.connection?.account??null;
const remoteLine=remote.ok&&branch.ok&&branch.stdout?run('git',['ls-remote','--heads','origin','refs/heads/'+branch.stdout]):{ok:false,error:'BRANCH_OR_REMOTE_MISSING'};
let remoteHead=remoteLine.ok?remoteLine.stdout.split(/\s+/)[0]||null:null,syncResult='NOT_REQUESTED';
if(sync&&dirty.ok&&!dirty.stdout&&branch.ok&&branch.stdout&&remoteHead&&head.ok&&head.stdout!==remoteHead){
  const fetched=run('git',['fetch','--quiet','origin',branch.stdout]);
  const remoteRef='refs/remotes/origin/'+branch.stdout;
  const fetchedHead=fetched.ok?run('git',['rev-parse',remoteRef]):{ok:false};
  const ancestor=fetchedHead.ok?run('git',['merge-base','--is-ancestor',head.stdout,fetchedHead.stdout]):{ok:false};
  if(fetched.ok&&fetchedHead.ok&&ancestor.ok){const merged=run('git',['merge','--ff-only',remoteRef]);syncResult=merged.ok?'FAST_FORWARDED':'FAST_FORWARD_FAILED';}
  else syncResult=fetched.ok?'DIVERGED':'FETCH_FAILED';
  head=run('git',['rev-parse','HEAD']);dirty=run('git',['status','--porcelain']);
  const refreshed=run('git',['ls-remote','--heads','origin','refs/heads/'+branch.stdout]);remoteHead=refreshed.ok?refreshed.stdout.split(/\s+/)[0]||remoteHead:remoteHead;
}else if(sync&&dirty.ok&&dirty.stdout)syncResult='SKIPPED_DIRTY';
else if(sync&&head.ok&&remoteHead===head.stdout)syncResult='ALREADY_CURRENT';
else if(sync)syncResult='REMOTE_HEAD_UNAVAILABLE';
const coreRepo='freepass-creator/ai-core';
const coreHead=ghAuth.ok?run('gh',['api','repos/'+coreRepo+'/commits/main','--jq','.sha']):{ok:false,error:'GH_AUTH_UNAVAILABLE'};
const projectFreshness=remoteHead&&head.ok?(remoteHead===head.stdout?'CURRENT':'STALE_OR_DIVERGED'):'UNKNOWN';
function kitFreshness({ kitRevision, coreHead, inputs, catalogInputs, compare, verificationSource, verification, currentVerification }) {
  // ★Codex 검토(PR #346): kit.verification 은 registry/projects.json 의 이 프로젝트 commands 다. 파일째 넣으면 매일 STALE,
  //   빼면 명령이 바뀌어도 모른다 → 그 «칸»만 비교한다. 못 읽었으면(undefined) 닫는다.
  const same = (a, b) => { const c = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? '[' + v.map(c).join(',') + ']' : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + c(v[k])).join(',') + '}') : JSON.stringify(v ?? null)); return c(a) === c(b); };
  const none = { changed: [], catalog_changed: [] };
  if (!coreHead) return { status: 'UNKNOWN', reason: 'CORE_HEAD_UNAVAILABLE', ...none };
  if (coreHead === kitRevision) return { status: 'CURRENT', reason: 'SAME_REVISION', ...none };
  if (!Array.isArray(inputs) || inputs.length === 0) return { status: 'STALE', reason: 'LEGACY_KIT_WITHOUT_INPUTS', ...none };
  if (!compare || !compare.ok || !Array.isArray(compare.files)) return { status: 'UNKNOWN', reason: 'COMPARE_UNAVAILABLE', ...none };
  if (compare.status === 'identical') return { status: 'CURRENT_CONTENT', reason: 'IDENTICAL', ...none };
  if (compare.status !== 'ahead') return { status: 'STALE', reason: 'HISTORY_' + String(compare.status).toUpperCase(), ...none };
  if (compare.files.length >= 300) return { status: 'STALE', reason: 'COMPARE_TRUNCATED', ...none };
  const touched = new Set(compare.files);
  const changed = inputs.filter((p) => touched.has(p));
  const catalog_changed = (catalogInputs || []).filter((p) => touched.has(p));
  if (verificationSource && touched.has(verificationSource)) {
    if (currentVerification === undefined) return { status: 'UNKNOWN', reason: 'VERIFICATION_UNREAD', changed, catalog_changed };
    if (!same(verification, currentVerification)) changed.push(verificationSource + '#commands');
  }
  return changed.length
    ? { status: 'STALE', reason: 'INPUT_CHANGED', changed, catalog_changed }
    : { status: 'CURRENT_CONTENT', reason: 'INPUTS_UNCHANGED', changed, catalog_changed };
}
const coreCompareRun=coreHead.ok&&coreHead.stdout!==kit.core_revision&&Array.isArray(kit.freshness_inputs)?run('gh',['api','repos/'+coreRepo+'/compare/'+kit.core_revision+'...'+coreHead.stdout,'--jq','{status:.status,ahead_by:.ahead_by,files:[.files[]|.filename,(.previous_filename//empty)]}']):null;
let coreCompare=null;try{coreCompare=coreCompareRun?.ok?{ok:true,...JSON.parse(coreCompareRun.stdout)}:(coreCompareRun?{ok:false}:null)}catch{coreCompare={ok:false}}
let currentVerification;
if(coreCompare?.ok&&kit.verification_source&&coreCompare.files?.includes(kit.verification_source)){const raw=run('gh',['api','-H','Accept: application/vnd.github.raw','repos/'+coreRepo+'/contents/'+kit.verification_source+'?ref='+coreHead.stdout]);try{if(raw.ok){const reg=JSON.parse(raw.stdout);const p=(reg.projects??[]).find(x=>x.project_id===kit.target?.project_id);currentVerification=p?.commands??null;}}catch{}}
const freshness=kitFreshness({kitRevision:kit.core_revision,coreHead:coreHead.ok?coreHead.stdout:null,inputs:kit.freshness_inputs,catalogInputs:kit.catalog_inputs,compare:coreCompare,verificationSource:kit.verification_source,verification:kit.verification,currentVerification});
const coreFreshness=freshness.status;
const authorityPaths=['.ai-core/kit.json','.ai-core/session-bootstrap.mjs','.ai-core/verify-kit.mjs','.ai-core/START_HERE.md'];
const authorityEpochPaths=['.ai-core/session-bootstrap.mjs','.ai-core/kit.json','.ai-core/START_HERE.md'];
const authorityHistory=run('git',['log','--format=%H','--','.ai-core/session-bootstrap.mjs']);
const authorityEpochs=[];
if(authorityHistory.ok){for(const candidate of authorityHistory.stdout.split(/\r?\n/).filter(Boolean)){const changed=run('git',['diff-tree','--no-commit-id','--name-only','-r',candidate]);if(!changed.ok)continue;const paths=changed.stdout.split(/\r?\n/).filter(Boolean);if(!authorityEpochPaths.every(path=>paths.includes(path)))continue;const manifestAtCandidate=run('git',['show',candidate+':.ai-core/kit.json']);if(!manifestAtCandidate.ok)continue;try{const candidateKit=JSON.parse(manifestAtCandidate.stdout);const coreRevisionAtCandidate=candidateKit.core_revision,targetRevisionAtCandidate=candidateKit.target?.revision;if(!coreRevisionAtCandidate||!targetRevisionAtCandidate)continue;authorityEpochs.push({commit:candidate,generation_key:coreRevisionAtCandidate+':'+targetRevisionAtCandidate});}catch{}}}
let authorityAnchor=null;
for(let index=0;index<authorityEpochs.length;index+=1){const candidate=authorityEpochs[index];const generationAlreadyIntroduced=authorityEpochs.slice(index+1).some(item=>item.generation_key===candidate.generation_key);if(!generationAlreadyIntroduced){authorityAnchor=candidate.commit;break;}}
const authorityChanged=[];
if(authorityAnchor){for(const path of authorityPaths){const anchored=run('git',['rev-parse',authorityAnchor+':'+path]);const current=run('git',['hash-object',path]);if(!anchored.ok||!current.ok||anchored.stdout!==current.stdout)authorityChanged.push(path.replace('.ai-core/',''));}}
if(kit.core_revision!==generatedAuthority.core_revision||kit.target?.revision!==generatedAuthority.target_revision){if(!authorityChanged.includes('kit.json'))authorityChanged.push('kit.json');}
const authorityStatus=!authorityAnchor?'UNAVAILABLE':authorityChanged.length?'MISMATCH':'MATCH';
const kitCheck=authorityStatus==='MATCH'?run(process.execPath,[join(core,'verify-kit.mjs')]):{ok:false,status:null,stdout:'',error:'STARTER_KIT_AUTHORITY_UNVERIFIED'};
let kitVerification=null;
try{kitVerification=kitCheck.stdout?JSON.parse(kitCheck.stdout):null}catch{}
const kitRevisionStatus=kitVerification?.revision?.status??'UNAVAILABLE';
const kitReady=authorityStatus==='MATCH'&&kitCheck.ok&&kitVerification?.status==='PASS';
const blockers=[];
if(!gitVersion.ok)blockers.push('GIT_UNAVAILABLE');
if(!remote.ok)blockers.push('GIT_REMOTE_UNAVAILABLE');
if(!ghVersion.ok)blockers.push('GH_CLI_UNAVAILABLE');else if(!ghAuth.ok)blockers.push('GH_AUTH_UNAVAILABLE');else if(expected&&ghUser.stdout!==expected)blockers.push('GH_IDENTITY_MISMATCH');
if(!repoAccess.ok)blockers.push('GITHUB_REPOSITORY_UNAVAILABLE');
if(dirty.ok&&dirty.stdout)blockers.push('DIRTY_WORKTREE_REVIEW_REQUIRED');
if(!remoteHead)blockers.push('REMOTE_BRANCH_HEAD_UNAVAILABLE');else if(projectFreshness!=='CURRENT')blockers.push(syncResult==='DIVERGED'?'LOCAL_BRANCH_DIVERGED':'LOCAL_BRANCH_NOT_CURRENT');
if(!coreHead.ok)blockers.push('AI_CORE_REMOTE_HEAD_UNAVAILABLE');else if(coreFreshness==='UNKNOWN')blockers.push('AI_CORE_KIT_FRESHNESS_UNKNOWN');else if(coreFreshness==='STALE')blockers.push('AI_CORE_KIT_STALE');
const warnings=freshness.catalog_changed.length?['AI_CORE_CATALOG_CHANGED: catalog/ 는 참고용 사본이다 — 쓰기 전에 ai-core registry 에서 다시 읽는다 ('+freshness.catalog_changed.join(', ')+')']:[];
if(!kitReady){if(kitRevisionStatus==='MISMATCH')blockers.push('STARTER_KIT_REVISION_MISMATCH');else blockers.push('STARTER_KIT_VERIFICATION_FAILED');}
if(syncResult==='FETCH_FAILED'||syncResult==='FAST_FORWARD_FAILED')blockers.push('SAFE_SYNC_FAILED');
const next=blockers.includes('STARTER_KIT_REVISION_MISMATCH')?'Regenerate the AI Core starter kit against this exact project revision before starting work.':blockers.includes('STARTER_KIT_VERIFICATION_FAILED')?'Repair starter-kit verification before starting work.':blockers.includes('AI_CORE_KIT_STALE')?'Refresh this project through the AI Core starter-kit distribution PR, then rerun bootstrap.':blockers.includes('LOCAL_BRANCH_NOT_CURRENT')?'If the worktree is clean and the branch should follow origin, rerun with --sync.':blockers.length?'Resolve only the listed blockers; preserve local work and continue safe read-only work where possible.':'Read project instructions and begin the user task directly.';
const out={schema:'ai-core-session-bootstrap/v2',status:blockers.length?'HOLD':'READY',mode:sync?'SYNC':'OBSERVE',project:{repository:repo,expected_baseline:kit.target?.revision??null,remote:remote.ok?remote.stdout:null,branch:branch.ok?branch.stdout:null,head:head.ok?head.stdout:null,remote_head:remoteHead,remote_freshness:projectFreshness,dirty:dirty.ok?Boolean(dirty.stdout):null,sync_result:syncResult,kit_authority:{status:authorityStatus,anchor_commit:authorityAnchor,changed:authorityChanged},kit_verification:kitVerification},civilization:{core_repository:coreRepo,kit_revision:kit.core_revision,remote_head:coreHead.ok?coreHead.stdout:null,remote_freshness:coreFreshness,freshness_reason:freshness.reason,ahead_by:coreCompare?.ahead_by??null,changed_inputs:freshness.changed,constitution:'standards/AI_WORKING_STANDARD.md',operating_knowledge:'OPERATING_KNOWLEDGE.json',catalog:'catalog/',handoff:'WORK_RESULT.md',evolution_inbox:'https://github.com/freepass-creator/ai-core/issues/211',verification:kit.verification},access:{node:nodeVersion.stdout,git:gitVersion.ok?gitVersion.stdout:null,github:{expected_identity:expected,actual_identity:ghUser.ok?ghUser.stdout:null,cli:ghVersion.ok?'AVAILABLE':'UNAVAILABLE',auth:ghAuth.ok?'READY':'UNAVAILABLE',repository:repoAccess.ok?'READY':'UNAVAILABLE'}},rules:{github_latest_required:true,fast_forward_only:true,reuse_first:true,preserve_dirty_work:true,no_secret_output:true,no_repeated_login:true},blockers,warnings,next_action:next};
console.log(JSON.stringify(out,null,2));if(blockers.length)process.exitCode=2;
