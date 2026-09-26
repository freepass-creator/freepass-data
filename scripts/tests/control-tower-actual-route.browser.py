"""Actual-route browser QA for U-01 Data Control Tower."""
from __future__ import annotations
import argparse,os,socket,subprocess,time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser();parser.add_argument("--output",type=Path,default=Path("/tmp/freepass-control-tower"))
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
    route=f"http://127.0.0.1:{port}/console/control-tower"
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True)
        page=browser.new_page(viewport={"width":1440,"height":1000});page.goto(route,wait_until="networkidle")
        expect(page.get_by_text("Control Tower 연결 대기")).to_be_visible()

        page.evaluate("""async()=>{
          const { mountControlTower }=await import('/console/control-tower/view.mjs');
          const report={
            contractVersion:'freepass-data-control-tower-v1',schemaVersion:'1.0.0',
            generatedAt:'2026-09-26T10:00:00.000Z',runId:'run-browser-1',
            axes:{
              sourceObservation:{status:'OBSERVED',projectId:'freepasserp5',databaseId:'(default)',readTime:'2026-09-26T10:00:00.000Z',digest:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',coverage:'FULL_SAME_READ_ONLY_TRANSACTION',products:321,policies:17},
              auditFreshness:{version:'erp5-audit-schedule-health/1',configured:true,status:'DEGRADED',reason:'AUDIT_GAP_EXCEEDED',currentReadTime:'2026-09-26T10:00:00.000Z',previousReadTime:'2026-09-26T07:00:00.000Z',gapMinutes:180,maxGapMinutes:120},
              publication:{decision:'HOLD',activeReleaseAuthorized:false,canonicalWriteAuthorized:false,destructiveActionAuthorized:false,holdReasons:['REVIEW_APPROVALS_NOT_INCLUDED','CANONICAL_RELEASE_NOT_BUILT']},
              consumerHealth:{configured:true,status:'BLOCKED',reason:'CONSUMER_BLOCKED',generatedAt:'2026-09-26T10:00:01.000Z',counts:{HEALTHY:0,DEGRADED:1,BLOCKED:7}},
              consumerReadiness:{configured:true,status:'BLOCKED',reason:'READINESS_HOLD',generatedAt:'2026-09-26T10:00:02.000Z',counts:{readyForNextStage:1,hold:7,final:0},readyTransitions:[{consumerId:'erp-com-public-catalog',from:'OBSERVE',to:'SHADOW_READ'}]},
              sheetHealth:{configured:true,status:'BLOCKED',reason:'SHEET_EVIDENCE_STALE',generatedAt:'2026-09-26T10:00:03.000Z'}
            },
            operatorSummary:{readyTransitionCount:1,consumerBlockedCount:7,readinessHoldCount:7,auditGapMinutes:180,publicationHoldReasonCount:2},
            attention:['AUDIT_SCHEDULE_DEGRADED','PUBLICATION_HOLD','CONSUMER_HEALTH_BLOCKED','CONSUMER_READINESS_HOLD','SHEET_HEALTH_BLOCKED']
          };
          window.__tower=mountControlTower(document.getElementById('control-tower'),{read:async()=>structuredClone(report)});
          await window.__tower.ready;
        }""")
        expect(page.get_by_role("heading",name="Data Control Tower")).to_be_visible()
        expect(page.locator(".ct-axis")).to_have_count(6)
        expect(page.get_by_text("PUBLICATION_HOLD",exact=True)).to_be_visible()
        expect(page.get_by_text("REVIEW_APPROVALS_NOT_INCLUDED")).to_be_visible()
        expect(page.get_by_text("erp-com-public-catalog · OBSERVE → SHADOW_READ")).to_be_visible()
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        page.screenshot(path=args.output/"control-tower-desktop.png",full_page=True)

        mobile=browser.new_page(viewport={"width":390,"height":844});mobile.goto(route,wait_until="networkidle")
        mobile.evaluate("""async()=>{
          const { mountControlTower }=await import('/console/control-tower/view.mjs');
          window.__tower=mountControlTower(document.getElementById('control-tower'),{read:async()=>({
            contractVersion:'freepass-data-control-tower-v1',schemaVersion:'1.0.0',
            generatedAt:'2026-09-26T10:00:00.000Z',runId:'run-mobile-1',
            axes:{
              sourceObservation:{status:'OBSERVED',projectId:'freepasserp5',databaseId:'(default)',readTime:'2026-09-26T10:00:00.000Z',digest:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',coverage:'FULL',products:9,policies:2},
              auditFreshness:{version:'erp5-audit-schedule-health/1',configured:false,status:'BLOCKED',reason:'ERP5_AUDIT_MAX_GAP_MINUTES_NOT_CONFIGURED',currentReadTime:'2026-09-26T10:00:00.000Z',previousReadTime:null,gapMinutes:null,maxGapMinutes:null},
              publication:{decision:'HOLD',activeReleaseAuthorized:false,canonicalWriteAuthorized:false,destructiveActionAuthorized:false,holdReasons:['POLICY_NOT_CONFIGURED']},
              consumerHealth:{configured:false,status:'BLOCKED',reason:'CONSUMER_HEALTH_MAX_AGE_MINUTES_NOT_CONFIGURED'},
              consumerReadiness:{configured:false,status:'BLOCKED',reason:'CONSUMER_READINESS_MAX_AGE_MINUTES_NOT_CONFIGURED'},
              sheetHealth:{configured:false,status:'BLOCKED',reason:'SHEET_EVIDENCE_MAX_AGE_MINUTES_NOT_CONFIGURED'}
            },
            operatorSummary:{readyTransitionCount:0,consumerBlockedCount:null,readinessHoldCount:null,auditGapMinutes:null,publicationHoldReasonCount:1},
            attention:['AUDIT_SCHEDULE_BLOCKED','PUBLICATION_HOLD','HEALTH_POLICY_NOT_CONFIGURED','READINESS_POLICY_NOT_CONFIGURED','SHEET_POLICY_NOT_CONFIGURED']
          })});
          await window.__tower.ready;
        }""")
        expect(mobile.locator(".ct-axis")).to_have_count(6)
        expect(mobile.get_by_text("HEALTH_POLICY_NOT_CONFIGURED")).to_be_visible()
        expect(mobile.get_by_text("POLICY_NOT_CONFIGURED",exact=True)).to_be_visible()
        assert mobile.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        mobile.screenshot(path=args.output/"control-tower-mobile.png",full_page=True)
        browser.close()
finally:
    server.terminate()
    try:server.wait(timeout=3)
    except subprocess.TimeoutExpired:server.kill();server.wait(timeout=3)
