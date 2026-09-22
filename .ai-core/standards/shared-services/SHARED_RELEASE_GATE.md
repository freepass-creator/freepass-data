# Shared Release Gate — Production Proof

상태: CURRENT / 공통 배포 원칙  
최종: 2026-09-19

## 목적

AI Core는 각 프로젝트의 실제 배포 명령을 소유하지 않는다. 대신 모든 프로젝트가 공통으로 지켜야 할 **release proof**와 복구 원칙을 관리한다.

기본 상태 흐름:

```
build/test → preview → release → production observation → EXECUTED
```

Git merge, CI success, deployment READY, production observation은 서로 다른 상태다.

## 공통 규칙

### 1. Merge != Deploy

- main에 커밋이 들어간 것만으로 배포 완료라 부르지 않는다.
- Git Integration 자동배포가 있어도 release target을 직접 관측한다.

### 2. Deploy READY != Production Proof

- 플랫폼이 deployment를 READY로 표시해도 custom domain alias/DNS가 옛 deployment를 가리킬 수 있다.
- 실제 운영 주소가 기대 revision을 서빙하는지 확인한다.

### 3. 프로젝트가 자기 revision proof를 제공한다

가능하면 각 프로젝트는 다음 중 하나를 제공한다.

- `/api/version`
- build SHA meta
- immutable release id endpoint
- deployment-specific health/version endpoint

AI Core는 그 값을 project registry의 expected revision과 대조한다.

### 4. 자동 경로 + 명시적 복구 경로

각 프로젝트는 가능하면 둘 다 가진다.

- Default: Git push / integration auto deploy
- Recovery: 명시적 production deploy command

Recovery는 자동배포를 대체하는 것이 아니라, Git Integration 지연/실패/alias 문제를 분리해 진단하기 위한 경로다.

### 5. 완료 판정

다음이 모두 맞을 때 release를 실제 운영 완료로 본다.

- build/test PASS
- target deployment 생성 성공
- production URL reachable
- production revision == expected revision
- 주요 runtime smoke PASS
- rollback target 확인 가능

## ERP4 기준 구현

현재 Vercel production release의 기준 구현:

- Repository: `freepass-creator/freepasserp4`
- Project canon: `docs/VERCEL-PRODUCTION-RELEASE.md`
- Explicit deploy: `npm run deploy:prod`
- Live verify: `npm run deploy:verify`
- Runtime proof: `/api/version.sha`
- Recovery-only alias repair: `npm run deploy:prod -- --repair-alias`

ERP4의 세부 Vercel project/domain 설정은 ERP4가 정본이다. AI Core에는 복제하지 않는다.

## 장애 분류

### A. Build/Deploy failure

증상:
- deployment ERROR
- build log 실패

조치:
- build log 확인
- 환경변수 parity 확인
- project root/framework/build command 확인
- 원인 수정 후 새 deployment

### B. Deployment READY, custom domain stale

증상:
- deployment는 성공
- production domain의 revision이 기대값과 다름

조치:
- alias/project domain 확인
- DNS target 확인
- 잘못된 project 연결 여부 확인
- 필요 시 검증된 deployment를 production alias로 복구

### C. Domain/DNS failure

증상:
- domain 자체가 resolve/reach되지 않음

조치:
- DNS provider / Vercel domain verification 확인
- apex/www 둘 다 확인
- build를 반복하지 않는다. DNS/alias 문제는 rebuild로 해결되지 않는다.

## 증거 묶음

release proof에는 최소 다음을 남긴다.

- repository
- expected revision
- deployment id/url
- production urls
- observed production revision
- observed_at
- test/build status
- rollback candidate
- result: VERIFIED / HOLD / FAILED

## 한 문장

> **배포 완료는 플랫폼의 성공 표시가 아니라, 실제 운영 주소가 기대 revision을 서빙한다는 관측으로 증명한다.**
