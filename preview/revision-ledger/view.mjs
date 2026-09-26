const ENTITY_TYPES=['vehicle_model','vehicle_asset','product','offer','policy'];
const ORIGINS=['CANONICALIZATION','MANUAL_COMMAND','SOURCE_REFRESH','OVERRIDE','ROLLBACK','MIGRATION'];
const text=value=>typeof value==='string'&&value.trim().length>0;
const invalid=field=>{throw new Error('INVALID_REVISION_LEDGER:'+field);};
const el=(tag,className,value)=>{const node=document.createElement(tag);if(className)node.className=className;if(value!==undefined)node.textContent=String(value);return node;};
const stringify=value=>{
  if(value===undefined)return '미제공';
  if(value===null)return 'null';
  if(typeof value==='string')return value;
  try{return JSON.stringify(value,null,2)}catch{return String(value)}
};
const formatTime=value=>{
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return '시각 없음';
  return new Intl.DateTimeFormat('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date);
};

function validateRecord(record){
  if(!record||!text(record.revisionRecordId)||!ENTITY_TYPES.includes(record.entityType)||!text(record.entityId)||
     !Number.isSafeInteger(record.revision)||record.revision<1||
     (record.previousRevision!==null&&(!Number.isSafeInteger(record.previousRevision)||record.previousRevision<1))||
     !record.actor||!text(record.actor.id)||!['USER','SERVICE'].includes(record.actor.kind)||
     !text(record.reason)||!ORIGINS.includes(record.origin)||!text(record.commandId)||
     !Number.isFinite(Date.parse(record.occurredAt)))invalid('record');
  if(record.sourceBindingId!=null&&!text(record.sourceBindingId))invalid('sourceBindingId');
  if(record.sourceRunId!=null&&!text(record.sourceRunId))invalid('sourceRunId');
  return structuredClone(record);
}
function validateSnapshot(input){
  if(!input||!Number.isFinite(Date.parse(input.observedAt))||!Array.isArray(input.revisions))invalid('snapshot');
  const ids=new Set();const revisions=input.revisions.map(item=>{
    const checked=validateRecord(item);if(ids.has(checked.revisionRecordId))invalid('duplicateRevision');ids.add(checked.revisionRecordId);return checked;
  });
  return {observedAt:input.observedAt,revisions};
}

export function mountRevisionLedger(root,{read}={}){
  if(!(root instanceof HTMLElement))throw new TypeError('Revision Ledger root must be HTMLElement');
  root.replaceChildren();root.classList.add('rl');

  let snapshot=null,selectedId=null,filter='ALL',query='',seq=0,disposed=false;

  const head=el('header','rl-head');const title=el('div');
  title.append(el('h1','','Revision Ledger'),el('p','','Canonical entity revision이 언제, 왜, 어떤 command로 만들어졌는지 추적합니다.'));
  const meta=el('div','rl-meta','관측 정보 없음');head.append(title,meta);

  const summary=el('section','rl-summary');const stats={};
  for(const [key,label] of [['TOTAL','전체 revision'],['product','상품'],['offer','오퍼'],['vehicle_model','차종'],['vehicle_asset','실차']]){
    const box=el('div','rl-stat');box.append(el('span','',label),stats[key]=el('strong','','—'));summary.append(box);
  }

  const toolbar=el('div','rl-toolbar');
  const search=el('label','rl-search');search.append(el('span','','revision 검색'));
  const input=el('input');input.type='search';input.placeholder='entity, command, actor, reason, source';search.append(input);
  const filters=el('div','rl-filters');filters.setAttribute('role','group');filters.setAttribute('aria-label','entity type 필터');
  const filterButtons=[];
  for(const type of ['ALL',...ENTITY_TYPES]){
    const button=el('button','rl-filter',type==='ALL'?'전체':type);button.type='button';button.dataset.filter=type;button.setAttribute('aria-pressed',String(type===filter));
    button.addEventListener('click',()=>{filter=type;for(const item of filterButtons)item.setAttribute('aria-pressed',String(item.dataset.filter===filter));renderList();});
    filterButtons.push(button);filters.append(button);
  }
  const refresh=el('button','rl-refresh','↻');refresh.type='button';refresh.setAttribute('aria-label','Revision Ledger 다시 조회');
  toolbar.append(search,filters,refresh);

  const status=el('div','rl-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const layout=el('div','rl-layout');const list=el('section','rl-list');const detail=el('aside','rl-detail');
  detail.id='rl-detail';detail.hidden=true;detail.setAttribute('role','region');layout.append(list,detail);
  root.append(head,summary,toolbar,status,layout);

  const stateSurface=(titleText,message)=>{
    list.replaceChildren();const box=el('div','rl-read-state');box.append(el('strong','',titleText),el('p','',message));list.append(box);
    detail.hidden=true;layout.dataset.inspecting='false';
  };

  function matches(record){
    if(filter!=='ALL'&&record.entityType!==filter)return false;
    const needle=query.trim().toLocaleLowerCase('ko');if(!needle)return true;
    return [
      record.revisionRecordId,record.entityType,record.entityId,record.origin,record.commandId,
      record.actor.id,record.actor.kind,record.reason,record.sourceBindingId??'',record.sourceRunId??''
    ].join(' ').toLocaleLowerCase('ko').includes(needle);
  }

  function addKv(parent,label,value){
    const row=el('div','rl-kv');row.append(el('span','',label),el('span','',value??'—'));parent.append(row);
  }

  function closeDetail(){
    const previous=selectedId;selectedId=null;detail.hidden=true;layout.dataset.inspecting='false';renderList();
    requestAnimationFrame(()=>{if(previous)root.querySelector('[data-revision-id="'+CSS.escape(previous)+'"]')?.focus({preventScroll:true});});
  }

  function renderDetail(record){
    detail.replaceChildren();detail.hidden=false;layout.dataset.inspecting='true';
    const headBox=el('div','rl-detail-head');const headText=el('div');
    const heading=el('h2','',record.entityType+' · '+record.entityId);heading.id='rl-detail-heading';heading.tabIndex=-1;
    headText.append(heading,el('div','rl-detail-id',record.revisionRecordId));
    const close=el('button','rl-close','×');close.type='button';close.setAttribute('aria-label','상세 닫기');close.addEventListener('click',closeDetail);
    headBox.append(headText,close);detail.setAttribute('aria-labelledby',heading.id);detail.append(headBox);

    const revision=el('section','rl-section');revision.append(el('h3','','Revision'));
    const chain=el('div','rl-chain');
    if(record.previousRevision!==null)chain.append(el('span','rl-revision','r'+record.previousRevision),el('span','','→'));
    chain.append(el('span','rl-revision','r'+record.revision));revision.append(chain);
    addKv(revision,'origin',record.origin);addKv(revision,'reason',record.reason);addKv(revision,'occurredAt',formatTime(record.occurredAt));detail.append(revision);

    const command=el('section','rl-section');command.append(el('h3','','Command / Actor'));
    addKv(command,'commandId',record.commandId);addKv(command,'actor',record.actor.kind+' · '+record.actor.id);
    if(record.actor.organizationId)addKv(command,'organization',record.actor.organizationId);
    addKv(command,'source binding',record.sourceBindingId??'없음');addKv(command,'source run',record.sourceRunId??'없음');detail.append(command);

    const snapshotBox=el('section','rl-section');snapshotBox.append(el('h3','','Revision snapshot'),el('pre','rl-json',stringify(record.snapshot)));detail.append(snapshotBox);
    const back=el('button','rl-mobile-back','목록으로');back.type='button';back.addEventListener('click',closeDetail);detail.append(back);
    requestAnimationFrame(()=>heading.focus({preventScroll:false}));
  }

  function renderList(){
    list.replaceChildren();if(!snapshot)return;
    const rows=snapshot.revisions.filter(matches);
    if(selectedId&&!rows.some(item=>item.revisionRecordId===selectedId)){selectedId=null;detail.hidden=true;layout.dataset.inspecting='false';}
    status.textContent=rows.length+'개 revision 표시 · reader 순서 유지';
    if(!rows.length){list.append(el('div','rl-empty','현재 검색/필터 조건과 일치하는 revision이 없습니다.'));return;}
    for(const record of rows){
      const row=el('button','rl-row');row.type='button';row.dataset.revisionId=record.revisionRecordId;row.dataset.selected=String(record.revisionRecordId===selectedId);
      row.setAttribute('aria-expanded',String(record.revisionRecordId===selectedId));row.setAttribute('aria-controls','rl-detail');
      const main=el('span','rl-row-main');
      main.append(
        el('span','rl-row-title',record.entityType+' · '+record.entityId+' · r'+record.revision),
        el('span','rl-row-sub',record.reason),
        el('span','rl-row-meta',record.commandId+' · '+record.actor.id+' · '+formatTime(record.occurredAt)),
      );
      const side=el('span','rl-row-side');side.append(el('span','rl-badge rl-origin-'+record.origin,record.origin),el('span','rl-row-meta',record.previousRevision===null?'초기 revision':'r'+record.previousRevision+' → r'+record.revision));
      row.append(main,side);row.addEventListener('click',()=>{selectedId=record.revisionRecordId;renderList();renderDetail(record);});list.append(row);
    }
  }

  function renderSnapshot(){
    stats.TOTAL.textContent=String(snapshot.revisions.length);
    for(const key of ['product','offer','vehicle_model','vehicle_asset'])stats[key].textContent=String(snapshot.revisions.filter(item=>item.entityType===key).length);
    meta.textContent='관측 '+formatTime(snapshot.observedAt);renderList();
  }

  async function reload({preserve=true}={}){
    const current=++seq;
    if(typeof read!=='function'){
      snapshot=null;meta.textContent='관측 정보 없음';for(const node of Object.values(stats))node.textContent='—';
      stateSurface('Revision Ledger 연결 대기','실제 EntityRevisionRecord reader가 연결되기 전에는 revision 이력을 추정하거나 생성하지 않습니다.');
      status.textContent='조회 연결 대기';return;
    }
    root.setAttribute('aria-busy','true');
    if(snapshot&&preserve)status.textContent='직전 Revision Ledger 유지 · 새 자료 조회 중';
    else{stateSurface('Revision Ledger 조회 중','EntityRevisionRecord 목록을 불러오고 있습니다.');status.textContent='자료 조회 중';}
    try{
      const next=validateSnapshot(await read());if(disposed||current!==seq)return;snapshot=next;
      if(selectedId&&!snapshot.revisions.some(item=>item.revisionRecordId===selectedId))selectedId=null;
      renderSnapshot();if(selectedId){const selected=snapshot.revisions.find(item=>item.revisionRecordId===selectedId);if(selected)renderDetail(selected);}
    }catch{
      if(disposed||current!==seq)return;
      if(snapshot&&preserve){renderSnapshot();status.textContent='직전 Revision Ledger 유지 · 새 조회 실패';}
      else{snapshot=null;stateSurface('Revision Ledger 조회 실패','조회 실패를 revision 없음으로 바꾸지 않습니다.');status.textContent='조회 실패';}
    }finally{if(!disposed&&current===seq)root.setAttribute('aria-busy','false');}
  }

  input.addEventListener('input',()=>{query=input.value;renderList();});refresh.addEventListener('click',()=>{void reload({preserve:true});});
  root.addEventListener('keydown',event=>{if(event.key==='Escape'&&selectedId){event.preventDefault();closeDetail();}});
  stateSurface('Revision Ledger 연결 대기','실제 EntityRevisionRecord reader가 연결되기 전에는 revision 이력을 추정하거나 생성하지 않습니다.');
  const ready=reload({preserve:false});
  return{ready,refresh:()=>reload({preserve:true}),destroy(){disposed=true;root.replaceChildren();root.classList.remove('rl');}};
}
