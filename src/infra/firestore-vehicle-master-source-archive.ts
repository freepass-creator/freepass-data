import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import type { VehicleMasterSourceArchive, VehicleMasterArchiveInput } from '../ports/vehicle-master-source-archive.js';

const MAX_RAW_BYTES=4*1024*1024;
const MAX_COMPRESSED_BYTES=512*1024;
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
/** Same source-capture lifecycle; an immutable byte archive backed by the bound
 * Data Firestore instead of a second storage credential or a current master. */
export class FirestoreVehicleMasterSourceArchive implements VehicleMasterSourceArchive {
  constructor(private db:Firestore=getFirestore(getTargetFirebaseApp())) {}
  async archive(input:VehicleMasterArchiveInput):Promise<'CREATED'|'UNCHANGED'> {
    if(!input.storagePath||input.storagePath.startsWith('/')||input.storagePath.includes('..')||!/^vehicle-master\/source-documents\//.test(input.storagePath)) throw new Error('VEHICLE_MASTER_ARCHIVE_INVALID_PATH');
    if(!/^[a-f0-9]{64}$/.test(input.expectedSha256)||hash(input.bytes)!==input.expectedSha256) throw new Error('VEHICLE_MASTER_ARCHIVE_SHA256_MISMATCH');
    if(input.bytes.length>MAX_RAW_BYTES) throw new Error('VEHICLE_MASTER_ARCHIVE_TOO_LARGE');
    const compressed=gzipSync(input.bytes);
    if(compressed.length>MAX_COMPRESSED_BYTES) throw new Error('VEHICLE_MASTER_ARCHIVE_TOO_LARGE');
    const ref=this.db.collection(FIRESTORE_COLLECTIONS.source.vehicleMasterArchives).doc(hash(input.storagePath));
    return this.db.runTransaction(async tx=>{
      const old=await tx.get(ref);
      if(old.exists) {
        const value=old.data()!;
        if(value.storagePath!==input.storagePath||value.sha256!==input.expectedSha256||value.codec!=='gzip'||value.byteLength!==input.bytes.length) throw new Error('VEHICLE_MASTER_ARCHIVE_PATH_COLLISION');
        const bytes=gunzipSync(value.bytes as Buffer,{maxOutputLength:MAX_RAW_BYTES});
        if(hash(bytes)!==input.expectedSha256) throw new Error('VEHICLE_MASTER_ARCHIVE_STORED_BYTES_INVALID');
        return 'UNCHANGED';
      }
      tx.create(ref,{contract:'vehicle-master-source-archive/firestore-gzip/v1',storagePath:input.storagePath,sha256:input.expectedSha256,byteLength:input.bytes.length,codec:'gzip',contentType:input.contentType??null,bytes:compressed});
      return 'CREATED';
    });
  }
}
