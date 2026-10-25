import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DAILY_WRITER_ALLOWED_COLLECTIONS, evaluateDailyWriterGuard, writeStepsSkippedConfirmed } from '../src/domain/daily-writer-guard.js';
import { FIRESTORE_COLLECTIONS } from '../src/infra/firestore-layout.js';
const account = 'github-data-inventory-writer@freepasserp5.iam.gserviceaccount.com';
it('recognizes the exact historical no-write Actions shape, but rejects every changed or missing step', () => {
    const names = ['Set up job', 'Run actions/checkout@v4', 'Daily schedule and manual apply gate',
        'Run actions/checkout@v4', 'Run actions/setup-node@v4', 'Run npm ci --ignore-scripts',
        'Require the Data delivery identity, sheet and private evidence bucket',
        'Run google-github-actions/auth@v2', 'Run google-github-actions/setup-gcloud@v2',
        'Capture and plan (no writes) — counts only in the public log',
        'Apply to FreePass Data (writes) — counts only in the public log',
        'Preserve private capture, plan and reports (location not printed)', 'Remove temporary files',
        'Post Run actions/checkout@v4', 'Complete job'];
    const steps = names.map((name, index) => ({ name,
        conclusion: [0, 1, 2, 13, 14].includes(index) ? 'success' : 'skipped' }));
    expect(writeStepsSkippedConfirmed(steps)).toBe(true);
    for (let i = 0; i < steps.length; i++) {
        expect(writeStepsSkippedConfirmed(steps.filter((_, index) => index !== i))).toBe(false);
        expect(writeStepsSkippedConfirmed(steps.map((step, index) => index === i ?
            { ...step, conclusion: step.conclusion === 'success' ? 'skipped' : 'success' } : step))).toBe(false);
    }
    expect(writeStepsSkippedConfirmed([...steps, { name: 'unknown operation', conclusion: 'success' }])).toBe(false);
});
it('requests quarter-hour refresh without a once-per-day skip and preserves writer safety gates', () => {
    const workflow = readFileSync('.github/workflows/shared-sheet-daily.yml', 'utf8');
    expect(workflow).toContain("cron: '*/15 * * * *'");
    expect(workflow).not.toContain('DAILY_ONCE_CHECK_FAILED');
    expect(workflow).not.toContain('already wrote on $day');
    expect(workflow).toContain('group: freepass-data-production-delivery');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('DAILY_WRITER_GUARD_NOT_OK');
    expect(workflow).toContain('assertCurrentSharedSheet(process.env.SHARED_SHEET_ID)');
    expect(workflow).toContain('FREEPASS_DATA_DAILY_SERVICE_ACCOUNT');
    expect(workflow).toContain('readbackMismatches');
});
it('pins manual apply to reviewed evidence and live recapture without introducing another Actions write step', () => {
    const workflow = readFileSync('.github/workflows/shared-sheet-daily.yml', 'utf8');
    for (const field of ['reviewed_run_id', 'reviewed_attempt', 'reviewed_generation', 'reviewed_digest', 'reviewed_source_pin'])
        expect(workflow).toContain(`${field}:`);
    const gate = workflow.slice(workflow.indexOf('- name: Daily schedule and manual apply gate'), workflow.indexOf('      - uses: actions/checkout@v4'));
    for (const field of ['REVIEWED_RUN_ID', 'REVIEWED_ATTEMPT', 'REVIEWED_GENERATION', 'REVIEWED_DIGEST', 'REVIEWED_SOURCE_PIN'])
        expect(gate).toMatch(new RegExp(`\\n          ${field}:`));
    expect(gate).toContain('REVIEWED_PLAN_INPUTS_INVALID');
    expect(workflow).toContain('FREEPASS_DATA_DAILY_MANUAL_APPLY');
    expect(workflow).toContain('assertReviewedSharedSheetRun');
    expect(workflow).toContain('assertReviewedPlanGeneration');
    expect(readFileSync('src/jobs/ingest-shared-sheet-canonical.ts', 'utf8')).toContain('assertLiveSharedSheetMatches(plan!');
    expect(workflow).toContain('--live-capture "$T/live-capture.json"');
    expect(workflow).toContain('--if-generation-match=0');
    expect((workflow.match(/name: Apply to FreePass Data \(writes\)/g) ?? []).length).toBe(1);
    expect((workflow.match(/name: Capture and plan \(no writes\)/g) ?? []).length).toBe(1);
    const apply = workflow.slice(workflow.indexOf('- name: Apply to FreePass Data'));
    expect(apply.indexOf('--out "$T/live-capture.json"')).toBeLessThan(apply.indexOf('--firestore --apply'));
    expect(apply.indexOf('REVIEWED_PLAN_GENERATION_HOLD')).toBeLessThan(apply.indexOf('--firestore --apply'));
});
it('reviewed manual selection preserves the approved capture and leaves the sole live recapture in Apply', () => {
    const workflow = readFileSync('.github/workflows/shared-sheet-daily.yml', 'utf8');
    const capture = workflow.slice(workflow.indexOf('- name: Capture and plan'), workflow.indexOf('- name: Apply to FreePass Data'));
    const apply = workflow.slice(workflow.indexOf('- name: Apply to FreePass Data'), workflow.indexOf('- name: Preserve private capture'));
    const branch = capture.slice(capture.indexOf('          if [ -z "$REVIEWED_RUN_ID" ]; then'));
    const normal = branch.slice(0, branch.indexOf('          else\r\n') >= 0 ? branch.indexOf('          else\r\n') : branch.indexOf('          else\n'));
    const reviewed = branch.slice(normal.length);
    expect(normal).toContain('inspect-erp5-source.ts');
    expect(normal).toContain('merge-shared-sheet-supplement.ts');
    expect(normal).toContain('capture-shared-sheet.ts');
    expect(normal).toContain('--operational-refresh --capture');
    expect(reviewed).toContain('assertReviewedSharedSheetRun');
    expect(reviewed).toContain('assertReviewedPlanGeneration');
    expect(reviewed).toContain("assertSharedSheetPlan(plan,e.REVIEWED_DIGEST,'freepasserp5')");
    expect(reviewed).toContain('JSON.stringify(plan.capture)');
    expect(reviewed).not.toContain('capture-shared-sheet.ts');
    expect(reviewed).not.toContain('inspect-erp5-source.ts');
    expect(reviewed).not.toContain('assertLiveSharedSheetMatches');
    expect(reviewed).not.toContain('plan.capture.readTime =');
    expect((apply.match(/src\/jobs\/capture-shared-sheet\.ts/g) ?? []).length).toBe(1);
    expect((apply.match(/src\/jobs\/inspect-erp5-source\.ts/g) ?? []).length).toBe(1);
    expect(apply).toContain('merge-shared-sheet-supplement.ts');
    expect(apply).toContain('REVIEWED_PLAN_GENERATION_HOLD');
    expect(apply).toContain('--live-capture "$T/live-capture.json"');
});
it.each(['', '123'])('executes the actual capture/selection shell with CLI stubs: reviewed ID %s', reviewedRunId => {
    const workflow = readFileSync('.github/workflows/shared-sheet-daily.yml', 'utf8');
    const capture = workflow.slice(workflow.indexOf('- name: Capture and plan'), workflow.indexOf('      # 쓰기는 별도 단계.'));
    const script = capture.split(/        run: \|\r?\n/)[1].split(/\r?\n/).map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'shared-selection-test-'));
    const fixture = join(dir, 'erp.json');
    writeFileSync(fixture, '{}');
    // Instrument the workflow's actual shell branching; no network, JS artifact selection, or DB is executed by these stubs.
    const stubs = `
    gcloud() { if [ "$1" = auth ]; then printf 'test-token'; else printf '404' >&2; return 1; fi; }
    gh() { printf '{}'; }
    node() {
      case "$*" in
        *inspect-erp5-source.ts*) echo ERP_CAPTURE >&2; printf '{}';;
        *console.log\\(JSON.parse*) printf '%s\\n' "$ERP_TEST_FILE";;
        *merge-shared-sheet-supplement.ts*) echo SUPPLEMENT_MERGE >&2;;
        *capture-shared-sheet.ts*) echo SHEET_CAPTURE >&2;;
        *ingest-shared-sheet-canonical.ts*) echo NEW_PLAN >&2; printf '{}';;
        *--input-type=module*) cat >/dev/null; echo PINNED_SELECTION >&2;;
        *) echo REPORT >&2;;
      esac
    }
  `;
    try {
        const result = spawnSync(process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash', ['-c', stubs + script], { encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: dir.replaceAll('\\', '/'), ERP_TEST_FILE: fixture.replaceAll('\\', '/'),
                REVIEWED_RUN_ID: reviewedRunId, REVIEWED_ATTEMPT: '1', REVIEWED_GENERATION: '456', REVIEWED_DIGEST: 'b'.repeat(64),
                REVIEWED_SOURCE_PIN: 'a'.repeat(40), GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'test/test',
                EVIDENCE_BUCKET: 'test-only', SHARED_SHEET_ID: 'test-only' } });
        expect(result.status, result.stderr).toBe(0);
        const calls = result.stdout + result.stderr;
        if (reviewedRunId) {
            expect(calls).toContain('PINNED_SELECTION');
            for (const call of ['ERP_CAPTURE', 'SHEET_CAPTURE', 'SUPPLEMENT_MERGE', 'NEW_PLAN'])
                expect(calls).not.toContain(call);
        }
        else {
            for (const call of ['ERP_CAPTURE', 'SHEET_CAPTURE', 'SUPPLEMENT_MERGE', 'NEW_PLAN'])
                expect(calls).toContain(call);
            expect(calls).not.toContain('PINNED_SELECTION');
        }
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
it('executes the actual gate shell: schedule-off/dry-run pass, manual-off/missing pin reject, exact manual pin passes', () => {
    const workflow = readFileSync('.github/workflows/shared-sheet-daily.yml', 'utf8');
    const gate = workflow.slice(workflow.indexOf('- name: Daily schedule and manual apply gate'), workflow.indexOf('      - uses: actions/checkout@v4'));
    const script = gate.split(/        run: \|\r?\n/)[1].split(/\r?\n/).map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
    const variables = Object.fromEntries([...gate.matchAll(/^          ([A-Z_]+):/gm)].map(m => [m[1], '']));
    const run = (event, mode, extra = {}) => spawnSync(process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash', ['-c',
        script.replaceAll('${{ github.event_name }}', event).replaceAll('${{ inputs.mode }}', mode)], { encoding: 'utf8', env: { ...process.env, ...variables, GITHUB_OUTPUT: '/dev/null', GITHUB_SHA: 'a'.repeat(40), ...extra } });
    expect(run('schedule', '').status).toBe(0);
    expect(run('workflow_dispatch', 'dry-run').status).toBe(0);
    expect(run('workflow_dispatch', 'apply').stdout).toContain('MANUAL_APPLY_DISABLED');
    expect(run('workflow_dispatch', 'apply', { MANUAL_APPLY: 'on' }).stdout).toContain('REVIEWED_PLAN_INPUTS_INVALID');
    expect(run('workflow_dispatch', 'apply', { MANUAL_APPLY: 'on', REVIEWED_RUN_ID: '123', REVIEWED_ATTEMPT: '1',
        REVIEWED_GENERATION: '456', REVIEWED_DIGEST: 'b'.repeat(64), REVIEWED_SOURCE_PIN: 'a'.repeat(40) }).status).toBe(0);
    expect(run('workflow_dispatch', 'dry-run', { REVIEWED_RUN_ID: '123' }).status).not.toBe(0);
});
const db = 'projects/freepasserp5/databases/(default)/documents';
const doc = (c) => `${db}/${c}/x1`;
const commit = (at, names, who = account) => ({ timestamp: at, protoPayload: {
        methodName: 'google.firestore.v1.Firestore.Commit', authenticationInfo: { principalEmail: who }, resourceName: db,
        request: { writes: names.map((name) => ({ update: { name } })) }
    } });
const run = { head_branch: 'main', event: 'schedule', status: 'completed', conclusion: 'success',
    run_started_at: '2026-10-05T18:40:00Z', updated_at: '2026-10-05T18:55:00Z' };
const sparseGateSkippedJobSteps = [
    { name: 'Set up job', conclusion: 'success' },
    { name: 'Fetch gate scripts (sparse)', conclusion: 'success' },
    { name: 'Daily schedule and manual apply gate', conclusion: 'success' },
    { name: 'Run actions/checkout@v4', conclusion: 'skipped' },
    { name: 'Run actions/setup-node@v4', conclusion: 'skipped' },
    { name: 'Run npm ci --ignore-scripts', conclusion: 'skipped' },
    { name: 'Require the Data delivery identity, sheet and private evidence bucket', conclusion: 'skipped' },
    { name: 'Run google-github-actions/auth@v2', conclusion: 'skipped' },
    { name: 'Run google-github-actions/setup-gcloud@v2', conclusion: 'skipped' },
    { name: 'Capture and plan (no writes) — counts only in the public log', conclusion: 'skipped' },
    { name: 'Apply to FreePass Data (writes) — counts only in the public log', conclusion: 'skipped' },
    { name: 'Preserve private capture, plan and reports (location not printed)', conclusion: 'skipped' },
    { name: 'Remove temporary files', conclusion: 'skipped' },
    { name: 'Post Fetch gate scripts (sparse)', conclusion: 'success' },
    { name: 'Complete job', conclusion: 'success' },
];
const skippedJobSteps = [
    { name: 'Set up job', conclusion: 'success' },
    { name: 'Daily schedule and manual apply gate', conclusion: 'success' },
    { name: 'Run actions/checkout@v4', conclusion: 'skipped' },
    { name: 'Run actions/setup-node@v4', conclusion: 'skipped' },
    { name: 'Run npm ci --ignore-scripts', conclusion: 'skipped' },
    { name: 'Require the Data delivery identity, sheet and private evidence bucket', conclusion: 'skipped' },
    { name: 'Run google-github-actions/auth@v2', conclusion: 'skipped' },
    { name: 'Run google-github-actions/setup-gcloud@v2', conclusion: 'skipped' },
    { name: 'Capture and plan (no writes) — counts only in the public log', conclusion: 'skipped' },
    { name: 'Apply to FreePass Data (writes) — counts only in the public log', conclusion: 'skipped' },
    { name: 'Preserve private capture, plan and reports (location not printed)', conclusion: 'skipped' },
    { name: 'Remove temporary files', conclusion: 'skipped' },
    { name: 'Complete job', conclusion: 'success' },
];
const oldWritingJobSteps = [
    { name: 'Set up job', conclusion: 'success' },
    { name: 'Daily schedule and manual apply gate', conclusion: 'success' },
    { name: 'Run actions/checkout@v4', conclusion: 'success' },
    { name: 'Run actions/setup-node@v4', conclusion: 'success' },
    { name: 'Run npm ci --ignore-scripts', conclusion: 'success' },
    { name: 'Require the Data delivery identity, sheet and private evidence bucket', conclusion: 'success' },
    { name: 'Run google-github-actions/auth@v2', conclusion: 'success' },
    { name: 'Run google-github-actions/setup-gcloud@v2', conclusion: 'success' },
    { name: 'Capture, plan and (apply) — counts only in the public log', conclusion: 'success' },
    { name: 'Preserve private capture, plan and reports (location not printed)', conclusion: 'success' },
    { name: 'Remove temporary files', conclusion: 'success' },
    { name: 'Post Run google-github-actions/auth@v2', conclusion: 'success' },
    { name: 'Post Run actions/setup-node@v4', conclusion: 'success' },
    { name: 'Post Run actions/checkout@v4', conclusion: 'success' },
    { name: 'Complete job', conclusion: 'success' },
];
const now = new Date('2026-10-05T19:30:00Z');
const judge = (entries, runs = [run]) => evaluateDailyWriterGuard({ entries: entries, runs: runs, account, now, lookbackHours: 26 });
describe('daily writer guard', () => {
    it('keeps shared-sheet-daily step names unique inside the guarded job', () => {
        const source = readFileSync('.github/workflows/shared-sheet-daily.yml', 'utf8');
        const job = source.slice(source.indexOf('  shared-sheet-daily:'), source.indexOf('  # 기간별 수수료 일괄', source.indexOf('  shared-sheet-daily:')));
        const stepBlocks = job.split(/\n      - /).slice(1);
        const names = stepBlocks.map((block) => {
            const explicit = block.match(/^name: (.+)$/m)?.[1];
            const uses = block.match(/^uses: (.+)$/m)?.[1];
            const run = block.match(/^run: (.+)$/m)?.[1];
            return explicit ?? (uses ? `Run ${uses}` : run ? `Run ${run}` : 'Run');
        });
        expect(names.filter((name) => name === 'Fetch gate scripts (sparse)')).toHaveLength(1);
        expect(new Set(names).size).toBe(names.length);
    });
    it('allowed collections are real Canonical/source/evidence collections, never legacy products', () => {
        const real = new Set(Object.values(FIRESTORE_COLLECTIONS).flatMap((g) => Object.values(g)));
        for (const c of DAILY_WRITER_ALLOWED_COLLECTIONS)
            expect(real.has(c)).toBe(true);
        expect(DAILY_WRITER_ALLOWED_COLLECTIONS).not.toContain('products');
    });
    it('is OK for allowed writes inside a main daily run; ignores other principals and non-write methods', () => {
        const read = { timestamp: '2026-10-05T19:00:00Z', protoPayload: { methodName: 'google.firestore.v1.Firestore.RunQuery',
                authenticationInfo: { principalEmail: account }, resourceName: doc('products') } };
        const r = judge([commit('2026-10-05T18:45:00Z', [doc('catalog_products'), doc('raw_records')]),
            commit('2026-10-05T19:20:00Z', [doc('products')], 'someone-else@example.com'), read]);
        expect(r).toMatchObject({ status: 'OK', writes: 1, writesWithDocumentPaths: 1, outsideRuns: 0, silentApplies: 0 });
    });
    it('alerts on products named by writes, resourceName, or CreateDocument parent + collectionId', () => {
        expect(judge([commit('2026-10-05T18:45:00Z', [doc('products')])]).outsideCollections).toEqual({ products: 1 });
        const byResource = { timestamp: '2026-10-05T18:45:00Z', protoPayload: { methodName: 'google.firestore.v1.Firestore.UpdateDocument',
                authenticationInfo: { principalEmail: account }, resourceName: doc('products') } };
        expect(judge([byResource]).reasons).toEqual(['DAILY_WRITER_OUTSIDE_ALLOWED_COLLECTIONS']);
        const create = { timestamp: '2026-10-05T18:45:00Z', protoPayload: { methodName: 'google.firestore.v1.Firestore.CreateDocument',
                authenticationInfo: { principalEmail: account }, request: { parent: db, collectionId: 'products' } } };
        expect(judge([create]).outsideCollections).toEqual({ products: 1 });
        const other = commit('2026-10-05T18:45:00Z', ['projects/freepasserp5/databases/other/documents/catalog_products/x']);
        expect(judge([other]).outsideCollections['(other-database)']).toBeGreaterThan(0);
        const otherDbOnly = { timestamp: '2026-10-05T18:45:00Z', protoPayload: { methodName: 'google.firestore.v1.Firestore.Commit',
                authenticationInfo: { principalEmail: account }, resourceName: 'projects/freepasserp5/databases/other' } };
        expect(judge([otherDbOnly]).reasons).toContain('DAILY_WRITER_OUTSIDE_ALLOWED_COLLECTIONS');
    });
    it('never prints an unknown collection name in the public report', () => {
        const r = judge([commit('2026-10-05T18:45:00Z', [doc('SENSITIVE_VALUE')])]);
        expect(r.outsideCollections).toEqual({ '(other)': 1 });
        expect(JSON.stringify(r)).not.toContain('SENSITIVE_VALUE');
    });
    it('alerts on writes outside every main daily run, and ignores branch or queued runs as windows', () => {
        const bare = { timestamp: '2026-10-05T12:00:00Z', protoPayload: { methodName: 'google.firestore.v1.Firestore.Commit',
                authenticationInfo: { principalEmail: account } } };
        const outside = judge([bare]);
        expect(outside.status).toBe('ALERT');
        expect(outside.reasons).toContain('DAILY_WRITER_OUTSIDE_SCHEDULED_RUN');
        const late = commit('2026-10-05T19:20:00Z', [doc('catalog_products')]);
        expect(judge([late], [{ ...run, head_branch: 'feature', status: 'in_progress', run_started_at: '2026-10-05T19:10:00Z' },
            { ...run, status: 'queued', run_started_at: '2026-10-05T19:10:00Z' },
            { ...run, status: 'pending', run_started_at: '2026-10-05T19:10:00Z' }]).reasons).toContain('DAILY_WRITER_OUTSIDE_SCHEDULED_RUN');
    });
    it('holds on a write whose document path cannot be read, even inside a daily run', () => {
        const bare = { timestamp: '2026-10-05T18:45:00Z', protoPayload: { methodName: 'google.firestore.v1.Firestore.Commit',
                authenticationInfo: { principalEmail: account } } };
        expect(judge([bare])).toMatchObject({ status: 'HOLD', reasons: ['DAILY_WRITER_DOCUMENT_PATH_MISSING'], writesWithoutDocumentPaths: 1 });
        // A database-level resourceName or a stray string elsewhere in the request is not a document path.
        const dbOnly = { ...bare, protoPayload: { ...bare.protoPayload, resourceName: db, request: { note: doc('catalog_products') } } };
        expect(judge([dbOnly])).toMatchObject({ status: 'HOLD', writesWithoutDocumentPaths: 1 });
    });
    it('holds when a successful apply run left no write log (audit log off or missing)', () => {
        expect(judge([])).toMatchObject({ status: 'HOLD', reasons: ['DAILY_WRITER_AUDIT_LOG_MISSING'], silentApplies: 1 });
        const dryRun = { ...run, event: 'workflow_dispatch', display_title: 'shared-sheet-daily dry-run' };
        expect(judge([], [dryRun]).status).toBe('OK');
    });
    it('does not count only when shared-sheet-daily steps prove the gate ran and write steps were skipped', () => {
        expect(judge([], [{ ...run, jobAttempts: [skippedJobSteps] }])).toMatchObject({ status: 'OK', silentApplies: 0 });
        expect(judge([], [{ ...run, jobAttempts: [sparseGateSkippedJobSteps] }])).toMatchObject({ status: 'OK', silentApplies: 0 });
    });
    it('holds for sparse gate skip runs when the sparse checkout failed or capture/apply did not skip', () => {
        const sparseCheckoutFailed = sparseGateSkippedJobSteps.map((s) => s.name === 'Fetch gate scripts (sparse)' ? { ...s, conclusion: 'failure' } : s);
        const captureRan = sparseGateSkippedJobSteps.map((s) => s.name === 'Capture and plan (no writes) — counts only in the public log'
            ? { ...s, conclusion: 'success' } : s);
        const applyRan = sparseGateSkippedJobSteps.map((s) => s.name === 'Apply to FreePass Data (writes) — counts only in the public log'
            ? { ...s, conclusion: 'success' } : s);
        expect(judge([], [{ ...run, jobAttempts: [sparseCheckoutFailed] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [{ ...run, jobAttempts: [captureRan] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [{ ...run, jobAttempts: [applyRan] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
    });
    it('holds for the actual older write run because non-allowlisted steps succeeded', () => {
        expect(judge([], [{ ...run, jobAttempts: [oldWritingJobSteps] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
    });
    it('checks every run attempt: an earlier attempt that wrote cannot hide behind a later all-skipped attempt', () => {
        const rerun = { ...run, run_attempt: 2 };
        expect(judge([], [{ ...rerun, jobAttempts: [oldWritingJobSteps, skippedJobSteps] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [{ ...rerun, jobAttempts: [skippedJobSteps, skippedJobSteps] }])).toMatchObject({ status: 'OK', silentApplies: 0 });
        expect(judge([], [{ ...{ ...run, run_attempt: 3 }, jobAttempts: [skippedJobSteps, skippedJobSteps, skippedJobSteps] }])).toMatchObject({ status: 'OK', silentApplies: 0 });
    });
    it('holds when any attempt could not be read or the attempt list is missing / the wrong length', () => {
        const rerun = { ...run, run_attempt: 2 };
        expect(judge([], [{ ...rerun, jobAttempts: [skippedJobSteps, null] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [{ ...rerun, jobAttempts: [null, skippedJobSteps] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [{ ...rerun, jobAttempts: [skippedJobSteps] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [{ ...rerun, jobAttempts: null }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [{ ...rerun }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [{ ...run, jobAttempts: [] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
    });
    it('malformed step entries (null, non-object, missing / empty / non-string name or conclusion) hold instead of throwing', () => {
        const bad = [null, 'x', 7, [], { conclusion: 'skipped' }, { name: '', conclusion: 'skipped' }, { name: '  ', conclusion: 'skipped' },
            { name: 42, conclusion: 'skipped' }, { name: 'Run something', conclusion: null }, { name: 'Run something' }];
        for (const entry of bad) {
            expect(() => judge([], [{ ...run, jobAttempts: [[...skippedJobSteps, entry]] }])).not.toThrow();
            expect(judge([], [{ ...run, jobAttempts: [[...skippedJobSteps, entry]] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        }
    });
    it('a nameless step holds even when it is skipped', () => {
        expect(judge([], [{ ...run, jobAttempts: [[...skippedJobSteps, { conclusion: 'skipped' }]] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
    });
    it('any repeated step name holds, not only the three required steps', () => {
        const dup = [...skippedJobSteps, { name: 'Run actions/checkout@v4', conclusion: 'skipped' }];
        expect(judge([], [{ ...run, jobAttempts: [dup] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        const dupSparse = [...sparseGateSkippedJobSteps, { name: 'Fetch gate scripts (sparse)', conclusion: 'success' }];
        expect(judge([], [{ ...run, jobAttempts: [dupSparse] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        const dupSetup = [...skippedJobSteps, { name: 'Set up job', conclusion: 'success' }];
        expect(judge([], [{ ...run, jobAttempts: [dupSetup] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
    });
    it('fails closed unless the exact gate/capture/apply skipped pattern is confirmed', () => {
        const changedName = skippedJobSteps.map((s) => s.name === 'Daily schedule and manual apply gate'
            ? { ...s, name: 'Daily schedule apply gate' } : s);
        const partialSkipped = skippedJobSteps.map((s) => s.name === 'Apply to FreePass Data (writes) — counts only in the public log'
            ? { ...s, conclusion: 'success' } : s);
        const gateNotSuccess = skippedJobSteps.map((s) => s.name === 'Daily schedule and manual apply gate'
            ? { ...s, conclusion: 'skipped' } : s);
        const unknownSuccess = [...skippedJobSteps, { name: 'Persist snapshot', conclusion: 'success' }];
        const failureStep = skippedJobSteps.map((s) => s.name === 'Run actions/checkout@v4' ? { ...s, conclusion: 'failure' } : s);
        const renamedApply = skippedJobSteps.map((s) => s.name === 'Apply to FreePass Data (writes) — counts only in the public log'
            ? { ...s, name: 'Apply to FreePass Data (writes)' } : s);
        const duplicateGate = [...skippedJobSteps, { name: 'Daily schedule and manual apply gate', conclusion: 'success' }];
        expect(judge([], [{ ...run, jobAttempts: [changedName] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [{ ...run, jobAttempts: [[]] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [{ ...run, jobAttempts: [partialSkipped] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [{ ...run, jobAttempts: [[{ name: 'Apply to FreePass Data (writes) — counts only in the public log', conclusion: 'success' }]] }]))
            .toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [{ ...run, jobAttempts: [gateNotSuccess] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [{ ...run, jobAttempts: [unknownSuccess] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [{ ...run, jobAttempts: [failureStep] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [{ ...run, jobAttempts: [renamedApply] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [{ ...run, jobAttempts: [duplicateGate] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [{ ...run, jobAttempts: [null] }])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
        expect(judge([], [run])).toMatchObject({ status: 'HOLD', silentApplies: 1 });
    });
});
