// 복사본이 MANIFEST.json 과 같은지 확인한다 — ai-ops 가 생성한 파일, 손으로 고치지 않는다.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8'));
let bad = 0;
for (const [path, expected] of Object.entries(manifest.files)) {
  const text = readFileSync(join(dir, path), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  const got = createHash('sha256').update(text).digest('hex');
  if (got !== expected) { bad += 1; console.error('DRIFT ' + path); }
}
if (bad) process.exit(1);
console.log('manifest ok, source ' + manifest.source_commit);
