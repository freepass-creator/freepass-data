import { describe, expect, it } from 'vitest';
import { classifyPhotoUrlSample, isSignedLooking, summarizePhotoUrlProbe, type PhotoUrlProbeSample } from '../src/adapters/sonogong-photo-probe.js';

const sample = (over: Partial<PhotoUrlProbeSample> = {}): PhotoUrlProbeSample => ({ statusPlain: 200, statusWithReferer: 200, contentType: 'image/jpeg', contentLength: 100,
  cacheControl: 'public, max-age=31536000', expires: null, signedLooking: false, sameHostAsApi: false, redirected: false, corsOpen: false, ...over });

describe('손오공 사진 URL 직접 열림 판정(읽기 전용 진단)', () => {
  it('open without auth or referer, image content type, no signed query → DIRECT_OPEN', () => {
    expect(classifyPhotoUrlSample(sample())).toBe('DIRECT_OPEN');
    expect(classifyPhotoUrlSample(sample({ statusPlain: 206 }))).toBe('DIRECT_OPEN');   // Range 0-0 응답
  });
  it('signed-looking query, an Expires header, an auth/referer wall, non-image or transport failure are never DIRECT_OPEN', () => {
    expect(classifyPhotoUrlSample(sample({ signedLooking: true }))).toBe('EXPIRING');
    expect(classifyPhotoUrlSample(sample({ expires: 'Wed, 15 Oct 2026 12:00:00 GMT' }))).toBe('EXPIRING');
    expect(classifyPhotoUrlSample(sample({ statusPlain: 403, statusWithReferer: 200 }))).toBe('NEEDS_REFERER');
    expect(classifyPhotoUrlSample(sample({ statusPlain: 401, statusWithReferer: 401 }))).toBe('NEEDS_AUTH');
    expect(classifyPhotoUrlSample(sample({ contentType: 'text/html' }))).toBe('NOT_IMAGE');
    expect(classifyPhotoUrlSample(sample({ statusPlain: 0, statusWithReferer: 0 }))).toBe('UNREACHABLE');
    expect(classifyPhotoUrlSample(sample({ statusPlain: 404, statusWithReferer: 404 }))).toBe('NEEDS_AUTH');
  });
  it('detects expiring/signature-style query keys without exposing the URL', () => {
    expect(isSignedLooking('https://cdn.example.invalid/a.jpg?Expires=1&Signature=x')).toBe(true);
    expect(isSignedLooking('https://cdn.example.invalid/a.jpg?X-Amz-Signature=x')).toBe(true);
    expect(isSignedLooking('https://cdn.example.invalid/a.jpg?w=640')).toBe(false);
    expect(isSignedLooking('https://cdn.example.invalid/a.jpg')).toBe(false);
    expect(isSignedLooking('not a url')).toBe(false);
  });
  it('the batch recommendation: all direct → URL as is; any failure → copy to drive; all unreachable → inconclusive', () => {
    expect(summarizePhotoUrlProbe([sample(), sample()])).toMatchObject({ verdict: 'DIRECT_OPEN', recommendation: 'URL_AS_IS' });
    expect(summarizePhotoUrlProbe([sample(), sample({ signedLooking: true })])).toMatchObject({ verdict: 'MIXED', recommendation: 'COPY_TO_DRIVE' });
    expect(summarizePhotoUrlProbe([sample({ statusPlain: 403, statusWithReferer: 403 })])).toMatchObject({ verdict: 'NEEDS_AUTH', recommendation: 'COPY_TO_DRIVE' });
    expect(summarizePhotoUrlProbe([sample({ statusPlain: 0, statusWithReferer: 0 })])).toMatchObject({ recommendation: 'INCONCLUSIVE' });
    expect(summarizePhotoUrlProbe([])).toMatchObject({ recommendation: 'INCONCLUSIVE' });
  });
});
