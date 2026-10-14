/** 사진 폴더 이름이 차량번호와 맞는지(승인 사진 등록 전 검증): «번호» 또는 «번호 차종…». 공백·유니코드 정규화 후 접두 일치, 번호 뒤에 숫자가 붙으면 다른 번호. */
const squash = (value: unknown): string => [...String(value ?? '').normalize('NFC')].filter(ch => ch.trim() !== '').join('');
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

export function folderMatchesPlate(folderName: unknown, plate: unknown): boolean {
  const name = squash(folderName), want = squash(plate);
  if (!want) return false;
  return name === want || (name.startsWith(want) && !isDigit(name.charAt(want.length)));
}

/** 공급사 사진 폴더(«번호» 또는 «번호 차종…») 이름에서 차량번호를 꺼낸다. 첫 낱말이 번호 모양이 아니면 null(추정하지 않는다). */
export function plateFromFolderName(folderName: unknown): string | null {
  const first = String(folderName ?? '').normalize('NFC').trim().split(/\s+/)[0] ?? '';
  const m = /^(\d{2,3}[가-힣]\d{4})(?!\d)/.exec(first);
  return m ? m[1]! : null;
}

/** 공급사 루트 폴더의 직계 폴더 목록 → «번호, 폴더 id» 행. 같은 번호 폴더가 둘 이상이면 그 번호는 빼고 ambiguous 로 돌려준다(사람이 합친 뒤 다음 회차). */
export function plateFoldersFromChildren(children: ReadonlyArray<{ id: string; name: string }>): { rows: Array<{ plate: string; folder: string }>; ambiguous: string[]; skipped: number } {
  const byPlate = new Map<string, string[]>();
  let skipped = 0;
  for (const c of children) {
    const plate = plateFromFolderName(c.name);
    if (!plate) { skipped++; continue; }
    byPlate.set(plate, [...(byPlate.get(plate) ?? []), c.id]);
  }
  const rows: Array<{ plate: string; folder: string }> = [], ambiguous: string[] = [];
  for (const [plate, ids] of [...byPlate].sort(([a], [b]) => a.localeCompare(b))) {
    if (ids.length === 1) rows.push({ plate, folder: ids[0]! }); else ambiguous.push(plate);
  }
  return { rows, ambiguous, skipped };
}
