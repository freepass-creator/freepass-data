import{spawnSync}from'node:child_process';
import{readFile}from'node:fs/promises';
import{dirname,resolve,join}from'node:path';
import{fileURLToPath}from'node:url';
const core=dirname(fileURLToPath(import.meta.url)),root=resolve(core,'..'),sync=process.argv.includes('--sync');
const generatedAuthority={core_revision:"ea1549f85ef9b76ea0e989aff2773ad70561d8c1",target_revision:"6a7165c4d4f54780e35bda7f3fe5bcdcd216f53c"};
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
function kitFreshness({ kitRevision, coreHead, inputs, advisoryInputs, catalogInputs, compare, verificationSource, verification, currentVerification }) {
  // ★2026-09-30 (Codex 설계): 입력을 «차단»과 «권고»로 가른다. 규격·정책·무결성(호환 버전 파일) 변경만 막고,
  //   생성기에 기능이 붙은 것만으로는 막지 않는다(AI_CORE_KIT_UPDATE_AVAILABLE). advisoryInputs 가 없는 옛 키트는 전부 차단(그대로).
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
  if (changed.length) return { status: 'STALE', reason: 'INPUT_CHANGED', changed, catalog_changed };
  const advisory_changed = (advisoryInputs || []).filter((p) => touched.has(p));
  if (advisory_changed.length) return { status: 'UPDATE_AVAILABLE', reason: 'ADVISORY_ONLY', changed, advisory_changed, catalog_changed };
  return { status: 'CURRENT_CONTENT', reason: 'INPUTS_UNCHANGED', changed, catalog_changed };
}
function kitAuthority({ run, kit, generatedAuthority }) {
  const authorityPaths = ['.ai-core/kit.json', '.ai-core/session-bootstrap.mjs', '.ai-core/verify-kit.mjs', '.ai-core/START_HERE.md'];
  const authorityEpochPaths = ['.ai-core/session-bootstrap.mjs', '.ai-core/kit.json', '.ai-core/START_HERE.md'];
  const lines = (s) => String(s || '').split(/\r?\n/).filter(Boolean);
  const history = run('git', ['log', '--format=%H', '--', '.ai-core/session-bootstrap.mjs']);
  const epochs = [];
  if (history.ok) {
    for (const candidate of lines(history.stdout)) {
      const changed = run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', candidate]);
      if (!changed.ok) continue;
      const paths = lines(changed.stdout);
      if (!authorityEpochPaths.every((path) => paths.includes(path))) continue;
      const manifest = run('git', ['show', candidate + ':.ai-core/kit.json']);
      if (!manifest.ok) continue;
      try {
        const k = JSON.parse(manifest.stdout);
        if (!k.core_revision || !k.target?.revision) continue;
        epochs.push({ commit: candidate, generation_key: k.core_revision + ':' + k.target.revision });
      } catch {}
    }
  }
  let anchor = null;
  for (let i = 0; i < epochs.length; i += 1) {
    if (!epochs.slice(i + 1).some((e) => e.generation_key === epochs[i].generation_key)) { anchor = epochs[i].commit; break; }
  }
  const changed = [];
  if (anchor) {
    for (const path of authorityPaths) {
      const anchored = run('git', ['rev-parse', anchor + ':' + path]);
      const current = run('git', ['hash-object', path]);
      if (!anchored.ok || !current.ok || anchored.stdout !== current.stdout) changed.push(path.replace('.ai-core/', ''));
    }
  }
  if (kit.core_revision !== generatedAuthority.core_revision || kit.target?.revision !== generatedAuthority.target_revision) {
    if (!changed.includes('kit.json')) changed.push('kit.json');
  }
  return { status: !anchor ? 'UNAVAILABLE' : changed.length ? 'MISMATCH' : 'MATCH', anchor, changed };
}
function kitFreshnessInputs(kit) {
  if (Array.isArray(kit.blocking_inputs)) return { inputs: kit.blocking_inputs, advisoryInputs: Array.isArray(kit.advisory_inputs) ? kit.advisory_inputs : [] };
  return { inputs: kit.freshness_inputs, advisoryInputs: undefined };
}
function kitSafetyDecision({ coreHeadOk, freshness, authorityStatus, kitCheckOk, kitVerification }) {
  const blockers = [], warnings = [];
  if (!coreHeadOk) blockers.push('AI_CORE_REMOTE_HEAD_UNAVAILABLE');
  else if (freshness.status === 'UNKNOWN') blockers.push('AI_CORE_KIT_FRESHNESS_UNKNOWN');
  else if (freshness.status === 'STALE') blockers.push('AI_CORE_KIT_STALE');
  else if (freshness.status === 'UPDATE_AVAILABLE') warnings.push('AI_CORE_KIT_UPDATE_AVAILABLE: AI Core 키트 생성기에 새 기능이 있다(' + (freshness.advisory_changed || []).join(', ') + ') — 안전 판정은 그대로라 막지 않는다. 다음 키트 배포 때 받는다');
  const kitReady = authorityStatus === 'MATCH' && kitCheckOk === true && kitVerification?.status === 'PASS';
  /** ★2026-10-03 (Codex 상의 MODIFY): 키트를 깐 뒤 제품에 평범한 커밋이 들어가면 예전엔 MISMATCH 로 모든 세션이 HOLD 였다 —
   *  재배포해도 다음 제품 커밋까지만 조용한 «늘 울리는 경보»였다. 키트 기준 revision 이 HEAD 의 조상이면 제품이 앞으로 간 것뿐이라
   *  PASS + 경고(PROJECT_ADVANCED)로 둔다. 조상이 아님(다른 저장소·가지·이력 재작성)·조상 확인 불가·기준 revision 없음은 계속 막는다. */
  const revisionStatus = kitVerification?.revision?.status;
  if (kitReady && revisionStatus === 'PROJECT_ADVANCED') warnings.push(`STARTER_KIT_PROJECT_ADVANCED: 키트 기준 ${String(kitVerification.revision.expected).slice(0, 8)} 뒤로 제품이 ${kitVerification.revision.ahead_count ?? '?'}커밋 앞서 있다(HEAD ${String(kitVerification.revision.actual).slice(0, 8)}) — 정상 진행이라 막지 않는다. 규격 판단은 프로젝트 지침·검증이 맡는다`);
  if (!kitReady) blockers.push(revisionStatus === 'MISMATCH' ? 'STARTER_KIT_REVISION_MISMATCH' : revisionStatus === 'ANCESTRY_UNKNOWN' ? 'STARTER_KIT_REVISION_ANCESTRY_UNKNOWN' : revisionStatus === 'TARGET_MISSING' ? 'STARTER_KIT_TARGET_REVISION_MISSING' : 'STARTER_KIT_VERIFICATION_FAILED');
  return { blockers, warnings, kitReady };
}
const coreCompareRun=coreHead.ok&&coreHead.stdout!==kit.core_revision&&Array.isArray(kit.freshness_inputs)?run('gh',['api','repos/'+coreRepo+'/compare/'+kit.core_revision+'...'+coreHead.stdout,'--jq','{status:.status,ahead_by:.ahead_by,files:[.files[]|.filename,(.previous_filename//empty)]}']):null;
let coreCompare=null;try{coreCompare=coreCompareRun?.ok?{ok:true,...JSON.parse(coreCompareRun.stdout)}:(coreCompareRun?{ok:false}:null)}catch{coreCompare={ok:false}}
let currentVerification;
if(coreCompare?.ok&&kit.verification_source&&coreCompare.files?.includes(kit.verification_source)){const raw=run('gh',['api','-H','Accept: application/vnd.github.raw','repos/'+coreRepo+'/contents/'+kit.verification_source+'?ref='+coreHead.stdout]);try{if(raw.ok){const reg=JSON.parse(raw.stdout);const p=(reg.projects??[]).find(x=>x.project_id===kit.target?.project_id);currentVerification=p?.commands??null;}}catch{}}
const freshnessInputs=kitFreshnessInputs(kit);
const freshness=kitFreshness({kitRevision:kit.core_revision,coreHead:coreHead.ok?coreHead.stdout:null,inputs:freshnessInputs.inputs,advisoryInputs:freshnessInputs.advisoryInputs,catalogInputs:kit.catalog_inputs,compare:coreCompare,verificationSource:kit.verification_source,verification:kit.verification,currentVerification});
const coreFreshness=freshness.status;
const {status:authorityStatus,anchor:authorityAnchor,changed:authorityChanged}=kitAuthority({run,kit,generatedAuthority});
const kitCheck=authorityStatus==='MATCH'?run(process.execPath,[join(core,'verify-kit.mjs')]):{ok:false,status:null,stdout:'',error:'STARTER_KIT_AUTHORITY_UNVERIFIED'};
let kitVerification=null;
try{kitVerification=kitCheck.stdout?JSON.parse(kitCheck.stdout):null}catch{}
const safety=kitSafetyDecision({coreHeadOk:coreHead.ok,freshness,authorityStatus,kitCheckOk:kitCheck.ok,kitVerification});
const kitReady=safety.kitReady;
const blockers=[];
if(!gitVersion.ok)blockers.push('GIT_UNAVAILABLE');
if(!remote.ok)blockers.push('GIT_REMOTE_UNAVAILABLE');
if(!ghVersion.ok)blockers.push('GH_CLI_UNAVAILABLE');else if(!ghAuth.ok)blockers.push('GH_AUTH_UNAVAILABLE');else if(expected&&ghUser.stdout!==expected)blockers.push('GH_IDENTITY_MISMATCH');
if(!repoAccess.ok)blockers.push('GITHUB_REPOSITORY_UNAVAILABLE');
if(dirty.ok&&dirty.stdout)blockers.push('DIRTY_WORKTREE_REVIEW_REQUIRED');
if(!remoteHead)blockers.push('REMOTE_BRANCH_HEAD_UNAVAILABLE');else if(projectFreshness!=='CURRENT')blockers.push(syncResult==='DIVERGED'?'LOCAL_BRANCH_DIVERGED':'LOCAL_BRANCH_NOT_CURRENT');
blockers.push(...safety.blockers);
const warnings=freshness.catalog_changed.length?['AI_CORE_CATALOG_CHANGED: catalog/ 는 참고용 사본이다 — 쓰기 전에 ai-core registry 에서 다시 읽는다 ('+freshness.catalog_changed.join(', ')+')']:[];
warnings.push(...safety.warnings);
let advisoryDetail=null;
const advisoryRun=spawnSync(process.execPath,[join(core,'advisory.mjs'),...(ghAuth.ok?['--gh-auth-ok']:[])],{cwd:root,encoding:'utf8',windowsHide:true,shell:false,timeout:120000});let advisoryResult=null;try{advisoryResult=!advisoryRun.error&&advisoryRun.status===0?JSON.parse(advisoryRun.stdout):null}catch{advisoryResult=null}if(!advisoryResult||!Array.isArray(advisoryResult.warnings)||!advisoryResult.warnings.every(w=>typeof w==='string'))warnings.push('ADVISORY_UNAVAILABLE: 경고 모듈이 실패했거나 형식이 맞지 않는다(별도 프로세스) — 안전 판정은 그대로다');else{warnings.push(...Object.freeze([...advisoryResult.warnings]));try{advisoryDetail=advisoryResult.detail?JSON.parse(JSON.stringify(advisoryResult.detail)):null}catch{advisoryDetail=null}}
if(syncResult==='FETCH_FAILED'||syncResult==='FAST_FORWARD_FAILED')blockers.push('SAFE_SYNC_FAILED');
const next=blockers.includes('STARTER_KIT_REVISION_MISMATCH')?'Regenerate the AI Core starter kit against this exact project revision before starting work.':blockers.includes('STARTER_KIT_VERIFICATION_FAILED')?'Repair starter-kit verification before starting work.':blockers.includes('AI_CORE_KIT_STALE')?'Refresh this project through the AI Core starter-kit distribution PR, then rerun bootstrap.':blockers.includes('LOCAL_BRANCH_NOT_CURRENT')?'If the worktree is clean and the branch should follow origin, rerun with --sync.':blockers.length?'Resolve only the listed blockers; preserve local work and continue safe read-only work where possible.':'Read project instructions and begin the user task directly.';
const out={schema:'ai-core-session-bootstrap/v2',status:blockers.length?'HOLD':'READY',mode:sync?'SYNC':'OBSERVE',project:{repository:repo,expected_baseline:kit.target?.revision??null,remote:remote.ok?remote.stdout:null,branch:branch.ok?branch.stdout:null,head:head.ok?head.stdout:null,remote_head:remoteHead,remote_freshness:projectFreshness,dirty:dirty.ok?Boolean(dirty.stdout):null,sync_result:syncResult,branch_flow:advisoryDetail?.branch_flow??null,kit_authority:{status:authorityStatus,anchor_commit:authorityAnchor,changed:authorityChanged},kit_verification:kitVerification},civilization:{core_repository:coreRepo,kit_revision:kit.core_revision,remote_head:coreHead.ok?coreHead.stdout:null,remote_freshness:coreFreshness,freshness_reason:freshness.reason,ahead_by:coreCompare?.ahead_by??null,changed_inputs:freshness.changed,constitution:'standards/AI_WORKING_STANDARD.md',operating_knowledge:'OPERATING_KNOWLEDGE.json',catalog:'catalog/',handoff:'WORK_RESULT.md',evolution_inbox:'https://github.com/freepass-creator/ai-core/issues/211',verification:kit.verification},access:{node:nodeVersion.stdout,git:gitVersion.ok?gitVersion.stdout:null,github:{expected_identity:expected,actual_identity:ghUser.ok?ghUser.stdout:null,cli:ghVersion.ok?'AVAILABLE':'UNAVAILABLE',auth:ghAuth.ok?'READY':'UNAVAILABLE',repository:repoAccess.ok?'READY':'UNAVAILABLE'}},rules:{github_latest_required:true,fast_forward_only:true,reuse_first:true,preserve_dirty_work:true,no_secret_output:true,no_repeated_login:true},blockers,warnings,next_action:next};
console.log(JSON.stringify(out,null,2));if(blockers.length)process.exitCode=2;
