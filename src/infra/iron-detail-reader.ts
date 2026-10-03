import { createHash } from 'node:crypto';

/** Deliberately conservative robots subset: only an explicit wildcard allow-all
 * (empty Disallow) is accepted. Specific groups, restrictions and unknown directives
 * require review, never a guessed permission. Supplier approval is an additional gate.
 */
export function ironRobotsAllow(text: string): boolean {
  let wildcard = false, explicit = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0]!.trim();
    if (!line) continue;
    const match = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) return false;
    const key = match[1]!.toLowerCase(), value = match[2]!.trim();
    if (key === 'sitemap') continue;
    if (key === 'user-agent') { if (value !== '*') return false; wildcard = true; }
    else if (key === 'disallow' && wildcard && value === '') explicit = true;
    else if (key === 'allow' && wildcard && value === '/') continue;
    else return false;
  }
  return wildcard && explicit;
}

export function ironDetailReader(ports: {
  env?: NodeJS.ProcessEnv; fetcher?: typeof fetch; now?: () => string;
} = {}) {
  const attempted = new Set<string>();
  let active = 0;
  const waiting: Array<() => void> = [];
  let robots: Promise<boolean> | undefined;
  const fetcher = ports.fetcher ?? fetch;
  const get = (url: string) => fetcher(url, { method: 'GET', redirect: 'error',
    headers: { 'user-agent': 'FreePassData-ApprovedCapture/1.0' }, signal: AbortSignal.timeout(30_000) });
  return async (target: Readonly<{ id: string; url: string; plate: string }>) => {
    if ((ports.env ?? process.env).IRON_FETCH_APPROVED !== 'true') throw new Error('IRON_FETCH_APPROVAL_HOLD');
    const url = new URL(target.url);
    if (!target.id || !target.plate.trim() || url.origin !== 'https://ironrentcar.com'
      || url.username || url.password || url.search || url.hash || url.pathname !== `/vehicles/${encodeURIComponent(target.id)}`)
      throw new Error('IRON_TARGET_HOLD');
    const plate = target.plate.replace(/\s+/g, '').toUpperCase();
    if (attempted.has(target.id) || attempted.has(`plate:${plate}`)) throw new Error('IRON_ALREADY_ATTEMPTED_HOLD');
    attempted.add(target.id); attempted.add(`plate:${plate}`);
    robots ??= (async () => {
      try { const response = await get('https://ironrentcar.com/robots.txt');
        return response.ok && ironRobotsAllow(await response.text());
      } catch { return false; }
    })();
    if (!await robots) throw new Error('IRON_ROBOTS_HOLD');
    if (active >= 2) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    try {
      const response = await get(url.href);
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error();
      const html = await response.text();
      if (!html.trim()) throw new Error();
      return { html, observedAt: (ports.now ?? (() => new Date().toISOString()))(),
        revision: createHash('sha256').update(html).digest('hex') };
    } catch { throw new Error('IRON_DETAIL_READ_HOLD'); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
}
