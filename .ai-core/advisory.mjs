// AI Core 키트 — 경고 기능(advisory). bootstrap 이 «별도 프로세스»로 돌려 stdout 의 JSON 문자열 경고만 받는다 — 세션을 막거나 상태를 바꿀 수 없다.
const 흐르나=function 흐르나(가지, 정책, 지금 = new Date()) {
  const 흐름 = 정책.flow_enforcement;
  if (흐름.exempt_refs.includes(가지.ref)) return { 흐름: '면제', 까닭: '정책이 면제로 지정' };
  if (흐름.exempt_prefixes.some((p) => 가지.ref.startsWith(p))) return { 흐름: '면제', 까닭: '아카이브 — 닫힌 가지의 도달 가능성을 붙잡는다' };

  /** ★만료형 예외만 받는다 (Codex 반례 2026-09-29: 「동시 생성 경합·긴급 작업 차단」).
   *  만료 없는 예외는 영구 구멍이 된다 — 이 저장소가 그렇게 126개가 됐다.
   *  expires 가 지나면 «스스로» 사라져 다시 위반으로 돌아온다. */
  const 예외 = (흐름.expiring_exceptions ?? []).find((x) => x.branch === 가지.ref);
  if (예외) {
    const 오늘 = 지금.toISOString().slice(0, 10);
    if (!예외.expires) return { 흐름: '위반', 까닭: 'EXCEPTION_WITHOUT_EXPIRY: 만료 없는 예외는 받지 않는다', 고치는법: 'expires 를 적거나 예외를 지운다' };
    if (예외.expires >= 오늘) return { 흐름: '면제', 까닭: `만료형 예외 — ${예외.expires} 까지 · ${예외.why}` };
    return { 흐름: '위반', 까닭: `EXCEPTION_EXPIRED: ${예외.expires} 에 만료됐다`, 고치는법: 예외.then ?? '예외를 갱신하거나 가지를 정리한다' };
  }

  const 금지 = (정책.branch_naming.forbidden_actor_prefixes ?? []).find((p) => 가지.ref.startsWith(p));
  if (금지) return { 흐름: '위반', 까닭: `ACTOR_PREFIX: '${금지}' — 가지는 «일»의 것이지 AI 의 것이 아니다`, 고치는법: 'work/<project-id>/<work-id> 로 다시 연다' };

  if (가지.열린PR) return { 흐름: '흐름', 까닭: `PR #${가지.열린PR} 로 main 을 향하는 중` };

  const 나이시간 = (지금 - new Date(가지.마지막커밋)) / 3_600_000;
  if (나이시간 <= 흐름.flowing_when.younger_than_hours) {
    return { 흐름: '흐름', 까닭: `${Math.round(나이시간)}시간 — 아직 어리다` };
  }

  return {
    흐름: '위반',
    까닭: `STALLED: ${Math.round(나이시간 / 24)}일째 멈춰 있고 열린 PR 도 없다`,
    고치는법: 'PR 을 열어 main 으로 보내거나, 아카이브에 묶어 닫는다'
  };
};
function branchFlowWarnings({ branches, policy, defaultBranch, now, judge, prKnown = true }) {
  if (!policy || !Array.isArray(branches)) return { checked: 0, violations: [], unconfirmed: [] };
  const p = { ...policy, flow_enforcement: { ...policy.flow_enforcement, exempt_refs: [...new Set([...(policy.flow_enforcement.exempt_refs || []), defaultBranch].filter(Boolean))] } };
  const violations = [], unconfirmed = [];
  for (const b of branches) {
    const r = judge(b, p, now);
    if (r.흐름 !== '위반') continue;
    // ★Codex 검토: PR 을 못 읽었으면 «열린 PR 없음»이 아니라 «모른다»다. PR 여부에 달린 STALLED 는 확정하지 않는다.
    //   (actor 접두사 위반은 PR 과 무관하므로 그대로 위반)
    if (!prKnown && /^STALLED/.test(r.까닭)) unconfirmed.push(b.ref);
    else violations.push({ ref: b.ref, why: r.까닭, fix: r.고치는법 || null });
  }
  return { checked: branches.length, violations, unconfirmed };
}
import{spawnSync}from'node:child_process';import{readFile}from'node:fs/promises';import{dirname,resolve,join}from'node:path';import{fileURLToPath}from'node:url';
const core=dirname(fileURLToPath(import.meta.url)),root=resolve(core,'..');
const run=(cmd,args=[])=>{const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8',windowsHide:true,shell:false,timeout:60000});return{ok:!r.error&&r.status===0,status:r.status,stdout:(r.stdout??'').trim()}};
const kit=JSON.parse(await readFile(join(core,'kit.json'),'utf8'));const repo=kit.target?.repository??null;const ghAuthOk=process.argv.includes('--gh-auth-ok');
const warnings=[];const ghAuth={ok:ghAuthOk};
const flowScan=kit.branch_flow_policy?run('git',['ls-remote','--symref','origin']):{ok:false,stdout:''};
let defaultBranch=null;const remoteHeads=new Map();
if(flowScan.ok){for(const line of flowScan.stdout.split(/\r?\n/).filter(Boolean)){const sym=line.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/);if(sym){defaultBranch=sym[1];continue;}const m=line.match(/^([0-9a-f]{40})\s+refs\/heads\/(.+)$/);if(m)remoteHeads.set(m[2],m[1]);}}
const localAll=flowScan.ok?run('git',['for-each-ref','--format=%(objectname)|%(committerdate:iso-strict)','refs/remotes/origin']):{ok:false,stdout:''};
const shaDate=new Map();if(localAll.ok)for(const l of localAll.stdout.split(/\r?\n/).filter(Boolean)){const [s,d]=l.split('|');shaDate.set(s,d);}
const defaultSha=defaultBranch?remoteHeads.get(defaultBranch):null;
const noMergedRun=flowScan.ok&&defaultSha&&shaDate.has(defaultSha)?run('git',['for-each-ref','--no-merged='+defaultSha,'--format=%(objectname)','refs/remotes/origin']):{ok:false,stdout:''};
const noMerged=new Set(noMergedRun.ok?noMergedRun.stdout.split(/\r?\n/).filter(Boolean):[]);
const openPrs=kit.branch_flow_policy&&defaultBranch&&ghAuth.ok&&repo?run('gh',['pr','list','--repo',repo,'--state','open','--base',defaultBranch,'--limit','1000','--json','headRefName,number,isCrossRepository']):{ok:false,stdout:''};
const prByRef=new Map();let prListTruncated=false,prKnown=false;try{if(openPrs.ok){const list=JSON.parse(openPrs.stdout||'[]');prListTruncated=list.length>=1000;for(const p of list)if(!p.isCrossRepository)prByRef.set(p.headRefName,p.number);prKnown=!prListTruncated;}}catch{}
const flowBranches=[],unscanned=[];
if(noMergedRun.ok){for(const [ref,sha] of remoteHeads){if(ref===defaultBranch)continue;if(!shaDate.has(sha)){unscanned.push(ref);continue;}if(!noMerged.has(sha))continue;flowBranches.push({ref,마지막커밋:shaDate.get(sha),열린PR:prByRef.get(ref)??null});}}
const branchFlow=branchFlowWarnings({branches:flowBranches,policy:kit.branch_flow_policy,defaultBranch,now:new Date(),judge:흐르나,prKnown});
if(branchFlow.unconfirmed.length)warnings.push('BRANCH_FLOW_PR_UNKNOWN: 열린 PR 을 확인하지 못해 멈춘 것으로 보이는 가지 '+branchFlow.unconfirmed.length+'개를 확정하지 못했다('+branchFlow.unconfirmed.slice(0,5).join(', ')+') — gh 인증 뒤 다시 본다');
if(kit.branch_flow_policy&&!noMergedRun.ok)warnings.push('BRANCH_FLOW_UNKNOWN: 원격 가지를 판정하지 못했다(원격 조회 또는 기본 가지 커밋이 로컬에 없음) — 「흐르지 않는 가지 없음」이 아니라 «모른다»다. git fetch 뒤 다시 본다');
if(unscanned.length)warnings.push('BRANCH_FLOW_PARTIAL: 로컬에 없는 원격 가지 '+unscanned.length+'개는 판정하지 못했다 — git fetch 뒤 다시 본다');
if(prListTruncated)warnings.push('BRANCH_FLOW_PR_LIST_TRUNCATED: 열린 PR 이 1000개 이상이라 목록이 잘렸을 수 있다 — PR 여부에 달린 판정은 확정하지 않는다');
if(branchFlow.violations.length)warnings.push('BRANCH_NOT_FLOWING: main 으로 흐르지 않는 가지 '+branchFlow.violations.length+'개 — '+branchFlow.violations.slice(0,5).map(v=>v.ref).join(', ')+(branchFlow.violations.length>5?' …':'')+' · 정리(PR 로 보내기·보관으로 닫기)는 운영 몫이다. 이 경고는 세션을 막지 않는다');
process.stdout.write(JSON.stringify({warnings,detail:{branch_flow:{default_branch:defaultBranch,checked:branchFlow.checked,unscanned:unscanned.length,pr_known:prKnown,unconfirmed:branchFlow.unconfirmed.slice(0,20),violations:branchFlow.violations.slice(0,20)}}}));
