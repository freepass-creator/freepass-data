/** 사진 폴더 이름이 차량번호와 맞는지(승인 사진 등록 전 검증): «번호» 또는 «번호 차종…». 공백·유니코드 정규화 후 접두 일치, 번호 뒤에 숫자가 붙으면 다른 번호. */
const squash = (value: unknown): string => [...String(value ?? '').normalize('NFC')].filter(ch => ch.trim() !== '').join('');
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

export function folderMatchesPlate(folderName: unknown, plate: unknown): boolean {
  const name = squash(folderName), want = squash(plate);
  if (!want) return false;
  return name === want || (name.startsWith(want) && !isDigit(name.charAt(want.length)));
}
