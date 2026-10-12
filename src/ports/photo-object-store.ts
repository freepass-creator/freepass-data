/** 사진 렌디션·매니페스트 객체 저장소 포트. 객체는 이름이 내용 주소라 덮어쓰지 않는다(이미 있으면 EXISTS). */
export interface PhotoObjectStore {
  getObject(name: string): Promise<Buffer | null>;
  createObject(name: string, bytes: Buffer, contentType: string): Promise<'CREATED' | 'EXISTS'>;
}
