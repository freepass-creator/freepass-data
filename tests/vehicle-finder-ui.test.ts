import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const viewPath = path.join(root, 'preview/vehicle-finder/view.mjs');
const cssPath = path.join(root, 'preview/vehicle-finder/finder.css');
const htmlPath = path.join(root, 'preview/vehicle-finder/index.html');

describe('U-01 vehicle finder presentation boundary', () => {
  it('stays presentation-only and has valid module syntax', async () => {
    const source = await readFile(viewPath, 'utf8');
    expect(source).not.toMatch(/core\.mjs|searchEntries|partialSelection|NODE_TYPES|Canonical/);
    expect(source).toMatch(/await read\(\{ mode, query, filters:/);
    expect(() => execFileSync(process.execPath, ['--check', viewPath])).not.toThrow();
  });

  it('is disconnected by default and ships no fake vehicle rows', async () => {
    const html = await readFile(htmlPath, 'utf8');
    expect(html).toMatch(/mountVehicleFinder\(document\.getElementById\('vehicle-finder'\)\)/);
    expect(html).not.toMatch(/쏘렌토|싼타페|현대|기아/);
    expect(html).not.toMatch(/fixture\s*\(|from\s+['"][^'"]*fixture/i);
  });

  it('renders state, observation and provenance without deriving governance meaning', async () => {
    const source = await readFile(viewPath, 'utf8');
    expect(source).toMatch(/item\.state\.code/);
    expect(source).toMatch(/formatObservedAt\(snapshot\.observedAt\)/);
    expect(source).toMatch(/item\.freshness\?\.label \?\? '판정 없음'/);
    expect(source).toMatch(/item\.confidenceLabel \?\? '평가 없음'/);
    expect(source).toMatch(/item\.sources \?\? \[\]/);
    expect(source).not.toMatch(/Date\.now\(\)|STALE_AFTER|confidenceScore/);
  });

  it('renders F-owned new/used presentation metadata without copying selector rules', async () => {
    const source = await readFile(viewPath, 'utf8');
    expect(source).toMatch(/input\.mode/);
    expect(source).toMatch(/input\.presentation/);
    expect(source).toMatch(/snapshot\.guidance\.resolutionStatus/);
    expect(source).toMatch(/snapshot\.guidance\.suggestedNextAxis/);
    expect(source).toMatch(/read\(\{ mode, query, filters:/);
    expect(source).not.toMatch(/VEHICLE_SELECTOR_UX_PRESETS|preferredAxisOrder|hiddenByDefault/);
  });

  it('clears UI selection state when switching new and used modes', async () => {
    const source = await readFile(viewPath, 'utf8');
    expect(source).toMatch(/mode = nextMode/);
    expect(source).toMatch(/query = ''/);
    expect(source).toMatch(/filters = \{\}/);
    expect(source).toMatch(/inspectedId = null/);
  });

  it('keeps the FreePass mobile action and accessibility boundaries', async () => {
    const css = await readFile(cssPath, 'utf8');
    expect(css).toMatch(/grid-template-columns:3fr 7fr/);
    expect(css).toMatch(/min-height:48px/);
    expect(css).toMatch(/safe-area-inset-bottom/);
    expect(css).toMatch(/border-radius:var\(--vf-card-radius\)/);
    expect(css).toMatch(/:focus-visible/);
  });

  it('keeps search filters results and detail together on desktop', async () => {
    const css = await readFile(cssPath, 'utf8');
    const source = await readFile(viewPath, 'utf8');
    expect(css).toMatch(/@media\(min-width:901px\)/);
    expect(css).toMatch(/grid-template-columns:minmax\(0,1\.35fr\) minmax\(360px,\.65fr\)/);
    expect(css).toMatch(/position:sticky/);
    expect(source).toMatch(/setFilterPanel\(!mobileMedia\.matches\)/);
  });
});
