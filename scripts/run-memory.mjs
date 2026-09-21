const entrypoints = {
  api: '../src/api/server.ts',
  worker: '../src/worker.ts'
};
const entrypoint = entrypoints[process.argv[2]];
if (!entrypoint || !Object.hasOwn(entrypoints, process.argv[2])) {
  throw new Error('Usage: node --import tsx scripts/run-memory.mjs <api|worker>');
}

// Local commands always use disposable demo data, regardless of inherited settings.
process.env.FREEPASS_DATA_DRIVER = 'memory';
process.env.HOST = '127.0.0.1';
await import(entrypoint);
