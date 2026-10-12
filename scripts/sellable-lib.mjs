// 공통 시트(F05) 줄 판매 가능 판정 — 순수 함수 (대표 2026-10-12: «출고불가» 외 전부 판매 가능, 숨긴 줄(행 숨기기·필터 숨김)도 출고불가로 본다).
export const F05_NOT_SELLABLE_STATUS = '출고불가';

/** 한 줄이 판매 가능한가. 숨긴 줄은 차량상태와 무관하게 판매 불가. */
export function f05RowSellable({ status, hidden = false }) {
  if (hidden) return false;
  return String(status ?? '').trim() !== F05_NOT_SELLABLE_STATUS;
}

/**
 * spreadsheets.get(ranges=탭!A:A, includeGridData) 응답에서 탭별 «숨긴 줄 번호(1부터)» 집합을 만든다.
 * rowMetadata[i] 가 hiddenByUser(행 숨기기) 또는 hiddenByFilter(필터 숨김)이면 숨긴 줄. 응답에 없는 줄은 보이는 줄.
 */
export function hiddenRowsByTab(response) {
  const out = new Map();
  for (const sheet of response?.sheets ?? []) {
    const title = sheet?.properties?.title; if (!title) continue;
    const set = new Set();
    for (const grid of sheet.data ?? []) {
      const start = (grid.startRow ?? 0);
      (grid.rowMetadata ?? []).forEach((m, i) => { if (m && (m.hiddenByUser === true || m.hiddenByFilter === true)) set.add(start + i + 1); });
    }
    out.set(title, set);
  }
  return out;
}
