import { GoogleAuth, UserRefreshClient } from 'google-auth-library';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getTargetFirebaseApp, CENTRAL_FIREBASE_PROJECT_ID } from './firebase-target.js';
import { FirestoreSourceStore } from './source-firestore-store.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import { KakaoDriveArchive } from './kakao-drive-archive.js';
import { encodeIancarBackupValue } from './iancar-publication-withdrawal-firestore.js';
import { stableDigest } from '../shared/stable-digest.js';
import type { KakaoPhotoPlan, KakaoPhotoWriterPort, KakaoProductSnapshot } from '../ports/kakao-archive.js';

// NATIVE-SOURCE-COLLECTOR.md 매시 회차 덮어쓰기 조사: engine fb35bfb6,
// sheet-autoplus.ts:60-79 / ingest-reborncar-to-firestore.mts:114-116 overwrite photo_link.
const PHOTO_OVERWRITE_SUPPLIER = 'RP023';
const PRODUCTS = FIRESTORE_COLLECTIONS.legacyAdminWorkflow.products;
function productId(id: string) {
  if (!id || /[/\u0000-\u001f\u007f]/.test(id)) throw new Error('KAKAO_PRODUCT_ID_INVALID');
  return id;
}

/** Read the whole supplier scope so an input snapshot cannot hide an ambiguous match. */
export class KakaoProductReader {
  constructor(private readonly db: Firestore) {}
  async readSupplier(supplierCode: string): Promise<KakaoProductSnapshot[]> {
    if (!/^[A-Za-z0-9_-]+$/.test(supplierCode)) throw new Error('KAKAO_SUPPLIER_INVALID');
    const result = await this.db.collection(PRODUCTS).where('provider_company_code', '==', supplierCode).get();
    // No guessed provider-specific ID field. Plate matching works; ID-only matching remains HOLD.
    return result.docs.map(doc => ({ id: doc.id, data: doc.data() }));
  }
  async read(id: string): Promise<KakaoProductSnapshot | null> {
    const doc = await this.db.collection(PRODUCTS).doc(productId(id)).get();
    return doc.exists ? { id: doc.id, data: doc.data()! } : null;
  }
}

/** Dedicated, separately approved blank-fill writer. Source ingestion never calls it. */
export class KakaoPhotoWriter implements KakaoPhotoWriterPort {
  constructor(private readonly db: Firestore, private readonly backupDirectory: string | undefined,
    private readonly approval: string | undefined) {}
  private validate(plan: KakaoPhotoPlan) {
    productId(plan.productId);
    if (plan.holds.length || plan.field !== 'photo_link' || !/^[a-f0-9]{64}$/.test(plan.eventId)
      || !/^[a-f0-9]{64}$/.test(plan.expectedDigest) || !plan.archiveIds.length
      || plan.archiveIds.some(id => !/^[\w-]+$/.test(id)) || (plan.before != null && plan.before !== '')
      || plan.after !== plan.archiveIds.map(id => `https://drive.google.com/file/d/${id}/view`).join('\n'))
      throw new Error('PHOTO_PLAN_HOLD');
  }
  private async capture(plan: KakaoPhotoPlan) {
    this.validate(plan);
    const snapshot = await this.db.collection(PRODUCTS).doc(plan.productId).get();
    const data = snapshot.data();
    if (data?.provider_company_code === PHOTO_OVERWRITE_SUPPLIER || data?.partner_code === PHOTO_OVERWRITE_SUPPLIER)
      throw new Error('PHOTO_SUPPLIER_OVERWRITE_HOLD');
    if (!snapshot.exists || !snapshot.updateTime || !data || stableDigest(data) !== plan.expectedDigest
      || (data.photo_link ?? null) !== plan.before || (data.photo_link != null && data.photo_link !== ''))
      throw new Error('PHOTO_CAS_CONFLICT');
    const planDigest = stableDigest({ plan, seconds: snapshot.updateTime.seconds, nanoseconds: snapshot.updateTime.nanoseconds });
    return { snapshot, data, planDigest };
  }
  async dryRun(plan: KakaoPhotoPlan) {
    const { planDigest } = await this.capture(plan);
    return { planDigest, ready: true };
  }
  async apply(plan: KakaoPhotoPlan, approval: { planDigest: string }) {
    if (this.approval !== 'approved' || !this.backupDirectory || !isAbsolute(this.backupDirectory))
      throw new Error('PHOTO_APPLY_NOT_APPROVED');
    const { snapshot, data, planDigest } = await this.capture(plan);
    if (planDigest !== approval.planDigest) throw new Error('PHOTO_CAS_CONFLICT');
    const afterExpected = { ...data, photo_link: plan.after };
    const runId = randomUUID();
    await mkdir(this.backupDirectory, { recursive: true });
    const persist = async (phase: string, value: unknown) => {
      const path = join(this.backupDirectory!, `${runId}-${phase}.json`);
      const text = JSON.stringify(value);
      await writeFile(path, text, { flag: 'wx', mode: 0o600 });
      if (await readFile(path, 'utf8') !== text) throw new Error('PHOTO_BACKUP_READBACK_FAILED');
    };
    // Reuse the typed backup codec: timestamps/bytes are not lossy JSON strings.
    await persist('before', { schema: 'kakao-photo-backup/1', runId, planDigest, path: snapshot.ref.path,
      before: encodeIancarBackupValue(data), expectedAfter: encodeIancarBackupValue(afterExpected),
      updateTime: encodeIancarBackupValue(snapshot.updateTime) });
    try {
      await this.db.runTransaction(async tx => {
        const current = await tx.get(snapshot.ref);
        if (!current.updateTime?.isEqual(snapshot.updateTime!) || stableDigest(current.data()) !== plan.expectedDigest)
          throw new Error('PHOTO_CAS_CONFLICT');
        tx.update(snapshot.ref, { photo_link: plan.after });
      }, { maxAttempts: 1 });
    } catch (error) {
      if (error instanceof Error && error.message === 'PHOTO_CAS_CONFLICT') throw error;
      throw new Error('PHOTO_WRITE_UNKNOWN_RECONCILE_BACKUP');
    }
    const after = await snapshot.ref.get();
    await persist('after', { runId, planDigest, exists: after.exists,
      data: encodeIancarBackupValue(after.data() ?? null), updateTime: encodeIancarBackupValue(after.updateTime ?? null) });
    if (!after.exists || stableDigest(after.data()) !== stableDigest(afterExpected)) throw new Error('PHOTO_READBACK_MISMATCH');
    return { verified: true };
  }
}

/** Called only after CLI approval + --apply. No secrets, folder IDs or service-account fallback. */
export async function createKakaoPorts(env: NodeJS.ProcessEnv = process.env) {
  const root = env.FREEPASS_KAKAO_DRIVE_ROOT_ID;
  if (!root) throw new Error('KAKAO_DRIVE_ROOT_REQUIRED');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  if (!(client instanceof UserRefreshClient)) throw new Error('KAKAO_USER_ADC_REQUIRED');
  const token = async () => {
    const result = await client.getAccessToken();
    if (!result.token) throw new Error('KAKAO_USER_ADC_REQUIRED');
    return result.token;
  };
  const identity = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
    headers: { Authorization: `Bearer ${await token()}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!identity.ok || (await identity.json() as { user?: { emailAddress?: string } }).user?.emailAddress !== 'pyh@teamjpk.com')
    throw new Error('KAKAO_USER_ADC_REQUIRED');
  const app = getTargetFirebaseApp();
  if (app.options.projectId !== CENTRAL_FIREBASE_PROJECT_ID) throw new Error('KAKAO_WRONG_FIREBASE_TARGET');
  const db = getFirestore(app);
  return { store: new FirestoreSourceStore(db), drive: new KakaoDriveArchive(root, token),
    organizationDomain: 'teamjpk.com', products: [] as KakaoProductSnapshot[], productReader: new KakaoProductReader(db),
    photoWriter: new KakaoPhotoWriter(db, env.FREEPASS_KAKAO_PHOTO_BACKUP_DIR, env.FREEPASS_KAKAO_PHOTO_APPLY) };
}
