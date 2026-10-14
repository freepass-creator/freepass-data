import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileRunnerFiles, firestoreRunnerFiles, RUNNER_FILE_MAX_BYTES, type RunnerFiles } from '../src/infra/runner-files.js';

function fakeFirestore() {
  const docs = new Map<string, unknown>(); const methods: string[] = [];
  const fetcher = (async (input: string, init: RequestInit) => {
    const url = new URL(input), method = init.method ?? 'GET'; methods.push(method);
    const id = url.searchParams.get('documentId') ?? decodeURIComponent(url.pathname.split('/').pop()!);
    const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
    if (method === 'GET') return docs.has(id) ? reply(200, docs.get(id)) : reply(404);
    if (method === 'POST') { if (docs.has(id)) return reply(409); docs.set(id, JSON.parse(String(init.body))); return reply(200); }
    if (method === 'PATCH') { docs.set(id, JSON.parse(String(init.body))); return reply(200); }
    return reply(405);
  }) as unknown as typeof fetch;
  return { docs, methods, fetcher };
}

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const contract = async (files: RunnerFiles) => {
  expect(await files.read('sonogong-api-count.json')).toBeNull();
  expect(await files.write('sonogong-api-count.json', '{"count":334}')).toBe(true);
  expect(await files.read('sonogong-api-count.json')).toBe('{"count":334}');
  expect(await files.createOnce('abc.backup.json', 'v1')).toBe(true);
  expect(await files.createOnce('abc.backup.json', 'v2')).toBe(false);          // 백업은 한 번만(불변)
  expect(await files.read('abc.backup.json')).toBe('v1');
  await expect(files.read('../escape')).rejects.toThrow('RUNNER_FILE_NAME_INVALID');
};

describe('runner state files (count baselines, once markers, backups)', () => {
  it('file store keeps the existing private-folder behaviour', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runner-files-')); dirs.push(dir);
    await contract(fileRunnerFiles(dir));
  });
  it('Firestore store has the same contract, never deletes, and refuses oversize values before writing', async () => {
    const fs = fakeFirestore();
    const files = firestoreRunnerFiles({ env: { FIREBASE_PROJECT_ID: 'freepasserp5' } as NodeJS.ProcessEnv, fetcher: fs.fetcher, token: async () => 'synthetic' });
    await contract(files);
    await expect(files.write('big', 'x'.repeat(RUNNER_FILE_MAX_BYTES + 1))).rejects.toThrow('RUNNER_FILE_TOO_LARGE');
    expect(fs.methods).not.toContain('DELETE');
    expect([...fs.docs.keys()].every(k => k.startsWith('file__'))).toBe(true);
  });
});
