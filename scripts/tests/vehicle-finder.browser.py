"""Local Chromium smoke tests with explicitly synthetic data; never opens production APIs.
Run: python scripts/tests/vehicle-finder.browser.py --output /tmp/finder-evidence
Requires the Python playwright package and Chromium (or Playwright's Chromium install).
"""
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from threading import Thread
import argparse
import json
import shutil
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--offline', action='store_true', help='Render source files in memory without HTTP navigation; not an HTTP integration test')
parser.add_argument('--output', type=Path, default=Path('/tmp/freepass-finder-evidence'))
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
thread = Thread(target=server.serve_forever, daemon=True)
thread.start()
checks = []
errors = []
completed = False
def passed(name):
    checks.append(name)
    print('PASS', name)

try:
    with sync_playwright() as pw:
        executable = shutil.which('chromium') or shutil.which('chromium-browser')
        browser = pw.chromium.launch(headless=True, executable_path=executable)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.set_default_timeout(5000)
        page.on('pageerror', lambda error: errors.append(str(error)))
        if args.offline:
            # No blocked URL is retried or bypassed. This is a separate in-memory DOM test.
            core = (ROOT / 'preview/vehicle-finder/core.mjs').read_text().replace('export ', '')
            view = (ROOT / 'preview/vehicle-finder/view.mjs').read_text().split('\n', 1)[1].replace('export ', '')
            fixtures = (ROOT / 'scripts/tests/vehicle-finder.fixture.mjs').read_text().replace('export ', '')
            css = (ROOT / 'preview/vehicle-finder/finder.css').read_text()
            page.set_content('<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style></head><body style="margin:0"><main id="vehicle-finder"></main></body></html>')
            page.add_script_tag(content=core + '\n' + view + '\n' + fixtures + '\nwindow.__finder = { mountVehicleFinder, fixture }; mountVehicleFinder(document.getElementById("vehicle-finder"));')
        else:
            page.goto(f'http://127.0.0.1:{server.server_port}/preview/vehicle-finder/')
        expect(page.locator('.vf-status')).to_have_text('조회 연결 대기')
        assert page.locator('tbody button').count() == 0
        passed('default page does not fabricate records before read adapter is connected')

        def mount(mode='normal'):
            page.evaluate('''async mode => {
              const { mountVehicleFinder, fixture } = window.__finder ?? { ...(await import('/preview/vehicle-finder/view.mjs')), ...(await import('/scripts/tests/vehicle-finder.fixture.mjs')) };
              window.finder?.destroy();
              window.selected = null;
              const data = fixture();
              if (mode === 'xss') data.entries[0].label = '<img src=x onerror=alert(1)>';
              const read = mode === 'error' ? async () => { throw new Error('simulated failure'); } : async () => data;
              window.finder = mountVehicleFinder(document.getElementById('vehicle-finder'), {
                read, onSelect: value => { window.selected = value; }
              });
              await window.finder.ready;
            }''', mode)

        mount()
        expect(page.locator('tbody button')).to_have_count(3)
        assert page.locator('.vf-selection').is_hidden()
        passed('initial browse has no required filters and never auto-selects a result')
        page.get_by_label('차량 검색', exact=True).fill('시험차 B')
        page.get_by_role('button', name='시험차 B', exact=True).click()
        page.get_by_role('button', name='이 수준으로 선택').click()
        selected = page.evaluate('window.selected')
        assert selected['nodeType'] == 'MODEL' and selected['configurationConfirmed'] is False
        assert 'modelYear' not in selected and 'trimId' not in selected
        passed('model with no year/trim/configuration supports explicit partial selection')
        page.keyboard.press('Escape')
        expect(page.get_by_label('차량 검색', exact=True)).to_have_value('시험차 B')
        expect(page.get_by_role('button', name='시험차 B', exact=True)).to_be_focused()
        passed('Escape/back restores the query and the exact row focus')
        page.get_by_label('차량 검색', exact=True).fill('시험차 A HEV 7인승')
        expect(page.locator('tbody button')).to_have_count(0)
        expect(page.get_by_label('차량 검색', exact=True)).to_have_value('시험차 A HEV 7인승')
        passed('incompatible sibling facts produce no match without rewriting the query')

        page.get_by_label('차량 검색', exact=True).fill('시험차 A')
        page.get_by_role('button', name='필터', exact=True).click()
        page.get_by_role('combobox', name='연료', exact=True).select_option('HEV')
        page.get_by_role('combobox', name='인승', exact=True).select_option('7')
        expect(page.locator('tbody button')).to_have_count(0)
        expect(page.get_by_role('combobox', name='연료', exact=True)).to_have_value('HEV')
        expect(page.get_by_role('combobox', name='인승', exact=True)).to_have_value('7')
        passed('explicit facet intersection is atomic and impossible filters remain visible')
        page.get_by_role('button', name='필터 초기화').click()
        page.get_by_label('차량 검색', exact=True).fill('')
        page.evaluate('''() => {
          const input = document.querySelector('input[type=search]');
          input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
          input.value = '아직조합중';
          input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
        }''')
        expect(page.locator('tbody button')).to_have_count(3)
        page.evaluate('''() => {
          const input = document.querySelector('input[type=search]');
          input.value = '노블레스';
          input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        }''')
        expect(page.locator('tbody button')).to_have_count(1)
        passed('synthetic IME composition does not filter midway; completed input does')

        mount('error')
        expect(page.locator('.vf-status')).to_have_text('조회 실패')
        expect(page.locator('.vf-empty')).to_contain_text('차량이 없다는 뜻은 아닙니다')
        passed('transport failure is not reported as zero vehicles')
        mount('xss')
        assert page.locator('.vf img').count() == 0
        assert '<img src=x onerror=alert(1)>' in page.locator('tbody').inner_text()
        passed('read model labels are inserted as text, not HTML')

        mount()
        for width in [360, 390, 412, 1280, 1440, 1920]:
            page.set_viewport_size({'width': width, 'height': 900})
            page.get_by_label('차량 검색', exact=True).fill('시험차 A')
            overflow = page.evaluate('document.documentElement.scrollWidth > window.innerWidth')
            assert not overflow, f'list overflow at {width}'
            row = page.get_by_role('button', name='시험차 A', exact=True)
            row.focus()
            page.keyboard.press('Enter')
            expect(page.locator('.vf-detail h2')).to_be_focused()
            assert not page.evaluate('document.documentElement.scrollWidth > window.innerWidth'), f'detail overflow at {width}'
            confirm = page.get_by_role('button', name='이 수준으로 선택')
            assert confirm.bounding_box()['height'] >= 44
            page.keyboard.press('Escape')
            expect(row).to_be_focused()
            expect(page.get_by_label('차량 검색', exact=True)).to_have_value('시험차 A')
            passed(f'{width}px list/detail: no horizontal overflow, keyboard focus/return, action >=44px')

        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.evaluate('''() => {
          const badge = document.createElement('p');
          badge.textContent = '브라우저 검증 화면 · 가상 테스트 데이터 · 운영 Firebase 미연결';
          badge.style.cssText = 'font:13px sans-serif;padding:12px 24px;margin:0;background:#F1F5FA;color:#1B2A4A';
          badge.id = 'test-only-banner'; document.body.prepend(badge);
        }''')
        page.get_by_label('차량 검색', exact=True).fill('')
        page.get_by_role('button', name='시험차 A', exact=True).click()
        page.screenshot(path=str(args.output / 'desktop.png'), full_page=True)
        page.keyboard.press('Escape')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.screenshot(path=str(args.output / 'mobile.png'), full_page=True)
        assert errors == [], errors
        passed('no uncaught browser errors')
        completed = True
        browser.close()
finally:
    server.shutdown()
    server.server_close()
    result = {'status': 'PASS' if completed else 'FAIL', 'environment': 'offline Chromium DOM / synthetic fixtures' if args.offline else 'local HTTP Chromium / synthetic fixtures', 'httpIntegrationPassed': bool(completed and not args.offline), 'checks': checks, 'passed': len(checks), 'browserErrors': errors, 'productionFirebaseTested': False}
    (args.output / 'browser-tests.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
