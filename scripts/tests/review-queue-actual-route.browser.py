"""Actual-route browser QA for U-01 Review Queue."""
from __future__ import annotations
import argparse,os,socket,subprocess,time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser();parser.add_argument("--output",type=Path,default=Path("/tmp/freepass-review-queue"))
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
    route=f"http://127.0.0.1:{port}/console/review-queue"
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True)
        page=browser.new_page(viewport={"width":1440,"height":1000});page.goto(route,wait_until="networkidle")
        expect(page.get_by_text("Review Queue 연결 대기")).to_be_visible()

        page.evaluate("""async()=>{
          const { mountReviewQueue }=await import('/console/review-queue/view.mjs');
          const base=(n)=>({
            bindingId:'binding-'+n,bindingRevision:n,candidateId:'candidate-'+n,sourceId:'supplier-feed',sourceRecordId:'row-'+n,
            previousFingerprint:'prev-'+n,candidateFingerprint:'next-'+n,sourceRunId:'run-20260926',
            vehicleModelRevision:4,productRevision:7,offerRevision:12,vehicleAssetRevision:3,
            candidateIssues:n===3?['missing supplier mapping']:[],diffs:[],reviewableChangeIds:[],blockedChangeIds:[]
          });
          const a=base(1);
          a.diffs=[{changeId:'chg-rent',classification:'REVIEWABLE',entityType:'offer',entityId:'offer-1',fieldPath:'priceTerms.36.monthlyRent',before:{amount:720000,currency:'KRW'},after:{amount:740000,currency:'KRW'},reasonCode:'SOURCE_MONTHLY_RENT_CHANGE',authorityRuleId:'rule-offer-rent'}];
          a.reviewableChangeIds=['chg-rent'];
          const b=base(2);
          b.diffs=[{changeId:'chg-model',classification:'BLOCKED',entityType:'vehicle_model',entityId:'model-1',fieldPath:'model',before:'쏘렌토',after:'쏘렌토 신형',reasonCode:'VEHICLE_IDENTITY_CHANGE'}];
          b.blockedChangeIds=['chg-model'];
          const c=base(3);
          c.diffs=[
            {changeId:'chg-mileage',classification:'REVIEWABLE',entityType:'vehicle_asset',entityId:'asset-1',fieldPath:'odometerKm',before:12000,after:13020,reasonCode:'SOURCE_ODOMETER_CHANGE',authorityRuleId:'rule-odometer'},
            {changeId:'chg-plate',classification:'BLOCKED',entityType:'vehicle_asset',entityId:'asset-1',fieldPath:'plateNumber',before:'12가3456',after:'34나5678',reasonCode:'VEHICLE_ASSET_IDENTITY_CHANGE_REQUIRES_SEPARATE_COMMAND'}
          ];
          c.reviewableChangeIds=['chg-mileage'];c.blockedChangeIds=['chg-plate'];
          window.__queue=mountReviewQueue(document.getElementById('review-queue'),{read:async()=>({observedAt:'2026-09-26T10:00:00.000Z',reviews:[a,b,c]})});
          await window.__queue.ready;
        }""")
        expect(page.locator(".rq-row")).to_have_count(3)
        expect(page.get_by_text("3",exact=True).first).to_be_visible()
        page.locator(".rq-row").nth(2).click()
        expect(page.get_by_role("heading",name="supplier-feed · row-3")).to_be_visible()
        expect(page.get_by_text("SOURCE_ODOMETER_CHANGE")).to_be_visible()
        expect(page.get_by_text("VEHICLE_ASSET_IDENTITY_CHANGE_REQUIRES_SEPARATE_COMMAND")).to_be_visible()
        expect(page.get_by_text("missing supplier mapping")).to_be_visible()
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        page.screenshot(path=args.output/"review-queue-desktop.png",full_page=True)

        page.get_by_role("button",name="BLOCKED",exact=True).click()
        expect(page.locator(".rq-row")).to_have_count(2)

        mobile=browser.new_page(viewport={"width":390,"height":844});mobile.goto(route,wait_until="networkidle")
        mobile.evaluate("""async()=>{
          const { mountReviewQueue }=await import('/console/review-queue/view.mjs');
          const review={
            bindingId:'binding-mobile',bindingRevision:2,candidateId:'candidate-mobile',sourceId:'supplier-mobile',sourceRecordId:'row-mobile',
            previousFingerprint:'prev-mobile',candidateFingerprint:'next-mobile',sourceRunId:'run-mobile',
            vehicleModelRevision:1,productRevision:2,offerRevision:3,candidateIssues:[],
            diffs:[{changeId:'chg-mobile',classification:'BLOCKED',entityType:'product',entityId:'product-mobile',fieldPath:'commercialType',before:'RENT',after:'SUBSCRIPTION',reasonCode:'COMMERCIAL_TYPE_CHANGE_REQUIRES_SEPARATE_COMMAND'}],
            reviewableChangeIds:[],blockedChangeIds:['chg-mobile']
          };
          window.__queue=mountReviewQueue(document.getElementById('review-queue'),{read:async()=>({observedAt:'2026-09-26T10:00:00.000Z',reviews:[review]})});
          await window.__queue.ready;
        }""")
        mobile.locator(".rq-row").first.click()
        expect(mobile.get_by_role("heading",name="supplier-mobile · row-mobile")).to_be_visible()
        expect(mobile.get_by_role("button",name="목록으로")).to_be_visible()
        mobile.screenshot(path=args.output/"review-queue-mobile.png",full_page=True)
        mobile.keyboard.press("Escape")
        expect(mobile.locator(".rq-detail")).to_be_hidden()
        browser.close()
finally:
    server.terminate()
    try:server.wait(timeout=3)
    except subprocess.TimeoutExpired:server.kill();server.wait(timeout=3)
