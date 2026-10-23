/** «쓰는 쪽 하나» 임대(writer lease) 순수 판정 — 대표/PC1 커맨드 2026-10-23.
 *  실행기(시간당·F05·RP031·마음카·사진)마다 레인 하나에 «지금 쓰는 PC·만료 시각» 임대 문서를 두고, 실행기는 회차 시작에 확인·갱신한다.
 *  내 PC 가 아니면 쓰기 0 으로 끝난다. 예약을 끄고 켜는 싸움 대신 임대만 넘긴다.
 *  원칙: 임대가 없거나 읽지 못하면 «쓰지 않는다»(닫힘). 다른 PC 의 임대는 만료돼도 자동으로 가져오지 않는다(명시 인수만). */
export const LEASE_COLLECTION = 'writer_leases';
export const LEASE_LANE_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const LEASE_PC_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,18}[A-Z0-9]$/;
export const LEASE_DEFAULT_TTL_MIN = 180;

export type Lease = { lane: string; holder: string; epoch: number; acquiredAt: string; renewedAt: string; expiresAt: string; ttlMin: number; note?: string; previousHolder?: string | null };

export function assertLane(lane: unknown): string {
  if (typeof lane !== 'string' || !LEASE_LANE_PATTERN.test(lane)) throw new Error('WRITER_LEASE_LANE_INVALID');
  return lane;
}
export function assertPc(pc: unknown): string {
  if (typeof pc !== 'string' || !LEASE_PC_PATTERN.test(pc)) throw new Error('WRITER_LEASE_PC_INVALID');
  return pc;
}
export function assertTtl(ttlMin: unknown): number {
  if (typeof ttlMin !== 'number' || !Number.isInteger(ttlMin) || ttlMin < 10 || ttlMin > 1440) throw new Error('WRITER_LEASE_TTL_INVALID');
  return ttlMin;
}
/** 저장된 값 검증: 모양이 틀리면 null(= 임대 없음과 같게 닫힘이 아니라 «손상»으로 구분하려고 호출자가 throw). */
export function parseLease(v: unknown): Lease | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const ok = typeof o.lane === 'string' && typeof o.holder === 'string' && typeof o.epoch === 'number' && Number.isInteger(o.epoch)
    && [o.acquiredAt, o.renewedAt, o.expiresAt].every(t => typeof t === 'string' && Number.isFinite(Date.parse(t as string))) && typeof o.ttlMin === 'number'
    && (o.epoch as number) >= 1 && (o.ttlMin as number) >= 10 && (o.ttlMin as number) <= 1440 && Date.parse(o.expiresAt as string) > Date.parse(o.renewedAt as string);
  if (!ok) return null;
  return { lane: o.lane as string, holder: o.holder as string, epoch: o.epoch as number, acquiredAt: o.acquiredAt as string, renewedAt: o.renewedAt as string,
    expiresAt: o.expiresAt as string, ttlMin: o.ttlMin as number, ...(typeof o.note === 'string' ? { note: o.note } : {}), previousHolder: typeof o.previousHolder === 'string' ? o.previousHolder : null };
}
const iso = (ms: number) => new Date(ms).toISOString();
const expired = (l: Lease, nowMs: number) => Date.parse(l.expiresAt) <= nowMs;

export type CheckDecision =
  | { status: 'HELD'; lease: Lease }                                       // 내 임대, 갱신 필요 없음
  | { status: 'HELD_RENEW'; next: Lease }                                  // 내 임대, 남은 시간이 절반 이하 → 갱신
  | { status: 'NOT_HELD'; holder: string; expired: boolean }
  | { status: 'NO_LEASE' };

/** 회차 시작 확인: 내 임대면 쓰기 허용(남은 시간이 절반 아래면 갱신). 내 임대가 만료됐어도 아무도 인수하지 않았으면 갱신해 계속 쓴다(CAS 가 동시 인수를 막는다). */
export function decideCheck(lease: Lease | null, me: string, nowMs: number): CheckDecision {
  if (!lease) return { status: 'NO_LEASE' };
  if (lease.holder !== me) return { status: 'NOT_HELD', holder: lease.holder, expired: expired(lease, nowMs) };
  const remaining = Date.parse(lease.expiresAt) - nowMs;
  if (remaining > (lease.ttlMin * 60_000) / 2) return { status: 'HELD', lease };
  return { status: 'HELD_RENEW', next: { ...lease, renewedAt: iso(nowMs), expiresAt: iso(nowMs + lease.ttlMin * 60_000) } };
}

export type ClaimDecision = { status: 'CREATE' | 'RENEW' | 'TAKE_EXPIRED'; next: Lease } | { status: 'REFUSED'; reason: 'HELD_BY_OTHER_UNEXPIRED'; holder: string };
/** 인수(claim): 임대가 없으면 만들고, 내 것이면 갱신, 남의 것이 «만료됐을 때만» 가져온다. 만료 전의 이전은 transfer(현재 보유자 지정) 로만. */
export function decideClaim(lease: Lease | null, lane: string, me: string, ttlMin: number, nowMs: number, note?: string): ClaimDecision {
  const base = { lane, ttlMin, renewedAt: iso(nowMs), expiresAt: iso(nowMs + ttlMin * 60_000), ...(note ? { note } : {}) };
  if (!lease) return { status: 'CREATE', next: { ...base, holder: me, epoch: 1, acquiredAt: iso(nowMs), previousHolder: null } };
  if (lease.holder === me) return { status: 'RENEW', next: { ...lease, ...base, acquiredAt: lease.acquiredAt } };
  if (expired(lease, nowMs)) return { status: 'TAKE_EXPIRED', next: { ...base, holder: me, epoch: lease.epoch + 1, acquiredAt: iso(nowMs), previousHolder: lease.holder } };
  return { status: 'REFUSED', reason: 'HELD_BY_OTHER_UNEXPIRED', holder: lease.holder };
}

export type TransferDecision = { status: 'TRANSFER'; next: Lease } | { status: 'REFUSED'; reason: 'NO_LEASE' | 'FROM_MISMATCH' | 'EPOCH_MISMATCH' | 'SAME_HOLDER'; holder?: string };
/** 이전(transfer): 현재 보유자(from)와 에포크가 명령과 같을 때만 새 보유자(to)에게 넘긴다(오래된 명령 방지). */
export function decideTransfer(lease: Lease | null, from: string, to: string, expectedEpoch: number, ttlMin: number, nowMs: number, note?: string): TransferDecision {
  if (!lease) return { status: 'REFUSED', reason: 'NO_LEASE' };
  if (lease.holder !== from) return { status: 'REFUSED', reason: 'FROM_MISMATCH', holder: lease.holder };
  if (lease.epoch !== expectedEpoch) return { status: 'REFUSED', reason: 'EPOCH_MISMATCH' };
  if (from === to) return { status: 'REFUSED', reason: 'SAME_HOLDER' };
  return { status: 'TRANSFER', next: { lane: lease.lane, holder: to, epoch: lease.epoch + 1, acquiredAt: iso(nowMs), renewedAt: iso(nowMs), expiresAt: iso(nowMs + ttlMin * 60_000), ttlMin, previousHolder: from, ...(note ? { note } : {}) } };
}

/** 환경 설정: WRITER_LEASE_ENFORCE=1 일 때만 켜진다(기본 꺼짐). 켜면 레인(WRITER_LEASE_LANE)과 내 PC 이름(WRITER_LEASE_PC)이 반드시 있어야 하고, 없으면 쓰지 않는다. */
export function leaseConfigFromEnv(env: NodeJS.ProcessEnv): { lane: string; pc: string; ttlMin: number } | null {
  const enforce = env.WRITER_LEASE_ENFORCE?.trim();
  if (!enforce || enforce === '0') return null;
  if (enforce !== '1') throw new Error('WRITER_LEASE_ENFORCE_INVALID');   // 오타(true 등)는 조용히 열지 않고 닫는다
  const ttlRaw = env.WRITER_LEASE_TTL_MIN?.trim();
  return { lane: assertLane(env.WRITER_LEASE_LANE?.trim()), pc: assertPc(env.WRITER_LEASE_PC?.trim()), ttlMin: ttlRaw ? assertTtl(Number(ttlRaw)) : LEASE_DEFAULT_TTL_MIN };
}
