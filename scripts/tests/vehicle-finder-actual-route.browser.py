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
          const makeItems = mode => Array.from({ length: 18 }, (_, index) => ({
            id: mode + '-' + index,
            label: (mode === 'NEW_CAR' ? '신차 후보 ' : '중고차 후보 ') + (index + 1),
            pathText: '제조사 › 모델 › 세대 › 트림 ' + (index + 1),
            nodeTypeLabel: '트림',
            state: { code: index === 2 ? 'HOLD' : 'ACTIVE', label: index === 2 ? '보류' : '사용 가능', tone: index === 2 ? 'warn' : 'ok' },
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
            selectable: index !== 2,
          }));

          window.__qaRead = async ({ mode }) => ({
            schemaVersion: 'freepass.vehicle-finder.ui/v1',
            mode,
            presentation: mode === 'NEW_CAR' ? 'GUIDED' : 'SEARCH_FILTER',
            guidance: {
              resolutionStatus: 'AMBIGUOUS',
              suggestedNextAxis: mode === 'NEW_CAR' ? 'model' : 'modelYear',
            },
            observationId: 'browser-qa-' + mode,
            observedAt: '2026-09-26T08:00:00.000Z',
            coverage: 'COMPLETE',
            total: 18,
            hasMore: false,
            excludedUnknownFacetCount: 0,
            facets: mode === 'NEW_CAR'
              ? [
                  { axis: 'maker', label: '제조사', options: [{ key: 'maker-a', label: '제조사 A', count: 18 }] },
                  { axis: 'model', label: '모델', options: [{ key: 'model-a', label: '모델 A', count: 9 }, { key: 'model-b', label: '모델 B', count: 9 }] },
                ]
              : [
                  { axis: 'model', label: '모델', options: [{ key: 'used-a', label: '중고 모델 A', count: 18 }] },
                  { axis: 'modelYear', label: '연식', options: [{ key: '2022', label: '2022', count: 10 }, { key: '2023', label: '2023', count: 8 }] },
                  { axis: 'generation', label: '세대', options: [{ key: 'g1', label: '1세대', count: 18 }] },
                  { axis: 'phase', label: '변경형', options: [{ key: 'p1', label: '페이스리프트', count: 18 }] },
                ],
            items: makeItems(mode),
          });

          window.__qaFinder = mountVehicleFinder(
            document.getElementById('vehicle-finder'),
            { read: window.__qaRead, initialMode: 'NEW_CAR' },
          );
          await window.__qaFinder.ready;
        }"""
        desktop.evaluate(mount_script)
        expect(desktop.get_by_text("신차 찾기")).to_be_visible()
        expect(desktop.locator(".vf-guided-options")).to_be_visible()
        expect(desktop.locator("tbody tr")).to_have_count(18)
        desktop.locator("tbody tr").nth(0).get_by_role("button").click()
        expect(desktop.locator(".vf-detail")).to_be_visible()
        assert desktop.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        desktop.screenshot(path=args.output / "desktop-finder.png", full_page=True)

        mobile = browser.new_page(viewport={"width": 390, "height": 844})
        mobile.goto(route, wait_until="networkidle")
        mobile.evaluate(mount_script)
        assert mobile.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        expect(mobile.get_by_role("button", name="필터")).to_be_visible()

        mobile.locator("tbody tr").nth(8).get_by_role("button").scroll_into_view_if_needed()
        mobile.locator("tbody tr").nth(8).get_by_role("button").click()
        expect(mobile.get_by_role("button", name="목록으로")).to_be_visible()
        expect(mobile.get_by_role("button", name="이 차량 선택")).to_be_visible()
        back_box = mobile.get_by_role("button", name="목록으로").bounding_box()
        primary_box = mobile.get_by_role("button", name="이 차량 선택").bounding_box()
        assert back_box and primary_box
        ratio = primary_box["width"] / back_box["width"]
        assert 1.9 <= ratio <= 2.8, f"unexpected mobile action ratio: {ratio}"
        mobile.screenshot(path=args.output / "mobile-detail.png", full_page=True)

        mobile.get_by_role("button", name="목록으로").click()
        expect(mobile.get_by_text("방금 본 후보")).to_be_visible()
        expect(mobile.get_by_role("button", name="필터")).to_be_visible()

        mobile.get_by_role("button", name="필터").click()
        expect(mobile.get_by_role("dialog", name="필터")).to_be_visible()
        assert mobile.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        mobile.get_by_role("button", name="필터 닫기").click()

        mobile.get_by_role("button", name="중고차").click()
        expect(mobile.get_by_text("중고차 찾기")).to_be_visible()
        expect(mobile.get_by_text("검색·필터형")).to_be_visible()
        expect(mobile.get_by_text("연식", exact=True)).to_be_visible()
        expect(mobile.get_by_text("세대", exact=True)).to_be_visible()
        expect(mobile.get_by_text("변경형", exact=True)).to_be_visible()
        expect(mobile.get_by_text("방금 본 후보")).to_have_count(0)
        mobile.screenshot(path=args.output / "mobile-used-finder.png", full_page=True)

        browser.close()
finally:
    server.terminate()
    try:
        server.wait(timeout=3)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait(timeout=3)
