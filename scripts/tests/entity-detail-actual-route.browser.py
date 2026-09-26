"""Actual-data browser QA for U-01 Entity Detail using the real local trace API."""
from __future__ import annotations
import argparse,json,os,socket,subprocess,time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser();parser.add_argument("--output",type=Path,default=Path("/tmp/freepass-entity-detail"))
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
    base=f"http://127.0.0.1:{port}";wait_http(base+"/health")
    with urlopen(base+"/v1/views/erp-public/products") as response:
        catalog=json.load(response)
    assert catalog["data"], "demo catalog must expose at least one product"
    product_id=catalog["data"][0]["productId"]
    with urlopen(base+"/v1/console/products/"+product_id+"/trace") as response:
        trace=json.load(response)
    assert trace["productId"]==product_id
    assert trace["rows"], "trace rows must exist"

    route=base+"/console/entity-detail?productId="+product_id
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True)
        page=browser.new_page(viewport={"width":1440,"height":1000});page.goto(route,wait_until="networkidle")
        expect(page.get_by_role("heading",name="Entity Detail")).to_be_visible()
        expect(page.locator(".ed-stage")).to_have_count(7)
        expect(page.get_by_text("CANONICAL",exact=True).first).to_be_visible()
        expect(page.get_by_text("CONSUMER",exact=True).first).to_be_visible()
        expect(page.locator(".ed-flow")).to_have_count(len(trace["fieldFlows"]))
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")

        if trace["fieldFlows"]:
            page.locator(".ed-flow").first.click()
            expect(page.locator(".ed-detail h2")).to_be_visible()
            expect(page.get_by_text("RAW",exact=True)).to_be_visible()
            expect(page.get_by_text("NORMALIZED",exact=True)).to_be_visible()
            expect(page.get_by_text("CANONICAL",exact=True).last).to_be_visible()
            expect(page.get_by_text("PROJECTION",exact=True)).to_be_visible()
            expect(page.get_by_text("CONSUMER",exact=True).last).to_be_visible()
        page.screenshot(path=args.output/"entity-detail-desktop.png",full_page=True)

        mobile=browser.new_page(viewport={"width":390,"height":844});mobile.goto(route,wait_until="networkidle")
        expect(mobile.get_by_role("heading",name="Entity Detail")).to_be_visible()
        expect(mobile.locator(".ed-stage")).to_have_count(7)
        if trace["fieldFlows"]:
            mobile.locator(".ed-flow").first.click()
            expect(mobile.get_by_role("button",name="목록으로")).to_be_visible()
            expect(mobile.locator(".ed-detail h2")).to_be_focused()
            mobile.screenshot(path=args.output/"entity-detail-mobile.png",full_page=True)
            assert mobile.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
            mobile.keyboard.press("Escape")
            expect(mobile.locator(".ed-detail")).to_be_hidden()
        browser.close()
finally:
    server.terminate()
    try:server.wait(timeout=3)
    except subprocess.TimeoutExpired:server.kill();server.wait(timeout=3)
