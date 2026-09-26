"""Actual-route browser QA for U-01 Data Health."""
from __future__ import annotations
import argparse, os, socket, subprocess, time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser()
parser.add_argument("--output",type=Path,default=Path("/tmp/freepass-data-health-actual-route"))
args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)

def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1",0));return sock.getsockname()[1]

def wait_http(url,timeout=12.0):
    deadline=time.time()+timeout;last=None
    while time.time()<deadline:
        try:
            with urlopen(url,timeout=1) as response:
                if response.status==200:return
        except Exception as error:last=error
        time.sleep(.1)
    raise RuntimeError(f"server did not become ready: {last}")

port=free_port()
env=os.environ.copy();env["PORT"]=str(port);env["NODE_ENV"]="test"
server=subprocess.Popen(["node","--import","tsx","scripts/run-memory.mjs","api"],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
try:
    wait_http(f"http://127.0.0.1:{port}/health")
    route=f"http://127.0.0.1:{port}/console/data-health"
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True)
        page=browser.new_page(viewport={"width":1440,"height":1000})
        page.goto(route,wait_until="networkidle")
        expect(page.get_by_text("Consumer Health 연결 대기")).to_be_visible()

        page.evaluate("""async () => {
          const { mountDataHealth } = await import('/console/data-health/view.mjs');
          const consumers = [
            ['erp-com-public-catalog','ERP.com','freepass-erp','DEGRADED','OBSERVE','SHADOW_READ','GATEWAY_RUNTIME','SUCCEEDED',true,false,[]],
            ['erp-whitelabel-catalogs','White Label','freepass-erp','BLOCKED','OBSERVE','SHADOW_READ','WHITELABEL_AGGREGATE','AGGREGATE_REQUIRES_IDENTITIES',true,false,['missing consumer identities']],
            ['freepass-admin-catalog','FreePass Admin','freepass-admin','HEALTHY','FREEPASS_DATA_READ',null,'GATEWAY_RUNTIME','SUCCEEDED',true,true,[]],
            ['freepass-sales-catalog','FreePass Sales','freepass-sales','BLOCKED','OBSERVE','SHADOW_READ','NOT_IMPLEMENTED','NOT_IMPLEMENTED',false,false,['runtime not implemented']],
            ['freepass-estimate-catalog','FreePass Estimate','freepass-estimate','BLOCKED','OBSERVE','SHADOW_READ','GATEWAY_RUNTIME','UNOBSERVED',true,false,['production readback missing']],
            ['kakao-ops-catalog','Kakao Ops','kakao-ops','DEGRADED','OBSERVE','SHADOW_READ','GATEWAY_RUNTIME','SUCCEEDED',true,false,[]],
            ['google-sheets-f01','Google Sheets F01','freepass-data','BLOCKED','OBSERVE','SHADOW_READ','SHEET_DELIVERY','STALE',true,false,['sheet readback stale']],
            ['google-sheets-f86','Google Sheets F86','freepass-data','BLOCKED','OBSERVE','SHADOW_READ','SHEET_DELIVERY','UNOBSERVED',true,false,['missing delivery receipt']],
          ].map((row,index)=>({
            consumerId:row[0],project:row[1],repository:row[2],domains:['catalog'],
            status:row[3],currentStage:row[4],nextStage:row[5],
            activeReadOwner:index===2?'freepass-data':'legacy',
            targetReadOwner:'freepass-data',switchKey:'switch-'+index,
            evidence:{
              source:row[6],state:row[7],
              observedAt:index===7?null:'2026-09-26T09:00:00.000Z',
              ageMs:index===7?null:index*60000,
              eventId:index<6?'event-'+index:null,
              receiptId:index>=6?'receipt-'+index:null,
              releaseAuthority:index===2?'CANONICAL_ACTIVE':null,
              projectionId:index===2?'erp-public':null,
              releaseId:index===2?'release-active':null,
              manifestId:index===2?'manifest-active':null,
              authenticated:row[8],
              freepassReadVerified:row[8],
              productionReadbackVerified:row[9],
              parityVerified:index===2,
              fallbackVerified:index===2,
            },
            nextTransition:row[5]?{allowed:!row[10].length,from:row[4],to:row[5],blockers:[...row[10]]}:null,
            blockers:[...row[10]],
            staticHoldReasons:index===1?['identity split required']:[],
          }));
          window.__healthReport={
            contractVersion:'consumer-health-v1',schemaVersion:'1.0.0',
            generatedAt:'2026-09-26T09:05:00.000Z',status:'BLOCKED',
            policy:{maxAgeMs:600000,maxFutureSkewMs:0,eventLimit:1000},
            consumers
          };
          window.__health = mountDataHealth(document.getElementById('data-health'),{read:async()=>structuredClone(window.__healthReport)});
          await window.__health.ready;
        }""")

        expect(page.get_by_role("heading",name="Data Health")).to_be_visible()
        expect(page.get_by_text("차단",exact=True).first).to_be_visible()
        expect(page.locator(".dh-row")).to_have_count(8)
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")

        page.get_by_role("button",name="FreePass Admin").click()
        expect(page.get_by_role("heading",name="FreePass Admin")).to_be_visible()
        expect(page.get_by_text("CANONICAL_ACTIVE")).to_be_visible()
        expect(page.get_by_text("확인",exact=True).first).to_be_visible()
        page.screenshot(path=args.output/"data-health-desktop.png",full_page=True)

        page.get_by_role("button",name="차단",exact=True).click()
        expect(page.locator(".dh-row")).to_have_count(5)
        page.locator("input[type=search]").fill("sheet")
        expect(page.locator(".dh-row")).to_have_count(2)

        mobile=browser.new_page(viewport={"width":390,"height":844})
        mobile.goto(route,wait_until="networkidle")
        mobile.evaluate("""async () => {
          const { mountDataHealth } = await import('/console/data-health/view.mjs');
          window.__health = mountDataHealth(document.getElementById('data-health'),{read:async()=>structuredClone(window.opener?.__healthReport ?? {
            contractVersion:'consumer-health-v1',schemaVersion:'1.0.0',generatedAt:'2026-09-26T09:05:00.000Z',status:'BLOCKED',
            policy:{maxAgeMs:600000,maxFutureSkewMs:0,eventLimit:1000},
            consumers:[{
              consumerId:'freepass-sales-catalog',project:'FreePass Sales',repository:'freepass-sales',domains:['catalog'],status:'BLOCKED',
              currentStage:'OBSERVE',nextStage:'SHADOW_READ',activeReadOwner:'legacy',targetReadOwner:'freepass-data',switchKey:'sales',
              evidence:{source:'NOT_IMPLEMENTED',state:'NOT_IMPLEMENTED',observedAt:null,ageMs:null,eventId:null,receiptId:null,releaseAuthority:null,projectionId:null,releaseId:null,manifestId:null,authenticated:false,freepassReadVerified:false,productionReadbackVerified:false,parityVerified:false,fallbackVerified:false},
              nextTransition:{allowed:false,from:'OBSERVE',to:'SHADOW_READ',blockers:['runtime not implemented']},
              blockers:['runtime not implemented'],staticHoldReasons:['implementation required']
            }]
          })});
          await window.__health.ready;
        }""")
        expect(mobile.get_by_role("heading",name="Data Health")).to_be_visible()
        expect(mobile.locator(".dh-row")).to_have_count(1)
        mobile.locator(".dh-row").first.click()
        expect(mobile.get_by_role("heading",name="FreePass Sales")).to_be_visible()
        expect(mobile.get_by_text("runtime not implemented")).to_be_visible()
        expect(mobile.get_by_role("button",name="목록으로")).to_be_visible()
        mobile.screenshot(path=args.output/"data-health-mobile.png",full_page=True)
        assert mobile.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        mobile.keyboard.press("Escape")
        expect(mobile.locator(".dh-detail")).to_be_hidden()
        browser.close()
finally:
    server.terminate()
    try:server.wait(timeout=3)
    except subprocess.TimeoutExpired:
        server.kill();server.wait(timeout=3)
