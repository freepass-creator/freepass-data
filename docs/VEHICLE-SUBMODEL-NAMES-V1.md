# 세부모델 이름 v1 — 우리 차 기준 115개 (2026-10-04)

기준: ai-ops `docs/차종-기준-한장.md` 0-1절 규칙 1~19(ai-ops 98d0ad5). 범위: 프리패스 데이터 `products`가 실제로 쓰는 세부모델 중 생산 시작 2016년 이후(규칙 17) — 115개, 차 1,652대.

정하는 법: Codex·Gemini 따로 답 → 일치 84, 다른 15개·부분변경 시점은 제조사 한국 보도자료로 다시 확인(두 답 일치) → 규칙 18·19로 판단. 다나와·엔카는 한 건씩 근거로만 봄(다나와 약관상 통째 수집 안 함).

열: 번호 · 제조사 · 모델 · 옛 F03 이름 → 새 이름 · 부분변경 나눔 · 프리패스 데이터 지금 이름 · 할 일 · 확신 · 메모

| # | 제조사 | 모델 | 옛 F03 | 새 이름 | 나눔 | 데이터 지금 | 할 일 | 확신 | 메모 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 현대 | 그랜저 | 더 뉴 그랜저 IG | **더 뉴 그랜저 IG** |  | 더 뉴 그랜저 IG | Data 그대로 | high | Codex·Gemini 일치 |
| 2 | 제네시스 | G80 | G80 RG3 | **G80 RG3** | G80 RG3 ~2023-11 / G80 RG3 FL 2023-12~ | G80 RG3 | Data 그대로 | high | 제네시스 부분변경 2023-12-26 출시(Codex·Gemini 일치), 공식 «더 뉴» 없음 → FL |
| 3 | 현대 | 싼타페 | 싼타페 MX5 | **싼타페 MX5** |  | 디 올 뉴 싼타페 MX5 | Data 이름 바꿈(출시수식어만 다름) | high | Codex·Gemini 일치 |
| 4 | 기아 | 레이 | 더 뉴 레이 | **더 뉴 레이 TAM** |  | 더 뉴 레이 TAM | Data 그대로 | high | Codex·Gemini 일치 |
| 5 | 현대 | 그랜저 | 그랜저 GN7 | **그랜저 GN7** |  | 그랜저 GN7 | Data 그대로 | high | Codex·Gemini 일치 |
| 6 | 르노 | 아르카나 | 기본형 | **아르카나 LJL** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 7 | 기아 | 카니발 | 카니발 KA4 | **카니발 KA4** |  | 카니발 KA4 | Data 그대로 | high | Codex·Gemini 일치 |
| 8 | 기아 | K8 | 기본형 | **K8 GL3** |  | K8 GL3 | Data 그대로 | high | Codex·Gemini 일치 |
| 9 | 기아 | 카니발 | 더 뉴 카니발 KA4 | **더 뉴 카니발 KA4** |  | 더 뉴 카니발 KA4 | Data 그대로 | high | Codex·Gemini 일치 |
| 10 | 기아 | K5 | K5 DL3 | **K5 DL3** |  | K5 DL3 | Data 그대로 | high | Codex·Gemini 일치 |
| 11 | 기아 | K5 | 더 뉴 K5 DL3 | **더 뉴 K5 DL3** |  | 더 뉴 K5 DL3 | Data 그대로 | high | Codex·Gemini 일치 |
| 12 | 현대 | 아반떼 | 아반떼 CN7 | **아반떼 CN7** |  | 아반떼 CN7 | Data 그대로 | high | Codex·Gemini 일치 |
| 13 | 기아 | EV6 | 기본형 | **EV6 CV** |  | EV6 CV1 | Data 이름 바꿈(코드 표기 다름) | high | Codex·Gemini 일치 |
| 14 | 현대 | 캐스퍼 | 기본형 | **캐스퍼 AX1** |  | 캐스퍼 AX1 | Data 그대로 | high | Codex·Gemini 일치 |
| 15 | 기아 | 스포티지 | 스포티지 NQ5 | **스포티지 NQ5** |  | 스포티지 NQ5 | Data 그대로 | high | Codex·Gemini 일치 |
| 16 | 현대 | 쏘나타 | 쏘나타 DN8 | **쏘나타 DN8** |  | 쏘나타 DN8 | Data 그대로 | high | Codex·Gemini 일치 |
| 17 | 기아 | 쏘렌토 | 쏘렌토 MQ4 | **쏘렌토 MQ4** |  | 쏘렌토 MQ4 | Data 그대로 | high | Codex·Gemini 일치 |
| 18 | 현대 | 팰리세이드 | 더 뉴 팰리세이드 | **더 뉴 팰리세이드 LX2** |  | 더 뉴 팰리세이드 LX2 | Data 그대로 | high | Codex·Gemini 일치 |
| 19 | 현대 | 아반떼 | 더 뉴 아반떼 CN7 | **더 뉴 아반떼 CN7** |  | 더 뉴 아반떼 CN7 | Data 그대로 | high | Codex·Gemini 일치 |
| 20 | 기아 | K3 | 더 뉴 K3 BD | **더 뉴 K3 BD** |  | 더 뉴 K3 BD | Data 그대로 | high | Codex·Gemini 일치 |
| 21 | 제네시스 | GV80 | 기본형 | **GV80 JX1** | GV80 JX1 ~2023-09 / GV80 JX1 FL 2023-10~ | GV80 JX1 | Data 그대로 | high | 부분변경 2023-10-11 판매 개시 |
| 22 | 기아 | K8 | 더 뉴 K8 | **더 뉴 K8 GL3** |  | 더 뉴 K8 GL3 | Data 그대로 | high | Codex·Gemini 일치 |
| 23 | 현대 | 쏘나타 | 쏘나타 디 엣지 DN8 | **쏘나타 디 엣지 DN8** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 24 | 현대 | 투싼 | 투싼 NX4 | **투싼 NX4** |  | 투싼 NX4 | Data 그대로 | high | Codex·Gemini 일치 |
| 25 | 현대 | 싼타페 | 더 뉴 싼타페 | **더 뉴 싼타페 TM** |  | 더 뉴 싼타페 TM | Data 그대로 | high | Codex·Gemini 일치 |
| 26 | 제네시스 | GV70 | 기본형 | **GV70 JK1** | GV70 JK1 ~2024-04 / GV70 JK1 FL 2024-05~ | GV70 JK1 | Data 그대로 | high | 부분변경 2024-05-08 |
| 27 | 기아 | 모닝 | 더 뉴 모닝 JA | **더 뉴 모닝 JA** |  | 더 뉴 모닝 JA | Data 그대로 | high | Codex·Gemini 일치 |
| 28 | 르노 | 그랑 콜레오스 | 기본형 | **그랑 콜레오스 Aurora 1** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 29 | 기아 | 쏘렌토 | 더 뉴 쏘렌토 MQ4 | **더 뉴 쏘렌토 MQ4** |  | 더 뉴 쏘렌토 MQ4 | Data 그대로 | high | Codex·Gemini 일치 |
| 30 | 제네시스 | G90 | G90 RS4 | **G90 RS4** |  | G90 RS4 | Data 그대로 | high | Codex·Gemini 일치 |
| 31 | 기아 | 셀토스 | 더 뉴 셀토스 | **더 뉴 셀토스 SP2** |  | 더 뉴 셀토스 SP2 | Data 그대로 | high | Codex·Gemini 일치 |
| 32 | 현대 | 팰리세이드 | 기본형 | **팰리세이드 LX2** |  | 팰리세이드 LX2 | Data 그대로 | high | Codex·Gemini 일치 |
| 33 | 벤츠 | E-클래스 | E-클래스 W214 | **E-클래스 W214** |  | E-클래스 W214 | Data 그대로 | medium | Codex·Gemini 일치 |
| 34 | 테슬라 | 모델 Y | 기본형 | **모델 Y** | 모델 Y ~2025-03 / 모델 Y FL 2025-04~ | — | Data에 없음 → 새로 넣음 | high | 공식 개발코드 없음 → 규칙 19 FL, 국내 출시 2025-04-02 |
| 35 | KGM | 티볼리 | 더 뉴 티볼리 | **더 뉴 티볼리 X170** |  | 더 뉴 티볼리 X100 | 코드 충돌 확인 필요(Data X100 ↔ 우리 X170) | high | Codex·Gemini 일치 |
| 36 | 현대 | 아이오닉5 | 기본형 | **아이오닉 5 NE** |  | 아이오닉5 NE | Data 이름 바꿈(같음) | high | 제조사 표기 띄어 씀(모델명도 «아이오닉 5») |
| 37 | 현대 | 베뉴 | 기본형 | **베뉴 QX** |  | 베뉴 QX1 | Data 이름 바꿈(코드 표기 다름) | high | 국내 부분변경 출시 없음(연식변경만) → 나누지 않음 |
| 38 | 기아 | 레이 | 더 뉴 기아 레이 | **더 뉴 기아 레이 TAM** |  | 더 뉴 기아 레이 TAM | Data 그대로 | high | Codex·Gemini 일치 |
| 39 | 기아 | K9 | 더 뉴 K9 RJ | **더 뉴 K9 RJ** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 40 | 기아 | 셀토스 | 셀토스 SP3 | **셀토스 SP3** |  | 디 올 뉴 셀토스 SP3 | Data 이름 바꿈(출시수식어만 다름) | high | Codex·Gemini 일치 |
| 41 | 기아 | 모하비 | 모하비 더 마스터 | **모하비 더 마스터 HM** |  | 모하비 더 마스터 HM | Data 그대로 | medium | Codex·Gemini 일치 |
| 42 | 기아 | 니로 | 디 올 뉴 니로 EV | **니로 EV SG2** |  | 디 올 뉴 니로 EV SG2 | Data 이름 바꿈(출시수식어만 다름) | high | Codex·Gemini 일치 |
| 43 | 르노 | XM3 | 기본형 | **XM3 LJL** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 44 | KGM | 토레스 | 더 뉴 토레스 | **더 뉴 토레스 J116** | 더 뉴 토레스 J116 2024-05~ / 더 뉴 토레스 하이브리드 J140 2025-03~ | 더 뉴 토레스 J116/J140 | Data 이름 바꿈(코드 표기 다름) | medium | 규칙 18 |
| 45 | 쉐보레 | 트랙스 | 트랙스 크로스오버 | **트랙스 크로스오버 9BQC** |  | 트랙스 크로스오버 9BQC | Data 그대로 | high | Codex·Gemini 일치 |
| 46 | 기아 | 니로 | 기본형 | **니로 DE** |  | 니로 DE | Data 그대로 | high | 처음부터 하이브리드 — 제조사가 «하이브리드» 안 붙임(규칙 18) |
| 47 | 기아 | 니로 | 디 올 뉴 니로 | **니로 SG2** |  | 디 올 뉴 니로 SG2 | Data 이름 바꿈(출시수식어만 다름) | high | 디 올 뉴(출시 수식어) 뺌, 하이브리드 안 붙임 |
| 48 | 르노 | QM6 | 더 뉴 QM6 | **더 뉴 QM6 HZG** | 더 뉴 QM6 HZG 2019-06~2020-10 / 뉴 QM6 HZG 2020-11~2023-02 / 더 뉴 QM6 HZG FL 2023-03~ | 더 뉴 QM6 HZG | Data 그대로 | medium | 르노 공식 이름이 2019·2023 둘 다 «더 뉴 QM6» → 영업자 혼동 막으려 2023 쪽 FL(규칙 19) |
| 49 | 기아 | 모닝 | 모닝 어반 JA | **모닝 어반 JA** |  | 모닝 어반 JA | Data 그대로 | high | Codex·Gemini 일치 |
| 50 | 기아 | 스포티지 | 더 뉴 스포티지 NQ5 | **더 뉴 스포티지 NQ5** |  | 더 뉴 스포티지 NQ5 | Data 그대로 | high | Codex·Gemini 일치 |
| 51 | 기아 | 셀토스 | 셀토스 SP2 | **셀토스 SP2** |  | 셀토스 SP2 | Data 그대로 | high | Codex·Gemini 일치 |
| 52 | 현대 | 그랜저 | 더 뉴 그랜저 GN7 | **더 뉴 그랜저 GN7** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 53 | 미니 | 쿠퍼 | 쿠퍼 C 4세대 | **쿠퍼 F66** | 쿠퍼 F66 (3도어, 2024-07~) / 쿠퍼 F65 (5도어, 2024-10~) | — | Data에 없음 → 새로 넣음 | medium | C·S는 세부트림(규칙 19). 차마다 3도어·5도어는 원문으로 가름 |
| 54 | 제네시스 | G80 | 일렉트리파이드 G80 RG3 | **일렉트리파이드 G80 RG3** | 일렉트리파이드 G80 RG3 ~2024-08 / 일렉트리파이드 G80 RG3 FL 2024-09~ | — | Data에 없음 → 새로 넣음 | high | 제조사 이름 그대로(규칙 2·19), 부분변경 2024-09-05 |
| 55 | 기아 | K3 | 올 뉴 K3 | **K3 BD** |  | 올 뉴 K3 BD | Data 이름 바꿈(출시수식어만 다름) | high | Codex·Gemini 일치 |
| 56 | 현대 | 팰리세이드 | 팰리세이드 LX3 | **팰리세이드 LX3** |  | 팰리세이드 LX3 | Data 그대로 | high | Codex·Gemini 일치 |
| 57 | 현대 | 싼타페 | 싼타페 TM | **싼타페 TM** |  | 싼타페 TM | Data 그대로 | high | Codex·Gemini 일치 |
| 58 | 현대 | 그랜저 | 그랜저 IG | **그랜저 IG** |  | 그랜저 IG | Data 그대로 | high | Codex·Gemini 일치 |
| 59 | 기아 | K7 | K7 프리미어 | **K7 프리미어 YG** |  | K7 프리미어 YG | Data 그대로 | high | Codex·Gemini 일치 |
| 60 | BMW | 5시리즈 | 5시리즈 G30 | **5시리즈 G30** | 5시리즈 G30 ~2020-09 / 5시리즈 G30 FL 2020-10~ | 5시리즈 G30 | Data 그대로 | high | LCI 2020-10-05 |
| 61 | 벤츠 | E-클래스 | E-클래스 W213 | **E-클래스 W213** | E-클래스 W213 ~2020-09 / E-클래스 W213 FL 2020-10~ | E-클래스 W213 | Data 그대로 | high | 벤츠는 출시·부분변경 모두 «더 뉴 E-클래스»라 영업자 혼동 → 규칙 19 FL, 2020-10-13 |
| 62 | 기아 | 스포티지 | 스포티지 더 볼드 | **스포티지 더 볼드 QL** |  | 스포티지 더 볼드 QL | Data 그대로 | medium | Codex·Gemini 일치 |
| 63 | 기아 | K8 | K8 하이브리드 | **K8 하이브리드 GL3** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 64 | 기아 | 카니발 | 더 뉴 카니발 | **더 뉴 카니발 YP** |  | 더 뉴 카니발 YP | Data 그대로 | medium | Codex·Gemini 일치 |
| 65 | 도요타 | RAV4 | RAV4 5세대 | **RAV4 XA50** |  | — | Data에 없음 → 새로 넣음 | high | XA50 (Codex·Gemini 일치) |
| 66 | KGM | 토레스 | 뉴 토레스 | **뉴 토레스 J150** |  | — | Data에 없음 → 새로 넣음 | medium | 하이브리드 코드 미확정(J150로 분류하는 자료만) — 하이브리드는 «뉴 토레스 하이브리드 J150» 확인 필요 |
| 67 | KGM | 렉스턴 | 올 뉴 렉스턴 | **올 뉴 렉스턴 Y450** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 68 | 아우디 | A6 | A6 C8 | **A6 C8** |  | A6 C8 | Data 그대로 | high | Codex·Gemini 일치 |
| 69 | 현대 | 투싼 | 더 뉴 투싼 NX4 | **더 뉴 투싼 NX4** |  | 더 뉴 투싼 NX4 | Data 그대로 | high | Codex·Gemini 일치 |
| 70 | 지프 | 어벤저 | 기본형 | **어벤저 516** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 71 | 기아 | K7 | 올 뉴 K7 | **K7 YG** |  | 올 뉴 K7 YG | Data 이름 바꿈(출시수식어만 다름) | high | Codex·Gemini 일치 |
| 72 | 기아 | 니로 | 니로 플러스 | **니로 플러스 DE** |  | 니로 플러스 DE | Data 그대로 | high | Codex·Gemini 일치 |
| 73 | 현대 | 아반떼 | 더 뉴 아반떼 AD | **더 뉴 아반떼 AD** |  | 더 뉴 아반떼 AD | Data 그대로 | medium | Codex·Gemini 일치 |
| 74 | BMW | X1 | X1 F48 | **X1 F48** | X1 F48 ~2019-10 / X1 F48 FL 2019-11~ | X1 F48 | Data 그대로 | high | LCI 2019-11-07 |
| 75 | 기아 | 니로 | 더 뉴 니로 | **더 뉴 니로 DE** |  | 더 뉴 니로 DE | Data 그대로 | high |  |
| 76 | 제네시스 | G90 | 기본형 | **G90 HI** |  | G90 HI | Data 그대로 | high | Codex·Gemini 일치 |
| 77 | 현대 | 코나 | 코나 SX2 | **코나 SX2** |  | 디 올 뉴 코나 SX2 | Data 이름 바꿈(출시수식어만 다름) | high | Codex·Gemini 일치 |
| 78 | 제네시스 | G70 | 더 뉴 G70 | **더 뉴 G70 IK** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 79 | 기아 | 니로 | 더 뉴 니로 SG2 | **더 뉴 니로 SG2** |  | — | Data에 없음 → 새로 넣음 | high |  |
| 80 | 테슬라 | 모델 3 | 기본형 | **모델 3** | 모델 3 ~2024-03 / 모델 3 FL 2024-04~ | — | Data에 없음 → 새로 넣음 | high | 국내 출시 2024-04-04 |
| 81 | BMW | 1시리즈 | 1시리즈 F40 | **1시리즈 F40** |  | 1시리즈 F40 | Data 그대로 | medium | Codex·Gemini 일치 |
| 82 | 미니 | 쿠퍼 | 쿠퍼 일렉트릭 | **쿠퍼 일렉트릭 F56** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 83 | KGM | 액티언 | 액티언 2세대 | **액티언 J120** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 84 | 르노 | QM6 | 기본형 | **QM6 HZG** |  | QM6 HZG | Data 그대로 | high | Codex·Gemini 일치 |
| 85 | 포드 | 익스플로러 | 익스플로러 6세대 | **익스플로러 U625** | 익스플로러 U625 ~2024-10 / 더 뉴 익스플로러 U625 2024-11~ | 익스플로러 U625 | Data 그대로 | high | 포드 공식 «더 뉴 포드 익스플로러» 2024-11-12 → 규칙 3 «더 뉴» |
| 86 | 기아 | K7 | 올 뉴 K7 하이브리드 | **K7 하이브리드 YG** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 87 | 제네시스 | G80 | 기본형 | **G80 DH** |  | G80 DH | Data 그대로 | high | Codex·Gemini 일치 |
| 88 | 쉐보레 | 볼트 EV | 기본형 | **볼트 EV** |  | — | Data에 없음 → 새로 넣음 | low | 개발코드 미확정(Gemini만 G2KC) → 모델명, 확인 필요 |
| 89 | 제네시스 | G70 | 기본형 | **G70 IK** |  | G70 IK | Data 그대로 | high | Codex·Gemini 일치 |
| 90 | 현대 | 아이오닉6 | 기본형 | **아이오닉 6 CE** |  | — | Data에 없음 → 새로 넣음 | high | 제조사 표기 띄어 씀 |
| 91 | 현대 | 스타리아 | 더 뉴 스타리아 | **더 뉴 스타리아 US4** |  | — | Data에 없음 → 새로 넣음 | medium | Codex·Gemini 일치 |
| 92 | 현대 | 스타리아 | 기본형 | **스타리아 US4** |  | 스타리아 US4 | Data 그대로 | high | Codex·Gemini 일치 |
| 93 | 쉐보레 | 트레일블레이저 | 기본형 | **트레일블레이저 9BYC** |  | 트레일블레이저 9BYC | Data 그대로 | high | Codex·Gemini 일치 |
| 94 | BMW | X4 | X4 G02 | **X4 G02** | X4 G02 ~2021-10 / X4 G02 FL 2021-11~ | X4 G02 | Data 그대로 | high | LCI 2021-11-01 |
| 95 | BMW | 5시리즈 | 5시리즈 G60 | **5시리즈 G60** |  | 5시리즈 G60 | Data 그대로 | high | Codex·Gemini 일치 |
| 96 | 현대 | 아반떼 | 더 뉴 아반떼 하이브리드 CN7 | **더 뉴 아반떼 하이브리드 CN7** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 97 | 볼보 | V60 | V60 크로스컨트리 2세대 | **V60 크로스컨트리** | V60 크로스컨트리 ~2022-08 / V60 크로스컨트리 FL 2022-09~ | V60 크로스컨트리 2세대 | Data 이름 바꿈(옛 F03 이름과 같음) | medium | 공식 표기 붙여 씀, 개발코드 미확정(V432는 Gemini만) → 모델명, 부분변경 2022-09-27 |
| 98 | 볼보 | XC40 | 기본형 | **XC40** | XC40 ~2022-07 / XC40 FL 2022-08~ | XC40 | Data 그대로 | medium | 개발코드 없음, 부분변경 2022-08-17 |
| 99 | 캐딜락 | XT6 | 기본형 | **XT6** |  | XT6 | Data 그대로 | medium | 공식 개발코드 미확정 → 모델명 |
| 100 | 현대 | 아반떼 | 아반떼 CN8 | **아반떼 CN8** |  | — | Data에 없음 → 새로 넣음 | medium | Codex·Gemini 일치 |
| 101 | KGM | 토레스 | 토레스 EVX | **토레스 EVX U100** |  | 토레스 EVX U100 | Data 그대로 | high | Codex·Gemini 일치 |
| 102 | 쉐보레 | 말리부 | 더 뉴 말리부 | **더 뉴 말리부 V400** |  | 더 뉴 말리부 V400 | Data 그대로 | high | Codex·Gemini 일치 |
| 103 | 쉐보레 | 트랙스 | 더 뉴 트랙스 | **더 뉴 트랙스 U200** |  | 더 뉴 트랙스 U200 | Data 그대로 | medium | Codex·Gemini 일치 |
| 104 | BMW | 2시리즈 | 2시리즈 그란쿠페 F44 | **2시리즈 그란쿠페 F44** |  | 2시리즈 그란쿠페 F44 | Data 그대로 | high | BMW 코리아 공식 «그란쿠페» 붙여 씀 |
| 105 | 기아 | 쏘울 | 쏘울 부스터 | **쏘울 부스터 SK3** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 106 | 현대 | 코나 | 더 뉴 코나 | **더 뉴 코나 OS** |  | 더 뉴 코나 OS | Data 그대로 | high | Codex·Gemini 일치 |
| 107 | 제네시스 | G70 | 더 뉴 G70 슈팅브레이크 | **G70 슈팅 브레이크 IK** |  | G70 슈팅 브레이크 IK | Data 그대로 | high | 제조사 공식 «G70 슈팅 브레이크»(2022-06), 띄어 씀 |
| 108 | 기아 | K9 | 더 K9 | **K9 RJ** |  | K9 RJ | Data 그대로 | high | Codex·Gemini 일치 |
| 109 | 현대 | 아이오닉 | 더 뉴 아이오닉 일렉트릭 | **더 뉴 아이오닉 일렉트릭 AE** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 110 | 기아 | K7 | K7 프리미어 하이브리드 | **K7 프리미어 하이브리드 YG** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 111 | 현대 | 캐스퍼 | 캐스퍼 일렉트릭 | **캐스퍼 일렉트릭 AX1** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 112 | 쉐보레 | 볼트 EV | 뉴 볼트 EV | **뉴 볼트 EV** |  | — | Data에 없음 → 새로 넣음 | low | 개발코드 미확정 → 확인 필요 |
| 113 | 쉐보레 | 스파크 | 더 뉴 스파크 | **더 뉴 스파크 M400** |  | 더 뉴 스파크 M400 | Data 그대로 | medium | Codex·Gemini 일치 |
| 114 | KGM | 렉스턴 | 더 뉴 렉스턴 스포츠 칸 | **더 뉴 렉스턴 스포츠 칸 Q250** |  | — | Data에 없음 → 새로 넣음 | high | Codex·Gemini 일치 |
| 115 | 기아 | 레이 | 더 뉴 기아 레이 EV | **더 기아 레이 EV TAM** |  | — | Data에 없음 → 새로 넣음 | high | 기아 공식 «더 기아 레이 EV» 2023-09-21 |

## 프리패스 데이터 반영 때 같이 할 일

- 하이브리드 떼기(규칙 15·18): 위 세부모델 중 국산(현대·기아·KGM)·쉐보레·포드처럼 제조사가 «하이브리드»를 모델 이름에 쓰는 차는 데이터 마스터의 하이브리드 행을 «… 하이브리드 코드» 세부모델로 옮긴다(약 28개 세부모델·176행). 벤츠·BMW처럼 모델번호 등급(E 300 e·530e)으로 가르는 수입차는 떼지 않는다.
- 모델명 띄어쓰기: 아이오닉5 → 아이오닉 5, 아이오닉6 → 아이오닉 6.
- 미니 쿠퍼 C·S는 세부트림으로(규칙 19), 3도어 F66·5도어 F65는 차마다 원문으로 가름.
- 확인 필요: 더 뉴 티볼리 코드(데이터 X100 ↔ 우리 X170), EV6 코드(데이터 CV1 ↔ 우리 CV), 볼트 EV 개발코드, 뉴 토레스 하이브리드 코드.
- 옛 이름(F03·데이터·공급사 원문)은 모두 별칭으로 새 이름에 잇고, 불변 ID는 그대로(규칙 10).

## 프리패스 데이터 반영 — 실행 방법(정정기 `repair:vehicle-name-parity`)

- 실행 환경: `FIREBASE_PROJECT_ID=freepasserp5` 필수(빠지면 시작에서 멈춤, 쓰기 0). freepass-data main 의 #348 이후 실행기.
- 묶음마다 시험: `VEHICLE_NAME_REPAIR_PLAN=<묶음 JSON> npx tsx src/jobs/apply-vehicle-name-reference-repair.ts` → `planDigest` 확인.
- 적용: `FIREBASE_PROJECT_ID=freepasserp5 AUTHORIZE_VEHICLE_NAME_REPAIR=<planDigest> VEHICLE_NAME_REPAIR_PLAN=<묶음 JSON> npx tsx src/jobs/apply-vehicle-name-reference-repair.ts --apply`
- 실행기가 묶음 안에서: 사전조건, 비공개 백업, 한 트랜잭션, 최종 이름 유일성·trim_row_key·variants 다이제스트, 감사 기록, 되읽기.
- 1차 적용 2026-10-04: 5묶음, 되읽기·감사 176·176·193·197·90, 재감사 차이 0(NEXT-START-HERE 같은 날 항목).
