"""Actual-route browser QA for U-01 Revision Ledger."""
from __future__ import annotations
import argparse,os,socket,subprocess,time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser();parser.add_argument("--output",type=Path,default=Path("/tmp/freepass-revision-ledger"))
args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)

def free_port():
    with socket.socket() as sock:sock.bind(("127.0.0.1",0));return sock.getsockname()[1]
def wait_http(url,timeout=12):
    deadline=time.time()+timeout;last=None
    while time.time()<deadline:
        try:
            with urlopen(url,timeout=1) as response:
                if response.status==200:return
        except Exception as error:last=error
        time.sleep(.1)
    raise RuntimeError(last)

port=free_port();env=os.environ.copy();env["PORT"]=str(port);env["NODE_ENV"]="test"
server=subprocess.Popen(["node","--import","tsx","scripts/run-memory.mjs","api"],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
try:
    wait_http(f"http://127.0.0.1:{port}/health")
    route=f"http://127.0.0.1:{port}/console/revision-ledger"
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True)
        page=browser.new_page(viewport={"width":1440,"height":1000});page.goto(route,wait_until="networkidle")
        expect(page.get_by_text("Revision Ledger 연결 대기")).to_be_visible()
        page.evaluate("""async()=>{
          const { mountRevisionLedger }=await import('/console/revision-ledger/view.mjs');
          const revisions=[
            {revisionRecordId:'rev-product-1',entityType:'product',entityId:'product-a',revision:1,previousRevision:null,snapshot:{displayName:'상품 A'},actor:{id:'service:seed',kind:'SERVICE'},reason:'초기 canonicalization',origin:'CANONICALIZATION',commandId:'cmd-seed-1',occurredAt:'2026-09-26T08:00:00.000Z',sourceBindingId:'binding-a',sourceRunId:'run-a'},
            {revisionRecordId:'rev-offer-2',entityType:'offer',entityId:'offer-a',revision:2,previousRevision:1,snapshot:{monthlyRent:740000},actor:{id:'user:operator',kind:'USER'},reason:'월 대여료 수정',origin:'MANUAL_COMMAND',commandId:'cmd-price-2',occurredAt:'2026-09-26T09:00:00.000Z'},
            {revisionRecordId:'rev-model-3',entityType:'vehicle_model',entityId:'model-a',revision:3,previousRevision:2,snapshot:{model:'쏘렌토'},actor:{id:'service:source-refresh',kind:'SERVICE'},reason:'원천 갱신 반영',origin:'SOURCE_REFRESH',commandId:'cmd-refresh-3',occurredAt:'2026-09-26T10:00:00.000Z',sourceBindingId:'binding-model-a',sourceRunId:'run-refresh-3'},
            {revisionRecordId:'rev-asset-4',entityType:'vehicle_asset',entityId:'asset-a',revision:4,previousRevision:3,snapshot:{odometerKm:13200},actor:{id:'user:operator',kind:'USER'},reason:'실차 주행거리 override',origin:'OVERRIDE',commandId:'cmd-override-4',occurredAt:'2026-09-26T10:30:00.000Z'}
          ];
          window.__ledger=mountRevisionLedger(document.getElementById('revision-ledger'),{read:async()=>({observedAt:'2026-09-26T10:35:00.000Z',revisions})});
          await window.__ledger.ready;
        }""")
        expect(page.locator(".rl-row")).to_have_count(4)
        expect(page.get_by_text("MANUAL_COMMAND")).to_be_visible()
        page.locator(".rl-row").nth(1).click()
        expect(page.get_by_role("heading",name="offer · offer-a")).to_be_visible()
        chain = page.locator(".rl-detail .rl-chain")
        expect(chain.get_by_text("r1",exact=True)).to_be_visible()
        expect(chain.get_by_text("r2",exact=True)).to_be_visible()
        detail = page.locator(".rl-detail")
        expect(detail.get_by_text("cmd-price-2",exact=True)).to_be_visible()
        expect(detail.get_by_text("USER · user:operator",exact=True)).to_be_visible()
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        page.screenshot(path=args.output/"revision-ledger-desktop.png",full_page=True)

        page.get_by_role("button",name="offer",exact=True).click()
        expect(page.locator(".rl-row")).to_have_count(1)

        mobile=browser.new_page(viewport={"width":390,"height":844});mobile.goto(route,wait_until="networkidle")
        mobile.evaluate("""async()=>{
          const { mountRevisionLedger }=await import('/console/revision-ledger/view.mjs');
          window.__ledger=mountRevisionLedger(document.getElementById('revision-ledger'),{read:async()=>({observedAt:'2026-09-26T10:35:00.000Z',revisions:[{
            revisionRecordId:'rev-mobile',entityType:'product',entityId:'product-mobile',revision:5,previousRevision:4,snapshot:{displayName:'모바일 상품'},actor:{id:'service:migration',kind:'SERVICE'},reason:'migration 재구성',origin:'MIGRATION',commandId:'cmd-mobile',occurredAt:'2026-09-26T10:30:00.000Z',sourceBindingId:null,sourceRunId:null
          }]})});await window.__ledger.ready;
        }""")
        mobile.locator(".rl-row").first.click()
        expect(mobile.get_by_role("heading",name="product · product-mobile")).to_be_visible()
        expect(mobile.get_by_role("button",name="목록으로")).to_be_visible()
        expect(mobile.locator(".rl-detail h2")).to_be_focused()
        mobile.screenshot(path=args.output/"revision-ledger-mobile.png",full_page=True)
        mobile.keyboard.press("Escape");expect(mobile.locator(".rl-detail")).to_be_hidden()
        browser.close()
finally:
    server.terminate()
    try:server.wait(timeout=3)
    except subprocess.TimeoutExpired:server.kill();server.wait(timeout=3)
