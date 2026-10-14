/** 손오공 API 사진 URL 직접 열림 확인(읽기 전용 진단) — 순수 판정 부분. URL·키는 어디에도 남기지 않고 상태 코드·헤더 «종류»·불리언만 낸다.
 * 근거 질문(커맨드 센터 2026-10-15): API 사진 URL 이 만료·인증·Referer 없이 브라우저에서 직접 열리는가 → 직접 열리면 URL 그대로 노출,
 * 아니면 이안카 방식(드라이브 복사)으로 전환. */
export type PhotoUrlProbeSample = {
  /** 인증 헤더·Referer 없이 받은 상태 코드(0 = 전송 실패). */ statusPlain: number;
  /** 우리 화면 출처를 Referer 로 준 상태 코드(0 = 전송 실패). */ statusWithReferer: number;
  contentType: string | null; contentLength: number | null; cacheControl: string | null; expires: string | null;
  /** URL 에 만료·서명성 쿼리 키(Expires·Signature·X-Amz·token·sig 등)가 있는가. */ signedLooking: boolean;
  /** URL 호스트가 공급사 API 호스트와 같은가(같으면 인증 쿠키·키 없이도 열리는지가 핵심). */ sameHostAsApi: boolean;
  /** 응답이 리다이렉트였는가. */ redirected: boolean;
  /** 교차 출처 로드 허용 신호(Access-Control-Allow-Origin 이 * 또는 우리 출처) — <img> 는 CORS 와 무관하지만 참고. */ corsOpen: boolean;
};
export type PhotoUrlProbeVerdict = 'DIRECT_OPEN' | 'NEEDS_AUTH' | 'NEEDS_REFERER' | 'EXPIRING' | 'NOT_IMAGE' | 'UNREACHABLE' | 'MIXED';

const SIGNED_KEYS = /^(expires?|signature|sig|token|x-amz-[a-z-]+|x-goog-[a-z-]+|se|sp|sv|sr|policy|key-pair-id|hmac|hash)$/i;
export const isSignedLooking = (url: string): boolean => {
  try { for (const key of new URL(url).searchParams.keys()) if (SIGNED_KEYS.test(key)) return true; } catch { return false; }
  return false;
};

/** 표본 1건 판정. 이미지가 인증·Referer 없이 200 + image/* 이면 직접 열린다. */
export function classifyPhotoUrlSample(s: PhotoUrlProbeSample): PhotoUrlProbeVerdict {
  const imageLike = (s.contentType ?? '').toLowerCase().startsWith('image/');
  if (s.statusPlain === 0 && s.statusWithReferer === 0) return 'UNREACHABLE';
  if (s.statusPlain === 401 || s.statusPlain === 403) return s.statusWithReferer === 200 && imageLike ? 'NEEDS_REFERER' : 'NEEDS_AUTH';
  if (s.statusPlain >= 200 && s.statusPlain < 300) {
    if (!imageLike) return 'NOT_IMAGE';
    if (s.signedLooking || s.expires) return 'EXPIRING';
    return 'DIRECT_OPEN';
  }
  return 'NEEDS_AUTH';
}

/** 표본 묶음 판정: 전부 DIRECT_OPEN 이어야 «직접 노출 가능», 하나라도 만료성이면 복사 전환 권고. */
export function summarizePhotoUrlProbe(samples: readonly PhotoUrlProbeSample[]): {
  verdict: PhotoUrlProbeVerdict; counts: Record<PhotoUrlProbeVerdict, number>; recommendation: 'URL_AS_IS' | 'COPY_TO_DRIVE' | 'INCONCLUSIVE';
} {
  const counts: Record<PhotoUrlProbeVerdict, number> = { DIRECT_OPEN: 0, NEEDS_AUTH: 0, NEEDS_REFERER: 0, EXPIRING: 0, NOT_IMAGE: 0, UNREACHABLE: 0, MIXED: 0 };
  for (const sample of samples) counts[classifyPhotoUrlSample(sample)]++;
  if (!samples.length) return { verdict: 'UNREACHABLE', counts, recommendation: 'INCONCLUSIVE' };
  const kinds = (Object.keys(counts) as PhotoUrlProbeVerdict[]).filter(k => counts[k] > 0);
  const verdict: PhotoUrlProbeVerdict = kinds.length === 1 ? kinds[0]! : 'MIXED';
  const recommendation = counts.DIRECT_OPEN === samples.length ? 'URL_AS_IS'
    : counts.UNREACHABLE === samples.length ? 'INCONCLUSIVE' : 'COPY_TO_DRIVE';
  return { verdict, counts, recommendation };
}
