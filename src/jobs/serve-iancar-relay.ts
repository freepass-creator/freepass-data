import { pathToFileURL } from 'node:url';
import { buildIancarRelayServer } from '../api/iancar-scheduler-relay.js';
import { createIancarRelayPorts, relayConfig } from '../api/iancar-relay-transport.js';

export async function startIancarRelay(env: NodeJS.ProcessEnv = process.env) {
  const config = relayConfig(env);
  const port = env.PORT ?? '8080';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('RELAY_PORT_INVALID');
  const server = buildIancarRelayServer(createIancarRelayPorts(config), config.jobName);
  await server.listen({ host: '0.0.0.0', port: Number(port) });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startIancarRelay().catch(() => { console.error('RELAY_START_FAILED'); process.exitCode = 1; });
}
