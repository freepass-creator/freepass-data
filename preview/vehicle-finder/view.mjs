import {
  LEVELS,
  createReadController,
  partialSelection,
  searchEntries,
} from './core.mjs';

let instanceCount = 0;
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
};

const facetLabels = Object.freeze({
  modelYear: '연식',
  fuel: '연료',
  seatCount: '인승',
  drivetrain: '구동',
  trim: '트림',
});
const facetValue = (key, value) => {
  if (value == null || value === '') return '미확인';
  if (key === 'seatCount') return `${value}인승`;
  return String(value);
};
const pathText = entry => entry.path.map(node => node.label).join(' › ');

/** Mount an isolated read-only finder. No hidden endpoint, local fixture, or Firebase write. */
export function mountVehicleFinder(root, { read, onSelect } = {}) {
  if (!(root instanceof HTMLElement)) throw new TypeError('Finder root must be an HTMLElement');

  const prefix = `vf-${++instanceCount}`;
  const events = new AbortController();
  const listen = (node, type, callback) =>
    node.addEventListener(type, callback, { signal: events.signal });

  let snapshot = null;
  let inspectedId = null;
  let composing = false;
  let listScroll = 0;
  let filters = {};
  let selectionPending = false;
  let disposed = false;
  let lastReadStatus = 'idle';

  root.replaceChildren();
  root.classList.add('vf');

  const head = element('header', 'vf-head');
  const titles = element('div');
  titles.append(
    element('h1', '', '차량 찾기'),
    element('p', 'vf-note', '아는 정보만으로 찾고, 확인한 수준에서 선택합니다.'),
  );
  head.append(titles);

  const toolbar = element('div', 'vf-toolbar');
  const searchLabel = element('label', 'vf-search');
  searchLabel.htmlFor = `${prefix}-search`;
  const input = element('input');
  input.id = searchLabel.htmlFor;
  input.type = 'search';
  input.autocomplete = 'off';
  input.placeholder = '제조사, 차량명, 세대, 연식, 트림 등';
  searchLabel.append(element('span', '', '차량 검색'), input);

  const utilityActions = element('div', 'vf-utility-actions');
  const filterToggle = element('button', '', '필터');
  filterToggle.type = 'button';
  filterToggle.setAttribute('aria-expanded', 'false');
  filterToggle.setAttribute('aria-controls', `${prefix}-filters`);
  const refresh = element('button', '', '다시 조회');
  refresh.type = 'button';
  utilityActions.append(filterToggle, refresh);
  toolbar.append(searchLabel, utilityActions);

  const filterPanel = element('div', 'vf-filters');
  filterPanel.id = `${prefix}-filters`;
  filterPanel.hidden = true;
  const filterInputs = new Map();
  for (const [key, label] of Object.entries(facetLabels)) {
    const wrapper = element('label');
    wrapper.htmlFor = `${prefix}-${key}`;
    const select = element('select');
    select.id = wrapper.htmlFor;
    select.append(new Option('전체 · 미확인 포함', ''));
    wrapper.append(element('span', '', label), select);
    filterPanel.append(wrapper);
    filterInputs.set(key, select);
    listen(select, 'change', () => {
      if (select.value) filters[key] = select.value;
      else delete filters[key];
      syncFilterUi();
      renderResults();
    });
  }
  const reset = element('button', '', '필터 초기화');
  reset.type = 'button';
  reset.hidden = true;
  filterPanel.append(reset);

  function syncFilterUi() {
    const count = Object.keys(filters).length;
    filterToggle.textContent = count ? `필터 · ${count}` : '필터';
    reset.hidden = count === 0;
  }

  function currentReadPrefix() {
    if (lastReadStatus === 'refreshing') return '직전 결과 표시 · 새 자료 조회 중';
    if (lastReadStatus === 'error' && snapshot) return '직전 관측 유지 · 새 조회 실패';
    return '';
  }

  const status = element('div', 'vf-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const layout = element('div', 'vf-layout');
  const list = element('div', 'vf-list');
  const table = element('table');
  table.setAttribute('aria-label', '차량 검색 결과');
  const thead = element('thead');
  const headerRow = element('tr');
  for (const label of ['차량', '선택 수준', '자료']) {
    const th = element('th', '', label);
    th.scope = 'col';
    headerRow.append(th);
  }
  thead.append(headerRow);
  const tbody = element('tbody');
  table.append(thead, tbody);
  const empty = element('p', 'vf-empty');
  list.append(table, empty);

  const detail = element('section', 'vf-detail');
  detail.id = `${prefix}-detail`;
  detail.hidden = true;
  layout.append(list, detail);

  const selectedNotice = element('p', 'vf-selection');
  selectedNotice.hidden = true;
  selectedNotice.setAttribute('role', 'status');
  root.append(head, toolbar, filterPanel, status, layout, selectedNotice);

  const currentResult = () =>
    snapshot ? searchEntries(snapshot, input.value, filters) : null;

  function closeDetail(restoreFocus = true) {
    const formerId = inspectedId;
    inspectedId = null;
    detail.hidden = true;
    root.classList.remove('vf-inspecting');

    for (const button of tbody.querySelectorAll('button')) {
      button.setAttribute('aria-expanded', 'false');
    }
    for (const row of tbody.children) row.dataset.selected = 'false';
    for (const marker of tbody.querySelectorAll('.vf-row-state')) marker.hidden = true;

    if (restoreFocus) {
      const button = [...tbody.querySelectorAll('button')]
        .find(node => node.dataset.entryId === formerId);
      (button ?? input).focus({ preventScroll: true });
      window.scrollTo({ top: listScroll, behavior: 'instant' });
    }
  }

  function configurationSummary(configuration) {
    return Object.entries(facetLabels)
      .map(([key, label]) => [label, facetValue(key, configuration.facets[key])])
      .filter(([, value]) => value !== '미확인')
      .map(([label, value]) => `${label} ${value}`)
      .join(' · ');
  }

  function inspect(id) {
    if (!snapshot) return;
    const result = currentResult();
    const match = result?.matches.find(item => item.entry.id === id);
    const entry = snapshot.entries.find(item => item.id === id);
    if (!entry || !match) return;

    if (!inspectedId) listScroll = window.scrollY;
    inspectedId = id;
    detail.replaceChildren();
    detail.hidden = false;
    root.classList.add('vf-inspecting');

    for (const button of tbody.querySelectorAll('button')) {
      button.setAttribute('aria-expanded', String(button.dataset.entryId === id));
    }
    for (const row of tbody.children) row.dataset.selected = String(row.dataset.entryId === id);
    for (const marker of tbody.querySelectorAll('.vf-row-state')) {
      marker.hidden = marker.dataset.entryId !== id;
    }

    const title = element('h2', '', entry.label);
    title.id = `${prefix}-title`;
    title.tabIndex = -1;
    detail.setAttribute('aria-labelledby', title.id);
    detail.append(
      title,
      element('p', 'vf-path', pathText(entry)),
      element('p', 'vf-note', `${LEVELS[entry.nodeType]} 수준 · 차량 구성 미확정`),
    );

    const matchedConfigurations = match.matchedConfigurationIds
      .map(configurationId => entry.configurations.find(item => item.id === configurationId))
      .filter(Boolean);

    const vehicleFacts = element('section', 'vf-configurations');
    vehicleFacts.append(element('h3', '', '검색 조건과 함께 확인된 구성'));
    if (!matchedConfigurations.length) {
      vehicleFacts.append(element(
        'p',
        'vf-note',
        '이 수준에서는 세부 구성 근거가 아직 연결되지 않았습니다. 확인되지 않은 사양은 채우지 않습니다.',
      ));
    } else {
      const listNode = element('ul', 'vf-config-list');
      for (const configuration of matchedConfigurations) {
        const item = element('li', 'vf-config-card');
        const summary = configurationSummary(configuration);
        item.append(
          element('strong', '', summary || '구성 사실 일부만 확인됨'),
          element('span', 'vf-config-evidence', `근거 ${configuration.evidenceId}`),
        );
        listNode.append(item);
      }
      vehicleFacts.append(listNode);
    }
    detail.append(vehicleFacts);

    const facts = element('dl');
    const fact = (name, value) =>
      facts.append(element('dt', '', name), element('dd', '', value));
    fact('계층 경로', pathText(entry));
    fact('현재 검색어', input.value || '미지정');
    fact('추가 필터', Object.values(filters).join(' · ') || '미지정');
    fact(
      '선택의 의미',
      '이 대상을 탐색 기준으로 선택합니다. 검색어와 필터는 확정 차량 사양으로 저장되지 않습니다.',
    );
    fact(
      '자료 범위',
      snapshot.coverage === 'PARTIAL' ? '제공된 일부 자료' : '이 조회 범위 전체',
    );
    detail.append(facts);

    const evidence = element('details', 'vf-evidence');
    evidence.append(element('summary', '', '조회 근거'));
    evidence.append(
      element('p', '', `관측 ${snapshot.observedAt}`),
      element('p', '', `조회 식별자 ${snapshot.observationId}`),
      element('p', '', `대상 ID ${entry.id}`),
    );
    detail.append(evidence);

    const actions = element('div', 'vf-actionbar');
    const back = element('button', 'vf-secondary', '목록으로');
    back.type = 'button';
    listen(back, 'click', () => closeDetail());

    const confirm = element('button', 'vf-primary', '이 수준으로 선택');
    confirm.type = 'button';
    listen(confirm, 'click', async () => {
      if (selectionPending || !snapshot) return;
      const selectedSnapshot = snapshot;
      const value = partialSelection(selectedSnapshot, id, {
        query: input.value,
        filters,
        matchedConfigurationIds: match.matchedConfigurationIds,
      });

      selectionPending = true;
      confirm.disabled = true;
      try {
        if (onSelect) await onSelect(value);
        if (disposed) return;

        const isCurrent =
          snapshot === selectedSnapshot &&
          inspectedId === id;

        selectedNotice.hidden = false;
        selectedNotice.textContent = isCurrent
          ? `${entry.label} · ${LEVELS[entry.nodeType]} 선택됨 · 차량 구성 미확정`
          : `${entry.label} · 이전 조회(${value.observationId}) 기준 선택이 전달됨 · 차량 구성 미확정`;

        root.dispatchEvent(new CustomEvent('vehicle-reference-selected', {
          detail: value,
          bubbles: true,
        }));
      } catch {
        if (!disposed) {
          selectedNotice.hidden = false;
          selectedNotice.textContent = '선택을 전달하지 못했습니다. 다시 선택할 수 있습니다.';
        }
      } finally {
        selectionPending = false;
        confirm.disabled = false;
        if (!disposed && confirm.isConnected && document.activeElement === document.body) {
          confirm.focus({ preventScroll: true });
        }
      }
    });

    actions.append(back, confirm);
    detail.append(actions);
    title.focus({ preventScroll: false });
  }

  function renderResults(prefixMessage = currentReadPrefix()) {
    if (!snapshot) return;
    const result = currentResult();
    tbody.replaceChildren();

    const parts = [];
    if (prefixMessage) parts.push(prefixMessage);
    parts.push(
      result.hasMore
        ? `${result.totalMatches}개 후보 중 ${result.matches.length}개 표시`
        : `${result.totalMatches}개 후보`,
    );
    if (result.excludedUnknownFacetCount) {
      parts.push(`필터 값 미확인 ${result.excludedUnknownFacetCount}개 제외됨`);
    }
    parts.push(
      snapshot.coverage === 'PARTIAL'
        ? '제공된 일부 자료에서 검색'
        : '이 조회 범위에서 검색',
    );
    status.textContent = parts.join(' · ');

    table.hidden = !result.matches.length;
    empty.hidden = Boolean(result.matches.length);
    empty.textContent =
      '등록된 자료에서 일치하는 후보를 찾지 못했습니다. 원래 검색어와 필터는 유지됩니다.';

    for (const { entry, pathText: entryPath } of result.matches) {
      const row = element('tr');
      row.dataset.entryId = entry.id;
      row.dataset.selected = String(entry.id === inspectedId);

      const name = element('td');
      const button = element('button', 'vf-row-button');
      button.type = 'button';
      button.dataset.entryId = entry.id;
      button.setAttribute('aria-expanded', String(entry.id === inspectedId));
      button.setAttribute('aria-controls', detail.id);
      button.setAttribute('aria-label', entryPath);
      button.append(
        element('span', 'vf-row-title', entry.label),
        element('span', 'vf-row-path', entryPath),
      );
      listen(button, 'click', () => inspect(entry.id));

      const marker = element('span', 'vf-row-state', '보는 중');
      marker.dataset.entryId = entry.id;
      marker.hidden = entry.id !== inspectedId;
      name.append(button, marker);

      row.append(
        name,
        element('td', 'vf-row-level', LEVELS[entry.nodeType]),
        element('td', 'vf-row-evidence', entry.configurations.length ? '구성 자료' : '구성 미확인'),
      );
      tbody.append(row);
    }

    if (inspectedId && !result.matches.some(item => item.entry.id === inspectedId)) {
      closeDetail(false);
    }
  }

  function populateFilters() {
    for (const [key, select] of filterInputs) {
      const values = new Set(snapshot.entries.flatMap(entry =>
        entry.configurations
          .map(item => item.facets[key])
          .filter(value => value != null)
          .map(String)
      ));
      if (filters[key]) values.add(filters[key]);
      select.replaceChildren(new Option('전체 · 미확인 포함', ''));
      for (const value of [...values].sort((a, b) =>
        a.localeCompare(b, 'ko', { numeric: true })
      )) {
        select.append(new Option(value, value));
      }
      select.value = filters[key] ?? '';
    }
    syncFilterUi();
  }

  const controller = createReadController(read, state => {
    lastReadStatus = state.status;
    refresh.disabled = state.status === 'loading' || state.status === 'refreshing';
    root.setAttribute(
      'aria-busy',
      String(state.status === 'loading' || state.status === 'refreshing'),
    );

    if (state.snapshot) {
      const changedObservation =
        snapshot && snapshot.observationId !== state.snapshot.observationId;
      snapshot = state.snapshot;

      if (state.status === 'ready') {
        if (changedObservation) closeDetail(false);
        populateFilters();
        renderResults();
        return;
      }
      if (state.status === 'refreshing') {
        renderResults('직전 결과 표시 · 새 자료 조회 중');
        return;
      }
      if (state.status === 'error') {
        renderResults('직전 관측 유지 · 새 조회 실패');
        return;
      }
    }

    snapshot = null;
    closeDetail(false);
    tbody.replaceChildren();
    table.hidden = true;
    empty.hidden = false;

    if (state.status === 'loading') {
      status.textContent = '자료 조회 중';
      empty.textContent = '조회가 끝나면 검색어에 맞는 후보를 표시합니다.';
    }
    if (state.status === 'not_connected') {
      status.textContent = '조회 연결 대기';
      empty.textContent =
        '차종 마스터 읽기 연결이 아직 없습니다. 예시 차량을 실제 자료처럼 표시하지 않습니다.';
    }
    if (state.status === 'error') {
      status.textContent = '조회 실패';
      empty.textContent =
        '자료를 불러오지 못했습니다. 차량이 없다는 뜻은 아닙니다. 검색어를 유지한 채 다시 조회할 수 있습니다.';
    }
  });

  listen(refresh, 'click', () => { void controller.refresh(); });
  listen(input, 'compositionstart', () => { composing = true; });
  listen(input, 'compositionend', () => {
    composing = false;
    renderResults();
  });
  listen(input, 'input', event => {
    if (!composing && !event.isComposing) {
      renderResults();
    }
  });
  listen(filterToggle, 'click', () => {
    filterPanel.hidden = !filterPanel.hidden;
    filterToggle.setAttribute('aria-expanded', String(!filterPanel.hidden));
  });
  listen(reset, 'click', () => {
    filters = {};
    for (const select of filterInputs.values()) select.value = '';
    syncFilterUi();
    renderResults();
  });
  listen(root, 'keydown', event => {
    if (event.key === 'Escape' && inspectedId) {
      event.preventDefault();
      closeDetail();
    }
  });

  const ready = controller.refresh();
  return {
    ready,
    refresh: () => controller.refresh(),
    destroy() {
      disposed = true;
      controller.dispose();
      events.abort();
      root.replaceChildren();
      root.classList.remove('vf', 'vf-inspecting');
    },
  };
}
