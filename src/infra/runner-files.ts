/**
 * 원천 엔진 실행기 상태 파일(기준 건수·한 회차 표식·적용 전 백업·영수증)의 저장 위치.
 * - fileRunnerFiles: 지금까지와 같은 개인 폴더 파일(B3Q 기본, 동작 불변).
 * - firestoreRunnerFiles: 온라인 실행기(러너 휘발)용. 회차 제어와 같은 컬렉션(FIRESTORE_COLLECTIONS.sourceCycle.control)에 이름별 문서 하나.
 *   createOnce 는 «없을 때만 생성»(백업 불변). 삭제 없음. 문서 한도(1MiB) 때문에 900,000 바이트 넘는 값은 거부한다(쓰기 전에 막힘).
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stableDigest } from '../shared/stable-digest.js';
import { resolveTargetProject } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS } from './firestore-layout.js';
import { gcloudUserToken } from './source-cycle-firestore.js';

export interface RunnerFiles {
  /** 없으면 null. 읽기 실패는 던진다. */
  read(name: string): Promise<string | null>;
  /** 덮어쓰기(원자적). 실패하면 false(호출자가 보수적으로 처리). */
  write(name: string, text: string): Promise<boolean>;
  /** 없을 때만 만든다. 이미 있으면 false. */
  createOnce(name: string, text: string): Promise<boolean>;
}

const safeName = (name: string) => {
  if (!name || name.startsWith('/') || name.split(/[\\/]/).some(part => part === '..' || part === '')) throw new Error('RUNNER_FILE_NAME_INVALID');
  return name;
};

export function fileRunnerFiles(directory: string): RunnerFiles {
  const path = (name: string) => join(directory, safeName(name));
  return {
    async read(name) {
      try { return await readFile(path(name), 'utf8'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    },
    async write(name, text) {
      const target = path(name), tmp = `${target}.${process.pid}.tmp`;
      try { await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(tmp, text, { mode: 0o600 }); await rename(tmp, target); return true; }
      catch { await unlink(tmp).catch(() => undefined); return false; }
    },
    async createOnce(name, text) {
      const target = path(name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      try { await writeFile(target, text, { flag: 'wx', mode: 0o600 }); return true; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
    },
  };
}

export const RUNNER_FILE_MAX_BYTES = 900_000;

export function firestoreRunnerFiles(options: { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch; token?: () => Promise<string> }): RunnerFiles {
  const project = resolveTargetProject(options.env);
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${FIRESTORE_COLLECTIONS.sourceCycle.control}`;
  const fetcher = options.fetcher ?? fetch;
  const docId = (name: string) => `file__${stableDigest(safeName(name)).slice(0, 40)}`;
  const call = async (path: string, method: string, body?: unknown) => {
    const response = await fetcher(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${await (options.token ?? gcloudUserToken)()}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const fields = (name: string, text: string) => {
    if (Buffer.byteLength(text) > RUNNER_FILE_MAX_BYTES) throw new Error('RUNNER_FILE_TOO_LARGE');
    return { fields: { kind: { stringValue: 'FILE' }, name: { stringValue: name }, text: { stringValue: text },
      savedAt: { stringValue: new Date().toISOString() } } };
  };
  return {
    async read(name) {
      const r = await call(`/${docId(name)}`, 'GET');
      if (r.status === 404) return null;
      if (r.status !== 200) throw new Error(`RUNNER_FILE_FIRESTORE_${r.status}`);
      const text = r.body?.fields?.text?.stringValue;
      if (typeof text !== 'string') throw new Error('RUNNER_FILE_INVALID');
      return text;
    },
    async write(name, text) {
      try { return (await call(`/${docId(name)}`, 'PATCH', fields(name, text))).status === 200; }
      catch (e) { if (e instanceof Error && e.message === 'RUNNER_FILE_TOO_LARGE') throw e; return false; }
    },
    async createOnce(name, text) {
      const r = await call(`?documentId=${encodeURIComponent(docId(name))}`, 'POST', fields(name, text));
      if (r.status === 409) return false;
      if (r.status !== 200) throw new Error(`RUNNER_FILE_FIRESTORE_${r.status}`);
      return true;
    },
  };
}
