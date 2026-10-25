import { IancarOneApiError } from '../adapters/iancar-one-api.js';
const ownValue = (error, key) => Object.getOwnPropertyDescriptor(error, key)?.value;
/** Only locally recognised error types and literal codes may produce private diagnostic fields. */
export function classifyPhotoMetadataFailure(stage, error, transportAttempted = false) {
    let reason = 'UNKNOWN', httpStatus = null;
    try {
        if (error instanceof IancarOneApiError) {
            const code = ownValue(error, 'code'), status = ownValue(error, 'status');
            const safeStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
            if (stage === 'FETCH_DETAIL') {
                if (safeStatus !== null && code === `IANCAR_ONE_API_HTTP_${safeStatus}` || code === 'IANCAR_ONE_API_REDIRECT_REJECTED') {
                    reason = 'HTTP_FAILURE';
                    httpStatus = safeStatus;
                }
                else if (['IANCAR_ONE_API_EMPTY_RESPONSE', 'IANCAR_ONE_API_NON_JSON_RESPONSE', 'IANCAR_ONE_API_UNSUPPORTED_JSON'].includes(code)) {
                    reason = 'JSON_FAILURE';
                    httpStatus = safeStatus;
                }
            }
            else {
                if (code === 'IANCAR_PHOTO_IDENTITY_MISMATCH')
                    reason = 'IDENTITY_MISMATCH';
                else if (code === 'IANCAR_PHOTO_DETAIL_STALE')
                    reason = 'STALE_DETAIL';
                else if (['IANCAR_PHOTO_LIST_MISSING', 'IANCAR_PHOTO_LIMIT_EXCEEDED', 'IANCAR_PHOTO_REFERENCE_INVALID', 'IANCAR_PHOTO_REPRESENTATIVE_AMBIGUOUS'].includes(code))
                    reason = 'LIST_INVALID';
            }
        }
        else if (stage === 'FETCH_DETAIL' && transportAttempted) {
            if (error instanceof DOMException) {
                const nativeName = Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get?.call(error);
                if (nativeName === 'TimeoutError' || nativeName === 'AbortError')
                    reason = 'TIMEOUT';
            }
            else if (error instanceof TypeError)
                reason = 'TRANSPORT';
        }
    }
    catch {
        reason = 'UNKNOWN';
        httpStatus = null;
    }
    return { event: 'vehicle_photo_metadata_failure', stage: stage === 'FETCH_DETAIL' ? 'FETCH_DETAIL' : 'VALIDATE_METADATA', reason, httpStatus };
}
/** Observation is best effort and must never replace the original error or public result. */
export function logPhotoMetadataFailure(stage, error, transportAttempted = false, sink = diagnostic => console.log(JSON.stringify(diagnostic))) {
    try {
        const pending = sink(classifyPhotoMetadataFailure(stage, error, transportAttempted));
        if (pending)
            void Promise.resolve(pending).catch(() => { });
    }
    catch { /* Preserve the original failure. */ }
}
