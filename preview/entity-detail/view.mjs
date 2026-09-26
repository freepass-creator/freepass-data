const STAGES=['SOURCE','RAW','NORMALIZED','CANONICAL','PROJECTION','RELEASE','CONSUMER'];
const STATUSES=['OK','HOLD','LOCAL_ONLY'];
const ORIGINS=['SOURCE_LINEAGE','REVISION_HISTORY'];
const MODES=['SOURCE','COMMAND_CHANGED','REVISION_CARRIED','NO_SOURCE'];
const ENTITY_TYPES=['vehicle_model','vehicle_asset','product','offer'];

const text=value=>typeof value==='string'&&value.trim().length>0;
const invalid=field=>{throw new Error('INVALID_CATALOG_PRODUCT_TRACE:'+field);};
const el=(tag,className,value)=>{const node=document.createElement(tag);if(className)node.className=className;if(value!==undefined)node.textContent=String(value);return node;};
const stringify=value=>{
  if(value===undefined)return '미제공';
  if(value===null)return 'null';
  if(typeof value==='string')return value;
  try{return JSON.stringify(value,null,2)}catch{return String(value)}
};

function validate(trace){
  if(!trace||!text(trace.productId)||!Number.isFinite(Date.parse(trace.generatedAt))||
     !Array.isArray(trace.rows)||!Array.isArray(trace.fieldFlows)||!trace.counts)invalid('root');
  for(const row of trace.rows){
    if(!row||!STAGES.includes(row.stage)||!STATUSES.includes(row.status)||!text(row.title)||
       !text(row.summary)||!text(row.evidence))invalid('row');
  }
  for(const flow of trace.fieldFlows){
    if(!flow||!text(flow.field)||!text(flow.label)||!ORIGINS.includes(flow.origin)||
       !flow.adapter||!MODES.includes(flow.adapter.mode)||!text(flow.adapter.transformId)||
       !text(flow.adapter.transformVersion)||!text(flow.adapter.decision)||
       !flow.canonical||!ENTITY_TYPES.includes(flow.canonical.entityType)||!text(flow.canonical.entityId)||
       !Number.isSafeInteger(flow.canonical.revision)||!text(flow.canonical.fieldPath)||
       !flow.projection||!text(flow.projection.fieldPath)||!flow.consumer||
       !text(flow.consumer.name)||!text(flow.consumer.location))invalid('fieldFlow');
    if(flow.raw!==null&&(!text(flow.raw.fieldPath)))invalid('raw');
    if(flow.adapter.normalizedFieldPath!==null&&!text(flow.adapter.normalizedFieldPath))invalid('normalized');
  }
  const countKeys=['sources','rawRecords','candidates','canonicalEntities','projectionFields','releases','connectedConsumers'];
  if(countKeys.some(key=>!Number.isSafeInteger(trace.counts[key])||trace.counts[key]<0))invalid('counts');
  return structuredClone(trace);
}

const formatTime=value=>{
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return '생성 정보 없음';
  return new Intl.DateTimeFormat('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date);
};

export function mountEntityDetail(root,{read,initialProductId=''}={}){
  if(!(root instanceof HTMLElement))throw new TypeError('Entity Detail root must be HTMLElement');
  root.replaceChildren();root.classList.add('ed');

  let trace=null,selectedKind=null,selectedIndex=null,query='',seq=0,disposed=false;

  const head=el('header','ed-head');const title=el('div');
  title.append(el('h1','','Entity Detail'),el('p','','한 상품의 SOURCE → RAW → NORMALIZED → CANONICAL → PROJECTION → CONSUMER lineage를 추적합니다.'));
  const generated=el('div','ed-generated','생성 정보 없음');head.append(title,generated);

  const queryBox=el('form','ed-query');const input=el('input');input.name='productId';input.placeholder='productId 입력';input.value=initialProductId;
  input.setAttribute('aria-label','productId');
  const load=el('button','ed-action','조회');load.type='submit';
  const refresh=el('button','ed-action secondary ed-refresh','다시 조회');refresh.type='button';
  queryBox.append(input,load,refresh);

  const summary=el('section','ed-summary');const summaryNodes={};
  for(const [key,label] of [['sources','원천'],['rawRecords','RAW'],['candidates','정규화'],['canonicalEntities','정본'],['projectionFields','Projection 필드'],['releases','Release'],['connectedConsumers','운영 사용처']]){
    const box=el('div','ed-stat');box.append(el('span','',label),summaryNodes[key]=el('strong','','—'));summary.append(box);
  }

  const status=el('div','ed-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');

  const layout=el('div','ed-layout');
  const stageSection=el('section','ed-stage-section');const stageHead=el('div','ed-section-head');
  stageHead.append(el('h2','','Stage Trace'),el('span','','계약이 반환한 stage/status 그대로'));
  const stageList=el('div','ed-stage-list');stageSection.append(stageHead,stageList);

  const flowSection=el('section','ed-flow-section');const flowHead=el('div','ed-section-head');
  flowHead.append(el('h2','','Field Lineage'),el('span','','RAW → 정규화 → Canonical → Projection → Consumer'));
  const flowToolbar=el('div','ed-flow-toolbar');const search=el('label','ed-search');search.append(el('span','','필드 검색'));
  const searchInput=el('input');searchInput.type='search';searchInput.placeholder='필드명, 경로, entity, origin';search.append(searchInput);flowToolbar.append(search);
  const flowList=el('div','ed-flow-list');flowSection.append(flowHead,flowToolbar,flowList);

  const detail=el('aside','ed-detail');detail.id='ed-detail';detail.hidden=true;detail.setAttribute('role','region');
  layout.append(stageSection,flowSection,detail);root.append(head,queryBox,summary,status,layout);

  const stateSurface=(titleText,message)=>{
    stageList.replaceChildren();flowList.replaceChildren();
    const stageState=el('div','ed-read-state');stageState.append(el('strong','',titleText),el('p','',message));stageList.append(stageState);
    flowList.append(el('div','ed-empty',message));detail.hidden=true;layout.dataset.inspecting='false';
  };

  function resetSummary(){
    for(const node of Object.values(summaryNodes))node.textContent='—';
    generated.textContent='생성 정보 없음';
  }

  function closeDetail(){
    const kind=selectedKind,index=selectedIndex;selectedKind=null;selectedIndex=null;detail.hidden=true;layout.dataset.inspecting='false';
    renderAll();
    requestAnimationFrame(()=>{
      if(kind==='row')root.querySelector('[data-stage-index="'+index+'"]')?.focus({preventScroll:true});
      if(kind==='flow')root.querySelector('[data-flow-index="'+index+'"]')?.focus({preventScroll:true});
    });
  }

  function addKv(parent,label,value){
    const row=el('div','ed-kv');row.append(el('span','',label),el('span','',value??'—'));parent.append(row);
  }

  function renderStageDetail(row,index){
    selectedKind='row';selectedIndex=index;detail.replaceChildren();detail.hidden=false;layout.dataset.inspecting='true';
    const headBox=el('div','ed-detail-head');const headText=el('div');
    const heading=el('h2','',row.stage+' · '+row.title);heading.id='ed-detail-heading';heading.tabIndex=-1;
    headText.append(heading,el('div','ed-detail-id',row.evidence));
    const close=el('button','ed-close','×');close.type='button';close.setAttribute('aria-label','상세 닫기');close.addEventListener('click',closeDetail);
    headBox.append(headText,close);detail.setAttribute('aria-labelledby',heading.id);detail.append(headBox);
    const meta=el('section','ed-section');meta.append(el('h3','','Stage 상태'));
    addKv(meta,'stage',row.stage);addKv(meta,'status',row.status);addKv(meta,'summary',row.summary);detail.append(meta);
    const raw=el('section','ed-section');raw.append(el('h3','','details'),el('pre','ed-json',stringify(row.details)));detail.append(raw);
    const back=el('button','ed-mobile-back','목록으로');back.type='button';back.addEventListener('click',closeDetail);detail.append(back);
    requestAnimationFrame(()=>heading.focus({preventScroll:false}));
  }

  function renderFlowDetail(flow,index){
    selectedKind='flow';selectedIndex=index;detail.replaceChildren();detail.hidden=false;layout.dataset.inspecting='true';
    const headBox=el('div','ed-detail-head');const headText=el('div');
    const heading=el('h2','',flow.label);heading.id='ed-detail-heading';heading.tabIndex=-1;
    headText.append(heading,el('div','ed-detail-id',flow.field+' · '+flow.origin+' · '+flow.adapter.mode));
    const close=el('button','ed-close','×');close.type='button';close.setAttribute('aria-label','상세 닫기');close.addEventListener('click',closeDetail);
    headBox.append(headText,close);detail.setAttribute('aria-labelledby',heading.id);detail.append(headBox);

    const chain=el('div','ed-chain');
    const raw=el('div','ed-chain-card');raw.append(el('strong','','RAW'),el('code','',flow.raw?.fieldPath??'원천 연결 없음'),el('pre','',stringify(flow.raw?.value)));
    const normalized=el('div','ed-chain-card');normalized.append(el('strong','','NORMALIZED'),el('code','',flow.adapter.normalizedFieldPath??'정제 경로 없음'),el('pre','',stringify(flow.adapter.normalizedValue)));
    const canonical=el('div','ed-chain-card');canonical.append(el('strong','','CANONICAL'),el('code','',flow.canonical.entityType+' '+flow.canonical.entityId+' r'+flow.canonical.revision+' · '+flow.canonical.fieldPath),el('pre','',stringify(flow.canonical.value)));
    const projection=el('div','ed-chain-card');projection.append(el('strong','','PROJECTION'),el('code','',flow.projection.fieldPath),el('pre','',stringify(flow.projection.value)));
    const consumer=el('div','ed-chain-card');consumer.append(el('strong','','CONSUMER'),el('code','',flow.consumer.name+' · '+flow.consumer.location),el('pre','',stringify(flow.consumer.value)));
    chain.append(raw,normalized,canonical,projection,consumer);detail.append(chain);

    const adapter=el('section','ed-section');adapter.append(el('h3','','Adapter / revision decision'));
    addKv(adapter,'transform',flow.adapter.transformId+'@'+flow.adapter.transformVersion);
    addKv(adapter,'mode',flow.adapter.mode);addKv(adapter,'origin',flow.origin);addKv(adapter,'decision',flow.adapter.decision);detail.append(adapter);
    const back=el('button','ed-mobile-back','목록으로');back.type='button';back.addEventListener('click',closeDetail);detail.append(back);
    requestAnimationFrame(()=>heading.focus({preventScroll:false}));
  }

  function matchingFlows(){
    if(!trace)return[];
    const needle=query.trim().toLocaleLowerCase('ko');
    return trace.fieldFlows
      .map((flow,index)=>({flow,index}))
      .filter(({flow})=>{
        if(!needle)return true;
        return [flow.label,flow.field,flow.origin,flow.adapter.mode,flow.canonical.entityType,flow.canonical.entityId,flow.consumer.name]
          .join(' ').toLocaleLowerCase('ko').includes(needle);
      });
  }

  function renderStages(){
    stageList.replaceChildren();
    if(!trace)return;
    const grouped=new Map(STAGES.map(stage=>[stage,[]]));
    trace.rows.forEach((row,index)=>grouped.get(row.stage)?.push({row,index}));
    for(const stage of STAGES){
      const entries=grouped.get(stage)??[];
      if(!entries.length){
        const missing=el('div','ed-stage');missing.dataset.status='HOLD';
        missing.append(el('span','ed-stage-label',stage),el('span','ed-stage-title','관측 없음'),el('span','ed-stage-summary','이 trace에 해당 stage row가 없습니다.'),el('span','ed-stage-status','HOLD'));
        stageList.append(missing);continue;
      }
      const primary=entries[0];
      const button=el('button','ed-stage');button.type='button';button.dataset.stageIndex=String(primary.index);button.dataset.status=primary.row.status;
      button.append(
        el('span','ed-stage-label',stage+(entries.length>1?' · '+entries.length+'건':'')),
        el('span','ed-stage-title',primary.row.title),
        el('span','ed-stage-summary',primary.row.summary),
        el('span','ed-stage-status',primary.row.status),
      );
      button.addEventListener('click',()=>renderStageDetail(primary.row,primary.index));stageList.append(button);
    }
  }

  function renderFlows(){
    flowList.replaceChildren();if(!trace)return;
    const rows=matchingFlows();status.textContent=rows.length+'개 필드 lineage 표시 · product '+trace.productId;
    if(!rows.length){flowList.append(el('div','ed-empty','현재 검색 조건과 일치하는 field lineage가 없습니다.'));return;}
    for(const {flow,index} of rows){
      const button=el('button','ed-flow');button.type='button';button.dataset.flowIndex=String(index);button.dataset.selected=String(selectedKind==='flow'&&selectedIndex===index);
      const main=el('span','ed-flow-main');main.append(el('span','ed-flow-title',flow.label),el('span','ed-flow-sub',flow.field+' · '+flow.canonical.entityType+' '+flow.canonical.entityId+' r'+flow.canonical.revision),el('span','ed-flow-sub',flow.adapter.decision));
      const side=el('span','ed-flow-side');const badge=el('span','ed-badge',flow.adapter.mode);badge.dataset.mode=flow.adapter.mode;side.append(badge,el('span','ed-flow-sub',flow.origin));
      button.append(main,side);button.addEventListener('click',()=>renderFlowDetail(flow,index));flowList.append(button);
    }
  }

  function renderAll(){
    if(!trace)return;
    generated.textContent='생성 '+formatTime(trace.generatedAt);
    for(const [key,node] of Object.entries(summaryNodes))node.textContent=String(trace.counts[key]);
    renderStages();renderFlows();
  }

  async function loadTrace(productId,{preserve=true}={}){
    const id=productId.trim();
    if(!id){
      trace=null;resetSummary();stateSurface('productId가 필요합니다','상품 ID를 입력하거나 Console 상품 상세에서 Entity Detail로 이동하세요.');status.textContent='productId 입력 대기';return;
    }
    if(typeof read!=='function'){
      trace=null;resetSummary();stateSurface('Entity Detail 연결 대기','CatalogProductTrace reader가 연결되지 않았습니다.');status.textContent='조회 연결 대기';return;
    }
    const current=++seq;root.setAttribute('aria-busy','true');
    if(trace&&preserve)status.textContent='직전 trace 표시 · 새 trace 조회 중';
    else{stateSurface('Entity Detail 조회 중',id+' trace를 불러오고 있습니다.');status.textContent='자료 조회 중';}
    try{
      const next=validate(await read(id));if(disposed||current!==seq)return;
      trace=next;input.value=trace.productId;selectedKind=null;selectedIndex=null;detail.hidden=true;layout.dataset.inspecting='false';
      const url=new URL(window.location.href);url.searchParams.set('productId',trace.productId);window.history.replaceState(null,'',url);
      renderAll();
    }catch(error){
      if(disposed||current!==seq)return;
      if(trace&&preserve){renderAll();status.textContent='직전 trace 유지 · 새 조회 실패';}
      else{
        trace=null;resetSummary();
        const notFound=error?.status===404||error?.code==='PRODUCT_NOT_FOUND';
        stateSurface(notFound?'상품을 찾지 못했습니다':'Entity Detail 조회 실패',notFound?'현재 local trace API에 해당 productId가 없습니다.':'조회 실패를 lineage 없음으로 바꾸지 않습니다.');
        status.textContent=notFound?'상품 없음':'조회 실패';
      }
    }finally{if(!disposed&&current===seq)root.setAttribute('aria-busy','false');}
  }

  queryBox.addEventListener('submit',event=>{event.preventDefault();void loadTrace(input.value,{preserve:false});});
  refresh.addEventListener('click',()=>{void loadTrace(input.value,{preserve:true});});
  searchInput.addEventListener('input',()=>{query=searchInput.value;renderFlows();});
  root.addEventListener('keydown',event=>{if(event.key==='Escape'&&!detail.hidden){event.preventDefault();closeDetail();}});

  stateSurface('productId가 필요합니다','상품 ID를 입력하거나 Console 상품 상세에서 Entity Detail로 이동하세요.');
  resetSummary();
  const ready=initialProductId?loadTrace(initialProductId,{preserve:false}):Promise.resolve();
  return{ready,load:(id)=>loadTrace(id,{preserve:false}),refresh:()=>loadTrace(input.value,{preserve:true}),destroy(){disposed=true;root.replaceChildren();root.classList.remove('ed');}};
}
