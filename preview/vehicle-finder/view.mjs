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
      (input.guidance.suggestedNextAxis != null && !text(input.guidance.suggestedNextAxis)) ||
      (input.guidance.noResultReason != null && !text(input.guidance.noResultReason)) ||
      (input.guidance.noResultTitle != null && !text(input.guidance.noResultTitle)) ||
      (input.guidance.noResultMessage != null && !text(input.guidance.noResultMessage))) {
    invalid('guidance');
  }
  if (!text(input.observationId) || !text(input.observedAt) || !Number.isFinite(Date.parse(input.observedAt))) {
    invalid('observation');
  }
  if (!['COMPLETE', 'PARTIAL'].includes(input.coverage)) invalid('coverage');
  if (!Number.isSafeInteger(input.total) || input.total < 0 || typeof input.hasMore !== 'boolean') invalid('resultMeta');
  if (!Array.isArray(input.items)) invalid('items');
  if (input.groups != null && !Array.isArray(input.groups)) invalid('groups');
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
    if (item.action != null &&
        (!item.action || !text(item.action.code) || !text(item.action.label) ||
          !Array.isArray(item.action.reasons) ||
          item.action.reasons.some(reason => !text(reason)) ||
          !Array.isArray(item.action.reasonDetails) ||
          item.action.reasonDetails.some(detail =>
            !detail || !text(detail.code) || !text(detail.title) ||
            !text(detail.message) || !text(detail.nextStep)))) {
      invalid('itemAction');
    }
    if (item.unresolved != null &&
        (!item.unresolved || !Array.isArray(item.unresolved.axes) ||
          !Number.isSafeInteger(item.unresolved.searchTokenCount) ||
          item.unresolved.searchTokenCount < 0 ||
          item.unresolved.axes.some(axis =>
            !axis || !text(axis.code) ||
            (axis.label != null && !text(axis.label))))) {
      invalid('itemUnresolved');
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

  if (input.groups != null) {
    const groupIds = new Set();
    const groupedMembers = new Set();
    for (const group of input.groups) {
      if (!group || !text(group.id) || groupIds.has(group.id) ||
          !text(group.label) || !text(group.representativeId) ||
          !Array.isArray(group.memberIds) ||
          !Array.isArray(group.drilldowns) ||
          !Number.isSafeInteger(group.candidateCount) || group.candidateCount < 1 ||
          group.memberIds.length !== group.candidateCount ||
          typeof group.expandable !== 'boolean') {
        invalid('group');
      }
      for (const drilldown of group.drilldowns) {
        if (!drilldown || !text(drilldown.axis) ||
            (drilldown.label != null && !text(drilldown.label)) ||
            !Array.isArray(drilldown.options) ||
            !Number.isSafeInteger(drilldown.selectableCandidateCount) ||
            !Number.isSafeInteger(drilldown.unknownValueCount)) {
          invalid('groupDrilldown');
        }
        for (const option of drilldown.options) {
          if (!option || !text(option.label) ||
              (option.id != null && !text(option.id)) ||
              (option.value != null && !Number.isFinite(option.value)) ||
              !Number.isSafeInteger(option.count) || option.count < 0) {
            invalid('groupDrilldownOption');
          }
        }
      }
      groupIds.add(group.id);
      if (!group.memberIds.includes(group.representativeId)) invalid('groupRepresentative');
      for (const memberId of group.memberIds) {
        if (!ids.has(memberId) || groupedMembers.has(memberId)) invalid('groupMember');
        groupedMembers.add(memberId);
      }
    }
    if (groupedMembers.size !== input.items.length) invalid('groupCoverage');
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

function formatAgeMs(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return '경과시간 미확인';
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return '1분 미만';
  if (minutes < 60) return minutes + '분';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + '시간 ' + (minutes % 60) + '분';
  const days = Math.floor(hours / 24);
  return days + '일 ' + (hours % 24) + '시간';
}

function groupTransitionRejectedMessage(reason) {
  switch (reason) {
    case 'GROUP_NOT_FOUND':
      return '그룹 상태가 바뀌었습니다. 최신 결과를 다시 확인해 주세요.';
    case 'UNRESOLVED_GROUP_IDENTITY':
      return '이 그룹은 모델·세대 정체성이 확정되지 않아 조건으로 좁힐 수 없습니다.';
    case 'DRILLDOWN_AXIS_NOT_AVAILABLE':
      return '이 조건은 현재 그룹에서 더 이상 사용할 수 없습니다.';
    case 'DRILLDOWN_OPTION_NOT_AVAILABLE':
      return '선택한 값은 현재 그룹에서 더 이상 사용할 수 없습니다.';
    default:
      return '현재 상태에서는 이 조건을 적용할 수 없습니다.';
  }
}

function stateBadge(item) {
  const badge = element('span', 'vf-state-badge', item.state.label);
  badge.dataset.tone = item.state.tone ?? 'neutral';
  return badge;
}

export function mountVehicleFinder(
  root,
  {
    read,
    onSelect,
    onFinalize,
    onRevalidate,
    onGroupDrilldown,
    initialMode = 'NEW_CAR',
  } = {},
) {
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
  let readContext = null;
  let finalizationReview = null;
  let finalizationContext = null;
  let confirmedReceipt = null;
  let receiptRevalidationReview = null;
  let activeDrilldownKey = null;
  const expandedGroupIds = new Set();
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
  detail.setAttribute('role', 'region');
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

  function filterFocusableElements() {
    return [...filterPanel.querySelectorAll(
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter(node => !node.hidden && node.getClientRects().length > 0);
  }

  function setFilterPanel(open, { restoreFocus = false } = {}) {
    filterPanel.hidden = !open;
    filterToggle.setAttribute('aria-expanded', String(open));
    root.classList.toggle('vf-filter-open', open && mobileMedia.matches);

    if (open && mobileMedia.matches) {
      filterPanel.setAttribute('role', 'dialog');
      filterPanel.setAttribute('aria-modal', 'true');
      filterPanel.setAttribute('aria-labelledby', filterSheetTitle.id);
      lockFilterContext();
      requestAnimationFrame(() => {
        (filterFocusableElements()[0] ?? filterPanel).focus?.({ preventScroll: true });
      });
    } else {
      filterPanel.removeAttribute('role');
      filterPanel.removeAttribute('aria-modal');
      filterPanel.removeAttribute('aria-labelledby');
      unlockFilterContext();
      if (restoreFocus && mobileMedia.matches) {
        requestAnimationFrame(() => {
          filterToggle.focus({ preventScroll: true });
        });
      }
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
    finalizationReview = null;
    finalizationContext = null;
    confirmedReceipt = null;
    receiptRevalidationReview = null;
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
    if (finalizationReview && finalizationReview.itemId !== item.id) {
      finalizationReview = null;
      finalizationContext = null;
      confirmedReceipt = null;
      receiptRevalidationReview = null;
    }
    const detailHead = element('div', 'vf-detail-head');
    const detailTitle = element('div', 'vf-detail-title');
    const detailHeading = element('h2', '', item.label);
    detailHeading.id = prefix + '-detail-heading';
    detailHeading.tabIndex = -1;
    detail.setAttribute('aria-labelledby', detailHeading.id);
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
    if (item.action) {
      const actionBadge = element('span', 'vf-action-state', item.action.label);
      actionBadge.dataset.action = item.action.code;
      resultMeta.append(actionBadge);
    }

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

    if (item.action && item.action.code !== 'SELECT') {
      const reasons = element('section', 'vf-action-reasons');
      reasons.dataset.action = item.action.code;
      const heading = element(
        'strong',
        'vf-action-reasons-heading',
        item.action.code === 'BLOCKED'
          ? '현재 선택할 수 없는 이유'
          : '선택 전 확인할 내용',
      );
      reasons.append(heading);

      if (item.action.reasonDetails.length) {
        const reasonList = element('div', 'vf-action-reason-list');
        for (const reason of item.action.reasonDetails) {
          const card = element('article', 'vf-action-reason-card');
          const title = element('div', 'vf-action-reason-title');
          title.append(
            element('strong', '', reason.title),
            element('code', 'vf-action-reason-code', reason.code),
          );
          card.append(
            title,
            element('p', 'vf-action-reason-message', reason.message),
            element('p', 'vf-action-reason-next', '다음 확인 · ' + reason.nextStep),
          );
          reasonList.append(card);
        }
        reasons.append(reasonList);
      }

      const unresolved = item.unresolved ?? { axes: [], searchTokenCount: 0 };
      if (unresolved.axes.length || unresolved.searchTokenCount > 0) {
        const unresolvedBox = element('div', 'vf-unresolved');
        unresolvedBox.append(element('strong', '', '미확인 항목'));
        const chips = element('div', 'vf-unresolved-chips');
        for (const axis of unresolved.axes) {
          const chip = element(
            'span',
            'vf-unresolved-chip',
            axis.label ?? axis.code,
          );
          chip.title = axis.code;
          chips.append(chip);
        }
        if (unresolved.searchTokenCount > 0) {
          chips.append(
            element(
              'span',
              'vf-unresolved-chip',
              '검색어 ' + unresolved.searchTokenCount + '개',
            ),
          );
        }
        unresolvedBox.append(chips);
        reasons.append(unresolvedBox);
      }
      detail._actionReasons = reasons;
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

    const finalization = element('section', 'vf-finalization');
    finalization.hidden = true;

    const renderFinalization = () => {
      finalization.replaceChildren();
      if (!finalizationReview) {
        finalization.hidden = true;
        return;
      }

      finalization.hidden = false;
      finalization.dataset.status = finalizationReview.status;
      const heading = element(
        'strong',
        'vf-finalization-heading',
        finalizationReview.status === 'APPROVED'
          ? '최종 확정 전 검토'
          : '현재는 최종 확정할 수 없습니다',
      );
      finalization.append(heading);

      if (finalizationReview.status === 'APPROVED') {
        finalization.append(
          element(
            'p',
            'vf-finalization-copy',
            'F 최종화 검증을 통과했습니다. 차량 정보와 근거를 마지막으로 확인한 뒤 확정하세요.',
          ),
          element(
            'code',
            'vf-finalization-record',
            finalizationReview.recordId ?? item.id,
          ),
        );
      } else {
        const list = element('div', 'vf-finalization-reasons');
        for (const reason of finalizationReview.reasons ?? []) {
          const card = element('article', 'vf-finalization-reason');
          const title = element('div', 'vf-finalization-reason-title');
          title.append(
            element('strong', '', reason.title),
            element('code', '', reason.code),
          );
          card.append(
            title,
            element('p', '', reason.message),
            element('p', 'vf-finalization-next', '다음 확인 · ' + reason.nextStep),
          );
          list.append(card);
        }
        finalization.append(list);
      }
    };

    const actions = element('div', 'vf-actionbar');
    const back = element('button', 'vf-back vf-secondary', '목록으로');
    back.type = 'button';
    listen(back, 'click', () => closeDetail());

    const primary = element('button', 'vf-primary');
    primary.type = 'button';
    const syncPrimary = () => {
      if (item.action?.code === 'INSPECT_ONLY') {
        primary.textContent = '확인만 가능';
        primary.disabled = true;
        return;
      }
      if (item.action?.code === 'BLOCKED') {
        primary.textContent = '선택할 수 없음';
        primary.disabled = true;
        return;
      }
      if (typeof onFinalize === 'function') {
        if (!finalizationReview) {
          primary.textContent = '최종 선택 검토';
          primary.disabled = false;
          return;
        }
        if (finalizationReview.status === 'HOLD' || !finalizationReview.canConfirm) {
          primary.textContent = '확정 보류';
          primary.disabled = true;
          return;
        }
        primary.textContent = '이 차량으로 확정';
        primary.disabled = false;
        return;
      }
      primary.textContent = '이 차량 선택';
      primary.disabled = item.selectable === false;
    };

    const renderReceiptRevalidation = (container) => {
      if (!receiptRevalidationReview) return;

      const review = element('section', 'vf-revalidation');
      review.dataset.status = receiptRevalidationReview.status;
      review.append(
        element(
          'strong',
          'vf-revalidation-heading',
          receiptRevalidationReview.status === 'CURRENT'
            ? '현재도 유효한 선택입니다'
            : '다시 선택이 필요합니다',
        ),
        element(
          'span',
          'vf-revalidation-age',
          'receipt 발급 후 ' + formatAgeMs(receiptRevalidationReview.ageMs),
        ),
      );

      if (receiptRevalidationReview.status === 'CURRENT') {
        review.append(
          element(
            'p',
            'vf-revalidation-copy',
            'F 재검증에서 현재 차량과 기존 선택 조건이 계속 유효한 것으로 확인되었습니다.',
          ),
        );
      } else {
        const reasons = element('div', 'vf-revalidation-reasons');
        for (const reason of receiptRevalidationReview.reasons) {
          const card = element('article', 'vf-revalidation-reason');
          const title = element('div', 'vf-revalidation-reason-title');
          title.append(
            element('strong', '', reason.title),
            element('code', '', reason.code),
          );
          card.append(
            title,
            element('p', '', reason.message),
            element('p', 'vf-revalidation-next', '다음 확인 · ' + reason.nextStep),
          );
          reasons.append(card);
        }
        review.append(reasons);

        const reselect = element('button', 'vf-reselect vf-secondary', '목록에서 다시 선택');
        reselect.type = 'button';
        listen(reselect, 'click', () => {
          confirmedReceipt = null;
          receiptRevalidationReview = null;
          finalizationReview = null;
          finalizationContext = null;
          closeDetail();
        });
        review.append(reselect);
      }

      if (receiptRevalidationReview.currentRecordChanged) {
        const digest = element('details', 'vf-revalidation-digest');
        digest.append(element('summary', '', '변경 digest 확인'));
        digest.append(
          element('code', '', '확정 당시 ' + receiptRevalidationReview.snapshotRecordDigest),
          element('code', '', '현재 ' + (receiptRevalidationReview.currentRecordDigest ?? '없음')),
        );
        review.append(digest);
      }

      container.append(review);
    };

    const showReceipt = (receipt, { preserveRevalidation = false } = {}) => {
      if (!receipt) return;
      confirmedReceipt = structuredClone(receipt);
      if (!preserveRevalidation) receiptRevalidationReview = null;

      const receiptBox = element('section', 'vf-receipt');
      receiptBox.append(
        element('strong', '', '선택 확정 완료'),
        element('div', '', receipt.receiptId ?? 'receipt id 없음'),
        element('div', '', receipt.issuedAt ?? '발급시각 없음'),
      );
      if (receipt.snapshotDigest) {
        receiptBox.append(element('code', '', 'snapshot ' + receipt.snapshotDigest));
      }
      if (receipt.receiptDigest) {
        receiptBox.append(element('code', '', 'receipt ' + receipt.receiptDigest));
      }

      if (typeof onRevalidate === 'function') {
        const revalidate = element('button', 'vf-revalidate vf-secondary', '유효성 다시 확인');
        revalidate.type = 'button';
        listen(revalidate, 'click', async () => {
          revalidate.disabled = true;
          revalidate.textContent = '재검증 중';
          try {
            const response = await onRevalidate({
              receipt: structuredClone(confirmedReceipt),
              id: item.id,
              observationId: snapshot.observationId,
              mode,
              readContext,
            });
            if (!response?.review ||
                !['CURRENT', 'RESELECT_REQUIRED'].includes(response.review.status) ||
                !Array.isArray(response.review.reasons)) {
              invalid('revalidationResponse');
            }
            receiptRevalidationReview = structuredClone(response.review);
            status.textContent =
              response.review.status === 'CURRENT'
                ? item.label + ' 선택 유효'
                : item.label + ' 다시 선택 필요';
            showReceipt(confirmedReceipt, { preserveRevalidation: true });
            primary.textContent =
              response.review.status === 'CURRENT'
                ? '확정 완료'
                : '다시 선택 필요';
            primary.disabled = true;
          } catch {
            status.textContent =
              'receipt 재검증을 완료하지 못했습니다. 기존 확정 정보는 유지됩니다.';
            revalidate.disabled = false;
            revalidate.textContent = '유효성 다시 확인';
          }
        });
        receiptBox.append(revalidate);
      }

      renderReceiptRevalidation(receiptBox);
      finalization.replaceChildren(receiptBox);
      finalization.hidden = false;
      finalization.dataset.status =
        receiptRevalidationReview?.status === 'RESELECT_REQUIRED'
          ? 'RESELECT_REQUIRED'
          : 'CONFIRMED';
    };

    listen(primary, 'click', async () => {
      if (primary.disabled) return;

      if (typeof onFinalize === 'function' && !finalizationReview) {
        primary.disabled = true;
        primary.textContent = '검토 중';
        try {
          const response = await onFinalize({
            id: item.id,
            observationId: snapshot.observationId,
            mode,
            query,
            filters: { ...filters },
            readContext,
          });
          if (!response?.review ||
              !['APPROVED', 'HOLD'].includes(response.review.status) ||
              !Array.isArray(response.review.reasons)) {
            invalid('finalizationResponse');
          }
          finalizationReview = {
            ...structuredClone(response.review),
            itemId: item.id,
          };
          finalizationContext = response.finalizationContext ?? null;
          renderFinalization();
          syncPrimary();
          status.textContent =
            response.review.status === 'APPROVED'
              ? item.label + ' 최종 검토 통과'
              : item.label + ' 최종 확정 보류';
        } catch {
          status.textContent =
            '최종 검토를 완료하지 못했습니다. 현재 후보와 입력은 유지됩니다.';
          finalizationReview = null;
          finalizationContext = null;
          syncPrimary();
        }
        return;
      }

      if (typeof onSelect !== 'function') return;
      primary.disabled = true;
      primary.textContent = '확정 중';
      try {
        const response = await onSelect({
          id: item.id,
          observationId: snapshot.observationId,
          stateCode: item.state.code,
          finalizationContext,
        });
        status.textContent = item.label + ' 선택 완료';
        showReceipt(response?.receipt ?? null);
        primary.textContent = '확정 완료';
        primary.disabled = true;
      } catch {
        status.textContent =
          '선택을 완료하지 못했습니다. 최종 검토 결과와 후보는 유지됩니다.';
        syncPrimary();
      }
    });

    syncPrimary();
    actions.append(back, primary);

    detail.append(detailHead, resultMeta);
    if (detail._actionReasons) {
      detail.append(detail._actionReasons);
      delete detail._actionReasons;
    }
    detail.append(trust, facts, evidence, finalization, actions);
    renderFinalization();
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

  function candidateRow(item) {
    const row = element('tr');
    row.classList.add('vf-candidate-row');
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
    return row;
  }

  async function applyGroupDrilldown(group, drilldown, option, button) {
    if (typeof onGroupDrilldown !== 'function' || activeDrilldownKey) return;

    const key = group.id + ':' + drilldown.axis + ':' + option.label;
    activeDrilldownKey = key;
    button.disabled = true;
    root.setAttribute('aria-busy', 'true');
    setReadNotice(
      'drilldown',
      (drilldown.label ?? drilldown.axis) + ' 조건을 적용하고 있습니다',
      '현재 후보를 유지한 채 F 전이 결과를 확인합니다.',
    );

    try {
      const response = await onGroupDrilldown({
        mode,
        groupId: group.id,
        axis: drilldown.axis,
        option: structuredClone(option),
        observationId: snapshot.observationId,
        query,
        filters: { ...filters },
        readContext,
      });

      if (!response || !response.transition ||
          !['APPLIED', 'REJECTED'].includes(response.transition.status)) {
        invalid('groupDrilldownResponse');
      }

      if (response.transition.status === 'REJECTED') {
        setReadNotice(
          'drilldown-rejected',
          '이 조건으로는 후보를 좁힐 수 없습니다',
          response.message ??
            groupTransitionRejectedMessage(response.transition.reason) +
              ' [' + (response.transition.reason ?? 'UNKNOWN') + ']',
        );
        return;
      }

      const next = validateSnapshot(response.snapshot);
      if (next.mode !== mode) invalid('modeEcho');
      snapshot = next;
      readContext = response.readContext ?? null;
      finalizationReview = null;
      finalizationContext = null;
      confirmedReceipt = null;
      receiptRevalidationReview = null;
      inspectedId = null;
      detail.hidden = true;
      root.classList.remove('vf-inspecting');
      expandedGroupIds.clear();
      if (response.transition.activeGroupId) {
        expandedGroupIds.add(response.transition.activeGroupId);
      }
      renderSnapshot(
        '후보 ' + response.transition.beforeCandidateCount +
          '개 → ' + response.transition.afterCandidateCount + '개',
      );
      setReadNotice(
        'drilldown-applied',
        '그룹 조건을 적용했습니다',
        response.transition.clearedAxes?.length
          ? '충돌하는 기존 조건 ' + response.transition.clearedAxes.length + '개가 정리되었습니다.'
          : '선택한 조건으로 후보 범위를 좁혔습니다.',
      );
    } catch {
      setReadNotice(
        'drilldown-error',
        '그룹 조건을 적용하지 못했습니다',
        '기존 후보는 그대로 유지됩니다. 다시 시도해 주세요.',
      );
    } finally {
      activeDrilldownKey = null;
      button.disabled = false;
      root.setAttribute('aria-busy', 'false');
    }
  }

  function groupRow(group) {
    const row = element('tr', 'vf-group-row');
    const cell = element('td');
    cell.colSpan = 2;

    const button = element('button', 'vf-group-button');
    button.type = 'button';
    button.dataset.groupId = group.id;
    const expanded = expandedGroupIds.has(group.id);
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute(
      'aria-label',
      group.label + ' · ' + group.candidateCount + '개 후보 · ' +
        (expanded ? '접기' : '후보 펼치기'),
    );

    const main = element('span', 'vf-group-main');
    main.append(
      element('strong', 'vf-group-title', group.label),
      element('span', 'vf-group-count', group.candidateCount + '개 후보'),
    );
    if (group.context) {
      main.append(element('span', 'vf-group-context', group.context));
    }

    const meta = element('span', 'vf-group-meta');
    if (group.selectableCount) {
      meta.append(element('span', 'vf-group-stat', '선택 ' + group.selectableCount));
    }
    if (group.inspectOnlyCount) {
      meta.append(element('span', 'vf-group-stat', '확인 ' + group.inspectOnlyCount));
    }
    if (group.blockedCount) {
      meta.append(element('span', 'vf-group-stat', '보류 ' + group.blockedCount));
    }
    if (group.suggestedDrilldownLabel) {
      meta.append(
        element('span', 'vf-group-next', '먼저 보기 · ' + group.suggestedDrilldownLabel),
      );
    }

    const disclosure = element(
      'span',
      'vf-group-disclosure',
      expanded ? '접기' : '후보 보기',
    );
    button.append(main, meta, disclosure);
    listen(button, 'click', () => {
      if (expandedGroupIds.has(group.id)) expandedGroupIds.delete(group.id);
      else expandedGroupIds.add(group.id);
      renderRows();
      root.querySelector(
        '[data-group-id="' + CSS.escape(group.id) + '"]',
      )?.focus({ preventScroll: true });
    });

    cell.append(button);

    if (expanded && typeof onGroupDrilldown === 'function' &&
        group.suggestedDrilldownAxis) {
      const drilldown = group.drilldowns.find(
        (item) => item.axis === group.suggestedDrilldownAxis,
      );
      if (drilldown?.options.length) {
        const panel = element('div', 'vf-group-drilldown');
        panel.append(
          element(
            'strong',
            'vf-group-drilldown-title',
            (drilldown.label ?? drilldown.axis) + ' 조건으로 좁히기',
          ),
        );
        const choices = element('div', 'vf-group-drilldown-options');
        for (const option of drilldown.options) {
          const choice = element(
            'button',
            'vf-group-drilldown-option',
            option.label + (option.count ? ' · ' + option.count : ''),
          );
          choice.type = 'button';
          choice.dataset.axis = drilldown.axis;
          listen(choice, 'click', () => {
            void applyGroupDrilldown(group, drilldown, option, choice);
          });
          choices.append(choice);
        }
        panel.append(choices);
        if (drilldown.unknownValueCount > 0) {
          panel.append(
            element(
              'span',
              'vf-group-drilldown-unknown',
              '값 미확인 ' + drilldown.unknownValueCount + '개',
            ),
          );
        }
        cell.append(panel);
      }
    }

    row.append(cell);
    return row;
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
        snapshot.guidance.noResultTitle ?? '일부 자료에서 후보를 찾지 못했습니다',
        snapshot.guidance.noResultMessage ??
          '현재 관측 범위 안에서만 0건입니다. 전체 차량에 후보가 없다는 뜻은 아닙니다. 검색어와 필터는 유지됩니다.',
      );
    } else {
      setEmptyState(
        'zero',
        snapshot.guidance.noResultTitle ?? '일치하는 후보가 없습니다',
        snapshot.guidance.noResultMessage ??
          '현재 완료된 관측 범위에서 조건과 일치하는 후보가 없습니다. 검색어와 필터는 유지됩니다.',
      );
    }

    const itemsById = new Map(snapshot.items.map((item) => [item.id, item]));
    const groups = snapshot.groups ?? [];

    if (!groups.length) {
      for (const item of snapshot.items) tbody.append(candidateRow(item));
      return;
    }

    for (const group of groups) {
      const members = group.memberIds
        .map((id) => itemsById.get(id))
        .filter(Boolean);

      if (!group.expandable || group.candidateCount === 1) {
        if (members[0]) tbody.append(candidateRow(members[0]));
        continue;
      }

      tbody.append(groupRow(group));
      if (!expandedGroupIds.has(group.id)) continue;

      for (const member of members) {
        const row = candidateRow(member);
        row.classList.add('vf-group-member');
        row.dataset.groupId = group.id;
        tbody.append(row);
      }
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
    if (snapshot.groups) {
      const validGroupIds = new Set(snapshot.groups.map((group) => group.id));
      for (const groupId of expandedGroupIds) {
        if (!validGroupIds.has(groupId)) expandedGroupIds.delete(groupId);
      }
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
      const next = validateSnapshot(await read({
        mode,
        query,
        filters: { ...filters },
        readContext,
      }));
      if (next.mode !== mode) invalid('modeEcho');
      if (disposed || seq !== requestSeq) return;
      snapshot = next;
      finalizationReview = null;
      finalizationContext = null;
      confirmedReceipt = null;
      receiptRevalidationReview = null;
      renderSnapshot();
      if (inspectedId) {
        const refreshedItem = snapshot.items.find((item) => item.id === inspectedId);
        if (refreshedItem) renderDetail(refreshedItem);
      }
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
    expandedGroupIds.clear();
    readContext = null;
    finalizationReview = null;
    finalizationContext = null;
    confirmedReceipt = null;
    receiptRevalidationReview = null;
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
  listen(filterToggle, 'click', () => {
    const opening = filterPanel.hidden;
    setFilterPanel(opening, { restoreFocus: !opening });
  });
  listen(filterClose, 'click', () => setFilterPanel(false, { restoreFocus: true }));
  listen(filterDone, 'click', () => setFilterPanel(false, { restoreFocus: true }));
  listen(reset, 'click', () => {
    filters = {};
    readContext = null;
    populateFilters();
    void refreshResults({ preserve: true });
  });
  listen(mobileMedia, 'change', () => {
    setFilterPanel(!mobileMedia.matches);
  });
  listen(root, 'keydown', event => {
    if (event.key === 'Tab' && !filterPanel.hidden && mobileMedia.matches) {
      const focusable = filterFocusableElements();
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const activeIndex = focusable.indexOf(document.activeElement);
      if (event.shiftKey && activeIndex <= 0) {
        event.preventDefault();
        focusable.at(-1)?.focus({ preventScroll: true });
        return;
      }
      if (!event.shiftKey && activeIndex === focusable.length - 1) {
        event.preventDefault();
        focusable[0]?.focus({ preventScroll: true });
        return;
      }
      if (activeIndex < 0) {
        event.preventDefault();
        focusable[0]?.focus({ preventScroll: true });
        return;
      }
    }

    if (event.key !== 'Escape') return;
    if (!filterPanel.hidden) {
      event.preventDefault();
      setFilterPanel(false, { restoreFocus: true });
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
