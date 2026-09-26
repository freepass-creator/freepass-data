const UI_SCHEMA = 'freepass.vehicle-finder.ui/v1';

let instanceCount = 0;

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
};

const text = value => typeof value === 'string' && value.trim().length > 0;
const invalid = field => { throw new Error('INVALID_VEHICLE_FINDER_UI:' + field); };

function validateSnapshot(input) {
  if (!input || input.schemaVersion !== UI_SCHEMA) invalid('schemaVersion');
  if (!['NEW_CAR', 'USED_CAR'].includes(input.mode)) invalid('mode');
  if (!['GUIDED', 'SEARCH_FILTER'].includes(input.presentation)) invalid('presentation');
  if (!input.guidance || !text(input.guidance.resolutionStatus) ||
      (input.guidance.suggestedNextAxis != null && !text(input.guidance.suggestedNextAxis))) {
    invalid('guidance');
  }
  if (!text(input.observationId) || !text(input.observedAt) || !Number.isFinite(Date.parse(input.observedAt))) {
    invalid('observation');
  }
  if (!['COMPLETE', 'PARTIAL'].includes(input.coverage)) invalid('coverage');
  if (!Number.isSafeInteger(input.total) || input.total < 0 || typeof input.hasMore !== 'boolean') invalid('resultMeta');
  if (!Array.isArray(input.items)) invalid('items');
  if (!Array.isArray(input.facets)) invalid('facets');
  const facetAxes = new Set();
  for (const facet of input.facets) {
    if (!facet || !text(facet.axis) || facetAxes.has(facet.axis) ||
        !text(facet.label) || !Array.isArray(facet.options)) {
      invalid('facet');
    }
    facetAxes.add(facet.axis);
    const optionKeys = new Set();
    for (const option of facet.options) {
      if (!option || !text(option.key) || optionKeys.has(option.key) ||
          !text(option.label) ||
          (option.count != null && (!Number.isSafeInteger(option.count) || option.count < 0))) {
        invalid('facetOption');
      }
      optionKeys.add(option.key);
    }
  }

  const ids = new Set();
  for (const item of input.items) {
    if (!item || !text(item.id) || ids.has(item.id) || !text(item.label)) invalid('item');
    ids.add(item.id);
    if (!text(item.pathText) || !text(item.nodeTypeLabel)) invalid('itemContext');
    if (!item.state || !text(item.state.code) || !text(item.state.label)) invalid('itemState');
    if (item.freshness != null &&
        (!item.freshness || !text(item.freshness.code) || !text(item.freshness.label))) {
      invalid('itemFreshness');
    }
    if (item.confidenceLabel != null && !text(item.confidenceLabel)) invalid('itemConfidence');
    if (item.sources != null && (!Array.isArray(item.sources) ||
        item.sources.some(source => !source || !text(source.id) ||
          (source.label != null && !text(source.label))))) {
      invalid('itemSources');
    }
    if (item.listLines != null &&
        (!Array.isArray(item.listLines) || item.listLines.length > 2 ||
          item.listLines.some(line => !text(line)))) {
      invalid('itemListLines');
    }
    if (!Array.isArray(item.facts) || !Array.isArray(item.evidenceIds)) invalid('itemDetail');
    for (const fact of item.facts) {
      if (!fact || !text(fact.label) || typeof fact.unknown !== 'boolean') invalid('fact');
      if (!fact.unknown && !text(String(fact.value ?? ''))) invalid('factValue');
    }
  }
  return structuredClone(input);
}

function facetByAxis(snapshot, axis) {
  return snapshot?.facets?.find(facet => facet.axis === axis) ?? null;
}

function visibleFactValue(fact) {
  return fact.unknown ? '미확인' : String(fact.value);
}

function formatObservedAt(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '관측시각 미확인';
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function stateBadge(item) {
  const badge = element('span', 'vf-state-badge', item.state.label);
  badge.dataset.tone = item.state.tone ?? 'neutral';
  return badge;
}

export function mountVehicleFinder(root, { read, onSelect, initialMode = 'NEW_CAR' } = {}) {
  if (!(root instanceof HTMLElement)) throw new TypeError('Finder root must be an HTMLElement');

  const prefix = 'vf-u01-' + (++instanceCount);
  const events = new AbortController();
  const listen = (node, type, callback) =>
    node.addEventListener(type, callback, { signal: events.signal });

  let snapshot = null;
  let mode = ['NEW_CAR', 'USED_CAR'].includes(initialMode) ? initialMode : 'NEW_CAR';
  let query = '';
  let filters = {};
  let inspectedId = null;
  let lastInspectedId = null;
  let listScrollY = 0;
  let requestSeq = 0;
  let disposed = false;
  let filterLock = null;

  root.replaceChildren();
  root.classList.add('vf');

  const head = element('header', 'vf-head');
  const headTitle = element('div', 'vf-head-title');
  headTitle.append(element('h1', '', '차량 찾기'));
  const observation = element('div', 'vf-observation', '관측 정보 대기');
  head.append(headTitle, observation);

  const modeSwitch = element('div', 'vf-mode-switch');
  modeSwitch.setAttribute('role', 'group');
  modeSwitch.setAttribute('aria-label', '차량 구분');
  const newCarButton = element('button', 'vf-mode-button', '신차');
  const usedCarButton = element('button', 'vf-mode-button', '중고차');
  newCarButton.type = 'button';
  usedCarButton.type = 'button';
  newCarButton.dataset.mode = 'NEW_CAR';
  usedCarButton.dataset.mode = 'USED_CAR';
  modeSwitch.append(newCarButton, usedCarButton);

  const guidance = element('section', 'vf-guidance');
  guidance.setAttribute('aria-live', 'polite');

  const toolbar = element('div', 'vf-toolbar');
  const searchLabel = element('label', 'vf-search');
  searchLabel.htmlFor = prefix + '-search';
  const input = element('input');
  input.id = searchLabel.htmlFor;
  input.type = 'search';
  input.autocomplete = 'off';
  input.placeholder = '차량명, 세대, 연식, 파워트레인, 트림 등';
  searchLabel.append(element('span', 'vf-field-label', '차량 검색'), input);

  const utilityActions = element('div', 'vf-utility-actions');
  const filterToggle = element('button', 'vf-filter-toggle', '필터');
  filterToggle.type = 'button';
  filterToggle.setAttribute('aria-expanded', 'false');
  filterToggle.setAttribute('aria-controls', prefix + '-filters');
  const refresh = element('button', 'vf-refresh', '↻');
  refresh.type = 'button';
  refresh.setAttribute('aria-label', '다시 조회');
  utilityActions.append(filterToggle, refresh);
  toolbar.append(searchLabel, utilityActions);

  const filterPanel = element('div', 'vf-filters');
  filterPanel.id = prefix + '-filters';
  filterPanel.hidden = true;

  const filterSheetHead = element('div', 'vf-filter-sheet-head');
  const filterSheetTitle = element('strong', '', '필터');
  filterSheetTitle.id = prefix + '-filter-title';
  const filterClose = element('button', 'vf-filter-close', '×');
  filterClose.type = 'button';
  filterClose.setAttribute('aria-label', '필터 닫기');
  filterSheetHead.append(filterSheetTitle, filterClose);
  filterPanel.append(filterSheetHead);

  const filterFields = element('div', 'vf-filter-fields');
  filterPanel.append(filterFields);

  const filterActions = element('div', 'vf-filter-actions');
  const reset = element('button', 'vf-filter-reset', '필터 초기화');
  reset.type = 'button';
  const filterDone = element('button', 'vf-filter-done vf-primary', '결과 보기');
  filterDone.type = 'button';
  filterActions.append(reset, filterDone);
  filterPanel.append(filterActions);

  const status = element('div', 'vf-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const layout = element('div', 'vf-layout');
  const list = element('section', 'vf-list');
  const table = element('table');
  const thead = element('thead');
  const headerRow = element('tr');
  headerRow.append(element('th', '', '차량'), element('th', '', '상태'));
  thead.append(headerRow);
  const tbody = element('tbody');
  table.append(thead, tbody);
  const empty = element('div', 'vf-empty vf-empty-state');
  empty.setAttribute('role', 'status');
  list.append(table, empty);

  const detail = element('aside', 'vf-detail');
  detail.id = prefix + '-detail';
  detail.hidden = true;
  layout.append(list, detail);

  const readNotice = element('section', 'vf-read-notice');
  readNotice.hidden = true;
  readNotice.setAttribute('role', 'status');
  readNotice.setAttribute('aria-live', 'polite');

  root.append(head, modeSwitch, guidance, toolbar, filterPanel, status, readNotice, layout);

  const mobileMedia = window.matchMedia('(max-width: 900px)');

  function setReadNotice(kind, title, message, { retry = false } = {}) {
    readNotice.replaceChildren();
    readNotice.dataset.kind = kind;
    readNotice.append(
      element('strong', 'vf-read-notice-title', title),
      element('span', 'vf-read-notice-copy', message),
    );
    if (retry) {
      const retryButton = element('button', 'vf-read-notice-action', '다시 조회');
      retryButton.type = 'button';
      listen(retryButton, 'click', () => { void refreshResults({ preserve: true }); });
      readNotice.append(retryButton);
    }
    readNotice.hidden = false;
  }

  function clearReadNotice() {
    readNotice.hidden = true;
    readNotice.replaceChildren();
    delete readNotice.dataset.kind;
  }

  function setEmptyState(kind, title, message, { retry = false } = {}) {
    empty.replaceChildren();
    empty.dataset.kind = kind;
    const mark = element('span', 'vf-empty-mark', kind === 'loading' ? '···' : '—');
    mark.setAttribute('aria-hidden', 'true');
    empty.append(
      mark,
      element('strong', 'vf-empty-title', title),
      element('p', 'vf-empty-copy', message),
    );
    if (retry) {
      const retryButton = element('button', 'vf-empty-action', '다시 조회');
      retryButton.type = 'button';
      listen(retryButton, 'click', () => { void refreshResults({ preserve: false }); });
      empty.append(retryButton);
    }
    empty.hidden = false;
  }

  function lockFilterContext() {
    if (filterLock || !mobileMedia.matches) return;
    const background = [...root.children]
      .filter(node => node !== filterPanel)
      .map(node => [node, Boolean(node.inert)]);
    for (const [node] of background) node.inert = true;
    filterLock = {
      background,
      htmlOverflow: document.documentElement.style.overflow,
      bodyOverflow: document.body?.style.overflow ?? '',
    };
    document.documentElement.style.overflow = 'hidden';
    if (document.body) document.body.style.overflow = 'hidden';
  }

  function unlockFilterContext() {
    if (!filterLock) return;
    for (const [node, wasInert] of filterLock.background) node.inert = wasInert;
    document.documentElement.style.overflow = filterLock.htmlOverflow;
    if (document.body) document.body.style.overflow = filterLock.bodyOverflow;
    filterLock = null;
  }

  function setFilterPanel(open) {
    filterPanel.hidden = !open;
    filterToggle.setAttribute('aria-expanded', String(open));
    root.classList.toggle('vf-filter-open', open && mobileMedia.matches);

    if (open && mobileMedia.matches) {
      filterPanel.setAttribute('role', 'dialog');
      filterPanel.setAttribute('aria-modal', 'true');
      filterPanel.setAttribute('aria-labelledby', filterSheetTitle.id);
      lockFilterContext();
    } else {
      filterPanel.removeAttribute('role');
      filterPanel.removeAttribute('aria-modal');
      filterPanel.removeAttribute('aria-labelledby');
      unlockFilterContext();
    }
  }

  function syncModeUi() {
    for (const button of [newCarButton, usedCarButton]) {
      const active = button.dataset.mode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    root.dataset.mode = mode;
    if (mode === 'NEW_CAR') {
      input.placeholder = '제조사, 모델, 파워트레인, 트림 등';
    } else {
      input.placeholder = '모델, 연식, 세대, 변경형, 파워트레인, 트림 등';
    }
  }

  function renderGuidance() {
    guidance.replaceChildren();
    if (!snapshot) return;

    const title = element(
      'strong',
      '',
      snapshot.mode === 'NEW_CAR' ? '신차 찾기' : '중고차 찾기',
    );
    const presentation = element(
      'span',
      'vf-guidance-presentation',
      snapshot.presentation === 'GUIDED' ? '가이드형' : '검색·필터형',
    );
    const statusText = element(
      'span',
      'vf-guidance-status',
      '상태 ' + snapshot.guidance.resolutionStatus,
    );
    guidance.append(title, presentation, statusText);

    if (snapshot.guidance.suggestedNextAxis) {
      const suggestedFacet = facetByAxis(snapshot, snapshot.guidance.suggestedNextAxis);
      guidance.append(
        element(
          'span',
          'vf-guidance-next',
          '다음으로 좁힐 수 있는 조건 · ' +
            (suggestedFacet?.label ?? snapshot.guidance.suggestedNextAxis),
        ),
      );

      if (snapshot.presentation === 'GUIDED' && suggestedFacet?.options.length) {
        const choices = element('div', 'vf-guided-options');
        choices.setAttribute('aria-label', suggestedFacet.label + ' 선택');
        for (const option of suggestedFacet.options) {
          const choice = element(
            'button',
            'vf-guided-option',
            option.label + (option.count == null ? '' : ' · ' + option.count),
          );
          choice.type = 'button';
          choice.dataset.selected = String(filters[suggestedFacet.axis] === option.key);
          listen(choice, 'click', () => {
            filters[suggestedFacet.axis] = option.key;
            void refreshResults({ preserve: true });
          });
          choices.append(choice);
        }
        guidance.append(choices);
      }
    }

    if (snapshot.mode === 'NEW_CAR') {
      guidance.append(
        element(
          'p',
          'vf-guidance-copy',
          '아는 정보부터 선택하세요. 모든 단계를 순서대로 입력할 필요는 없습니다.',
        ),
      );
    } else {
      guidance.append(
        element(
          'p',
          'vf-guidance-copy',
          '연식·세대·변경형을 몰라도 검색할 수 있습니다. 조건을 알수록 후보가 좁아집니다.',
        ),
      );
    }
  }

  function populateFilters() {
    filterFields.replaceChildren();
    if (!snapshot) {
      reset.hidden = Object.keys(filters).length === 0;
      return;
    }

    for (const facet of snapshot.facets) {
      const wrapper = element('label', 'vf-filter-field');
      const selectId = prefix + '-facet-' + facet.axis;
      wrapper.htmlFor = selectId;
      const select = element('select');
      select.id = selectId;
      select.dataset.axis = facet.axis;
      select.append(new Option('전체 · 미확인 포함', ''));

      for (const option of facet.options) {
        const label = option.count == null
          ? option.label
          : option.label + ' (' + option.count + ')';
        select.append(new Option(label, option.key));
      }

      const current = filters[facet.axis] ?? '';
      if (current && ![...select.options].some(option => option.value === current)) {
        select.append(new Option('선택값 유지', current));
      }
      select.value = current;

      listen(select, 'change', () => {
        if (select.value) filters[facet.axis] = select.value;
        else delete filters[facet.axis];
        void refreshResults({ preserve: true });
      });

      wrapper.append(element('span', '', facet.label), select);
      filterFields.append(wrapper);
    }

    reset.hidden = Object.keys(filters).length === 0;
  }

  function closeDetail(restoreFocus = true) {
    const priorId = inspectedId;
    if (priorId) lastInspectedId = priorId;
    inspectedId = null;
    detail.hidden = true;
    root.classList.remove('vf-inspecting');
    renderRows();

    if (restoreFocus && priorId) {
      const priorButton = root.querySelector(
        '[data-entry-id="' + CSS.escape(priorId) + '"]',
      );
      priorButton?.focus({ preventScroll: true });
      if (mobileMedia.matches) {
        requestAnimationFrame(() => {
          window.scrollTo({ top: listScrollY, behavior: 'auto' });
        });
      }
    }
  }

  function renderDetail(item) {
    detail.replaceChildren();
    const detailHead = element('div', 'vf-detail-head');
    const detailTitle = element('div', 'vf-detail-title');
    const detailHeading = element('h2', '', item.label);
    detailHeading.tabIndex = -1;
    detailTitle.append(detailHeading, element('div', 'vf-path', item.pathText));
    const close = element('button', 'vf-detail-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '상세 닫기');
    listen(close, 'click', () => closeDetail());
    detailHead.append(detailTitle, close);

    const resultMeta = element('div', 'vf-result-meta');
    resultMeta.append(
      stateBadge(item),
      element('span', 'vf-state-code', item.state.code),
      element('span', 'vf-note', item.nodeTypeLabel),
    );

    const trust = element('dl', 'vf-trust-grid');
    const trustItems = [
      ['관측', formatObservedAt(snapshot.observedAt)],
      ['최신성', item.freshness?.label ?? '판정 없음'],
      ['신뢰도', item.confidenceLabel ?? '평가 없음'],
      ['근거', item.evidenceIds.length + '개'],
    ];
    for (const [label, value] of trustItems) {
      const cell = element('div', 'vf-trust-item');
      cell.append(element('dt', '', label), element('dd', '', value));
      trust.append(cell);
    }

    const facts = element('dl', 'vf-detail-facts');
    for (const fact of item.facts) {
      const row = element('div', 'vf-detail-fact');
      row.dataset.unknown = String(fact.unknown);
      row.append(element('dt', '', fact.label), element('dd', '', visibleFactValue(fact)));
      facts.append(row);
    }

    const evidence = element('details', 'vf-evidence');
    const sources = item.sources ?? [];
    const summary = element(
      'summary',
      '',
      '출처 ' + sources.length + '곳 · 근거 ' + item.evidenceIds.length + '개',
    );
    evidence.append(summary);
    if (sources.length) {
      const sourceList = element('ul', 'vf-source-list');
      for (const source of sources) {
        sourceList.append(element('li', '', source.label ?? source.id));
      }
      evidence.append(sourceList);
    } else {
      evidence.append(element('div', 'vf-note', '표시 가능한 출처 이름이 없습니다.'));
    }
    if (item.evidenceIds.length) {
      evidence.append(
        element('div', 'vf-config-evidence', '근거 ID · ' + item.evidenceIds.join(' · ')),
      );
    } else {
      evidence.append(element('div', 'vf-note', '표시 가능한 근거 ID가 없습니다.'));
    }

    const actions = element('div', 'vf-actionbar');
    const back = element('button', 'vf-back vf-secondary', '목록으로');
    back.type = 'button';
    listen(back, 'click', () => closeDetail());
    const confirm = element('button', 'vf-primary', '이 차량 선택');
    confirm.type = 'button';
    confirm.disabled = item.selectable === false;
    listen(confirm, 'click', async () => {
      if (confirm.disabled || typeof onSelect !== 'function') return;
      confirm.disabled = true;
      try {
        await onSelect({
          id: item.id,
          observationId: snapshot.observationId,
          stateCode: item.state.code,
        });
        status.textContent = item.label + ' 선택 완료';
      } catch {
        status.textContent = '선택을 완료하지 못했습니다. 입력과 조회 결과는 유지됩니다.';
      } finally {
        confirm.disabled = item.selectable === false;
      }
    });
    actions.append(back, confirm);

    detail.append(detailHead, resultMeta, trust, facts, evidence, actions);
    detail.hidden = false;
    root.classList.add('vf-inspecting');
  }

  function inspect(id) {
    const item = snapshot?.items.find(candidate => candidate.id === id);
    if (!item) return;
    listScrollY = window.scrollY;
    inspectedId = id;
    lastInspectedId = id;
    renderRows();
    renderDetail(item);
    detail.querySelector('h2')?.focus?.({ preventScroll: false });
  }

  function renderRows() {
    tbody.replaceChildren();
    if (!snapshot) return;

    table.hidden = snapshot.items.length === 0;
    if (snapshot.items.length > 0) {
      empty.hidden = true;
      empty.replaceChildren();
      delete empty.dataset.kind;
    } else if (snapshot.coverage === 'PARTIAL') {
      setEmptyState(
        'partial-zero',
        '일부 자료에서 후보를 찾지 못했습니다',
        '현재 관측 범위 안에서만 0건입니다. 전체 차량에 후보가 없다는 뜻은 아닙니다. 검색어와 필터는 유지됩니다.',
      );
    } else {
      setEmptyState(
        'zero',
        '일치하는 후보가 없습니다',
        '현재 완료된 관측 범위에서 조건과 일치하는 후보가 없습니다. 검색어와 필터는 유지됩니다.',
      );
    }

    for (const item of snapshot.items) {
      const row = element('tr');
      row.dataset.selected = String(item.id === inspectedId);
      row.dataset.recent = String(item.id === lastInspectedId && item.id !== inspectedId);

      const nameCell = element('td');
      const button = element('button', 'vf-row-button');
      button.type = 'button';
      button.dataset.entryId = item.id;
      button.setAttribute('aria-expanded', String(item.id === inspectedId));
      button.setAttribute('aria-controls', detail.id);
      button.setAttribute('aria-label', item.pathText);
      button.append(element('span', 'vf-row-title', item.label));
      const listLines = item.listLines ?? [];
      if (listLines.length) {
        const summary = element('span', 'vf-row-summary');
        for (const line of listLines) {
          summary.append(element('span', 'vf-row-summary-line', line));
        }
        button.append(summary);
      } else {
        const context = item.pathText === item.label ? '' : item.pathText;
        if (context) button.append(element('span', 'vf-row-path', context));
      }
      if (item.id === lastInspectedId && item.id !== inspectedId) {
        button.append(element('span', 'vf-row-recent', '방금 본 후보'));
      }
      listen(button, 'click', () => inspect(item.id));
      nameCell.append(button);

      const stateCell = element('td');
      const stateMeta = element('div', 'vf-row-state');
      stateMeta.append(stateBadge(item), element('span', 'vf-state-code', item.state.code));
      stateCell.append(stateMeta);
      row.append(nameCell, stateCell);
      tbody.append(row);
    }
  }

  function renderSnapshot(prefix = '') {
    if (!snapshot) return;
    if (!prefix) clearReadNotice();
    syncModeUi();
    renderGuidance();
    populateFilters();
    renderRows();

    const parts = [];
    if (prefix) parts.push(prefix);
    parts.push(snapshot.hasMore
      ? snapshot.total + '개 후보 중 ' + snapshot.items.length + '개 표시'
      : snapshot.total + '개 후보');
    if (Number.isSafeInteger(snapshot.excludedUnknownFacetCount) && snapshot.excludedUnknownFacetCount > 0) {
      parts.push('필터 값 미확인 ' + snapshot.excludedUnknownFacetCount + '개 제외');
    }
    if (snapshot.coverage === 'PARTIAL') parts.push('일부 자료');
    status.textContent = parts.join(' · ');
    observation.textContent =
      '관측 ' + formatObservedAt(snapshot.observedAt) + ' · 범위 ' + snapshot.coverage;
    filterDone.textContent = snapshot.total + '개 결과 보기';

    if (inspectedId && !snapshot.items.some(item => item.id === inspectedId)) closeDetail(false);
    if (lastInspectedId && !snapshot.items.some(item => item.id === lastInspectedId)) {
      lastInspectedId = null;
    }
  }

  async function refreshResults({ preserve = true } = {}) {
    if (disposed) return;
    if (typeof read !== 'function') {
      snapshot = null;
      table.hidden = true;
      clearReadNotice();
      setEmptyState(
        'disconnected',
        '차량 마스터 조회 연결을 기다리고 있습니다',
        '아직 실제 조회 경로가 연결되지 않았습니다. 예시 차량을 실제 자료처럼 표시하지 않습니다.',
      );
      status.textContent = '조회 연결 대기';
      observation.textContent = '관측 정보 없음';
      return;
    }

    const seq = ++requestSeq;
    refresh.disabled = true;
    root.setAttribute('aria-busy', 'true');
    if (snapshot && preserve) {
      renderSnapshot('직전 결과 표시 · 새 자료 조회 중');
      setReadNotice(
        'refreshing',
        '새 자료를 확인하고 있습니다',
        '직전 관측 결과를 그대로 표시합니다. 새 조회가 끝나기 전까지 현재 목록을 유지합니다.',
      );
    } else {
      table.hidden = true;
      clearReadNotice();
      setEmptyState(
        'loading',
        '차량 자료를 불러오는 중입니다',
        '조회가 끝나면 현재 검색어와 조건에 맞는 후보를 표시합니다.',
      );
      status.textContent = '자료 조회 중';
    }

    try {
      const next = validateSnapshot(await read({ mode, query, filters: { ...filters } }));
      if (next.mode !== mode) invalid('modeEcho');
      if (disposed || seq !== requestSeq) return;
      snapshot = next;
      renderSnapshot();
    } catch {
      if (disposed || seq !== requestSeq) return;
      if (snapshot && preserve) {
        renderSnapshot('직전 관측 유지 · 새 조회 실패');
        setReadNotice(
          'refresh-error',
          '새 조회를 완료하지 못했습니다',
          '직전 관측 결과를 계속 표시합니다. 이 오류를 후보 0건으로 해석하지 않습니다.',
          { retry: true },
        );
      } else {
        snapshot = null;
        observation.textContent = '관측 실패';
        table.hidden = true;
        clearReadNotice();
        setEmptyState(
          'error',
          '자료를 불러오지 못했습니다',
          '차량이 없다는 뜻이 아닙니다. 검색어와 필터는 유지되며 다시 조회할 수 있습니다.',
          { retry: true },
        );
        status.textContent = '조회 실패';
      }
    } finally {
      if (!disposed && seq === requestSeq) {
        refresh.disabled = false;
        root.setAttribute('aria-busy', 'false');
      }
    }
  }

  let inputTimer = null;
  const changeMode = nextMode => {
    if (nextMode === mode) return;
    mode = nextMode;
    query = '';
    filters = {};
    inspectedId = null;
    lastInspectedId = null;
    listScrollY = 0;
    snapshot = null;
    input.value = '';
    detail.hidden = true;
    root.classList.remove('vf-inspecting');
    syncModeUi();
    guidance.replaceChildren();
    clearReadNotice();
    empty.replaceChildren();
    populateFilters();
    void refreshResults({ preserve: false });
  };
  listen(newCarButton, 'click', () => changeMode('NEW_CAR'));
  listen(usedCarButton, 'click', () => changeMode('USED_CAR'));

  listen(input, 'input', () => {
    query = input.value;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => { void refreshResults({ preserve: true }); }, 120);
  });
  listen(refresh, 'click', () => { void refreshResults({ preserve: true }); });
  listen(filterToggle, 'click', () => setFilterPanel(filterPanel.hidden));
  listen(filterClose, 'click', () => setFilterPanel(false));
  listen(filterDone, 'click', () => setFilterPanel(false));
  listen(reset, 'click', () => {
    filters = {};
    populateFilters();
    void refreshResults({ preserve: true });
  });
  listen(mobileMedia, 'change', () => {
    setFilterPanel(!mobileMedia.matches);
  });
  listen(root, 'keydown', event => {
    if (event.key !== 'Escape') return;
    if (!filterPanel.hidden) {
      event.preventDefault();
      setFilterPanel(false);
      filterToggle.focus({ preventScroll: true });
      return;
    }
    if (inspectedId) {
      event.preventDefault();
      closeDetail();
    }
  });

  syncModeUi();
  setFilterPanel(!mobileMedia.matches);
  const ready = refreshResults({ preserve: false });

  return {
    ready,
    refresh: () => refreshResults({ preserve: true }),
    destroy() {
      disposed = true;
      clearTimeout(inputTimer);
      unlockFilterContext();
      events.abort();
      root.replaceChildren();
      root.classList.remove('vf', 'vf-inspecting', 'vf-filter-open');
    },
  };
}
