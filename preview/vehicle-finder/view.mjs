import { LEVELS, createReadController, searchEntries, partialSelection } from './core.mjs';
let instanceCount = 0;
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
};

/** Mount an isolated read-only finder. No hidden endpoint, local fixture, or Firebase write. */
export function mountVehicleFinder(root, { read, onSelect } = {}) {
  if (!(root instanceof HTMLElement)) throw new TypeError('Finder root must be an HTMLElement');
  const prefix = `vf-${++instanceCount}`;
  const events = new AbortController();
  const listen = (node, type, callback) => node.addEventListener(type, callback, { signal: events.signal });
  let snapshot = null;
  let inspectedId = null;
  let composing = false;
  let listScroll = 0;
  let filters = {};
  let selectionPending = false;
  let disposed = false;
  root.replaceChildren(); root.classList.add('vf');
  const head = element('header', 'vf-head');
  const titles = element('div');
  titles.append(element('h1', '', '차량 찾기'), element('p', 'vf-note', '아는 정보만으로 찾고, 확인한 수준에서 선택합니다.'));
  const refresh = element('button', '', '다시 조회'); refresh.type = 'button'; head.append(titles, refresh);
  const toolbar = element('div', 'vf-toolbar');
  const searchLabel = element('label', 'vf-search'); searchLabel.htmlFor = `${prefix}-search`;
  const input = element('input'); input.id = searchLabel.htmlFor; input.type = 'search'; input.autocomplete = 'off';
  input.placeholder = '차량명, 세대 코드, 연식, 트림 등';
  searchLabel.append(element('span', '', '차량 검색'), input);
  const filterToggle = element('button', '', '필터'); filterToggle.type = 'button';
  filterToggle.setAttribute('aria-expanded', 'false'); filterToggle.setAttribute('aria-controls', `${prefix}-filters`);
  toolbar.append(searchLabel, filterToggle);
  const filterPanel = element('div', 'vf-filters'); filterPanel.id = `${prefix}-filters`; filterPanel.hidden = true;
  const filterInputs = new Map();
  for (const [key, label] of [['modelYear', '연식'], ['fuel', '연료'], ['seatCount', '인승']]) {
    const wrapper = element('label'); wrapper.htmlFor = `${prefix}-${key}`;
    const select = element('select'); select.id = wrapper.htmlFor;
    select.append(new Option('전체 · 모르면 선택하지 않음', ''));
    wrapper.append(element('span', '', label), select); filterPanel.append(wrapper); filterInputs.set(key, select);
    listen(select, 'change', () => { if (select.value) filters[key] = select.value; else delete filters[key]; renderResults(); });
  }
  const reset = element('button', '', '필터 초기화'); reset.type = 'button'; filterPanel.append(reset);
  const status = element('div', 'vf-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const layout = element('div', 'vf-layout');
  const list = element('div', 'vf-list');
  const table = element('table'); table.setAttribute('aria-label', '차량 검색 결과');
  const thead = element('thead'); const headerRow = element('tr');
  for (const label of ['차량', '선택 수준', '자료']) { const th = element('th', '', label); th.scope = 'col'; headerRow.append(th); }
  thead.append(headerRow); const tbody = element('tbody'); table.append(thead, tbody);
  const empty = element('p', 'vf-empty'); list.append(table, empty);
  const detail = element('section', 'vf-detail'); detail.id = `${prefix}-detail`; detail.hidden = true;
  layout.append(list, detail);
  const selectedNotice = element('p', 'vf-selection'); selectedNotice.hidden = true; selectedNotice.setAttribute('role', 'status');
  root.append(head, toolbar, filterPanel, status, layout, selectedNotice);

  function closeDetail(restoreFocus = true) {
    const formerId = inspectedId; inspectedId = null; detail.hidden = true;
    root.classList.remove('vf-inspecting');
    for (const button of tbody.querySelectorAll('button')) button.setAttribute('aria-expanded', 'false');
    for (const row of tbody.children) row.dataset.selected = 'false';
    if (restoreFocus) {
      const button = [...tbody.querySelectorAll('button')].find(node => node.dataset.entryId === formerId);
      (button ?? input).focus({ preventScroll: true }); window.scrollTo({ top: listScroll, behavior: 'instant' });
    }
  }
  function inspect(id) {
    if (!snapshot) return;
    const entry = snapshot.entries.find(item => item.id === id); if (!entry) return;
    if (!inspectedId) listScroll = window.scrollY;
    inspectedId = id; detail.replaceChildren(); detail.hidden = false; root.classList.add('vf-inspecting');
    for (const button of tbody.querySelectorAll('button')) button.setAttribute('aria-expanded', String(button.dataset.entryId === id));
    for (const row of tbody.children) row.dataset.selected = String(row.dataset.entryId === id);
    const back = element('button', 'vf-return', '목록으로'); back.type = 'button';
    back.addEventListener('click', () => closeDetail());
    const title = element('h2', '', entry.label); title.id = `${prefix}-title`; title.tabIndex = -1;
    detail.setAttribute('aria-labelledby', title.id);
    detail.append(back, title, element('p', 'vf-note', `${LEVELS[entry.level]} 수준 · 차량 구성 미확정`));
    const facts = element('dl');
    const fact = (name, value) => facts.append(element('dt', '', name), element('dd', '', value));
    fact('현재 검색어', input.value || '미지정');
    fact('추가 필터', Object.values(filters).join(' · ') || '미지정');
    fact('선택의 의미', '이 대상을 탐색 기준으로 선택합니다. 검색어와 필터가 차량의 확정 사양으로 저장되지는 않습니다.');
    fact('자료 범위', snapshot.coverage === 'PARTIAL' ? '제공된 일부 자료' : '이 조회 범위 전체');
    detail.append(facts);
    const evidence = element('details', 'vf-evidence'); evidence.append(element('summary', '', '조회 근거'));
    evidence.append(element('p', '', `관측 ${snapshot.observedAt}`), element('p', '', `조회 식별자 ${snapshot.observationId}`), element('p', '', `대상 ID ${entry.id}`));
    detail.append(evidence);
    const confirm = element('button', 'vf-primary', '이 수준으로 선택'); confirm.type = 'button';
    confirm.addEventListener('click', async () => {
      if (selectionPending || !snapshot) return;
      const selectedSnapshot = snapshot;
      const value = partialSelection(snapshot, id, { query: input.value, filters });
      selectionPending = true; confirm.disabled = true;
      try {
        if (onSelect) await onSelect(value);
        if (disposed || snapshot !== selectedSnapshot || inspectedId !== id) return;
        selectedNotice.hidden = false;
        selectedNotice.textContent = `${entry.label} · ${LEVELS[entry.level]} 선택됨 · 차량 구성 미확정 (이 컴포넌트는 서버에 저장하지 않습니다.)`;
        root.dispatchEvent(new CustomEvent('vehicle-reference-selected', { detail: value, bubbles: true }));
      } catch {
        if (!disposed) { selectedNotice.hidden = false; selectedNotice.textContent = '선택을 전달하지 못했습니다. 다시 선택할 수 있습니다.'; }
      } finally {
        selectionPending = false; confirm.disabled = false;
        // Disabling a focused button can move focus to body; retain keyboard navigation.
        if (!disposed && confirm.isConnected && document.activeElement === document.body) confirm.focus({ preventScroll: true });
      }
    });
    detail.append(confirm); title.focus({ preventScroll: false });
  }
  function renderResults() {
    if (!snapshot) return;
    const result = searchEntries(snapshot, input.value, filters);
    tbody.replaceChildren();
    const count = result.matches.length;
    status.textContent = `${count}개 후보 · ${snapshot.coverage === 'PARTIAL' ? '제공된 일부 자료에서 검색' : '이 조회 범위에서 검색'}`;
    table.hidden = !count; empty.hidden = Boolean(count);
    empty.textContent = '등록된 자료에서 일치하는 후보를 찾지 못했습니다. 원래 검색어와 필터는 유지됩니다.';
    for (const { entry } of result.matches) {
      const row = element('tr'); row.dataset.entryId = entry.id; row.dataset.selected = String(entry.id === inspectedId);
      const name = element('td'); const button = element('button', 'vf-row-button', entry.label); button.type = 'button';
      button.dataset.entryId = entry.id; button.setAttribute('aria-expanded', String(entry.id === inspectedId)); button.setAttribute('aria-controls', detail.id);
      button.addEventListener('click', () => inspect(entry.id)); name.append(button);
      row.append(name, element('td', '', LEVELS[entry.level]), element('td', '', entry.configurations.length ? '구성 자료' : '구성 미확인'));
      tbody.append(row);
    }
    if (inspectedId) closeDetail(false);
  }
  function populateFilters() {
    for (const [key, select] of filterInputs) {
      const values = new Set(snapshot.entries.flatMap(entry => entry.configurations.map(item => item.facets[key]).filter(value => value != null).map(String)));
      if (filters[key]) values.add(filters[key]); // Never silently remove a user's explicit filter.
      select.replaceChildren(new Option('전체 · 모르면 선택하지 않음', ''));
      for (const value of [...values].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }))) select.append(new Option(value, value));
      select.value = filters[key] ?? '';
    }
  }
  const controller = createReadController(read, state => {
    snapshot = state.snapshot; closeDetail(false);
    refresh.disabled = state.status === 'loading'; root.setAttribute('aria-busy', String(state.status === 'loading'));
    if (state.status === 'ready') { populateFilters(); renderResults(); return; }
    tbody.replaceChildren(); table.hidden = true; empty.hidden = false;
    if (state.status === 'loading') { status.textContent = '자료 조회 중'; empty.textContent = '조회가 끝나면 검색어에 맞는 후보를 표시합니다.'; }
    if (state.status === 'not_connected') { status.textContent = '조회 연결 대기'; empty.textContent = '차종 마스터 읽기 연결이 아직 없습니다. 예시 차량을 실제 자료처럼 표시하지 않습니다.'; }
    if (state.status === 'error') { status.textContent = '조회 실패'; empty.textContent = '자료를 불러오지 못했습니다. 차량이 없다는 뜻은 아닙니다. 검색어를 유지한 채 다시 조회할 수 있습니다.'; }
  });
  listen(refresh, 'click', () => { void controller.refresh(); });
  listen(input, 'compositionstart', () => { composing = true; });
  listen(input, 'compositionend', () => { composing = false; renderResults(); });
  listen(input, 'input', event => { if (!composing && !event.isComposing) renderResults(); });
  listen(filterToggle, 'click', () => { filterPanel.hidden = !filterPanel.hidden; filterToggle.setAttribute('aria-expanded', String(!filterPanel.hidden)); });
  listen(reset, 'click', () => { filters = {}; for (const select of filterInputs.values()) select.value = ''; renderResults(); });
  listen(root, 'keydown', event => { if (event.key === 'Escape' && inspectedId) { event.preventDefault(); closeDetail(); } });
  const ready = controller.refresh();
  return { ready, refresh: () => controller.refresh(), destroy() { disposed = true; controller.dispose(); events.abort(); root.replaceChildren(); root.classList.remove('vf', 'vf-inspecting'); } };
}
