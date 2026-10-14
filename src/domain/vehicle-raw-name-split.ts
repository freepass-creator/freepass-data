/** 공급사 원문 차명의 «결정적 분해»(순수, 대표 10-15 «원문을 그냥 때려 넣지 말라» — 커맨드 센터 요청).
 * 기준 한 장(ai-ops docs/차종-기준-한장.md)이 유일한 규칙이다: 이름은 «차종 마스터에 있는 이름만» 쓴다. 이 모듈은 이름을 짓지 않는다 —
 * 원문을 제조사·모델 원문·파워트레인 원문·세부트림 후보 낱말로 «쪼개기만» 하고, 쪼갠 조각은 마스터 일치 검증을 통과해야 쓰인다(identity-promotion-plan).
 * 쪼갤 수 없거나 구조가 어긋나면 구조 코드로 알리고 낱말을 지어내지 않는다. 원문은 호출자가 raw 에 그대로 보존한다. */

/** 규칙 0-1·7: 제조사 이름은 짧게(쉐보레·르노·KGM·도요타). 원문 표기 → 우리 짧은 이름. 표에 없으면 원문 그대로 둔다(마스터 일치에서 걸러짐). */
const MAKER_SHORT: ReadonlyArray<readonly [RegExp, string]> = [
  [/^KG\s*모빌리티(?:\s*\(.*\))?$/i, 'KGM'], [/^KGM$/i, 'KGM'], [/^쌍용(?:\s*\(.*\))?$/, 'KGM'],
  [/^쉐보레(?:\s*\(.*\))?$/, '쉐보레'], [/^한국GM(?:\s*\(.*\))?$/i, '쉐보레'],
  [/^르노(?:코리아|삼성)?(?:\s*\(.*\))?$/, '르노'], [/^토요타$|^도요타$/, '도요타'],
];
export const shortMakerName = (raw: string): string => {
  const text = raw.trim();
  for (const [pattern, name] of MAKER_SHORT) if (pattern.test(text)) return name;
  return text;
};

/** 파워트레인 낱말(배기량·엔진·연료·구동·인승). 세부트림에는 쓰지 않는다(규칙 5): 제원 칸으로 간다. */
const POWERTRAIN_WORD = /^(?:\d(?:\.\d)?[Tt]?|\d{3,4}cc|HEV|PHEV|EV|MHEV|하이브리드|플러그인|가솔린|휘발유|디젤|경유|LPG|LPi|LPI|전기|터보|GDI|TCe|T-GDI|2WD|4WD|AWD|FWD|RWD|e-AWD|\d+인승|렌터카용|\(렌터카용\))$/;
const isPowertrainWord = (w: string) => POWERTRAIN_WORD.test(w);

export type RawNameStructure =
  | 'MAKER_MODEL_POWERTRAIN_TRIM'   // 4토큰(제조사_모델_파워트레인_트림)
  | 'MAKER_MODEL_TAIL'             // 3토큰(제조사_모델_꼬리) — 꼬리는 파워트레인·트림·«파워트레인 / 트림» 중 하나
  | 'MISALIGNED'                   // 토큰이 어긋남(2토큰·5토큰 이상·빈 토큰·꼬리가 모델 반복)
  | 'NO_DELIMITER';                // «_» 구분자 없음(분해 불가 — 마스터 매칭 규칙만)

export type RawNameSplit = {
  structure: RawNameStructure;
  maker: string | null;
  /** 모델·세부모델 «원문» 토큰(세대명·괄호 코드·더 뉴 수식어 포함 그대로). 마스터 이름이 아니다. */
  modelText: string | null;
  /** 파워트레인 낱말(배기량·연료·구동·인승), 제원 칸 후보. */
  powertrain: string | null;
  /** 세부트림 «후보»(파워트레인 낱말을 뗀 나머지). 마스터 트림 이름과 일치할 때만 쓰인다. */
  trimCandidate: string | null;
};

/** 낱말 단위로 앞뒤의 파워트레인 낱말을 떼어 [파워트레인, 나머지(트림 후보)]로 나눈다. 가운데에 낀 파워트레인 낱말은 그대로 둔다(추측 금지). */
export function peelPowertrain(text: string): { powertrain: string | null; rest: string | null } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  let start = 0, end = words.length;
  while (start < end && isPowertrainWord(words[start]!)) start++;
  while (end > start && isPowertrainWord(words[end - 1]!)) end--;
  const power = [...words.slice(0, start), ...words.slice(end)].join(' ');
  const rest = words.slice(start, end).join(' ');
  return { powertrain: power || null, rest: rest || null };
}

export function splitRawVehicleName(raw: string): RawNameSplit {
  const empty = (structure: RawNameStructure): RawNameSplit => ({ structure, maker: null, modelText: null, powertrain: null, trimCandidate: null });
  const text = raw.normalize('NFKC').trim();
  if (!text.includes('_')) return empty('NO_DELIMITER');
  const tokens = text.split('_').map(t => t.trim());
  if (tokens.length < 3 || tokens.length > 4 || tokens.some(t => !t)) return empty('MISALIGNED');
  const maker = shortMakerName(tokens[0]!), modelText = tokens[1]!;
  const compact = (s: string) => s.replace(/[\s()\-.]/g, '').toUpperCase();
  if (tokens.length === 4) {
    const trim = tokens[3]!;
    const power = peelPowertrain(tokens[2]!);
    // 파워트레인 자리에 파워트레인 낱말이 하나도 없으면 칸이 어긋난 것이다.
    if (!power.powertrain) return { ...empty('MISALIGNED'), maker, modelText };
    return { structure: 'MAKER_MODEL_POWERTRAIN_TRIM', maker, modelText, powertrain: power.powertrain,
      trimCandidate: [power.rest, trim].filter(Boolean).join(' ') || null };
  }
  const tail = tokens[2]!;
  // 꼬리가 모델 이름 반복(예: «K8 HEV», «G80 RG3», «더 뉴 팰리세이드»)이면 구조가 어긋난 것이다 — 꼬리의 비(非)파워트레인 낱말(2자 이상)이 모델 토큰 안에 있으면 어긋남.
  const modelKey = compact(modelText);
  if (tail.split(/[\s/]+/).some(w => w.length >= 2 && !isPowertrainWord(w) && modelKey.includes(compact(w))))
    return { ...empty('MISALIGNED'), maker, modelText };
  const parts = tail.split('/').map(p => p.trim()).filter(Boolean);
  if (parts.length === 2) {
    // «파워트레인 / 트림»: 앞은 파워트레인, 뒤는 트림 후보(그 안의 파워트레인 낱말은 떼어 낸다).
    const head = peelPowertrain(parts[0]!), back = peelPowertrain(parts[1]!);
    return { structure: 'MAKER_MODEL_TAIL', maker, modelText,
      powertrain: [head.powertrain ?? parts[0]!, back.powertrain].filter(Boolean).join(' ') || null,
      trimCandidate: (head.powertrain ? head.rest : null) ?? back.rest };
  }
  const only = peelPowertrain(tail);
  return { structure: 'MAKER_MODEL_TAIL', maker, modelText, powertrain: only.powertrain, trimCandidate: only.rest };
}
