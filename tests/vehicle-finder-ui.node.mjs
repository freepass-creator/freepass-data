import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const viewPath = path.join(root, 'preview/vehicle-finder/view.mjs');
const cssPath = path.join(root, 'preview/vehicle-finder/finder.css');
const htmlPath = path.join(root, 'preview/vehicle-finder/index.html');

test('U-01 finder stays presentation-only', async () => {
  const source = await readFile(viewPath, 'utf8');
  assert.doesNotMatch(source, /core\.mjs|searchEntries|partialSelection|NODE_TYPES|Canonical/);
  assert.match(source, /await read\(\{ query, filters:/);
  const module = await import(pathToFileURL(viewPath).href);
  assert.equal(typeof module.mountVehicleFinder, 'function');
});

test('finder is disconnected by default and does not ship fake vehicle rows', async () => {
  const html = await readFile(htmlPath, 'utf8');
  assert.match(html, /mountVehicleFinder\(document\.getElementById\('vehicle-finder'\)\)/);
  assert.doesNotMatch(html, /fixture|쏘렌토|싼타페|현대|기아/);
});

test('mobile UI keeps FreePass action and accessibility boundaries', async () => {
  const css = await readFile(cssPath, 'utf8');
  assert.match(css, /grid-template-columns:3fr 7fr/);
  assert.match(css, /min-height:48px/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /border-radius:var\(--vf-card-radius\)/);
  assert.match(css, /:focus-visible/);
});
