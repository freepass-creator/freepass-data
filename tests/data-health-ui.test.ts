import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd();
const viewPath=path.join(root,'preview/data-health/view.mjs');
const cssPath=path.join(root,'preview/data-health/health.css');
const htmlPath=path.join(root,'preview/data-health/index.html');
const serverPath=path.join(root,'src/api/server.ts');
const consolePath=path.join(root,'preview/index.html');

describe('U-01 Data Health presentation boundary',()=>{
  it('is presentation-only and validates consumer-health-v1',async()=>{
    const source=await readFile(viewPath,'utf8');
    expect(source).toMatch(/consumer-health-v1/);
    expect(source).toMatch(/HEALTHY/);
    expect(source).toMatch(/DEGRADED/);
    expect(source).toMatch(/BLOCKED/);
    expect(source).not.toMatch(/readConsumerHealth|statusOf\(|CONSUMER_SWITCH_REGISTRY/);
    expect(()=>execFileSync(process.execPath,['--check',viewPath])).not.toThrow();
  });

  it('fails closed when no real health reader is connected',async()=>{
    const html=await readFile(htmlPath,'utf8');
    const source=await readFile(viewPath,'utf8');
    expect(html).toMatch(/mountDataHealth\(document\.getElementById\('data-health'\)\)/);
    expect(source).toMatch(/Consumer Health 연결 대기/);
    expect(source).toMatch(/상태를 추정하지 않습니다/);
  });

  it('renders evidence and blockers without recomputing health',async()=>{
    const source=await readFile(viewPath,'utf8');
    expect(source).toMatch(/item\.evidence\.source/);
    expect(source).toMatch(/item\.evidence\.state/);
    expect(source).toMatch(/item\.blockers/);
    expect(source).toMatch(/item\.staticHoldReasons/);
    expect(source).toMatch(/item\.nextTransition\.allowed/);
    expect(source).not.toMatch(/ageMs\s*>|parityVerified\s*&&|productionReadbackVerified\s*\?/);
  });

  it('wires a real local Console UI route without adding a health data API',async()=>{
    const server=await readFile(serverPath,'utf8');
    const consoleHtml=await readFile(consolePath,'utf8');
    expect(server).toMatch(/app\.get\('\/console\/data-health'/);
    expect(server).toMatch(/\/console\/data-health\/health\.css/);
    expect(server).toMatch(/\/console\/data-health\/view\.mjs/);
    expect(server).not.toMatch(/\/v1\/.*data-health/);
    expect(consoleHtml).toMatch(/href="\/console\/data-health"/);
  });

  it('keeps mobile and desktop detail readable',async()=>{
    const css=await readFile(cssPath,'utf8');
    expect(css).toMatch(/@media\(min-width:901px\)/);
    expect(css).toMatch(/position:sticky/);
    expect(css).toMatch(/@media\(max-width:900px\)/);
    expect(css).toMatch(/min-height:48px/);
    expect(css).toMatch(/overflow-wrap:anywhere/);
  });
});
