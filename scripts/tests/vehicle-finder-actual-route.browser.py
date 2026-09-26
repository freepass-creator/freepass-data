"""Actual-route browser QA for U-01 Vehicle Finder.

Runs the real local dev server, opens /console/vehicle-finder in Chromium, then injects
synthetic read data only inside the browser test. No production API or fixture is shipped.
"""
from __future__ import annotations

import argparse
import os
import socket
import subprocess
import time
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]

parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, default=Path("/tmp/freepass-vehicle-finder-actual-route"))
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_http(url: str, timeout: float = 12.0) -> None:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            with urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except Exception as error:  # noqa: BLE001
            last = error
        time.sleep(0.1)
    raise RuntimeError(f"server did not become ready: {last}")


port = free_port()
env = os.environ.copy()
env["PORT"] = str(port)
env["NODE_ENV"] = "test"
server = subprocess.Popen(
    ["node", "--import", "tsx", "scripts/run-memory.mjs", "api"],
    cwd=ROOT,
    env=env,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
)

try:
    wait_http(f"http://127.0.0.1:{port}/health")
    route = f"http://127.0.0.1:{port}/console/vehicle-finder"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)

        desktop = browser.new_page(viewport={"width": 1440, "height": 1000})
        desktop.goto(route, wait_until="networkidle")
        expect(desktop.get_by_role("heading", name="차량 찾기")).to_be_visible()
        expect(desktop.get_by_text("차량 마스터 조회 연결을 기다리고 있습니다")).to_be_visible()
        assert desktop.locator("tbody tr").count() == 0
        assert desktop.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")

        mount_script = """async () => {
          const { mountVehicleFinder } = await import('/console/vehicle-finder/view.mjs');
          const makeItems = mode => Array.from({ length: 18 }, (_, index) => {
            const hold = index === 2;
            const unknown = index === 3;
            const action = hold
              ? {
                  code: 'BLOCKED',
                  label: '선택 차단',
                  reasons: ['LIFECYCLE_HOLD', 'IDENTITY_HOLD'],
                  reasonDetails: [
                    {
                      code: 'LIFECYCLE_HOLD',
                      title: '차량 상태가 HOLD입니다',
                      message: 'F가 이 후보의 lifecycle을 HOLD로 판정했습니다.',
                      nextStep: '활성화 근거가 확인되기 전에는 선택하지 마세요.',
                    },
                    {
                      code: 'IDENTITY_HOLD',
                      title: '차량 식별 상태가 HOLD입니다',
                      message: 'F가 이 후보의 identity 상태를 HOLD로 판정했습니다.',
                      nextStep: '식별 정보 정합성이 해소되기 전에는 선택하지 마세요.',
                    },
                  ],
                }
              : unknown
                ? {
                    code: 'INSPECT_ONLY',
                    label: '확인만 가능',
                    reasons: ['IDENTITY_PARTIAL', 'UNRESOLVED_SELECTION'],
                    reasonDetails: [
                      {
                        code: 'IDENTITY_PARTIAL',
                        title: '차량 식별 정보가 일부 미확정입니다',
                        message: 'F가 이 후보의 식별 상태를 PARTIAL로 판정했습니다.',
                        nextStep: '차종·세대·연식·트림 등 식별 근거를 추가로 확인해 주세요.',
                      },
                      {
                        code: 'UNRESOLVED_SELECTION',
                        title: '선택 조건과 비교할 값이 일부 미확인입니다',
                        message: 'F가 입력 조건 중 하나 이상을 이 후보의 현재 자료로 확정하지 못했습니다.',
                        nextStep: '미확인 조건의 근거를 확인하거나 해당 조건을 비워 다시 비교해 주세요.',
                      },
                    ],
                  }
                : {
                    code: 'SELECT',
                    label: '선택 가능',
                    reasons: [],
                    reasonDetails: [],
                  };
            return {
            id: mode + '-' + index,
            label: (mode === 'NEW_CAR' ? '신차 후보 ' : '중고차 후보 ') + (index + 1),
            pathText: '제조사 › 모델 › 세대 › 트림 ' + (index + 1),
            nodeTypeLabel: '트림',
            state: hold
              ? { code: 'HOLD', label: '보류', tone: 'bad' }
              : unknown
                ? { code: 'UNKNOWN', label: '확인 필요', tone: 'warn' }
                : { code: 'ACTIVE', label: '사용 가능', tone: 'ok' },
            action,
            unresolved: unknown
              ? { axes: [{ code: 'seats', label: '인승' }], searchTokenCount: 0 }
              : { axes: [], searchTokenCount: 0 },
            listLines: [
              mode === 'NEW_CAR' ? '파워트레인 · 구성 정보' : '2022 · 세대 · 변경형',
              '트림/상세 맥락 ' + (index + 1),
            ],
            facts: [
              { label: '연식', value: mode === 'USED_CAR' ? '2022' : null, unknown: mode !== 'USED_CAR' },
              { label: '트림', value: '트림 ' + (index + 1), unknown: false },
            ],
            evidenceIds: ['evidence-' + index],
            sources: [{ id: 'source-test', label: '브라우저 QA synthetic' }],
            selectable: !hold && !unknown,
          };
          });

          const makeDrilldown = mode => mode === 'NEW_CAR'
            ? {
                axis: 'model',
                label: '모델',
                selectableCandidateCount: 9,
                unknownValueCount: 0,
                options: [
                  { id: 'model-a', label: '모델 A', value: null, count: 5 },
                  { id: 'model-b', label: '모델 B', value: null, count: 4 },
                ],
              }
            : {
                axis: 'modelYear',
                label: '연식',
                selectableCandidateCount: 9,
                unknownValueCount: 1,
                options: [
                  { id: 'my-2022', label: '2022', value: 2022, count: 5 },
                  { id: 'my-2023', label: '2023', value: 2023, count: 3 },
                ],
              };

          const makeGroups = mode => [0, 1].map(groupIndex => {
            const start = groupIndex * 9;
            const memberIds = Array.from(
              { length: 9 },
              (_, offset) => mode + '-' + (start + offset),
            );
            const drilldown = makeDrilldown(mode);
            return {
              id: mode + '-group-' + groupIndex,
              scope: 'MODEL_GENERATION',
              label: (mode === 'NEW_CAR' ? '신차 모델 ' : '중고차 모델 ') + (groupIndex + 1),
              context: '제조사 · ' + (groupIndex + 1) + '세대',
              representativeId: memberIds[0],
              memberIds,
              candidateCount: 9,
              selectableCount: groupIndex === 0 ? 7 : 9,
              inspectOnlyCount: groupIndex === 0 ? 1 : 0,
              blockedCount: groupIndex === 0 ? 1 : 0,
              expandable: true,
              suggestedDrilldownAxis: drilldown.axis,
              suggestedDrilldownLabel: drilldown.label,
              drilldowns: [drilldown],
            };
          });

          const makeFacets = mode => mode === 'NEW_CAR'
            ? [
                { axis: 'maker', label: '제조사', options: [{ key: 'maker-a', label: '제조사 A', count: 18 }] },
                { axis: 'model', label: '모델', options: [{ key: 'model-a', label: '모델 A', count: 9 }, { key: 'model-b', label: '모델 B', count: 9 }] },
              ]
            : [
                { axis: 'model', label: '모델', options: [{ key: 'used-a', label: '중고 모델 A', count: 18 }] },
                { axis: 'modelYear', label: '연식', options: [{ key: '2022', label: '2022', count: 10 }, { key: '2023', label: '2023', count: 8 }] },
                { axis: 'generation', label: '세대', options: [{ key: 'g1', label: '1세대', count: 18 }] },
                { axis: 'phase', label: '변경형', options: [{ key: 'p1', label: '페이스리프트', count: 18 }] },
              ];

          const makeSnapshot = (mode, count = 18) => {
            const items = makeItems(mode).slice(0, count);
            const groups = count === 18
              ? makeGroups(mode)
              : [{
                  ...makeGroups(mode)[0],
                  memberIds: items.map(item => item.id),
                  representativeId: items[0].id,
                  candidateCount: items.length,
                  selectableCount: items.filter(item => item.action.code === 'SELECT').length,
                  inspectOnlyCount: items.filter(item => item.action.code === 'INSPECT_ONLY').length,
                  blockedCount: items.filter(item => item.action.code === 'BLOCKED').length,
                }];
            return {
              schemaVersion: 'freepass.vehicle-finder.ui/v1',
              mode,
              presentation: mode === 'NEW_CAR' ? 'GUIDED' : 'SEARCH_FILTER',
              guidance: {
                resolutionStatus: 'AMBIGUOUS',
                suggestedNextAxis: mode === 'NEW_CAR' ? 'model' : 'modelYear',
              },
              observationId: 'browser-qa-' + mode + '-' + count,
              observedAt: '2026-09-26T08:00:00.000Z',
              coverage: 'COMPLETE',
              total: items.length,
              hasMore: false,
              excludedUnknownFacetCount: 0,
              facets: makeFacets(mode),
              groups,
              items,
            };
          };

          window.__qaReadContexts = [];
          window.__qaRead = async ({ mode, readContext }) => {
            window.__qaReadContexts.push(readContext ?? null);
            return readContext ? makeSnapshot(mode, 4) : makeSnapshot(mode);
          };
          window.__qaGroupDrilldown = async payload => {
            window.__qaLastDrilldown = payload;
            if (payload.option.label.endsWith('B')) {
              return {
                transition: {
                  status: 'REJECTED',
                  reason: 'DRILLDOWN_OPTION_NOT_AVAILABLE',
                  activeGroupId: null,
                  beforeCandidateCount: 18,
                  afterCandidateCount: 18,
                  clearedAxes: [],
                },
              };
            }
            return {
              transition: {
                status: 'APPLIED',
                reason: null,
                activeGroupId: payload.mode + '-group-0',
                beforeCandidateCount: 18,
                afterCandidateCount: 4,
                clearedAxes: ['trim'],
              },
              snapshot: makeSnapshot(payload.mode, 4),
              readContext: {
                transition: 'browser-qa',
                groupId: payload.groupId,
                axis: payload.axis,
                option: payload.option.label,
              },
            };
          };

          window.__qaSnapshot = makeSnapshot; 
          window.__qaReadLegacy = window.__qaRead;

          window.__qaFinder = mountVehicleFinder(
            document.getElementById('vehicle-finder'),
            {
              read: window.__qaRead,
              onGroupDrilldown: window.__qaGroupDrilldown,
              initialMode: 'NEW_CAR',
            },
          );
          await window.__qaFinder.ready;
        }"""
        desktop.evaluate(mount_script)
        expect(desktop.get_by_text("신차 찾기")).to_be_visible()
        expect(desktop.locator(".vf-guided-options")).to_be_visible()
        expect(desktop.locator(".vf-group-row")).to_have_count(2)
        expect(desktop.locator(".vf-group-member")).to_have_count(0)
        desktop.locator(".vf-group-button").first.click()
        expect(desktop.locator(".vf-group-member")).to_have_count(9)
        expect(
            desktop.locator(".vf-group-row").first.get_by_text("먼저 보기 · 모델")
        ).to_be_visible()
        expect(desktop.get_by_text("모델 조건으로 좁히기")).to_be_visible()
        desktop.locator(".vf-group-drilldown-option").nth(1).click()
        expect(desktop.get_by_text("선택한 값은 현재 그룹에서 더 이상 사용할 수 없습니다. [DRILLDOWN_OPTION_NOT_AVAILABLE]")).to_be_visible()
        expect(desktop.locator(".vf-group-member")).to_have_count(9)

        desktop.locator(".vf-group-drilldown-option").first.click()
        expect(desktop.get_by_text("후보 18개 → 4개")).to_be_visible()
        expect(desktop.locator(".vf-group-member")).to_have_count(4)
        assert desktop.evaluate("window.__qaLastDrilldown.option.label") == "모델 A"

        desktop.locator(".vf-group-member").nth(2).get_by_role("button").click()
        expect(desktop.get_by_text("현재 선택할 수 없는 이유")).to_be_visible()
        expect(desktop.get_by_text("LIFECYCLE_HOLD")).to_be_visible()
        expect(desktop.get_by_text("IDENTITY_HOLD")).to_be_visible()
        expect(desktop.get_by_role("button", name="선택할 수 없음")).to_be_disabled()
        desktop.get_by_role("button", name="상세 닫기").click()

        desktop.locator(".vf-group-member").first.get_by_role("button").click()
        expect(desktop.locator(".vf-detail")).to_be_visible()
        assert desktop.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        desktop.screenshot(path=args.output / "desktop-finder.png", full_page=True)

        mobile = browser.new_page(viewport={"width": 390, "height": 844})
        mobile.goto(route, wait_until="networkidle")
        mobile.evaluate(mount_script)
        assert mobile.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        expect(mobile.get_by_role("button", name="필터")).to_be_visible()
        expect(mobile.locator(".vf-group-row")).to_have_count(2)
        expect(mobile.locator(".vf-group-member")).to_have_count(0)

        mobile.locator(".vf-group-button").first.click()
        expect(mobile.locator(".vf-group-member")).to_have_count(9)
        expect(mobile.get_by_text("모델 조건으로 좁히기")).to_be_visible()
        mobile.locator(".vf-group-drilldown-option").first.click()
        expect(mobile.locator(".vf-group-member")).to_have_count(4)
        expect(mobile.get_by_text("충돌하는 기존 조건 1개가 정리되었습니다.")).to_be_visible()
        mobile.locator(".vf-group-member").nth(3).get_by_role("button").scroll_into_view_if_needed()
        mobile.locator(".vf-group-member").nth(3).get_by_role("button").click()
        expect(mobile.get_by_text("선택 전 확인할 내용")).to_be_visible()
        expect(mobile.get_by_text("IDENTITY_PARTIAL")).to_be_visible()
        expect(mobile.get_by_text("UNRESOLVED_SELECTION")).to_be_visible()
        expect(mobile.get_by_text("인승", exact=True)).to_be_visible()
        expect(mobile.get_by_role("button", name="목록으로")).to_be_visible()
        expect(mobile.get_by_role("button", name="확인만 가능")).to_be_disabled()
        back_box = mobile.get_by_role("button", name="목록으로").bounding_box()
        primary_box = mobile.get_by_role("button", name="확인만 가능").bounding_box()
        assert back_box and primary_box
        ratio = primary_box["width"] / back_box["width"]
        assert 1.9 <= ratio <= 2.8, f"unexpected mobile action ratio: {ratio}"
        mobile.screenshot(path=args.output / "mobile-detail.png", full_page=True)

        mobile.get_by_role("button", name="목록으로").click()
        expect(mobile.get_by_text("방금 본 후보")).to_be_visible()
        expect(mobile.locator(".vf-group-member")).to_have_count(4)
        expect(mobile.get_by_role("button", name="필터")).to_be_visible()
        mobile.get_by_role("button", name="다시 조회").click()
        expect(mobile.locator(".vf-group-member")).to_have_count(4)
        assert mobile.evaluate(
            "window.__qaReadContexts[window.__qaReadContexts.length - 1].transition"
        ) == "browser-qa"

        mobile.get_by_role("button", name="필터").click()
        expect(mobile.get_by_role("dialog", name="필터")).to_be_visible()
        assert mobile.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        mobile.get_by_role("button", name="필터 닫기").click()

        mobile.get_by_role("button", name="중고차").click()
        expect(mobile.get_by_text("중고차 찾기")).to_be_visible()
        assert mobile.evaluate("window.__qaReadContexts[window.__qaReadContexts.length - 1]") is None
        expect(mobile.get_by_text("검색·필터형")).to_be_visible()
        expect(mobile.get_by_text("방금 본 후보")).to_have_count(0)
        expect(mobile.locator(".vf-group-member")).to_have_count(0)
        expect(
            mobile.locator(".vf-group-row").first.get_by_text("먼저 보기 · 연식")
        ).to_be_visible()

        mobile.get_by_role("button", name="필터").click()
        filter_dialog = mobile.get_by_role("dialog", name="필터")
        expect(filter_dialog).to_be_visible()
        expect(filter_dialog.get_by_text("연식", exact=True)).to_be_visible()
        expect(filter_dialog.get_by_text("세대", exact=True)).to_be_visible()
        expect(filter_dialog.get_by_text("변경형", exact=True)).to_be_visible()
        mobile.screenshot(path=args.output / "mobile-used-finder.png", full_page=True)
        mobile.get_by_role("button", name="필터 닫기").click()

        browser.close()
finally:
    server.terminate()
    try:
        server.wait(timeout=3)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait(timeout=3)
