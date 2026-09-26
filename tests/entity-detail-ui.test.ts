import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd();
const viewPath=path.join(root,'preview/entity-detail/view.mjs');
const htmlPath=path.join(root,'preview/entity-detail/index.html');
const cssPath=path.join(root,'preview/entity-detail/entity.css');
const serverPath=path.join(root,'src/api/server.ts');
const consolePath=path.join(root,'preview/index.html');

describe('U-01 CatalogProductTrace Entity Detail',()=>{
  it('renders the existing CatalogProductTrace contract without rebuilding lineage',async()=>{
    const source=await readFile(viewPath,'utf8');
    for(const stage of ['SOURCE','RAW','NORMALIZED','CANONICAL','PROJECTION','RELEASE','CONSUMER'])expect(source).toMatch(new RegExp(stage));
    expect(source).toMatch(/flow\.adapter\.decision/);
    expect(source).toMatch(/flow\.canonical\.revision/);
    expect(source).toMatch(/flow\.consumer\.location/);
    expect(source).not.toMatch(/buildCatalogProductTrace|listLineageByStage|fieldPriority/);
    expect(()=>execFileSync(process.execPath,['--check',viewPath])).not.toThrow();
  });

  it('uses the existing authorized local trace API rather than adding a second endpoint',async()=>{
    const html=await readFile(htmlPath,'utf8');const server=await readFile(serverPath,'utf8');
    expect(html).toMatch(/\/v1\/console\/products\/.*\/trace/);
    expect(server).toMatch(/app\.get\('\/v1\/console\/products\/:productId\/trace'/);
    expect(server).not.toMatch(/\/v1\/console\/entity-detail/);
  });

  it('wires a local UI route and links from Console',async()=>{
    const server=await readFile(serverPath,'utf8');const consoleHtml=await readFile(consolePath,'utf8');
    expect(server).toMatch(/app\.get\('\/console\/entity-detail'/);
    expect(server).toMatch(/\/console\/entity-detail\/entity\.css/);
    expect(server).toMatch(/\/console\/entity-detail\/view\.mjs/);
    expect(consoleHtml).toMatch(/href="\/console\/entity-detail"/);
    expect(consoleHtml).toMatch(/전체 lineage 보기/);
  });

  it('keeps lineage readable across desktop and mobile',async()=>{
    const css=await readFile(cssPath,'utf8');
    expect(css).toMatch(/grid-template-columns:repeat\(5/);
    expect(css).toMatch(/position:sticky/);
    expect(css).toMatch(/min-height:48px/);
    expect(css).toMatch(/overflow-wrap:anywhere/);
  });
});
