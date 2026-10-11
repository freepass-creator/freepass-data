import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/deploy-read-runtime.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const section = workflow.split('      - name: Resolve trusted runtime source')[1]!.split('      - name: Validate public approval')[0]!;
const script = section.split('        run: |\n')[1]!.split('\n').map(line => line.slice(10)).join('\n');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

describe('trusted read runtime source selection', () => {
  it('accepts default main and an exact ancestor, rejects every untrusted ref before effects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-source-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      git('init', '-b', 'main');
      git('config', 'user.name', 'Synthetic Test');
      git('config', 'user.email', 'test@example.invalid');
      git('commit', '--allow-empty', '-m', 'ancestor');
      const ancestor = git('rev-parse', 'HEAD');
      git('commit', '--allow-empty', '-m', 'trusted main');
      const main = git('rev-parse', 'HEAD');
      git('checkout', '-b', 'unmerged');
      git('commit', '--allow-empty', '-m', 'unmerged');
      const unmerged = git('rev-parse', 'HEAD');
      git('checkout', 'main');
      for (const [requested, ref, head, pass] of [
        ['', 'refs/heads/main', main, true], [ancestor, 'refs/heads/main', main, true],
        [main, 'refs/heads/main', main, true], [unmerged, 'refs/heads/main', main, false],
        ['main', 'refs/heads/main', main, false], ['refs/tags/release', 'refs/heads/main', main, false],
        ['--help', 'refs/heads/main', main, false], ['a'.repeat(39), 'refs/heads/main', main, false],
        ['A'.repeat(40), 'refs/heads/main', main, false], ['f'.repeat(40), 'refs/heads/main', main, false],
        [ancestor, 'refs/heads/unmerged', main, false], [ancestor, 'refs/heads/main', ancestor, false],
      ] as const) {
        const output = join(dir, 'output');
        const result = spawnSync(bash, ['-s'], { cwd: dir, input: script, encoding: 'utf8', env: {
          ...process.env, REQUESTED_RUNTIME_SOURCE_SHA: requested, GITHUB_REF: ref, GITHUB_SHA: head,
          GITHUB_OUTPUT: output, GITHUB_ENV: join(dir, 'env'),
        } });
        expect(result.status === 0, `${requested}: ${result.stderr}`).toBe(pass);
        if (pass) expect(readFileSync(output, 'utf8')).toContain(`sha=${requested || main}`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('builds and attests the resolved source while retaining trusted main workflow and verification guards', () => {
    expect(workflow).toContain('ref: ${{ github.sha }}');
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow.indexOf('Resolve trusted runtime source')).toBeLessThan(workflow.indexOf('Authenticate deploy identity'));
    expect(workflow).toContain('ref: ${{ steps.runtime-source.outputs.sha }}');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$EXPECTED_SOURCE_SHA"');
    expect(workflow).toContain('$image_name:$EXPECTED_SOURCE_SHA');
    expect(workflow).toContain('org.opencontainers.image.revision=$EXPECTED_SOURCE_SHA');
    expect(workflow).toContain('docker image inspect "$image@$digest"');
    expect(workflow).toContain('test "${IMAGE##*:}" = "$EXPECTED_SOURCE_SHA"');
    expect(workflow).toContain('WORKFLOW_SOURCE_SHA=$GITHUB_SHA');
    expect(workflow.split('\n  verify:')[1]).not.toContain('runtime_source_sha');
  });

  it('refuses an immutable image whose revision label disagrees with the resolved source', () => {
    const build = workflow.split('      - name: Build immutable container')[1]!.split('      - name: Deploy private read-only service')[0]!
      .split('        run: |\n')[1]!.split('\n').map(line => line.slice(10)).join('\n');
    const source = 'a'.repeat(40), digest = 'sha256:' + 'b'.repeat(64);
    const mocks = `git() { echo "$EXPECTED_SOURCE_SHA"; }\n` +
      `gcloud() { if [ "$1" = artifacts ]; then echo '${digest}'; fi; }\n` +
      `docker() { if [ "$1" = image ]; then echo "$MOCK_LABEL"; else echo "DOCKER $*"; fi; }\n`;
    for (const [label, pass] of [[source, true], ['c'.repeat(40), false], ['', false]] as const) {
      const result = spawnSync(bash, ['-s'], { input: mocks + build, encoding: 'utf8', env: {
        ...process.env, EXPECTED_SOURCE_SHA: source, MOCK_LABEL: label, GITHUB_ENV: '/dev/null',
        REGION: 'asia-northeast3', PROJECT_ID: 'freepasserp5', ARTIFACT_REPOSITORY: 'freepass-data',
        RUNTIME_ENTRYPOINT: 'dist/src/api/consumer-server.js', SERVICE_NAME: 'freepass-data-read',
      } });
      expect(result.status === 0, result.stderr).toBe(pass);
      expect(result.stdout).toContain(`freepass-data-read:${source}@${digest}`);
    }
  });
});
