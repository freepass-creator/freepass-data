import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd();
const viewPath=path.join(root,'preview/control-tower/view.mjs');
const cssPath=path.join(root,'preview/control-tower/tower.css');
const htmlPath=path.join(root,'preview/control-tower/index.html');
const serverPath=path.join(root,'src/api/server.ts');
const consolePath=path.join(root,'preview/index.html');

describe('U-01 Data Control Tower presentation',()=>{
  it('consumes the exact control-tower contract and does not build an aggregate verdict',async()=>{
    const source=await readFile(viewPath,'utf8');
    expect(source).toMatch(/freepass-data-control-tower-v1/);
    expect(source).toMatch(/sourceObservation/);
    expect(source).toMatch(/auditFreshness/);
    expect(source).toMatch(/consumerReadiness/);
    expect(source).toMatch(/report\.attention/);
    expect(source).not.toMatch(/buildDataControlTower|attentionCodes|validateDataControlTowerInput/);
    expect(()=>execFileSync(process.execPath,['--check',viewPath])).not.toThrow();
  });

  it('fails closed without a report reader',async()=>{
    const html=await readFile(htmlPath,'utf8');const source=await readFile(viewPath,'utf8');
    expect(html).toMatch(/mountControlTower\(document\.getElementById\('control-tower'\)\)/);
    expect(source).toMatch(/Control Tower 연결 대기/);
    expect(source).toMatch(/운영 상태를 추정하지 않습니다/);
  });

  it('preserves publication HOLD and ready transition evidence',async()=>{
    const source=await readFile(viewPath,'utf8');
    expect(source).toMatch(/publication\.holdReasons/);
    expect(source).toMatch(/readiness\.readyTransitions/);
    expect(source).toMatch(/operatorSummary/);
    expect(source).not.toMatch(/activeReleaseAuthorized\s*&&|gapMinutes\s*>|consumerBlockedCount\s*\?/);
  });

  it('wires only a local UI route and no new control-tower data API',async()=>{
    const server=await readFile(serverPath,'utf8');const consoleHtml=await readFile(consolePath,'utf8');
    expect(server).toMatch(/app\.get\('\/console\/control-tower'/);
    expect(server).toMatch(/\/console\/control-tower\/tower\.css/);
    expect(server).toMatch(/\/console\/control-tower\/view\.mjs/);
    expect(server).not.toMatch(/\/v1\/.*control-tower/);
    expect(consoleHtml).toMatch(/href="\/console\/control-tower"/);
  });

  it('keeps cards readable on mobile',async()=>{
    const css=await readFile(cssPath,'utf8');
    expect(css).toMatch(/ct-axes/);expect(css).toMatch(/ct-grid2/);expect(css).toMatch(/min-height:48px/);expect(css).toMatch(/overflow-wrap:anywhere/);
  });
});
