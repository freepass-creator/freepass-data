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
    expect(source).toMatch(/await read\(\{ query, filters:/);
    expect(() => execFileSync(process.execPath, ['--check', viewPath])).not.toThrow();
  });

  it('is disconnected by default and ships no fake vehicle rows', async () => {
    const html = await readFile(htmlPath, 'utf8');
    expect(html).toMatch(/mountVehicleFinder\(document\.getElementById\('vehicle-finder'\)\)/);
    expect(html).not.toMatch(/쏘렌토|싼타페|현대|기아/);\n    expect(html).not.toMatch(/fixture\\s*\\(|from\\s+['\"][^'\"]*fixture/i);
  });

  it('keeps the FreePass mobile action and accessibility boundaries', async () => {
    const css = await readFile(cssPath, 'utf8');
    expect(css).toMatch(/grid-template-columns:3fr 7fr/);
    expect(css).toMatch(/min-height:48px/);
    expect(css).toMatch(/safe-area-inset-bottom/);
    expect(css).toMatch(/border-radius:var\(--vf-card-radius\)/);
    expect(css).toMatch(/:focus-visible/);
  });
});
