// 공통 시트(F05) 줄 판매 가능 판정 — 순수 함수 (대표 2026-10-12: «출고불가» 외 전부 판매 가능, 숨긴 줄(행 숨기기·필터 숨김)도 출고불가로 본다).
export const F05_NOT_SELLABLE_STATUS = '출고불가';

/** 한 줄이 판매 가능한가. 숨긴 줄은 차량상태와 무관하게 판매 불가. */
export function f05RowSellable({ status, hidden = false }) {
  if (hidden) return false;
  return String(status ?? '').trim() !== F05_NOT_SELLABLE_STATUS;
}

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** 차량번호 전체가 들어갈 수 있는 증거 파일은 저장소(.git 이 있는 폴더 아래) 밖에만 쓴다. 안이면 즉시 중단. */
export function assertPrivateOutputPath(path) {
  if (!path) return;
  for (let dir = dirname(resolve(path)); ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, '.git'))) throw new Error('OUTPUT_PATH_INSIDE_REPOSITORY');
    if (dirname(dir) === dir) break;
  }
}

/** 화면·로그 출력에서 차량번호(예 123가4567)를 끝 4자리만 남긴다. 중첩 객체도 문자열로 바꿔 한 번에 가린다. */
export function maskPlates(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  return text.replace(/\d{2,3}\s?[가-힣]\s?(\d{4})/g, '…$1');
}

/** 읽기 전용 도구의 fail-closed: 불완전·실패한 읽기(blockers)가 하나라도 있으면 계획 생성을 중단한다. 오류 메시지는 고정 코드만. */
export function assertPlanComplete(blockers) {
  if (!blockers || blockers.length === 0) return;
  console.error(`PLAN_BLOCKED ${blockers.join(' ')}`);
  throw Object.assign(new Error('PLAN_BLOCKED'), { blockers });
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
