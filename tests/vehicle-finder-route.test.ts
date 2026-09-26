import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('NO_TEST_PORT');
  const port = address.port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error('HTTP_' + response.status);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error('SERVER_START_TIMEOUT');
}

describe('Vehicle Finder actual local Console route', () => {
  it('serves the Finder page and its UI assets from the real dev server', async () => {
    const port = await freePort();
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'scripts/run-memory.mjs', 'api'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(port),
          NODE_ENV: 'test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });

    try {
      const base = 'http://127.0.0.1:' + port;
      await waitFor(base + '/health');

      const consoleResponse = await fetch(base + '/console');
      expect(consoleResponse.status).toBe(200);
      expect(consoleResponse.headers.get('content-type')).toContain('text/html');
      expect(await consoleResponse.text()).toContain('href="/console/vehicle-finder"');

      const finderResponse = await fetch(base + '/console/vehicle-finder');
      expect(finderResponse.status).toBe(200);
      expect(finderResponse.headers.get('content-type')).toContain('text/html');
      const finderHtml = await finderResponse.text();
      expect(finderHtml).toContain('id="vehicle-finder"');
      expect(finderHtml).toContain('/console/vehicle-finder/finder.css');
      expect(finderHtml).toContain('/console/vehicle-finder/view.mjs');

      const cssResponse = await fetch(base + '/console/vehicle-finder/finder.css');
      expect(cssResponse.status).toBe(200);
      expect(cssResponse.headers.get('content-type')).toContain('text/css');
      expect(await cssResponse.text()).toContain('.vf');

      const moduleResponse = await fetch(base + '/console/vehicle-finder/view.mjs');
      expect(moduleResponse.status).toBe(200);
      expect(moduleResponse.headers.get('content-type')).toContain('text/javascript');
      expect(await moduleResponse.text()).toContain('mountVehicleFinder');
    } finally {
      child.kill('SIGTERM');
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve(undefined);
        }, 1500);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
    }

    expect(output).not.toContain('EADDRINUSE');
  }, 20000);
});
