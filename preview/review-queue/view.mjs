const CLASSES=['REVIEWABLE','BLOCKED'];
const ENTITY_TYPES=['vehicle_model','vehicle_asset','product','offer'];
const text=value=>typeof value==='string'&&value.trim().length>0;
const invalid=field=>{throw new Error('INVALID_SOURCE_CHANGE_REVIEW_QUEUE:'+field);};
const el=(tag,className,value)=>{const node=document.createElement(tag);if(className)node.className=className;if(value!==undefined)node.textContent=String(value);return node;};

function validateReview(review){
  if(!review||!text(review.bindingId)||!Number.isSafeInteger(review.bindingRevision)||
     !text(review.candidateId)||!text(review.sourceId)||!text(review.sourceRecordId)||
     !text(review.previousFingerprint)||!text(review.candidateFingerprint)||!text(review.sourceRunId)||
     !Number.isSafeInteger(review.vehicleModelRevision)||!Number.isSafeInteger(review.productRevision)||
     !Number.isSafeInteger(review.offerRevision)||!Array.isArray(review.candidateIssues)||
     !Array.isArray(review.diffs)||!Array.isArray(review.reviewableChangeIds)||!Array.isArray(review.blockedChangeIds))invalid('review');
  for(const diff of review.diffs){
    if(!diff||!text(diff.changeId)||!CLASSES.includes(diff.classification)||!ENTITY_TYPES.includes(diff.entityType)||
       !text(diff.entityId)||!text(diff.fieldPath)||!text(diff.reasonCode))invalid('diff');
  }
  return structuredClone(review);
}

function validateSnapshot(input){
  if(!input||!Number.isFinite(Date.parse(input.observedAt))||!Array.isArray(input.reviews))invalid('snapshot');
  const keys=new Set();
  const reviews=input.reviews.map(review=>{
    const checked=validateReview(review);
    const key=checked.bindingId+':'+checked.candidateId;
    if(keys.has(key))invalid('duplicateReview');
    keys.add(key);return checked;
  });
  return {observedAt:input.observedAt,reviews};
}

const formatTime=value=>{
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return '관측 정보 없음';
  return new Intl.DateTimeFormat('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date);
};
const stringify=value=>{
  if(value===undefined)return '미제공';
  if(value===null)return 'null';
  if(typeof value==='string')return value;
  try{return JSON.stringify(value,null,2)}catch{return String(value)}
};

export function mountReviewQueue(root,{read}={}){
  if(!(root instanceof HTMLElement))throw new TypeError('Review Queue root must be HTMLElement');
  root.replaceChildren();root.classList.add('rq');

  let snapshot=null,selectedKey=null,filter='ALL',query='',seq=0,disposed=false;

  const head=el('header','rq-head');
  const title=el('div');title.append(el('h1','','Review Queue'),el('p','','원천 변경 후보의 REVIEWABLE/BLOCKED diff와 근거를 검토합니다.'));
  const observed=el('div','rq-observed','관측 정보 없음');head.append(title,observed);

  const summary=el('section','rq-summary');
  const summaryNodes={};
  for(const [key,label] of [['REVIEWS','검토 건'],['REVIEWABLE','검토 가능 변경'],['BLOCKED','차단 변경'],['ISSUES','후보 이슈']]){
    const box=el('div','rq-stat');box.append(el('span','',label),summaryNodes[key]=el('strong','','—'));summary.append(box);
  }

  const toolbar=el('div','rq-toolbar');
  const search=el('label','rq-search');search.append(el('span','','검토 건 검색'));
  const input=el('input');input.type='search';input.placeholder='source, binding, candidate, reason code';search.append(input);
  const filters=el('div','rq-filters');filters.setAttribute('role','group');filters.setAttribute('aria-label','변경 분류 필터');
  const buttons=[];
  for(const value of ['ALL',...CLASSES]){
    const button=el('button','rq-filter',value==='ALL'?'전체':value==='REVIEWABLE'?'REVIEWABLE':'BLOCKED');
    button.type='button';button.dataset.filter=value;button.setAttribute('aria-pressed',String(value===filter));
    button.addEventListener('click',()=>{filter=value;for(const item of buttons)item.setAttribute('aria-pressed',String(item.dataset.filter===filter));renderList();});
    buttons.push(button);filters.append(button);
  }
  const refresh=el('button','rq-refresh','↻');refresh.type='button';refresh.setAttribute('aria-label','Review Queue 다시 조회');
  toolbar.append(search,filters,refresh);

  const status=el('div','rq-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const layout=el('div','rq-layout');const list=el('section','rq-list');const detail=el('aside','rq-detail');
  detail.id='rq-detail';detail.hidden=true;detail.setAttribute('role','region');layout.append(list,detail);
  root.append(head,summary,toolbar,status,layout);

  const stateSurface=(titleText,message)=>{
    list.replaceChildren();const box=el('div','rq-read-state');box.append(el('strong','',titleText),el('p','',message));list.append(box);
    detail.hidden=true;layout.dataset.inspecting='false';
  };

  const keyOf=review=>review.bindingId+':'+review.candidateId;
  const classificationOf=review=>{
    const blocked=review.blockedChangeIds.length>0;
    const reviewable=review.reviewableChangeIds.length>0;
    if(blocked&&reviewable)return 'MIXED';
    if(blocked)return 'BLOCKED';
    if(reviewable)return 'REVIEWABLE';
    return 'NO_CHANGE';
  };

  function matches(review){
    if(filter==='REVIEWABLE'&&!review.reviewableChangeIds.length)return false;
    if(filter==='BLOCKED'&&!review.blockedChangeIds.length)return false;
    const needle=query.trim().toLocaleLowerCase('ko');
    if(!needle)return true;
    const haystack=[
      review.bindingId,review.candidateId,review.sourceId,review.sourceRecordId,review.sourceRunId,
      ...review.candidateIssues,
      ...review.diffs.flatMap(diff=>[diff.changeId,diff.entityType,diff.entityId,diff.fieldPath,diff.reasonCode,diff.authorityRuleId??''])
    ].join(' ').toLocaleLowerCase('ko');
    return haystack.includes(needle);
  }

  function addKv(parent,label,value){
    const row=el('div','rq-kv');row.append(el('span','',label),el('span','',value??'—'));parent.append(row);
  }

  function closeDetail(){
    const previous=selectedKey;selectedKey=null;detail.hidden=true;layout.dataset.inspecting='false';renderList();
    requestAnimationFrame(()=>{if(previous)root.querySelector('[data-review-key="'+CSS.escape(previous)+'"]')?.focus({preventScroll:true});});
  }

  function renderDetail(review){
    detail.replaceChildren();detail.hidden=false;layout.dataset.inspecting='true';
    const headBox=el('div','rq-detail-head');const headText=el('div');
    const heading=el('h2','',review.sourceId+' · '+review.sourceRecordId);heading.id='rq-detail-heading';heading.tabIndex=-1;
    headText.append(heading,el('div','rq-detail-id','binding '+review.bindingId+' · candidate '+review.candidateId));
    const close=el('button','rq-close','×');close.type='button';close.setAttribute('aria-label','상세 닫기');close.addEventListener('click',closeDetail);
    headBox.append(headText,close);detail.setAttribute('aria-labelledby',heading.id);detail.append(headBox);

    const meta=el('section','rq-section');meta.append(el('h3','','관측 기준'));
    addKv(meta,'source run',review.sourceRunId);addKv(meta,'binding revision','r'+review.bindingRevision);
    addKv(meta,'vehicle model revision','r'+review.vehicleModelRevision);addKv(meta,'product revision','r'+review.productRevision);
    addKv(meta,'offer revision','r'+review.offerRevision);addKv(meta,'vehicle asset revision',review.vehicleAssetRevision==null?'없음':'r'+review.vehicleAssetRevision);
    addKv(meta,'이전 fingerprint',review.previousFingerprint);addKv(meta,'후보 fingerprint',review.candidateFingerprint);detail.append(meta);

    const diffs=el('section','rq-section');diffs.append(el('h3','','변경 diff · '+review.diffs.length+'개'));
    const diffList=el('div','rq-diffs');
    if(!review.diffs.length)diffList.append(el('div','rq-empty','현재 비교 기준에서 변경 diff가 없습니다.'));
    for(const diff of review.diffs){
      const card=el('article','rq-diff');card.dataset.classification=diff.classification;
      const cardHead=el('div','rq-diff-head');cardHead.append(el('div','rq-diff-path',diff.entityType+' · '+diff.fieldPath),el('span','rq-badge '+(diff.classification==='BLOCKED'?'blocked':'reviewable'),diff.classification));
      const values=el('div','rq-diff-values');values.append(el('pre','rq-diff-value',stringify(diff.before)),el('span','rq-arrow','→'),el('pre','rq-diff-value',stringify(diff.after)));
      const reason=el('div','rq-reason');reason.append(el('code','',diff.reasonCode));
      if(diff.authorityRuleId)reason.append(document.createTextNode(' · authority '+diff.authorityRuleId));
      card.append(cardHead,values,reason);diffList.append(card);
    }
    diffs.append(diffList);detail.append(diffs);

    const issues=el('section','rq-section');issues.append(el('h3','','후보 이슈'));
    const issueList=el('ul','rq-issues');
    if(!review.candidateIssues.length)issueList.append(el('li','rq-issue','전달된 candidate issue 없음'));
    else for(const issue of review.candidateIssues)issueList.append(el('li','rq-issue',issue));
    issues.append(issueList);detail.append(issues);

    const back=el('button','rq-mobile-back','목록으로');back.type='button';back.addEventListener('click',closeDetail);detail.append(back);
    requestAnimationFrame(()=>heading.focus({preventScroll:false}));
  }

  function renderList(){
    list.replaceChildren();if(!snapshot)return;
    const rows=snapshot.reviews.filter(matches);
    if(selectedKey&&!rows.some(item=>keyOf(item)===selectedKey)){selectedKey=null;detail.hidden=true;layout.dataset.inspecting='false';}
    status.textContent=rows.length+'건 표시 · 원본 '+snapshot.reviews.length+'건';
    if(!rows.length){list.append(el('div','rq-empty','현재 검색/필터 조건과 일치하는 검토 건이 없습니다.'));return;}
    for(const review of rows){
      const row=el('button','rq-row');row.type='button';const key=keyOf(review);row.dataset.reviewKey=key;row.dataset.selected=String(key===selectedKey);
      row.setAttribute('aria-expanded',String(key===selectedKey));row.setAttribute('aria-controls','rq-detail');
      const main=el('span','rq-row-main');main.append(el('span','rq-row-title',review.sourceId+' · '+review.sourceRecordId),el('span','rq-row-sub',review.bindingId+' · '+review.candidateId),el('span','rq-row-meta','diff '+review.diffs.length+' · issue '+review.candidateIssues.length));
      const side=el('span','rq-row-side');const classification=classificationOf(review);
      const badge=el('span','rq-badge '+(classification==='BLOCKED'?'blocked':classification==='REVIEWABLE'?'reviewable':classification==='MIXED'?'mixed':''),classification);
      side.append(badge,el('span','rq-row-meta','R '+review.reviewableChangeIds.length+' · B '+review.blockedChangeIds.length));
      row.append(main,side);row.addEventListener('click',()=>{selectedKey=key;renderList();renderDetail(review);});list.append(row);
    }
  }

  function renderSnapshot(){
    const reviewable=snapshot.reviews.reduce((n,item)=>n+item.reviewableChangeIds.length,0);
    const blocked=snapshot.reviews.reduce((n,item)=>n+item.blockedChangeIds.length,0);
    const issues=snapshot.reviews.reduce((n,item)=>n+item.candidateIssues.length,0);
    summaryNodes.REVIEWS.textContent=String(snapshot.reviews.length);summaryNodes.REVIEWABLE.textContent=String(reviewable);
    summaryNodes.BLOCKED.textContent=String(blocked);summaryNodes.ISSUES.textContent=String(issues);
    observed.textContent='관측 '+formatTime(snapshot.observedAt);renderList();
  }

  async function reload({preserve=true}={}){
    const current=++seq;
    if(typeof read!=='function'){
      snapshot=null;observed.textContent='관측 정보 없음';for(const node of Object.values(summaryNodes))node.textContent='—';
      stateSurface('Review Queue 연결 대기','실제 SourceChangeReview 목록 reader가 연결되기 전에는 검토 건을 만들거나 추정하지 않습니다.');status.textContent='조회 연결 대기';return;
    }
    root.setAttribute('aria-busy','true');
    if(snapshot&&preserve)status.textContent='직전 Review Queue 표시 · 새 자료 조회 중';
    else{stateSurface('Review Queue 조회 중','실제 SourceChangeReview 목록을 불러오고 있습니다.');status.textContent='자료 조회 중';}
    try{
      const next=validateSnapshot(await read());if(disposed||current!==seq)return;snapshot=next;
      if(selectedKey&&!snapshot.reviews.some(item=>keyOf(item)===selectedKey))selectedKey=null;
      renderSnapshot();
      if(selectedKey){const selected=snapshot.reviews.find(item=>keyOf(item)===selectedKey);if(selected)renderDetail(selected);}
    }catch{
      if(disposed||current!==seq)return;
      if(snapshot&&preserve){renderSnapshot();status.textContent='직전 Review Queue 유지 · 새 조회 실패';}
      else{snapshot=null;stateSurface('Review Queue 조회 실패','조회 실패를 변경 없음이나 승인 가능 상태로 바꾸지 않습니다.');status.textContent='조회 실패';}
    }finally{if(!disposed&&current===seq)root.setAttribute('aria-busy','false');}
  }

  input.addEventListener('input',()=>{query=input.value;renderList();});refresh.addEventListener('click',()=>{void reload({preserve:true});});
  root.addEventListener('keydown',event=>{if(event.key==='Escape'&&selectedKey){event.preventDefault();closeDetail();}});
  stateSurface('Review Queue 연결 대기','실제 SourceChangeReview 목록 reader가 연결되기 전에는 검토 건을 만들거나 추정하지 않습니다.');
  const ready=reload({preserve:false});
  return{ready,refresh:()=>reload({preserve:true}),destroy(){disposed=true;root.replaceChildren();root.classList.remove('rq');}};
}
