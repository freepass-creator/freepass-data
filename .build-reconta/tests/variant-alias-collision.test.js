import { describe, expect, it } from 'vitest';
import { dropVariantAliasCollisions, refineEngineIdentity } from '../src/application/identity-promotion-plan.js';
// 마스터 트림 문서는 변형 행(하이브리드)도 원래 세부모델 이름을 별칭으로 들고 있어 일반 행과 동률 → 매번 AMBIGUOUS_MASTER (대표 2026-10-22 «99대 정리»).
const m = (over) => ({ maker: '현대', model: '아반떼', model_aliases: [], sub_model_aliases: [],
    yearFrom: 2020, yearTo: 2023, trims: [{ name: '스마트', aliases: [] }], ...over });
const base = m({ id: 'base', sub_model: '아반떼 CN7' });
const hybrid = m({ id: 'hyb', sub_model: '아반떼 하이브리드 CN7', sub_model_aliases: ['아반떼 CN7', '아반떼 HEV'] });
// 세대 쌍: «더 뉴» 행의 별칭 «아반떼 CN7» 은 연식으로 가르는 근거라 일반 행(변형 아님)에서는 건드리지 않는다.
const facelift = m({ id: 'fl', sub_model: '더 뉴 아반떼 CN7', yearFrom: 2023, yearTo: null, sub_model_aliases: ['아반떼 CN7'] });
describe('변형 행 별칭 충돌 제외', () => {
    it('변형 행이 일반 행의 이름과 같은 별칭을 가지면 그 별칭만 뺀다(다른 별칭·일반 행·세대 쌍은 그대로)', () => {
        const out = dropVariantAliasCollisions([base, hybrid, facelift]);
        expect(out.find(x => x.id === 'hyb').sub_model_aliases).toEqual(['아반떼 HEV']);
        expect(out.find(x => x.id === 'base')).toBe(base);
        expect(out.find(x => x.id === 'fl').sub_model_aliases).toEqual(['아반떼 CN7']);
    });
    it('충돌 제외 전에는 원문 «아반떼 CN7» 이 보류, 제외 후에는 일반 행으로 하나로 특정되고 변형 낱말이 있으면 변형 행', () => {
        const before = [base, hybrid];
        expect(refineEngineIdentity({ rawName: '현대_아반떼_아반떼 CN7', year: '2021' }, before)).toBeNull(); // 동률 → 보류
        const after = dropVariantAliasCollisions(before);
        expect(refineEngineIdentity({ rawName: '현대_아반떼_아반떼 CN7', year: '2021' }, after)?.sub_model).toBe('아반떼 CN7');
        expect(refineEngineIdentity({ rawName: '현대_아반떼 하이브리드 CN7_스마트', year: '2021' }, after)?.sub_model).toBe('아반떼 하이브리드 CN7');
    });
    it('같은 모델의 일반 행이 없으면(충돌 아님) 별칭을 그대로 둔다', () => {
        const lone = m({ id: 'solo', sub_model: '쏘나타 하이브리드 DN8', model: '쏘나타', sub_model_aliases: ['쏘나타 DN8'] });
        expect(dropVariantAliasCollisions([lone])[0]).toBe(lone);
    });
});
describe('변형 행 별칭 충돌 제외 — Codex 반례', () => {
    it('연식 범위가 갈리는 일반 행과의 같은 이름 별칭은 연식 근거라 남긴다', () => {
        const old = m({ id: 'old', sub_model: '아반떼 CN7', yearFrom: 2010, yearTo: 2015 });
        const hyb = m({ id: 'hyb2', sub_model: '아반떼 하이브리드 CN7', yearFrom: 2020, yearTo: null, sub_model_aliases: ['아반떼 CN7'] });
        expect(dropVariantAliasCollisions([old, hyb]).find(x => x.id === 'hyb2').sub_model_aliases).toEqual(['아반떼 CN7']);
    });
    it('영문 표기 변형(HYBRID·ELECTRIC·E-TECH·전기차)도 변형 행으로 본다', () => {
        const b = m({ id: 'b3', sub_model: '코나 OS', model: '코나' });
        for (const [i, name] of ['코나 HYBRID OS', '코나 ELECTRIC OS', '코나 E-TECH OS', '코나 전기차 OS'].entries()) {
            const v = m({ id: 'v' + i, sub_model: name, model: '코나', sub_model_aliases: ['코나 OS'] });
            expect(dropVariantAliasCollisions([b, v]).find(x => x.id === 'v' + i).sub_model_aliases).toEqual([]);
        }
    });
});
