import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { KakaoQueueInput } from '../adapters/kakao-source-intake.js';
import { planKakaoIntake, ingestKakaoBundle, processKakaoQueueInput } from '../application/kakao-source-intake.js';

/** Also callable by the approved operational composition root with injected ports. */
export async function runKakaoSourceCli(args: string[], env: NodeJS.ProcessEnv,
  ports?: Parameters<typeof ingestKakaoBundle>[1]) {
  const files = args.filter(x => !x.startsWith('--'));
  if (files.length !== 1 || args.some(x => x.startsWith('--') && x !== '--apply'))
    throw new Error('USAGE: npm.cmd run ingest:kakao-source -- <bundle.json> [--apply]');
  const input = JSON.parse(await readFile(resolve(files[0]!), 'utf8')) as KakaoQueueInput;
  if (!args.includes('--apply')) return { mode: 'DRY_RUN', writes: 0,
    results: planKakaoIntake(input.bundle, input.products ?? []) };
  if (env.FREEPASS_KAKAO_SOURCE_APPLY !== 'approved') throw new Error('KAKAO_APPLY_NOT_APPROVED');
  // Never take executable code from source JSON. Only an operator-configured local module,
  // after both approval gates, may compose the existing authenticated operational ports.
  planKakaoIntake(input.bundle, input.products ?? []);
  if (!ports && env.FREEPASS_KAKAO_PORTS_MODULE) {
    const moduleUrl = pathToFileURL(resolve(env.FREEPASS_KAKAO_PORTS_MODULE)).href;
    const module = await import(moduleUrl) as { createKakaoPorts?: () => Promise<Parameters<typeof ingestKakaoBundle>[1]> };
    if (typeof module.createKakaoPorts !== 'function') throw new Error('HOLD_KAKAO_PORT_FACTORY_MISSING');
    ports = await module.createKakaoPorts();
  }
  if (!ports) throw new Error('HOLD_KAKAO_LIVE_PORTS_NOT_CONFIGURED');
  return { mode: 'APPLY', receipt: await processKakaoQueueInput(input, ports,
    { apply: true, approval: env.FREEPASS_KAKAO_SOURCE_APPLY, now: new Date().toISOString() }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runKakaoSourceCli(process.argv.slice(2), process.env)
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      if ('receipt' in result && result.receipt && !result.receipt.deleteAllowed) process.exitCode = 2;
    })
    .catch(error => { console.error(error instanceof Error ? error.message : 'KAKAO_INTAKE_FAILED'); process.exitCode = 1; });
}
