const CONTRACT='consumer-health-v1';
const SCHEMA='1.0.0';
const STATUSES=['HEALTHY','DEGRADED','BLOCKED'];
const STAGES=['LEGACY_DIRECT','OBSERVE','SHADOW_READ','PARITY_VERIFIED','FREEPASS_DATA_READ'];
const SOURCES=['GATEWAY_RUNTIME','SHEET_DELIVERY','WHITELABEL_AGGREGATE','NOT_IMPLEMENTED'];

const el=(tag,className,text)=>{
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined)node.textContent=String(text);
  return node;
};
const hasText=value=>typeof value==='string'&&value.trim().length>0;
const invalid=field=>{throw new Error('INVALID_CONSUMER_HEALTH_UI:'+field);};

function validate(report){
  if(!report||report.contractVersion!==CONTRACT||report.schemaVersion!==SCHEMA)invalid('contract');
  if(!Number.isFinite(Date.parse(report.generatedAt)))invalid('generatedAt');
  if(!STATUSES.includes(report.status))invalid('status');
  if(!report.policy||!Number.isSafeInteger(report.policy.maxAgeMs)||report.policy.maxAgeMs<1||
     !Number.isSafeInteger(report.policy.maxFutureSkewMs)||report.policy.maxFutureSkewMs<0||
     !Number.isSafeInteger(report.policy.eventLimit)||report.policy.eventLimit<1)invalid('policy');
  if(!Array.isArray(report.consumers)||!report.consumers.length)invalid('consumers');
  const ids=new Set();
  for(const item of report.consumers){
    if(!item||!hasText(item.consumerId)||ids.has(item.consumerId)||!hasText(item.project)||
       !hasText(item.repository)||!Array.isArray(item.domains)||!item.domains.length||
       !STATUSES.includes(item.status)||!STAGES.includes(item.currentStage)||
       (item.nextStage!==null&&!STAGES.includes(item.nextStage))||
       !hasText(item.activeReadOwner)||item.targetReadOwner!=='freepass-data'||
       !hasText(item.switchKey)||!Array.isArray(item.blockers)||!Array.isArray(item.staticHoldReasons))invalid('consumer');
    ids.add(item.consumerId);
    const e=item.evidence;
    if(!e||!SOURCES.includes(e.source)||!hasText(e.state)||
       (e.observedAt!==null&&!Number.isFinite(Date.parse(e.observedAt)))||
       (e.ageMs!==null&&(!Number.isSafeInteger(e.ageMs)||e.ageMs<0))||
       ['authenticated','freepassReadVerified','productionReadbackVerified','parityVerified','fallbackVerified']
         .some(key=>typeof e[key]!=='boolean'))invalid('evidence');
    if(item.nextTransition!==null){
      const n=item.nextTransition;
      if(typeof n.allowed!=='boolean'||!STAGES.includes(n.from)||!STAGES.includes(n.to)||!Array.isArray(n.blockers))invalid('transition');
    }
  }
  return structuredClone(report);
}

const statusLabel=status=>({
  HEALTHY:'정상',
  DEGRADED:'주의',
  BLOCKED:'차단',
}[status]??status);

const sourceLabel=source=>({
  GATEWAY_RUNTIME:'Gateway runtime',
  SHEET_DELIVERY:'Sheet delivery',
  WHITELABEL_AGGREGATE:'White Label aggregate',
  NOT_IMPLEMENTED:'미구현',
}[source]??source);

const formatTime=value=>{
  if(!value)return '관측 없음';
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return '관측 없음';
  return new Intl.DateTimeFormat('ko-KR',{
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'
  }).format(date);
};

const formatAge=value=>{
  if(value==null)return '신선도 근거 없음';
  const min=Math.floor(value/60000);
  if(min<1)return '1분 미만';
  if(min<60)return min+'분';
  const hour=Math.floor(min/60);
  if(hour<24)return hour+'시간 '+(min%60)+'분';
  return Math.floor(hour/24)+'일 '+(hour%24)+'시간';
};

export function mountDataHealth(root,{read}={}){
  if(!(root instanceof HTMLElement))throw new TypeError('Data Health root must be HTMLElement');
  root.replaceChildren();
  root.classList.add('dh');

  let report=null;
  let selectedId=null;
  let filter='ALL';
  let query='';
  let seq=0;
  let disposed=false;

  const head=el('header','dh-head');
  const title=el('div');
  title.append(el('h1','', 'Data Health'),el('p','', '소비처별 실제 읽기 증거·신선도·전환 차단 상태를 확인합니다.'));
  const overall=el('div','dh-overall');
  const overallBadge=el('span','dh-badge','연결 대기');
  const generated=el('span','dh-generated','관측 정보 없음');
  overall.append(overallBadge,generated);
  head.append(title,overall);

  const summary=el('section','dh-summary');
  const summaryNodes={};
  for(const [key,label] of [['TOTAL','전체'],['HEALTHY','정상'],['DEGRADED','주의'],['BLOCKED','차단']]){
    const box=el('div','dh-stat');
    box.append(el('span','',label),summaryNodes[key]=el('strong','','—'));
    summary.append(box);
  }

  const toolbar=el('div','dh-toolbar');
  const search=el('label','dh-search');
  const searchLabel=el('span','','소비처 검색');
  const input=el('input');
  input.type='search';input.placeholder='소비처, 프로젝트, 저장소';
  search.append(searchLabel,input);
  const filters=el('div','dh-filters');
  filters.setAttribute('role','group');filters.setAttribute('aria-label','상태 필터');
  const filterButtons=[];
  for(const value of ['ALL',...STATUSES]){
    const button=el('button','dh-filter',value==='ALL'?'전체':statusLabel(value));
    button.type='button';button.dataset.filter=value;
    button.setAttribute('aria-pressed',String(value===filter));
    button.addEventListener('click',()=>{
      filter=value;
      for(const item of filterButtons)item.setAttribute('aria-pressed',String(item.dataset.filter===filter));
      renderList();
    });
    filterButtons.push(button);filters.append(button);
  }
  const refreshButton=el('button','dh-refresh','↻');
  refreshButton.type='button';
  refreshButton.setAttribute('aria-label','Data Health 다시 조회');
  toolbar.append(search,filters,refreshButton);

  const status=el('div','dh-status');
  status.setAttribute('role','status');status.setAttribute('aria-live','polite');

  const layout=el('div','dh-layout');
  const list=el('section','dh-list');
  const detail=el('aside','dh-detail');detail.id='dh-detail';detail.hidden=true;detail.setAttribute('role','region');
  layout.append(list,detail);
  root.append(head,summary,toolbar,status,layout);

  const stateSurface=(titleText,message)=>{
    list.replaceChildren();
    const box=el('div','dh-read-state');
    box.append(el('strong','',titleText),el('p','',message));
    list.append(box);
    detail.hidden=true;layout.dataset.inspecting='false';
  };

  function matching(){
    if(!report)return[];
    const needle=query.trim().toLocaleLowerCase('ko');
    return report.consumers.filter(item=>{
      if(filter!=='ALL'&&item.status!==filter)return false;
      if(!needle)return true;
      return [item.consumerId,item.project,item.repository,...item.domains]
        .join(' ').toLocaleLowerCase('ko').includes(needle);
    });
  }

  function addKv(parent,label,value){
    const row=el('div','dh-kv');
    row.append(el('span','',label),el('span','',value??'—'));
    parent.append(row);
  }

  function renderDetail(item){
    detail.replaceChildren();detail.hidden=false;layout.dataset.inspecting='true';
    const headBox=el('div','dh-detail-head');
    const headText=el('div');
    const heading=el('h2','',item.project);heading.id='dh-detail-heading';heading.tabIndex=-1;
    headText.append(heading,el('div','dh-detail-id',item.consumerId+' · '+item.repository));
    const close=el('button','dh-close','×');close.type='button';close.setAttribute('aria-label','상세 닫기');
    close.addEventListener('click',()=>closeDetail());
    headBox.append(headText,close);
    detail.setAttribute('aria-labelledby',heading.id);
    detail.append(headBox);

    const stage=el('section','dh-section');stage.append(el('h3','','전환 상태'));
    addKv(stage,'현재 단계',item.currentStage);
    addKv(stage,'다음 단계',item.nextStage??'없음');
    addKv(stage,'활성 read owner',item.activeReadOwner);
    addKv(stage,'목표 read owner',item.targetReadOwner);
    addKv(stage,'switch key',item.switchKey);
    addKv(stage,'다음 전환',item.nextTransition?((item.nextTransition.allowed?'허용':'차단')+' · '+item.nextTransition.from+' → '+item.nextTransition.to):'판정 없음');
    detail.append(stage);

    const evidence=el('section','dh-section');evidence.append(el('h3','','관측 증거'));
    addKv(evidence,'증거 원천',sourceLabel(item.evidence.source));
    addKv(evidence,'원천 상태',item.evidence.state);
    addKv(evidence,'관측 시각',formatTime(item.evidence.observedAt));
    addKv(evidence,'경과',formatAge(item.evidence.ageMs));
    addKv(evidence,'release authority',item.evidence.releaseAuthority??'없음');
    for(const [label,key] of [['event ID','eventId'],['receipt ID','receiptId'],['projection ID','projectionId'],['release ID','releaseId'],['manifest ID','manifestId']]){
      if(item.evidence[key])evidence.append(el('code','dh-evidence-id',label+' · '+item.evidence[key]));
    }
    detail.append(evidence);

    const checks=el('section','dh-section');checks.append(el('h3','','검증 상태'));
    const grid=el('div','dh-checks');
    for(const [label,key] of [
      ['인증','authenticated'],
      ['FreePass read','freepassReadVerified'],
      ['운영 readback','productionReadbackVerified'],
      ['Parity','parityVerified'],
      ['Fallback','fallbackVerified'],
    ]){
      const row=el('div','dh-check');const value=Boolean(item.evidence[key]);
      const mark=el('b','',value?'확인':'미확인');mark.dataset.ok=String(value);
      row.append(el('span','',label),mark);grid.append(row);
    }
    checks.append(grid);detail.append(checks);

    const blockers=el('section','dh-section');blockers.append(el('h3','','차단·HOLD 근거'));
    const listBox=el('ul','dh-blockers');
    if(!item.blockers.length&&!item.staticHoldReasons.length){
      listBox.append(el('li','dh-blocker','현재 전달된 blocker 없음'));
    }else{
      for(const reason of item.blockers)listBox.append(el('li','dh-blocker',reason));
      for(const reason of item.staticHoldReasons)listBox.append(el('li','dh-blocker dh-hold','정적 HOLD · '+reason));
    }
    blockers.append(listBox);detail.append(blockers);

    const back=el('button','dh-mobile-back','목록으로');back.type='button';back.addEventListener('click',()=>closeDetail());
    detail.append(back);
    requestAnimationFrame(()=>heading.focus({preventScroll:false}));
  }

  function closeDetail(){
    const previous=selectedId;
    selectedId=null;detail.hidden=true;layout.dataset.inspecting='false';
    renderList();
    requestAnimationFrame(()=>{
      if(previous)root.querySelector('[data-consumer-id="'+CSS.escape(previous)+'"]')?.focus({preventScroll:true});
    });
  }

  function renderList(){
    list.replaceChildren();
    if(!report)return;
    const rows=matching();
    if(selectedId&&!rows.some(item=>item.consumerId===selectedId)){
      selectedId=null;
      detail.hidden=true;
      layout.dataset.inspecting='false';
    }
    status.textContent=rows.length+'개 소비처 표시 · 전체 상태 '+report.status;
    if(!rows.length){
      list.append(el('div','dh-empty','현재 검색/필터 조건과 일치하는 소비처가 없습니다.'));
      return;
    }
    for(const item of rows){
      const row=el('button','dh-row');row.type='button';row.dataset.consumerId=item.consumerId;
      row.dataset.selected=String(item.consumerId===selectedId);
      row.setAttribute('aria-expanded',String(item.consumerId===selectedId));
      row.setAttribute('aria-controls','dh-detail');
      const main=el('span','dh-row-main');
      main.append(
        el('span','dh-row-title',item.project),
        el('span','dh-row-sub',item.consumerId+' · '+item.repository),
        el('span','dh-row-stage',item.currentStage+(item.nextStage?' → '+item.nextStage:'')),
      );
      const side=el('span','dh-row-state');
      const badge=el('span','dh-badge',statusLabel(item.status));badge.dataset.status=item.status;
      side.append(badge,el('span','dh-row-stage',sourceLabel(item.evidence.source)+' · '+item.evidence.state));
      row.append(main,side);
      row.addEventListener('click',()=>{selectedId=item.consumerId;renderList();renderDetail(item);});
      list.append(row);
    }
  }

  function renderReport(){
    const counts=Object.fromEntries(STATUSES.map(key=>[key,report.consumers.filter(item=>item.status===key).length]));
    summaryNodes.TOTAL.textContent=String(report.consumers.length);
    for(const key of STATUSES)summaryNodes[key].textContent=String(counts[key]);
    overallBadge.textContent=statusLabel(report.status);overallBadge.dataset.status=report.status;
    generated.textContent='생성 '+formatTime(report.generatedAt);
    renderList();
  }

  async function refresh({preserve=true}={}){
    const current=++seq;
    if(typeof read!=='function'){
      report=null;
      overallBadge.textContent='연결 대기';delete overallBadge.dataset.status;
      generated.textContent='관측 정보 없음';
      for(const node of Object.values(summaryNodes))node.textContent='—';
      stateSurface('Consumer Health 연결 대기','실제 consumer-health-v1 read adapter가 연결되기 전에는 상태를 추정하지 않습니다.');
      status.textContent='조회 연결 대기';
      return;
    }
    root.setAttribute('aria-busy','true');
    if(report&&preserve){
      status.textContent='직전 Consumer Health 표시 · 새 관측 조회 중';
    }else{
      stateSurface('Consumer Health 조회 중','실제 health 계약을 불러오고 있습니다.');
      status.textContent='자료 조회 중';
    }
    try{
      const next=validate(await read());
      if(disposed||current!==seq)return;
      report=next;
      if(selectedId&&!report.consumers.some(item=>item.consumerId===selectedId))selectedId=null;
      renderReport();
      if(selectedId){
        const selected=report.consumers.find(item=>item.consumerId===selectedId);
        if(selected)renderDetail(selected);
      }
    }catch{
      if(disposed||current!==seq)return;
      if(report&&preserve){
        renderReport();status.textContent='직전 Consumer Health 유지 · 새 조회 실패';
      }else{
        report=null;stateSurface('Consumer Health 조회 실패','실패를 HEALTHY/BLOCKED 판정으로 바꾸지 않습니다.');status.textContent='조회 실패';
      }
    }finally{
      if(!disposed&&current===seq)root.setAttribute('aria-busy','false');
    }
  }

  input.addEventListener('input',()=>{query=input.value;renderList();});
  refreshButton.addEventListener('click',()=>{void refresh({preserve:true});});
  root.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&selectedId){event.preventDefault();closeDetail();}
  });

  stateSurface('Consumer Health 연결 대기','실제 consumer-health-v1 read adapter가 연결되기 전에는 상태를 추정하지 않습니다.');
  const ready=refresh({preserve:false});
  return{ready,refresh:()=>refresh({preserve:true}),destroy(){disposed=true;root.replaceChildren();root.classList.remove('dh');}};
}
