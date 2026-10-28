// 쓰는 쪽 하나(writer lease) 운영 도구. 상태·확인은 읽기, 인수·이전은 외부 승인 환경변수가 있어야 한다.
//   상태: FIREBASE_PROJECT_ID=freepasserp5 tsx src/jobs/writer-lease.ts status --lane=source-cycle
//   확인(실행기용, 필요하면 갱신): WRITER_LEASE_PC=PC3 tsx src/jobs/writer-lease.ts check --lane=photo   → 내 임대면 종료 코드 0, 아니면 3(쓰기 금지)
//   인수(없거나 만료일 때만): WRITER_LEASE_WRITE_APPROVED=true tsx src/jobs/writer-lease.ts claim --lane=source-cycle --pc=PC3 [--ttl-min=180] [--note=…]
//   한 명령 전환(PC1↔PC3 어느 쪽이든): WRITER_LEASE_WRITE_APPROVED=true tsx src/jobs/writer-lease.ts handover --lane=source-cycle --to=PC1
//   이전(현재 보유자·에포크 지정): WRITER_LEASE_WRITE_APPROVED=true tsx src/jobs/writer-lease.ts transfer --lane=source-cycle --from=PC1 --to=PC3 --epoch=<현재> [--ttl-min=180]
import { writerLeaseStore } from '../infra/writer-lease-firestore.js';
import { stableDigest } from '../shared/stable-digest.js';
import { createJobDataAccessRuntime } from './data-access-runtime.js';
import { assertLane, assertPc, assertTtl, LEASE_DEFAULT_TTL_MIN } from '../domain/writer-lease.js';

const [command, ...rest] = process.argv.slice(2);
const arg = (name: string) => rest.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
for (const a of rest) if (!/^--(lane|pc|from|to|epoch|ttl-min|note)=/.test(a)) throw new Error(`UNKNOWN_OPTION ${a.split('=')[0]}`);
const lane = assertLane(arg('lane'));
const ttlMin = arg('ttl-min') ? assertTtl(Number(arg('ttl-min'))) : LEASE_DEFAULT_TTL_MIN;
const note = arg('note');
if (note !== undefined && note.length > 200) throw new Error('NOTE_TOO_LONG');
const needApproval = () => { if (process.env.WRITER_LEASE_WRITE_APPROVED !== 'true') throw new Error('WRITER_LEASE_WRITE_APPROVAL_REQUIRED'); };
const store = writerLeaseStore();
const runtime = createJobDataAccessRuntime();
const context = { actor: { id: 'service:freepass-data-writer-lease', kind: 'SERVICE' as const }, clientId: 'job:writer-lease', purpose: 'check or hand over the single-writer lease of a runner lane' };
const resource = { kind: 'SOURCE' as const, name: 'freepasserp5/writer-lease' };
const readOp = <T>(operation: string, run: () => Promise<T>) => runtime.access.read({ context, operation, resource, summarize: () => ({ count: 1 }) }, run);
const writeOp = <T>(operation: string, digest: unknown, run: () => Promise<T>) => runtime.access.write({ context, operation, resource, requestDigest: stableDigest(digest), summarize: () => ({ count: 1 }) }, run);

if (command === 'status') {
  const { lease } = await readOp('READ_WRITER_LEASE', () => store.read(lane));
  console.log(JSON.stringify(lease ? { ...lease, expired: Date.parse(lease.expiresAt) <= Date.now() } : { lane, lease: null }));
} else if (command === 'check') {
  const pc = assertPc(arg('pc') ?? process.env.WRITER_LEASE_PC?.trim());
  const result = await writeOp('CHECK_WRITER_LEASE', { lane, pc }, () => store.check(lane, pc));
  console.log(JSON.stringify({ lane, pc, ...result }));
  if (!result.held) process.exitCode = 3;
} else if (command === 'claim') {
  needApproval();
  console.log(JSON.stringify({ lane, ...(await writeOp('CLAIM_WRITER_LEASE', { lane, pc: arg('pc') }, () => store.claim(lane, assertPc(arg('pc')), ttlMin, note))) }));
} else if (command === 'handover') {
  needApproval();
  console.log(JSON.stringify({ lane, ...(await writeOp('HANDOVER_WRITER_LEASE', { lane, to: arg('to') }, () => store.handover(lane, assertPc(arg('to')), ttlMin, note))) }));
} else if (command === 'transfer') {
  needApproval();
  const epoch = Number(arg('epoch'));
  if (!Number.isInteger(epoch) || epoch < 1) throw new Error('EPOCH_REQUIRED');
  console.log(JSON.stringify({ lane, ...(await writeOp('TRANSFER_WRITER_LEASE', { lane, from: arg('from'), to: arg('to'), epoch }, () => store.transfer(lane, assertPc(arg('from')), assertPc(arg('to')), epoch, ttlMin, note))) }));
} else throw new Error('COMMAND_REQUIRED: status|check|claim|handover|transfer');
