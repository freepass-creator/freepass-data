// 프리패스 데이터(차종 마스터) → F03 시트 «차종마스터» 탭 투영 계획.
// 대표 10-04: F03 은 정본이 아니라 프리패스 데이터를 보여 주는 투영이다 — 손으로 쓰지 않는다.
// 이 계획은 «없는 줄만 아래에 덧붙인다». 이미 있는 줄(사람·AI 검토 칸 포함)은 절대 건드리지 않고, 다른 점은 보고만 한다.

export interface TrimMasterRow {
  maker: string; model: string; sub_model: string; trim: string;
  origin?: string; production_start?: string; production_end?: string; trim_row_key?: string;
}
export interface VehicleMasterRow {
  id?: string; maker: string; model: string; sub_model: string;
  origin?: string; year_start?: string; year_end?: string; trims?: string[]; market_class?: string;
}
export const F03_HEADER = ['원산지', '제조사', '모델', '세부모델', '세부트림', '생산시작', '생산종료'] as const;
export const F03_WIDTH = 16; // A~P, 모델행키는 P(16번째)

const norm = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ');
export const f03Key = (maker: unknown, model: unknown, sub: unknown, trim: unknown) =>
  [maker, model, sub, trim].map((v) => norm(v).toLowerCase()).join('|');

export interface ProjectionRow { values: string[]; key: string; source: 'trim_master' | 'vehicle_master'; marketClass?: string }
export interface ProjectionPlan {
  append: ProjectionRow[];
  alreadyInSheet: number;
  sheetOnly: string[]; // 시트에는 있으나 정본에 없는 줄(보고만)
  nameDiffers: number; // 모델은 시트에 있으나 세부모델·트림 이름이 달라 덧붙이지 않은 정본 줄(보고만)
  makers: Record<string, number>;
  marketClassCounts: Record<string, number>;
}

function line(r: { origin?: string; maker: string; model: string; sub_model: string; trim: string; start?: string; end?: string; rowKey: string }): string[] {
  const v = new Array<string>(F03_WIDTH).fill('');
  v[0] = norm(r.origin); v[1] = norm(r.maker); v[2] = norm(r.model); v[3] = norm(r.sub_model); v[4] = norm(r.trim);
  v[5] = norm(r.start); v[6] = norm(r.end);
  v[13] = '확인 필요 · 정본 투영으로 추가'; // 종합판정(N) — 검토 칸은 비워 두고, 사람·AI 검토를 기다린다
  v[15] = r.rowKey;
  return v;
}

/** 정본 줄 = 트림 마스터 전부 + (트림 마스터에 없는) 차종 마스터의 세부트림 펼침. 시트에 없는 줄만 덧붙인다. */
export interface ProjectionOptions {
  /** 기본 true: 시트에 «모델(제조사+모델) 자체가 없는» 새 차만 덧붙인다. 시트에 모델이 있는데 세부모델·트림 이름만 다른 줄은 이름 차이로 보고만 한다(이중 등록 방지). */
  onlyNewModels?: boolean;
  /** 비어 있으면 전체 제조사. 값이 있으면 그 제조사만. */
  makers?: string[];
}

export function planF03Projection(input: { trimRows: TrimMasterRow[]; masterRows: VehicleMasterRow[]; sheetRows: string[][] }, options: ProjectionOptions = {}): ProjectionPlan {
  const onlyNew = options.onlyNewModels ?? true;
  const makerSet = new Set((options.makers ?? []).map((m) => norm(m).toLowerCase()).filter(Boolean));
  const have = new Set<string>();
  const haveModel = new Set<string>();
  for (const r of input.sheetRows) {
    have.add(f03Key(r[1], r[2], r[3], r[4]));
    haveModel.add(f03Key(r[1], r[2], '', ''));
  }

  const canon = new Map<string, ProjectionRow>();
  for (const t of input.trimRows) {
    const key = f03Key(t.maker, t.model, t.sub_model, t.trim);
    if (!norm(t.maker) || !norm(t.model) || !norm(t.trim)) continue;
    if (!canon.has(key)) canon.set(key, { key, source: 'trim_master', values: line({ ...t, start: t.production_start, end: t.production_end, rowKey: norm(t.trim_row_key) || `tm::${key}` }) });
  }
  for (const m of input.masterRows) {
    if (!norm(m.maker) || !norm(m.model)) continue;
    const sub = norm(m.sub_model) || norm(m.model);
    const trims = (m.trims ?? []).map(norm).filter(Boolean);
    (trims.length ? trims : ['기본형']).forEach((trim, i) => {
      const key = f03Key(m.maker, m.model, sub, trim);
      if (canon.has(key)) return;
      canon.set(key, {
        key, source: 'vehicle_master', marketClass: m.market_class,
        values: line({ origin: m.origin, maker: m.maker, model: m.model, sub_model: sub, trim, start: m.year_start, end: m.year_end, rowKey: `${norm(m.id)}::${i + 1}` }),
      });
    });
  }

  const missing = [...canon.values()].filter((r) => !have.has(r.key) && (!makerSet.size || makerSet.has(norm(r.values[1]).toLowerCase())));
  const append = onlyNew ? missing.filter((r) => !haveModel.has(f03Key(r.values[1], r.values[2], '', ''))) : missing;
  const nameDiffers = missing.length - append.length;
  const makers: Record<string, number> = {};
  const marketClassCounts: Record<string, number> = {};
  for (const r of append) {
    makers[r.values[1]] = (makers[r.values[1]] ?? 0) + 1;
    const mc = r.marketClass ?? '(트림 마스터)';
    marketClassCounts[mc] = (marketClassCounts[mc] ?? 0) + 1;
  }
  const sheetOnly = [...have].filter((k) => k !== '|||' && !canon.has(k));
  return { append, nameDiffers, alreadyInSheet: [...canon.keys()].filter((k) => have.has(k)).length, sheetOnly, makers, marketClassCounts };
}
