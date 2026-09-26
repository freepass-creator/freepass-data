const CONTRACT='freepass-data-control-tower-v1';
const SCHEMA='1.0.0';
const HEALTH=['HEALTHY','DEGRADED','BLOCKED'];
const ATTENTION=[
  'AUDIT_SCHEDULE_BLOCKED','AUDIT_SCHEDULE_DEGRADED','PUBLICATION_HOLD',
  'CONSUMER_HEALTH_BLOCKED','CONSUMER_HEALTH_DEGRADED',
  'CONSUMER_READINESS_HOLD','CONSUMER_READINESS_DEGRADED',
  'SHEET_HEALTH_BLOCKED','SHEET_HEALTH_DEGRADED',
  'HEALTH_POLICY_NOT_CONFIGURED','READINESS_POLICY_NOT_CONFIGURED','SHEET_POLICY_NOT_CONFIGURED'
];
const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;};
const hasText=value=>typeof value==='string'&&value.trim().length>0;
const invalid=field=>{throw new Error('INVALID_CONTROL_TOWER_UI:'+field);};

function validateScheduled(value,field){
  if(!value||typeof value.configured!=='boolean'||!HEALTH.includes(value.status))invalid(field);
  if(value.reason!=null&&!hasText(value.reason))invalid(field+'.reason');
  if(value.generatedAt!=null&&!Number.isFinite(Date.parse(value.generatedAt)))invalid(field+'.generatedAt');
}
function validate(report){
  if(!report||report.contractVersion!==CONTRACT||report.schemaVersion!==SCHEMA||
     !Number.isFinite(Date.parse(report.generatedAt))||!hasText(report.runId)||
     !report.axes||!report.operatorSummary||!Array.isArray(report.attention))invalid('root');
  if(report.attention.some(code=>!ATTENTION.includes(code)))invalid('attention');
  const source=report.axes.sourceObservation;
  if(!source||source.status!=='OBSERVED'||source.projectId!=='freepasserp5'||source.databaseId!=='(default)'||
     !Number.isFinite(Date.parse(source.readTime))||!hasText(source.digest)||!hasText(source.coverage)||
     !Number.isFinite(source.products)||source.products<0||!Number.isFinite(source.policies)||source.policies<0)invalid('sourceObservation');
  const audit=report.axes.auditFreshness;
  if(!audit||typeof audit.configured!=='boolean'||!HEALTH.includes(audit.status)||!hasText(audit.reason)||
     !Number.isFinite(Date.parse(audit.currentReadTime))||
     (audit.previousReadTime!=null&&!Number.isFinite(Date.parse(audit.previousReadTime)))||
     (audit.gapMinutes!=null&&(!Number.isFinite(audit.gapMinutes)||audit.gapMinutes<0))||
     (audit.maxGapMinutes!=null&&(!Number.isFinite(audit.maxGapMinutes)||audit.maxGapMinutes<0)))invalid('auditFreshness');
  const publication=report.axes.publication;
  if(!publication||!hasText(publication.decision)||
     typeof publication.activeReleaseAuthorized!=='boolean'||
     typeof publication.canonicalWriteAuthorized!=='boolean'||
     typeof publication.destructiveActionAuthorized!=='boolean'||
     !Array.isArray(publication.holdReasons))invalid('publication');
  validateScheduled(report.axes.consumerHealth,'consumerHealth');
  validateScheduled(report.axes.consumerReadiness,'consumerReadiness');
  validateScheduled(report.axes.sheetHealth,'sheetHealth');
  const summary=report.operatorSummary;
  for(const key of ['readyTransitionCount','publicationHoldReasonCount']){
    if(!Number.isFinite(summary[key])||summary[key]<0)invalid('operatorSummary.'+key);
  }
  for(const key of ['consumerBlockedCount','readinessHoldCount','auditGapMinutes']){
    if(summary[key]!=null&&(!Number.isFinite(summary[key])||summary[key]<0))invalid('operatorSummary.'+key);
  }
  return structuredClone(report);
}

const formatTime=value=>{
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return '시각 없음';
  return new Intl.DateTimeFormat('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date);
};
const statusLabel=status=>({HEALTHY:'정상',DEGRADED:'주의',BLOCKED:'차단',OBSERVED:'관측 완료'}[status]??status);
const bool=value=>value?'허용':'차단';

export function mountControlTower(root,{read}={}){
  if(!(root instanceof HTMLElement))throw new TypeError('Control Tower root must be HTMLElement');
  root.replaceChildren();root.classList.add('ct');

  let report=null,seq=0,disposed=false;

  const head=el('header','ct-head');const title=el('div');
  title.append(el('h1','','Data Control Tower'),el('p','','FreePass Data 운영축을 하나의 화면에서 보되, 각 축의 판정은 원본 계약 그대로 유지합니다.'));
  const meta=el('div','ct-meta','관측 정보 없음');head.append(title,meta);

  const summary=el('section','ct-summary');const summaryNodes={};
  for(const [key,label] of [
    ['readyTransitionCount','다음 단계 준비'],
    ['consumerBlockedCount','소비처 차단'],
    ['readinessHoldCount','Readiness HOLD'],
    ['auditGapMinutes','감사 간격(분)'],
    ['publicationHoldReasonCount','배포 HOLD 사유'],
  ]){
    const box=el('div','ct-stat');box.append(el('span','',label),summaryNodes[key]=el('strong','','—'));summary.append(box);
  }

  const toolbar=el('div','ct-toolbar');
  const healthLink=document.createElement('a');healthLink.href='/console/data-health';healthLink.className='ct-link';healthLink.textContent='Data Health 보기';
  const refresh=el('button','ct-refresh','↻ 다시 조회');refresh.type='button';refresh.setAttribute('aria-label','Control Tower 다시 조회');
  toolbar.append(healthLink,refresh);

  const status=el('div','ct-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const attention=el('div','ct-attention');
  const axes=el('section','ct-axes');
  const details=el('section','ct-section');
  root.append(head,summary,toolbar,status,attention,axes,details);

  const addKv=(parent,label,value)=>{
    const row=el('div','ct-kv');row.append(el('span','',label),el('span','',value??'—'));parent.append(row);
  };
  const axisCard=(titleText,statusCode,reason)=>{
    const card=el('article','ct-axis');card.dataset.status=statusCode;
    const headBox=el('div','ct-axis-head');headBox.append(el('div','ct-axis-title',titleText));
    const badge=el('span','ct-badge',statusLabel(statusCode));badge.dataset.status=statusCode;headBox.append(badge);
    card.append(headBox);
    if(reason)card.append(el('p','ct-axis-reason',reason));
    return card;
  };
  const showState=(titleText,message)=>{
    axes.replaceChildren();attention.replaceChildren();details.replaceChildren();
    const box=el('div','ct-read-state');box.append(el('strong','',titleText),el('p','',message));axes.append(box);
  };

  function render(){
    if(!report)return;
    meta.textContent='run '+report.runId+' · 생성 '+formatTime(report.generatedAt);
    for(const [key,node] of Object.entries(summaryNodes)){
      const value=report.operatorSummary[key];
      node.textContent=value==null?'—':String(value);
    }

    attention.replaceChildren();
    if(!report.attention.length)attention.append(el('span','ct-attention-chip','주의 신호 없음'));
    for(const code of report.attention){
      const chip=el('span','ct-attention-chip '+(code.includes('BLOCKED')||code.includes('HOLD')||code.includes('NOT_CONFIGURED')?'blocked':''),code);
      attention.append(chip);
    }

    axes.replaceChildren();
    const source=report.axes.sourceObservation;
    const sourceCard=axisCard('원천 관측',source.status,source.coverage);
    addKv(sourceCard,'project',source.projectId);addKv(sourceCard,'database',source.databaseId);
    addKv(sourceCard,'read time',formatTime(source.readTime));addKv(sourceCard,'products',source.products);
    addKv(sourceCard,'policies',source.policies);addKv(sourceCard,'digest',source.digest);axes.append(sourceCard);

    const audit=report.axes.auditFreshness;
    const auditCard=axisCard('감사 신선도',audit.status,audit.reason);
    addKv(auditCard,'정책 설정',audit.configured?'설정됨':'미설정');addKv(auditCard,'현재 관측',formatTime(audit.currentReadTime));
    addKv(auditCard,'이전 관측',audit.previousReadTime?formatTime(audit.previousReadTime):'없음');
    addKv(auditCard,'gap',audit.gapMinutes==null?'—':audit.gapMinutes+'분');
    addKv(auditCard,'max gap',audit.maxGapMinutes==null?'—':audit.maxGapMinutes+'분');axes.append(auditCard);

    const publication=report.axes.publication;
    const pubStatus=publication.activeReleaseAuthorized?'HEALTHY':'BLOCKED';
    const pubCard=axisCard('배포 권한',pubStatus,publication.decision);
    addKv(pubCard,'active release',bool(publication.activeReleaseAuthorized));
    addKv(pubCard,'canonical write',bool(publication.canonicalWriteAuthorized));
    addKv(pubCard,'destructive action',bool(publication.destructiveActionAuthorized));
    addKv(pubCard,'HOLD reasons',publication.holdReasons.length);axes.append(pubCard);

    const health=report.axes.consumerHealth;
    const healthCard=axisCard('소비처 Health',health.status,health.reason??'사유 없음');
    addKv(healthCard,'정책 설정',health.configured?'설정됨':'미설정');
    addKv(healthCard,'생성',health.generatedAt?formatTime(health.generatedAt):'없음');
    if(health.counts){
      addKv(healthCard,'HEALTHY',health.counts.HEALTHY);addKv(healthCard,'DEGRADED',health.counts.DEGRADED);addKv(healthCard,'BLOCKED',health.counts.BLOCKED);
    }
    axes.append(healthCard);

    const readiness=report.axes.consumerReadiness;
    const readyCard=axisCard('Consumer Readiness',readiness.status,readiness.reason??'사유 없음');
    addKv(readyCard,'정책 설정',readiness.configured?'설정됨':'미설정');
    addKv(readyCard,'생성',readiness.generatedAt?formatTime(readiness.generatedAt):'없음');
    if(readiness.counts){
      addKv(readyCard,'ready',readiness.counts.readyForNextStage);addKv(readyCard,'hold',readiness.counts.hold);addKv(readyCard,'final',readiness.counts.final);
    }
    axes.append(readyCard);

    const sheet=report.axes.sheetHealth;
    const sheetCard=axisCard('Sheet Health',sheet.status,sheet.reason??'사유 없음');
    addKv(sheetCard,'정책 설정',sheet.configured?'설정됨':'미설정');
    addKv(sheetCard,'생성',sheet.generatedAt?formatTime(sheet.generatedAt):'없음');axes.append(sheetCard);

    details.replaceChildren();
    const sectionHead=el('div','ct-section-head');sectionHead.append(el('h2','','운영자 확인 항목'),el('span','','계약이 제공한 HOLD/ready 항목'));
    const grid=el('div','ct-grid2');

    const holds=el('div','ct-box');holds.append(el('strong','','Publication HOLD'));
    const holdList=el('ul','ct-list');
    if(!publication.holdReasons.length)holdList.append(el('li','ct-item','전달된 publication HOLD 사유 없음'));
    else for(const reason of publication.holdReasons)holdList.append(el('li','ct-item hold',reason));
    holds.append(holdList);

    const transitions=el('div','ct-box');transitions.append(el('strong','','Ready transitions'));
    const transitionList=el('ul','ct-list');
    const readyTransitions=readiness.readyTransitions??[];
    if(!readyTransitions.length)transitionList.append(el('li','ct-item','전달된 ready transition 없음'));
    else for(const item of readyTransitions){
      const row=el('li','ct-item ready',item.consumerId+' · '+item.from+' → '+item.to);
      transitionList.append(row);
    }
    transitions.append(transitionList);
    grid.append(holds,transitions);details.append(sectionHead,grid);

    status.textContent='Control Tower '+report.attention.length+'개 attention · run '+report.runId;
  }

  async function reload({preserve=true}={}){
    const current=++seq;
    if(typeof read!=='function'){
      report=null;meta.textContent='관측 정보 없음';for(const node of Object.values(summaryNodes))node.textContent='—';
      showState('Control Tower 연결 대기','실제 freepass-data-control-tower-v1 report reader가 연결되기 전에는 운영 상태를 추정하지 않습니다.');
      status.textContent='조회 연결 대기';return;
    }
    root.setAttribute('aria-busy','true');
    if(report&&preserve)status.textContent='직전 Control Tower 유지 · 새 report 조회 중';
    else{showState('Control Tower 조회 중','운영 report를 불러오고 있습니다.');status.textContent='자료 조회 중';}
    try{
      const next=validate(await read());if(disposed||current!==seq)return;report=next;render();
    }catch{
      if(disposed||current!==seq)return;
      if(report&&preserve){render();status.textContent='직전 Control Tower 유지 · 새 조회 실패';}
      else{report=null;showState('Control Tower 조회 실패','조회 실패를 HEALTHY/BLOCKED 판정으로 바꾸지 않습니다.');status.textContent='조회 실패';}
    }finally{if(!disposed&&current===seq)root.setAttribute('aria-busy','false');}
  }

  refresh.addEventListener('click',()=>{void reload({preserve:true});});
  showState('Control Tower 연결 대기','실제 freepass-data-control-tower-v1 report reader가 연결되기 전에는 운영 상태를 추정하지 않습니다.');
  const ready=reload({preserve:false});
  return{ready,refresh:()=>reload({preserve:true}),destroy(){disposed=true;root.replaceChildren();root.classList.remove('ct');}};
}
