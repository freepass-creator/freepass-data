/** 사진 폴더 이름이 차량번호와 맞는지(승인 사진 등록 전 검증): «번호» 또는 «번호 차종…». 공백·유니코드 정규화 후 접두 일치, 번호 뒤에 숫자가 붙으면 다른 번호. */
const squash = (value) => [...String(value ?? '').normalize('NFC')].filter(ch => ch.trim() !== '').join('');
const isDigit = (ch) => ch >= '0' && ch <= '9';
export function folderMatchesPlate(folderName, plate) {
    const want = squash(plate);
    if (!want)
        return false;
    // 원본 이름(공백 보존)에서 번호를 앞에서부터 맞춘다(번호 안의 공백은 건너뜀). 번호 «바로 뒤» 글자가 숫자면 다른 번호(133하45310),
    // 공백 뒤 숫자는 차종(«109호4100 5시리즈» — 공백을 지운 «41005시리즈» 로 오판하지 않는다).
    const name = String(folderName ?? '').normalize('NFC');
    let matched = 0, i = 0;
    for (; i < name.length && matched < want.length; i++) {
        const ch = name.charAt(i);
        if (ch.trim() === '')
            continue;
        if (ch !== want.charAt(matched))
            return false;
        matched++;
    }
    if (matched < want.length)
        return false;
    return i >= name.length || !isDigit(name.charAt(i));
}
/** 공급사 사진 폴더(«번호» 또는 «번호 차종…») 이름에서 차량번호를 꺼낸다. 첫 낱말이 번호 모양이 아니면 null(추정하지 않는다). */
export function plateFromFolderName(folderName) {
    const first = String(folderName ?? '').normalize('NFC').trim().split(/\s+/)[0] ?? '';
    const m = /^(\d{2,3}[가-힣]\d{4})(?!\d)/.exec(first);
    return m ? m[1] : null;
}
/** 공급사 루트 폴더의 직계 폴더 목록 → «번호, 폴더 id» 행. 같은 번호 폴더가 둘 이상이면 그 번호는 빼고 ambiguous 로 돌려준다(사람이 합친 뒤 다음 회차). */
export function plateFoldersFromChildren(children) {
    const byPlate = new Map();
    let skipped = 0;
    for (const c of children) {
        const plate = plateFromFolderName(c.name);
        if (!plate) {
            skipped++;
            continue;
        }
        byPlate.set(plate, [...(byPlate.get(plate) ?? []), c.id]);
    }
    const rows = [], ambiguous = [];
    for (const [plate, ids] of [...byPlate].sort(([a], [b]) => a.localeCompare(b))) {
        if (ids.length === 1)
            rows.push({ plate, folder: ids[0] });
        else
            ambiguous.push(plate);
    }
    return { rows, ambiguous, skipped };
}
