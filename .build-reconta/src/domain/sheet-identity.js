const text = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').normalize('NFKC').replace(/\s+/g, ' ').trim();
/** 헤더 이름으로 4칸을 읽는다. 제조사·모델·세부모델 중 하나라도 비면 후보 없음(undefined). 세부트림은 비어도 된다. */
export function sheetIdentityOf(headers, cells) {
    if (!Array.isArray(headers) || !Array.isArray(cells))
        return undefined;
    const at = (name) => text(cells[headers.findIndex(h => text(h) === name)]);
    const id = { maker: at('제조사'), model: at('모델'), sub_model: at('세부모델'), trim_name: at('세부트림') };
    return id.maker && id.model && id.sub_model ? id : undefined;
}
/** 저장된/전달된 raw.sheet_identity 를 검증해 되돌린다(모양이 틀리면 undefined). */
export function validSheetIdentity(v) {
    if (!v || typeof v !== 'object')
        return undefined;
    const o = v;
    const id = { maker: text(o.maker), model: text(o.model), sub_model: text(o.sub_model), trim_name: text(o.trim_name) };
    return id.maker && id.model && id.sub_model ? id : undefined;
}
