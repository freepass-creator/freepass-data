const SIGNED_KEYS = /^(expires?|signature|sig|token|x-amz-[a-z-]+|x-goog-[a-z-]+|se|sp|sv|sr|policy|key-pair-id|hmac|hash)$/i;
export const isSignedLooking = (url) => {
    try {
        for (const key of new URL(url).searchParams.keys())
            if (SIGNED_KEYS.test(key))
                return true;
    }
    catch {
        return false;
    }
    return false;
};
/** 표본 1건 판정. 이미지가 인증·Referer 없이 200 + image/* 이면 직접 열린다. */
export function classifyPhotoUrlSample(s) {
    const imageLike = (s.contentType ?? '').toLowerCase().startsWith('image/');
    if (s.statusPlain === 0 && s.statusWithReferer === 0)
        return 'UNREACHABLE';
    if (s.statusPlain === 401 || s.statusPlain === 403)
        return s.statusWithReferer === 200 && imageLike ? 'NEEDS_REFERER' : 'NEEDS_AUTH';
    if (s.statusPlain >= 200 && s.statusPlain < 300) {
        if (!imageLike)
            return 'NOT_IMAGE';
        if (s.signedLooking || s.expires)
            return 'EXPIRING';
        return 'DIRECT_OPEN';
    }
    return 'NEEDS_AUTH';
}
/** 표본 묶음 판정: 전부 DIRECT_OPEN 이어야 «직접 노출 가능», 하나라도 만료성이면 복사 전환 권고. */
export function summarizePhotoUrlProbe(samples) {
    const counts = { DIRECT_OPEN: 0, NEEDS_AUTH: 0, NEEDS_REFERER: 0, EXPIRING: 0, NOT_IMAGE: 0, UNREACHABLE: 0, MIXED: 0 };
    for (const sample of samples)
        counts[classifyPhotoUrlSample(sample)]++;
    if (!samples.length)
        return { verdict: 'UNREACHABLE', counts, recommendation: 'INCONCLUSIVE' };
    const kinds = Object.keys(counts).filter(k => counts[k] > 0);
    const verdict = kinds.length === 1 ? kinds[0] : 'MIXED';
    const recommendation = counts.DIRECT_OPEN === samples.length ? 'URL_AS_IS'
        : counts.UNREACHABLE === samples.length ? 'INCONCLUSIVE' : 'COPY_TO_DRIVE';
    return { verdict, counts, recommendation };
}
