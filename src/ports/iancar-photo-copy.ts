/** 이안카 사진 → 드라이브 복사 포트(application 오케스트레이션과 infra 드라이브 어댑터가 함께 쓰는 계약). 설계: docs/IANCAR-PHOTO-DRIVE-COPY-RUNBOOK-20261014.md */

/** label = 차종 표기(있으면 새 폴더 이름 «<번호> <차종>» 에 쓴다. 없으면 번호만). */
export type SourceVehicle = { vehicleId: string; plate: string; label?: string };
export interface PhotoCopySource {
  /** 판매 대상 차량(노출 대상 상태). 읽기가 신선하지 않으면 throw 'IANCAR_SOURCE_NOT_READY'. */
  listVehicles(): Promise<SourceVehicle[]>;
  /** 상세 조회 → 사진 id 목록(대표 먼저). 사진이 없으면 빈 배열. */
  photoIds(vehicle: SourceVehicle): Promise<string[]>;
  /** 사진 본문(래스터, 크기·시그니처 검증 완료). */
  download(vehicle: SourceVehicle, photoId: string): Promise<{ bytes: Buffer; contentType: string }>;
}
export type PhotoCompressor = (input: { bytes: Buffer; contentType: string }) => Promise<{ bytes: Buffer; contentType: 'image/jpeg' }>;
/** srcKey = 이 잡이 올린 파일의 원본 사진 표식(파일 속성). null = 이 잡이 올리지 않은 파일(기존 사진 정본 등). */
export type DriveFileInfo = { fileId: string; name: string; sha256: string | null; srcKey: string | null; image: boolean };
export type DriveVehicleFolder = { folderId: string; name: string; fingerprint: string | null; files: DriveFileInfo[] };
export interface PhotoCopyDrive {
  /** 읽기 전용: 이안카 폴더 아래에서 이름의 첫 토큰이 «번호»인 폴더(이름 «<번호>» 또는 «<번호> <차종…>»)를 모두 돌려준다. 파일 목록 포함. */
  findVehicleFolders(plate: string): Promise<DriveVehicleFolder[]>;
  /** 번호 폴더를 만든다(쓰기). 이름 = label 이 있으면 «<번호> <label>», 없으면 «<번호>». */
  createVehicleFolder(plate: string, label?: string): Promise<DriveVehicleFolder>;
  /** 파일 올리기 + 파일 속성(srcKey)·체크섬 확인. 올린 뒤 드라이브가 준 sha256 이 내 바이트와 다르면 throw 'DRIVE_UPLOAD_CHECKSUM_MISMATCH'. */
  upload(folderId: string, name: string, bytes: Buffer, srcKey: string): Promise<DriveFileInfo>;
  /** 모든 파일이 올라간 뒤에만 호출: 폴더 지문·시각 기록. */
  setFingerprint(folderId: string, fingerprint: string, copiedAtIso: string): Promise<void>;
}
