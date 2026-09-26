import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd();
const viewPath=path.join(root,'preview/revision-ledger/view.mjs');
const cssPath=path.join(root,'preview/revision-ledger/revision.css');
const htmlPath=path.join(root,'preview/revision-ledger/index.html');
const serverPath=path.join(root,'src/api/server.ts');
const consolePath=path.join(root,'preview/index.html');

describe('U-01 EntityRevisionRecord ledger',()=>{
  it('renders existing revision records without generating history',async()=>{
    const source=await readFile(viewPath,'utf8');
    expect(source).toMatch(/revisionRecordId/);expect(source).toMatch(/previousRevision/);expect(source).toMatch(/sourceBindingId/);expect(source).toMatch(/sourceRunId/);
    expect(source).not.toMatch(/appendRevision|listRevisionHistory|revision\s*\+\s*1/);
    expect(()=>execFileSync(process.execPath,['--check',viewPath])).not.toThrow();
  });

  it('fails closed when no revision reader is wired',async()=>{
    const html=await readFile(htmlPath,'utf8');const source=await readFile(viewPath,'utf8');
    expect(html).toMatch(/mountRevisionLedger\(document\.getElementById\('revision-ledger'\)\)/);
    expect(source).toMatch(/Revision Ledger 연결 대기/);expect(source).toMatch(/이력을 추정하거나 생성하지 않습니다/);
  });

  it('keeps command actor origin and snapshot evidence visible',async()=>{
    const source=await readFile(viewPath,'utf8');
    expect(source).toMatch(/record\.commandId/);expect(source).toMatch(/record\.actor\.id/);expect(source).toMatch(/record\.origin/);expect(source).toMatch(/record\.snapshot/);
  });

  it('adds only local UI routes and no revision data API',async()=>{
    const server=await readFile(serverPath,'utf8');const consoleHtml=await readFile(consolePath,'utf8');
    expect(server).toMatch(/app\.get\('\/console\/revision-ledger'/);
    expect(server).not.toMatch(/\/v1\/.*revision-ledger/);
    expect(consoleHtml).toMatch(/href="\/console\/revision-ledger"/);
  });

  it('keeps desktop sticky detail and mobile return behavior',async()=>{
    const css=await readFile(cssPath,'utf8');expect(css).toMatch(/position:sticky/);expect(css).toMatch(/min-height:48px/);expect(css).toMatch(/overflow-wrap:anywhere/);
  });
});
