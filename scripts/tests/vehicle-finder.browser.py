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
            raw_view = (ROOT / 'preview/vehicle-finder/view.mjs').read_text()
            view = 'let instanceCount' + raw_view.split('let instanceCount', 1)[1]
            view = view.replace('export ', '')
            fixtures = (ROOT / 'scripts/tests/vehicle-finder.fixture.mjs').read_text().replace('export ', '')
            css = (ROOT / 'preview/vehicle-finder/finder.css').read_text()
            page.set_content('<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style></head><body style="margin:0"><main id="vehicle-finder"></main></body></html>')
            page.add_script_tag(content=core + '\n' + view + '\n' + fixtures + '\nwindow.__finder = { mountVehicleFinder, fixture }; mountVehicleFinder(document.getElementById("vehicle-finder"));')
        else:
            page.goto(f'http://127.0.0.1:{server.server_port}/preview/vehicle-finder/')

        expect(page.locator('.vf-status')).to_have_text('조회 연결 대기')
        assert page.locator('tbody .vf-row-button').count() == 0
        passed('default page does not fabricate records before read adapter is connected')

        def mount(mode='normal'):
            page.evaluate('''async mode => {
              const { mountVehicleFinder, fixture } = window.__finder ?? {
                ...(await import('/preview/vehicle-finder/view.mjs')),
                ...(await import('/scripts/tests/vehicle-finder.fixture.mjs'))
              };
              window.finder?.destroy();
              window.selected = null;
              const data = fixture();
              if (mode === 'xss') {
                data.entries[0].label = '<img src=x onerror=alert(1)>';
                data.entries[0].path[data.entries[0].path.length - 1].label = data.entries[0].label;
              }
              let calls = 0;
              const read = mode === 'error'
                ? async () => { throw new Error('simulated failure'); }
                : mode === 'stale-error'
                  ? async () => {
                      if (calls++ === 0) return data;
                      throw new Error('simulated refresh failure');
                    }
                  : async () => data;
              window.finder = mountVehicleFinder(document.getElementById('vehicle-finder'), {
                read,
                onSelect: value => { window.selected = value; }
              });
              await window.finder.ready;
            }''', mode)

        mount()
        expect(page.get_by_role('button', name='다시 조회', exact=True)).to_be_visible()
        assert page.get_by_role('button', name='다시 조회', exact=True).inner_text() == '↻'
        expect(page.locator('tbody .vf-row-button')).to_have_count(5)
        assert page.locator('.vf-selection').is_hidden()
        expect(page.locator('thead th')).to_have_count(1)
        expect(page.locator('thead')).to_have_text('차량')
        model_b_row = page.locator('tr', has=page.get_by_role('button', name='시험제조사 › 시험차 B', exact=True))
        expect(model_b_row.locator('.vf-row-check')).to_have_text('구성 미확인')
        assert '구성 자료' not in page.locator('tbody').inner_text()
        expect(page.locator('.vf-head')).to_have_text('차량 찾기')
        expect(page.locator('.vf-head')).not_to_contain_text('아는 정보만으로')
        passed('initial browse stays minimal and only exceptional configuration state is visible')

        page.get_by_label('차량 검색', exact=True).fill('쏘렌토 프레스티지')
        expect(page.locator('tbody .vf-row-button')).to_have_count(1)
        trim_row = page.locator('tr').filter(has=page.get_by_role('button', name='기아 › 쏘렌토 › 2027 › 프레스티지', exact=True))
        expect(trim_row.locator('.vf-row-path')).to_have_text('쏘렌토 › 2027')
        selected_trim = page.get_by_role('button', name='기아 › 쏘렌토 › 2027 › 프레스티지', exact=True)
        selected_trim.click()
        expect(page.get_by_role('button', name='상세 닫기', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='목록으로', exact=True)).to_be_hidden()
        expect(page.locator('.vf-configurations summary')).to_have_text('검색 조건과 일치한 구성 1개')
        assert not page.locator('.vf-configurations').evaluate('(node) => node.open')
        expect(selected_trim).to_have_attribute('aria-expanded', 'true')
        expect(trim_row).to_have_attribute('data-selected', 'true')
        expect(page.locator('.vf-row-state')).to_have_count(0)
        passed('ancestor path disambiguates duplicate trims with one visual selected-row signal')
        page.keyboard.press('Escape')

        page.get_by_label('차량 검색', exact=True).fill('시험차 B')
        model_b = page.get_by_role('button', name='시험제조사 › 시험차 B', exact=True)
        expect(model_b.locator('.vf-row-path')).to_have_count(0)
        assert model_b.bounding_box()['height'] >= 44
        model_b.click()
        expect(page.locator('.vf-detail')).to_contain_text('MODEL 수준 · 차량 구성 미확정')
        expect(page.locator('.vf-config-missing')).to_contain_text('세부 구성 미확인')
        expect(page.get_by_text('검색·조회 근거', exact=True)).to_be_visible()
        assert not page.locator('.vf-evidence').evaluate('(node) => node.open')
        confirm = page.get_by_role('button', name='이 수준으로 선택')
        confirm.click()
        expect(page.get_by_role('button', name='선택됨', exact=True)).to_be_disabled()
        expect(page.locator('.vf-selection-success')).to_have_text('시험차 B 선택됨')
        selected = page.evaluate('window.selected')
        assert selected['nodeType'] == 'MODEL' and selected['configurationConfirmed'] is False
        assert selected['path'][-1]['label'] == '시험차 B'
        assert 'modelYear' not in selected and 'trimId' not in selected
        passed('model with no year/trim/configuration supports explicit partial selection')

        page.keyboard.press('Escape')
        expect(page.get_by_label('차량 검색', exact=True)).to_have_value('시험차 B')
        expect(model_b).to_be_focused()
        passed('Escape/back restores query and exact row focus')

        page.get_by_label('차량 검색', exact=True).fill('시험차 A HEV 7인승')
        expect(page.locator('tbody .vf-row-button')).to_have_count(0)
        expect(page.get_by_label('차량 검색', exact=True)).to_have_value('시험차 A HEV 7인승')
        passed('incompatible sibling facts produce no match without rewriting the query')

        page.get_by_label('차량 검색', exact=True).fill('시험차 A')
        page.get_by_role('button', name='필터', exact=True).click()
        page.get_by_role('combobox', name='연료', exact=True).select_option('HEV')
        page.get_by_role('combobox', name='인승', exact=True).select_option('7')
        expect(page.locator('tbody .vf-row-button')).to_have_count(0)
        expect(page.get_by_role('combobox', name='연료', exact=True)).to_have_value('HEV')
        expect(page.get_by_role('combobox', name='인승', exact=True)).to_have_value('7')
        expect(page.get_by_role('button', name='필터 · 2', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='필터 초기화', exact=True)).to_be_visible()
        passed('explicit facet intersection is atomic and active filter count stays visible')

        page.get_by_role('button', name='필터 초기화').click()
        expect(page.get_by_role('button', name='필터', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='필터 초기화', exact=True)).to_be_hidden()

        page.set_viewport_size({'width': 390, 'height': 844})
        filter_button = page.get_by_role('button', name='필터', exact=True)
        filter_button.click()
        expect(page.get_by_role('button', name='필터 닫기', exact=True)).to_be_visible()
        filter_sheet = page.locator('.vf-filters')
        sheet_box = filter_sheet.bounding_box()
        assert sheet_box['y'] + sheet_box['height'] >= 840
        expect(page.get_by_role('combobox', name='연식', exact=True)).to_be_visible()
        expect(page.get_by_role('combobox', name='연료', exact=True)).to_be_visible()
        expect(page.get_by_role('combobox', name='트림', exact=True)).to_be_visible()
        expect(page.get_by_role('combobox', name='인승', exact=True)).to_be_hidden()
        expect(page.get_by_role('combobox', name='구동', exact=True)).to_be_hidden()
        page.get_by_role('button', name='추가 조건', exact=True).click()
        expect(page.get_by_role('combobox', name='인승', exact=True)).to_be_visible()
        expect(page.get_by_role('combobox', name='구동', exact=True)).to_be_visible()
        page.get_by_role('button', name='필터 닫기', exact=True).click()
        expect(filter_sheet).to_be_hidden()
        expect(filter_button).to_be_focused()
        passed('mobile filter sheet keeps three primary filters and progressively reveals advanced conditions')
        page.set_viewport_size({'width': 1440, 'height': 1000})

        page.get_by_label('차량 검색', exact=True).fill('')
        page.evaluate('''() => {
          const input = document.querySelector('input[type=search]');
          input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
          input.value = '아직조합중';
          input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
        }''')
        expect(page.locator('tbody .vf-row-button')).to_have_count(5)
        page.evaluate('''() => {
          const input = document.querySelector('input[type=search]');
          input.value = '프레스티지';
          input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        }''')
        expect(page.locator('tbody .vf-row-button')).to_have_count(2)
        passed('synthetic IME composition does not filter midway; completed input does')

        mount('stale-error')
        expect(page.locator('tbody .vf-row-button')).to_have_count(5)
        page.evaluate('window.finder.refresh()')
        expect(page.locator('.vf-status')).to_contain_text('직전 관측 유지 · 새 조회 실패')
        page.get_by_label('차량 검색', exact=True).fill('시험차 A')
        expect(page.locator('.vf-status')).to_contain_text('직전 관측 유지 · 새 조회 실패')
        page.get_by_role('button', name='필터', exact=True).click()
        page.get_by_role('combobox', name='연료', exact=True).select_option('HEV')
        expect(page.locator('.vf-status')).to_contain_text('직전 관측 유지 · 새 조회 실패')
        expect(page.get_by_role('button', name='필터 · 1', exact=True)).to_be_visible()
        passed('stale last-known-good warning survives query and filter rerenders')

        mount('error')
        expect(page.locator('.vf-status')).to_have_text('조회 실패')
        expect(page.locator('.vf-empty')).to_contain_text('차량이 없다는 뜻은 아닙니다')
        passed('transport failure is not reported as zero vehicles')

        mount('xss')
        assert page.locator('.vf img').count() == 0
        assert '<img src=x onerror=alert(1)>' in page.locator('tbody').inner_text()
        passed('read model labels are inserted as text, not HTML')

        mount()
        for width in [360, 390, 412, 768, 899, 900, 901, 1024, 1280, 1440, 1920]:
            page.set_viewport_size({'width': width, 'height': 900})
            page.get_by_label('차량 검색', exact=True).fill('시험차 A')
            assert not page.evaluate('document.documentElement.scrollWidth > window.innerWidth'), f'list overflow at {width}'
            if width <= 900:
                search_box = page.get_by_label('차량 검색', exact=True).bounding_box()
                filter_box = page.get_by_role('button', name='필터', exact=True).bounding_box()
                refresh_box = page.get_by_role('button', name='다시 조회', exact=True).bounding_box()
                assert abs(search_box['y'] - filter_box['y']) <= 2, f'mobile filter wraps below search at {width}'
                assert abs(search_box['y'] - refresh_box['y']) <= 2, f'mobile refresh wraps below search at {width}'
            if width == 1920:
                assert page.locator('.vf').bounding_box()['width'] > 1800, 'desktop data workspace is still artificially capped'
            row = page.get_by_role('button', name='시험제조사 › 시험차 A', exact=True)
            row.focus()
            page.keyboard.press('Enter')
            expect(page.locator('.vf-detail h2')).to_be_focused()
            assert not page.evaluate('document.documentElement.scrollWidth > window.innerWidth'), f'detail overflow at {width}'
            if width > 900:
                expect(page.get_by_role('button', name='상세 닫기', exact=True)).to_be_visible()
                expect(page.get_by_role('button', name='목록으로', exact=True)).to_be_hidden()
            confirm = page.get_by_role('button', name='이 수준으로 선택')
            assert confirm.bounding_box()['height'] >= (48 if width <= 900 else 44)
            if width <= 900:
                expect(page.locator('.vf-head')).to_be_hidden()
                expect(page.get_by_role('button', name='상세 닫기', exact=True)).to_be_hidden()
                actionbar = page.locator('.vf-actionbar').bounding_box()
                assert actionbar['y'] + actionbar['height'] >= 890
                expect(page.get_by_role('button', name='목록으로')).to_be_visible()
                page.keyboard.press('Escape')
                expect(row).to_be_focused()
                expect(page.get_by_label('차량 검색', exact=True)).to_have_value('시험차 A')
                list_row = page.locator('tr').filter(has=row)
                assert list_row.evaluate("(node) => getComputedStyle(node).borderRadius") == '0px'
                assert list_row.evaluate("(node) => getComputedStyle(node).backgroundColor") in ('rgba(0, 0, 0, 0)', 'transparent')
                passed(f'{width}px list/detail: no overflow, focus return, mobile bottom action boundary')
                continue
            page.keyboard.press('Escape')
            expect(row).to_be_focused()
            expect(page.get_by_label('차량 검색', exact=True)).to_have_value('시험차 A')
            passed(f'{width}px list/detail: no overflow, focus return, mobile bottom action boundary')

        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.evaluate('''() => {
          const badge = document.createElement('p');
          badge.textContent = '브라우저 검증 화면 · 가상 테스트 데이터 · 운영 Firebase 미연결';
          badge.style.cssText = 'font:13px sans-serif;padding:12px 24px;margin:0;background:#F1F5FA;color:#1B2A4A';
          badge.id = 'test-only-banner';
          document.body.prepend(badge);
        }''')
        page.get_by_label('차량 검색', exact=True).fill('')
        page.get_by_role('button', name='시험제조사 › 시험차 A', exact=True).click()
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
    result = {
        'status': 'PASS' if completed else 'FAIL',
        'environment': 'offline Chromium DOM / synthetic fixtures' if args.offline else 'local HTTP Chromium / synthetic fixtures',
        'httpIntegrationPassed': bool(completed and not args.offline),
        'checks': checks,
        'passed': len(checks),
        'browserErrors': errors,
        'productionFirebaseTested': False
    }
    (args.output / 'browser-tests.json').write_text(
        json.dumps(result, ensure_ascii=False, indent=2)
    )
