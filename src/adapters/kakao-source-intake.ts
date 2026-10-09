import { createHash } from 'node:crypto';
import { stableDigest } from '../shared/stable-digest.js';
import type { SourceIntakeBatch } from '../domain/source-intake.js';

export type KakaoAttachment = { bytesBase64: string; mediaType: string; role: 'VEHICLE_PHOTO' | 'DOCUMENT' | 'UNKNOWN' };
export type KakaoMessage = {
  messageId?: string; senderKey?: string; sentAt: string; sequence?: string;
  /** A sequence must be shared across collectors, never a PC-local row number. */
  sequenceScope?: 'ROOM'; text: string; attachments: KakaoAttachment[];
  captureVerified: boolean; version: number;
  vehicle?: { supplierVehicleId?: string; plate?: string; evidenceText: string };
  sheetConflict?: boolean;
  /** Output of a verified local CSV/XLSX reader, tied to the original bytes and cell locations. */
  tables?: Array<{ attachmentSha256: string; extractorVersion: string; verified: boolean;
    sheet: string; startRow: number; rows: string[][] }>;
};
export type KakaoBundle = {
  supplierCode: string; roomId: string; collectorId: string; observedAt: string;
  messages: KakaoMessage[];
};
export const bytesSha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const instant = (v: unknown): v is string => typeof v === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v)
  && Number.isFinite(Date.parse(v));
const nonblank = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export function prepareKakaoBundle(bundle: KakaoBundle) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(bundle.supplierCode) || !nonblank(bundle.roomId)
    || !nonblank(bundle.collectorId) || !instant(bundle.observedAt) || !Array.isArray(bundle.messages)
    || !bundle.messages.length || bundle.messages.length > 100) throw new Error('INVALID_KAKAO_BUNDLE');
  const sourceId = `kakao:${stableDigest([bundle.supplierCode, bundle.roomId])}`;
  const observations = new Set<string>();
  return bundle.messages.map(message => {
    if (!instant(message.sentAt) || typeof message.text !== 'string' || !Array.isArray(message.attachments)
      || typeof message.captureVerified !== 'boolean' || !Number.isSafeInteger(message.version) || message.version < 0
      || message.attachments.length > 30) throw new Error('INVALID_KAKAO_MESSAGE');
    const identity = nonblank(message.messageId) ? ['카카오톡', bundle.roomId, message.messageId]
      : nonblank(message.senderKey) && nonblank(message.sequence) && message.sequenceScope === 'ROOM'
        ? ['카카오톡', bundle.roomId, message.senderKey, new Date(message.sentAt).toISOString(), message.sequence] : null;
    // JSON tuple framing prevents concatenation collisions (room ab/id c versus room a/id bc).
    const eventId = identity ? bytesSha256(Buffer.from(JSON.stringify(identity), 'utf8')) : null;
    const attachments = message.attachments.map(attachment => {
      if (!['VEHICLE_PHOTO', 'DOCUMENT', 'UNKNOWN'].includes(attachment.role)
        || !nonblank(attachment.mediaType) || typeof attachment.bytesBase64 !== 'string'
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attachment.bytesBase64))
        throw new Error('INVALID_KAKAO_ATTACHMENT');
      const bytes = Buffer.from(attachment.bytesBase64, 'base64');
      if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('KAKAO_ATTACHMENT_SIZE');
      return { sha256: bytesSha256(bytes), mediaType: attachment.mediaType, role: attachment.role, bytes };
    });
    if (message.tables !== undefined && !Array.isArray(message.tables)) throw new Error('INVALID_KAKAO_TABLE');
    const tables = message.tables ?? [];
    for (const table of tables) {
      if (!nonblank(table.extractorVersion) || !nonblank(table.sheet) || !Number.isSafeInteger(table.startRow)
        || table.startRow < 1 || typeof table.verified !== 'boolean' || !Array.isArray(table.rows)
        || table.rows.some(row => !Array.isArray(row) || row.some(cell => typeof cell !== 'string'))
        || !attachments.some(a => a.sha256 === table.attachmentSha256 && a.role === 'DOCUMENT'
          && ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(a.mediaType)))
        throw new Error('INVALID_KAKAO_TABLE');
    }
    const original = { ...message, attachments: attachments.map(({ bytes, ...metadata }) => metadata) };
    if (Buffer.byteLength(JSON.stringify(original), 'utf8') > 700_000) throw new Error('KAKAO_RAW_SIZE_LIMIT');
    const fingerprint = stableDigest(original);
    const observationId = stableDigest([eventId, bundle.collectorId, bundle.observedAt, fingerprint]);
    if (observations.has(observationId)) throw new Error('DUPLICATE_KAKAO_OBSERVATION');
    observations.add(observationId);
    const issues = [
      ...(!eventId ? ['IDENTITY_UNRESOLVED'] : []),
      ...(!message.captureVerified ? ['CAPTURE_UNVERIFIED'] : []),
      ...(message.sheetConflict ? ['CONFLICT'] : []),
      ...(attachments.some(x => x.role === 'UNKNOWN') ? ['ATTACHMENT_ROLE_UNRESOLVED'] : []),
      ...(attachments.some(x => x.role === 'DOCUMENT' && !tables.some(t => t.attachmentSha256 === x.sha256 && t.verified))
        ? ['DOCUMENT_EXTRACTION_HOLD'] : []),
      ...(attachments.some(x => x.role === 'VEHICLE_PHOTO' && (!x.mediaType.startsWith('image/')
        || attachments.some(y => y.sha256 === x.sha256 && y.role !== x.role))) ? ['ATTACHMENT_ROLE_CONFLICT'] : []),
    ];
    const classification = message.text.includes('2차 없습니다') ? 'STATUS_NOTICE_CANDIDATE'
      : message.text.includes('매물') ? 'PARTIAL_INVENTORY_CANDIDATE'
        : tables.some(t => t.verified) ? 'TABLE_CANDIDATE' : 'UNCLASSIFIED';
    const directory = eventId ? `원문/카카오톡/${bundle.supplierCode}/${message.sentAt.slice(0, 7)}/${eventId}/` : null;
    const batch: SourceIntakeBatch = {
      laneId: 'PRODUCT_VEHICLE', source: { sourceId, kind: 'FILE', displayName: '카카오톡 공급사 원천',
        authorityScope: ['supplier-message-evidence'] }, observedAt: bundle.observedAt,
      sourceRevision: String(message.version),
      coverage: { mode: 'PARTIAL', completeness: message.captureVerified ? 'COMPLETE' : 'INCOMPLETE',
        scope: 'ONE_SUPPLIER_ONE_ROOM', note: 'Absence never establishes deletion or stock zero.' },
      records: [{ sourceRecordId: observationId, sourceFingerprint: fingerprint,
        payload: { eventId, observationId, collectorId: bundle.collectorId, supplierCode: bundle.supplierCode,
          roomId: bundle.roomId, original, issues, classification, directory, ruleVersion: 'kakao-intake/1' } }],
    };
    const originalBytes = Buffer.from(JSON.stringify(original), 'utf8');
    return { eventId, observationId, fingerprint, message, batch, directory, issues, classification,
      archives: [{ sha256: bytesSha256(originalBytes), mediaType: 'application/json', role: 'DOCUMENT' as const, bytes: originalBytes }, ...attachments],
      attachments, deletionCount: 0 as const, stockZeroAsserted: false as const };
  });
}
export type PreparedKakaoMessage = ReturnType<typeof prepareKakaoBundle>[number];
