import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd();
const viewPath=path.join(root,'preview/review-queue/view.mjs');
const cssPath=path.join(root,'preview/review-queue/review.css');
const htmlPath=path.join(root,'preview/review-queue/index.html');
const serverPath=path.join(root,'src/api/server.ts');
const consolePath=path.join(root,'preview/index.html');

describe('U-01 SourceChangeReview queue presentation',()=>{
  it('renders SourceChangeReview fields without classifying diffs itself',async()=>{
    const source=await readFile(viewPath,'utf8');
    expect(source).toMatch(/REVIEWABLE/);expect(source).toMatch(/BLOCKED/);
    expect(source).toMatch(/review\.reviewableChangeIds/);expect(source).toMatch(/review\.blockedChangeIds/);
    expect(source).toMatch(/diff\.classification/);expect(source).toMatch(/diff\.reasonCode/);
    expect(source).not.toMatch(/reviewSourceChange|buildChanges|resolveFieldAuthority/);
    expect(()=>execFileSync(process.execPath,['--check',viewPath])).not.toThrow();
  });

  it('fails closed when no queue reader exists',async()=>{
    const html=await readFile(htmlPath,'utf8');const source=await readFile(viewPath,'utf8');
    expect(html).toMatch(/mountReviewQueue\(document\.getElementById\('review-queue'\)\)/);
    expect(source).toMatch(/Review Queue 연결 대기/);
    expect(source).toMatch(/검토 건을 만들거나 추정하지 않습니다/);
  });

  it('shows before-after reason and authority evidence read-only',async()=>{
    const source=await readFile(viewPath,'utf8');
    expect(source).toMatch(/stringify\(diff\.before\)/);expect(source).toMatch(/stringify\(diff\.after\)/);
    expect(source).toMatch(/diff\.authorityRuleId/);expect(source).toMatch(/review\.candidateIssues/);
    expect(source).not.toMatch(/approvedChangeIds|APPLY_REVIEWED_SOURCE_CHANGE|fetch\(/);
  });

  it('wires an actual local Console route without adding a review data API',async()=>{
    const server=await readFile(serverPath,'utf8');const consoleHtml=await readFile(consolePath,'utf8');
    expect(server).toMatch(/app\.get\('\/console\/review-queue'/);
    expect(server).toMatch(/\/console\/review-queue\/review\.css/);
    expect(server).toMatch(/\/console\/review-queue\/view\.mjs/);
    expect(server).not.toMatch(/\/v1\/.*review-queue/);
    expect(consoleHtml).toMatch(/href="\/console\/review-queue"/);
  });

  it('supports sticky desktop detail and mobile bottom return',async()=>{
    const css=await readFile(cssPath,'utf8');
    expect(css).toMatch(/position:sticky/);expect(css).toMatch(/min-height:48px/);expect(css).toMatch(/overflow-wrap:anywhere/);
  });
});
