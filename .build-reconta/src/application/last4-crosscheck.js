/** 끝 4자리 교차 대조(순수, 읽기 전용). 아이언 즉출 이미지(참고·대조용)와 홈페이지 정본 목록의 차이를 사람이 보게 하는 리포트 재료.
 * 결정 근거: ai-ops docs/대표-결정-장부.md 10-12 «공급사 원천 정본 지도» — 아이언은 홈페이지가 정본이다. 이 대조는 어떤 상품 문서도 바꾸지 않는다.
 * 입력은 차량번호(또는 이미 끝 4자리) 문자열 배열 두 개이고, 출력에는 끝 4자리만 나온다. 같은 끝 4자리가 한쪽에 둘 이상이면 «모호»로 따로 센다. */
/** 끝 4자리 숫자만 취한다(번호판 끝 숫자 4자리). 얻지 못하면 null. */
export const last4Of = (value) => {
    if (typeof value !== 'string')
        return null;
    const m = /(\d{4})\s*$/.exec(value.normalize('NFKC').trim());
    return m ? m[1] : null;
};
export function crosscheckLast4(homepage, image) {
    const unusable = { homepage: 0, image: 0 };
    const collect = (list, side) => {
        const counts = {};
        for (const v of list) {
            const key = last4Of(v);
            if (!key) {
                unusable[side]++;
                continue;
            }
            counts[key] = (counts[key] ?? 0) + 1;
        }
        return counts;
    };
    const h = collect(homepage, 'homepage'), i = collect(image, 'image');
    const ambiguous = [...new Set([...Object.keys(h).filter(k => h[k] > 1), ...Object.keys(i).filter(k => i[k] > 1)])].sort();
    const skip = new Set(ambiguous);
    const hk = Object.keys(h).filter(k => !skip.has(k)).sort(), ik = Object.keys(i).filter(k => !skip.has(k)).sort();
    return {
        homepageCount: homepage.length, imageCount: image.length,
        matched: hk.filter(k => k in i),
        onlyInHomepage: hk.filter(k => !(k in i)),
        onlyInImage: ik.filter(k => !(k in h)),
        ambiguous, unusable,
    };
}
