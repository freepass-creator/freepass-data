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
  head.append(element('h1', '', '차량 찾기'));

  const toolbar = element('div', 'vf-toolbar');
  const searchLabel = element('label', 'vf-search');
  searchLabel.htmlFor = `${prefix}-search`;
  const input = element('input');
  input.id = searchLabel.htmlFor;
  input.type = 'search';
  input.autocomplete = 'off';
  input.placeholder = '차량명, 세대, 연식, 트림 등';
  searchLabel.append(element('span', 'vf-field-label', '차량 검색'), input);

  const utilityActions = element('div', 'vf-utility-actions');
  const filterToggle = element('button', '', '필터');
  filterToggle.type = 'button';
  filterToggle.setAttribute('aria-expanded', 'false');
  filterToggle.setAttribute('aria-controls', `${prefix}-filters`);
  const refresh = element('button', 'vf-refresh', '↻');
  refresh.type = 'button';
  refresh.setAttribute('aria-label', '다시 조회');
  refresh.title = '다시 조회';
  utilityActions.append(filterToggle, refresh);
  toolbar.append(searchLabel, utilityActions);

  const filterPanel = element('div', 'vf-filters');
  filterPanel.id = `${prefix}-filters`;
  filterPanel.hidden = true;

  const filterSheetHead = element('div', 'vf-filter-sheet-head');
  const filterSheetTitle = element('strong', '', '필터');
  filterSheetTitle.id = `${prefix}-filter-title`;
  filterSheetHead.append(filterSheetTitle);
  const filterClose = element('button', 'vf-filter-close', '×');
  filterClose.type = 'button';
  filterClose.setAttribute('aria-label', '필터 닫기');
  filterSheetHead.append(filterClose);
  filterPanel.append(filterSheetHead);

  const filterInputs = new Map();
  for (const [key, label] of Object.entries(facetLabels)) {
    const wrapper = element('label', ['seatCount', 'drivetrain'].includes(key) ? 'vf-filter-advanced' : '');
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
  const filterMore = element('button', 'vf-filter-more', '추가 조건');
  filterMore.type = 'button';
  filterMore.setAttribute('aria-expanded', 'false');
  filterPanel.append(filterMore);

  const reset = element('button', 'vf-filter-reset', '필터 초기화');
  reset.type = 'button';
  reset.hidden = true;
  filterPanel.append(reset);

  const filterDone = element('button', 'vf-filter-done vf-primary', '결과 보기');
  filterDone.type = 'button';
  filterPanel.append(filterDone);

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
  const vehicleHeader = element('th', '', '차량');
  vehicleHeader.scope = 'col';
  headerRow.append(vehicleHeader);
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

  function rowContext(entry) {
    if (!snapshot) return '';
    const ancestors = entry.path.slice(0, -1);
    if (!ancestors.length || entry.nodeType === 'MAKE') return '';

    if (entry.nodeType === 'MODEL') {
      const duplicated = snapshot.entries.some(item =>
        item.id !== entry.id &&
        item.nodeType === 'MODEL' &&
        item.label === entry.label
      );
      return duplicated ? ancestors.at(-1)?.label ?? '' : '';
    }

    return ancestors.slice(-2).map(node => node.label).join(' › ');
  }

  function closeDetail(restoreFocus = true) {
    const formerId = inspectedId;
    inspectedId = null;
    detail.hidden = true;
    root.classList.remove('vf-inspecting');

    for (const button of tbody.querySelectorAll('button')) {
      button.setAttribute('aria-expanded', 'false');
    }
    for (const row of tbody.children) row.dataset.selected = 'false';

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
    selectedNotice.hidden = true;
    selectedNotice.classList.remove('vf-selection-success', 'vf-selection-error', 'vf-selection-warning');
    detail.replaceChildren();
    detail.hidden = false;
    root.classList.add('vf-inspecting');

    for (const button of tbody.querySelectorAll('button')) {
      button.setAttribute('aria-expanded', String(button.dataset.entryId === id));
    }
    for (const row of tbody.children) row.dataset.selected = String(row.dataset.entryId === id);

    const title = element('h2', '', entry.label);
    title.id = `${prefix}-title`;
    title.tabIndex = -1;
    detail.setAttribute('aria-labelledby', title.id);

    const detailHead = element('div', 'vf-detail-head');
    const detailTitle = element('div', 'vf-detail-title');
    detailTitle.append(
      title,
      element('p', 'vf-path', pathText(entry)),
      element('p', 'vf-note', `${LEVELS[entry.nodeType]} 수준 · 차량 구성 미확정`),
    );
    const close = element('button', 'vf-detail-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '상세 닫기');
    close.title = '상세 닫기';
    listen(close, 'click', () => closeDetail());
    detailHead.append(detailTitle, close);
    detail.append(detailHead);

    const matchedConfigurations = match.matchedConfigurationIds
      .map(configurationId => entry.configurations.find(item => item.id === configurationId))
      .filter(Boolean);

    if (!matchedConfigurations.length) {
      detail.append(element(
        'p',
        'vf-note vf-config-missing',
        '세부 구성 미확인 · 확인되지 않은 사양은 채우지 않습니다.',
      ));
    } else {
      const vehicleFacts = element('details', 'vf-configurations');
      vehicleFacts.append(
        element('summary', '', `검색 조건과 일치한 구성 ${matchedConfigurations.length}개`),
      );
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
      detail.append(vehicleFacts);
    }

    const evidence = element('details', 'vf-evidence');
    evidence.append(element('summary', '', '검색·조회 근거'));
    evidence.append(
      element(
        'p',
        '',
        `자료 범위 ${snapshot.coverage === 'PARTIAL' ? '제공된 일부 자료' : '이 조회 범위 전체'}`,
      ),
      element('p', '', `검색어 ${input.value || '미지정'}`),
      element('p', '', `필터 ${Object.values(filters).join(' · ') || '미지정'}`),
      element('p', '', `관측 ${snapshot.observedAt}`),
      element('p', '', `조회 식별자 ${snapshot.observationId}`),
      element('p', '', `대상 ID ${entry.id}`),
    );
    detail.append(evidence);

    const actions = element('div', 'vf-actionbar');
    const back = element('button', 'vf-secondary vf-back', '목록으로');
    back.type = 'button';
    listen(back, 'click', () => closeDetail());

    const confirm = element('button', 'vf-primary', '이 수준으로 선택');
    confirm.type = 'button';
    listen(confirm, 'click', async () => {
      if (selectionPending || !snapshot || confirm.dataset.selected === 'true') return;
      const selectedSnapshot = snapshot;
      const value = partialSelection(selectedSnapshot, id, {
        query: input.value,
        filters,
        matchedConfigurationIds: match.matchedConfigurationIds,
      });

      selectionPending = true;
      confirm.disabled = true;
      confirm.textContent = '선택 중…';
      let keepDisabled = false;
      try {
        if (onSelect) await onSelect(value);
        if (disposed) return;

        const isCurrent =
          snapshot === selectedSnapshot &&
          inspectedId === id;

        selectedNotice.hidden = false;
        selectedNotice.classList.remove('vf-selection-error', 'vf-selection-warning', 'vf-selection-success');

        if (isCurrent) {
          keepDisabled = true;
          confirm.dataset.selected = 'true';
          confirm.textContent = '선택됨';
          selectedNotice.classList.add('vf-selection-success');
          selectedNotice.textContent = `${entry.label} 선택됨`;
        } else {
          confirm.textContent = '이 수준으로 선택';
          selectedNotice.classList.add('vf-selection-warning');
          selectedNotice.textContent =
            `${entry.label} · 이전 조회(${value.observationId}) 기준 선택이 전달됨 · 현재 화면은 변경됨`;
        }

        root.dispatchEvent(new CustomEvent('vehicle-reference-selected', {
          detail: value,
          bubbles: true,
        }));
      } catch {
        if (!disposed) {
          selectedNotice.hidden = false;
          selectedNotice.classList.remove('vf-selection-success', 'vf-selection-warning');
          selectedNotice.classList.add('vf-selection-error');
          selectedNotice.textContent = '선택을 전달하지 못했습니다. 다시 선택할 수 있습니다.';
          confirm.textContent = '이 수준으로 선택';
        }
      } finally {
        selectionPending = false;
        confirm.disabled = keepDisabled;
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
    if (snapshot.coverage === 'PARTIAL') {
      parts.push('일부 자료');
    }
    status.textContent = parts.join(' · ');
    filterDone.textContent = `${result.totalMatches}개 결과 보기`;

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
      button.append(element('span', 'vf-row-title', entry.label));
      const context = rowContext(entry);
      if (context) button.append(element('span', 'vf-row-path', context));
      listen(button, 'click', () => inspect(entry.id));

      name.append(button);
      if (!entry.configurations.length) {
        name.append(element('span', 'vf-row-check', '구성 미확인'));
      }

      row.append(name);
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
  const isMobileFilter = () => window.matchMedia('(max-width: 900px)').matches;

  function setFilterPanel(open) {
    const mobile = isMobileFilter();
    filterPanel.hidden = !open;
    filterToggle.setAttribute('aria-expanded', String(open));
    root.classList.toggle('vf-filter-open', open && mobile);

    if (open && mobile) {
      filterPanel.setAttribute('role', 'dialog');
      filterPanel.setAttribute('aria-modal', 'true');
      filterPanel.setAttribute('aria-labelledby', filterSheetTitle.id);
    } else {
      filterPanel.removeAttribute('role');
      filterPanel.removeAttribute('aria-modal');
      filterPanel.removeAttribute('aria-labelledby');
    }

    if (open) {
      const firstSelect = filterPanel.querySelector('select');
      firstSelect?.focus({ preventScroll: true });
    } else {
      filterToggle.focus({ preventScroll: true });
    }
  }

  listen(filterToggle, 'click', () => setFilterPanel(filterPanel.hidden));
  listen(filterClose, 'click', () => setFilterPanel(false));
  listen(filterDone, 'click', () => setFilterPanel(false));
  listen(filterMore, 'click', () => {
    const expanded = filterMore.getAttribute('aria-expanded') !== 'true';
    filterMore.setAttribute('aria-expanded', String(expanded));
    filterMore.textContent = expanded ? '추가 조건 접기' : '추가 조건';
    filterPanel.classList.toggle('vf-filter-advanced-open', expanded);
  });
  listen(reset, 'click', () => {
    filters = {};
    for (const select of filterInputs.values()) select.value = '';
    syncFilterUi();
    renderResults();
  });
  listen(root, 'keydown', event => {
    if (!filterPanel.hidden && isMobileFilter() && event.key === 'Tab') {
      const focusable = [...filterPanel.querySelectorAll(
        'button:not([disabled]):not([hidden]), select:not([disabled]):not([hidden])'
      )].filter(node => node.offsetParent !== null);
      if (focusable.length) {
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
      return;
    }

    if (event.key !== 'Escape') return;
    if (!filterPanel.hidden) {
      event.preventDefault();
      setFilterPanel(false);
      return;
    }
    if (inspectedId) {
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
      root.classList.remove('vf', 'vf-inspecting', 'vf-filter-open');
    },
  };
}
