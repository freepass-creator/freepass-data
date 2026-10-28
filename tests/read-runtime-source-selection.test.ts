import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = readFileSync(new URL('../.github/workflows/deploy-read-runtime.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const section = workflow.split('      - name: Resolve trusted runtime source')[1]!.split('      - name: Validate public approval')[0]!;
const script = section.split('        run: |\n')[1]!.split('\n').map(line => line.slice(10)).join('\n');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

describe('trusted read runtime source selection', () => {
  it('stops selected-source publication on failed Linux checks or a mismatched local image', () => {
    const validation = workflow.split('      - name: Validate selected photo source before publication')[1]!.split('      - name: Authenticate deploy identity')[0]!;
    const validationScript = validation.split('        run: |\n')[1]!.split('\n').map(line => line.slice(10)).join('\n');
    for (const [selected, tree, parent] of [
      ['57abb8a978457b87068c3c9c9d76cc8116934bd5', '712c286a842dea616e7360b421fdd5e068540a40', '2ebdb18822416847b2019f6506b7b0d65daf0ee2'],
      ['d42c4f58d939d7899457730cd1a82f419b3eade8', '4ea34735d2c5ebd4b0b369435e8f3dda81ace01b', '1fa62d59151e25f78d900e27d496eb92f9f210bf'],
      ['bd03f33b9bdedfb8f49ad8717062b32784e9a08a', 'f8b0d22400bff1987ae9cf1824302c99afefce05', 'c9b9a4b31d001c2cbffd43022c9213e01e3d2544'],
    ] as const) {
    const mocks = `git() { case "$1" in rev-parse) if [ "$2" = 'HEAD^{tree}' ]; then echo "$MOCK_TREE"; else echo '${selected}'; fi;; show) if [ "$2" = -s ]; then echo "$MOCK_PARENT"; else echo PROBE_FROM_TRUSTED_MAIN; fi;; write-tree) echo '${tree}';; ls-tree) printf 'fixture\\0';; ls-files) if [ "$MOCK_FILE_MISMATCH" = true ]; then printf 'other\\0'; else printf 'fixture\\0'; fi;; esac; }\n` +
      `tar() { :; }\n` +
      `npm() { echo; echo "NPM $*"; if [ "$1" = test ]; then test -z "\${IANCAR_PHOTO_ID_GATE_SUPPLIERS+x}" && test -z "\${REQUESTED_RUNTIME_SOURCE_SHA+x}" || return 1; fi; if [ "$1" = exec ] && [ "$MOCK_FAILED_CHECK" = true ]; then return 1; fi; }\n` +
      `env() { test "$1/$2/$3/$4" = '-u/IANCAR_PHOTO_ID_GATE_SUPPLIERS/-u/REQUESTED_RUNTIME_SOURCE_SHA' || return 1; shift 4; (unset IANCAR_PHOTO_ID_GATE_SUPPLIERS REQUESTED_RUNTIME_SOURCE_SHA; "$@"); }\n` +
      `docker() { if [ "$1" = image ]; then case "$*" in *Config.Env*) echo '["FREEPASS_DATA_ENTRYPOINT=dist/src/api/consumer-server.js"]';; *) echo "$MOCK_LABEL";; esac; else echo "DOCKER $*"; if [ "$1" = run ]; then test -r "$probe_file" || return 1; if [ "$MOCK_NATIVE_FAIL" = true ]; then return 1; fi; fi; fi; }\n` +
      `jq() { cat >/dev/null; }\n`;
    const dir = mkdtempSync(join(tmpdir(), 'selected-photo-NPM-check-'));
    try {
      for (const [failed, label, mismatch, actualTree, actualParent, nativeFail, pass] of [
        ['false', selected, 'false', tree, parent, 'false', true],
        ['true', selected, 'false', tree, parent, 'false', false],
        ['false', 'c'.repeat(40), 'false', tree, parent, 'false', false],
        ['false', selected, 'true', tree, parent, 'false', false],
        ['false', selected, 'false', 'f'.repeat(40), parent, 'false', false],
        ['false', selected, 'false', tree, 'f'.repeat(40), 'false', false],
        ...(selected !== '57abb8a978457b87068c3c9c9d76cc8116934bd5' ? [['false', selected, 'false', tree, parent, 'true', false] as const] : []),
      ] as const) {
        const retainedSelection = `\ntest "$IANCAR_PHOTO_ID_GATE_SUPPLIERS" = RP031\ntest "$REQUESTED_RUNTIME_SOURCE_SHA" = '${selected}'\ntest "$EXPECTED_SOURCE_SHA" = '${selected}'\ntest "$EXPECTED_BASELINE_REVISION" = freepass-data-read-00038-phh\ntest "$EXPECTED_BASELINE_SOURCE_SHA" = c9b9a4b31d001c2cbffd43022c9213e01e3d2544\ntest "$EXPECTED_BASELINE_IMAGE_DIGEST" = sha256:6322eb95ab90882f42febd480844c45e400411ccc1a81c99f8601de3e2e6c5b2\necho PUBLICATION_ALLOWED\n`;
        const result = spawnSync(bash, ['-s'], { input: mocks + validationScript + retainedSelection, encoding: 'utf8', env: {
          ...process.env, EXPECTED_SOURCE_SHA: selected, WORKFLOW_SOURCE_SHA: 'a'.repeat(40), RUNNER_TEMP: dir,
          MOCK_FAILED_CHECK: failed, MOCK_LABEL: label, MOCK_FILE_MISMATCH: mismatch, RUNTIME_ENTRYPOINT: 'dist/src/api/consumer-server.js',
          MOCK_TREE: actualTree as string, MOCK_PARENT: actualParent as string, MOCK_NATIVE_FAIL: nativeFail as string,
          IANCAR_PHOTO_ID_GATE_SUPPLIERS: 'RP031', REQUESTED_RUNTIME_SOURCE_SHA: selected,
          EXPECTED_BASELINE_REVISION: 'freepass-data-read-00038-phh',
          EXPECTED_BASELINE_SOURCE_SHA: 'c9b9a4b31d001c2cbffd43022c9213e01e3d2544',
          EXPECTED_BASELINE_IMAGE_DIGEST: 'sha256:6322eb95ab90882f42febd480844c45e400411ccc1a81c99f8601de3e2e6c5b2',
          GITHUB_ENV: '/dev/null', GITHUB_STEP_SUMMARY: '/dev/null',
        } });
        expect(result.status === 0, result.stderr).toBe(pass);
        expect(result.stdout.includes('PUBLICATION_ALLOWED')).toBe(pass);
        // cmp can print NPM inside a temporary path; only the mock invocation line proves execution.
        if (mismatch === 'true' || actualTree !== tree || actualParent !== parent) expect(result.stdout).not.toMatch(/^NPM(?:\s|$)/m);
        else {
          expect(result.stdout).toContain('NPM run test:delivery-owner');
          expect(result.stdout).toContain(selected !== '57abb8a978457b87068c3c9c9d76cc8116934bd5' ? 'NPM exec -- vitest run tests/vehicle-photo-rendition.test.ts' : 'NPM exec -- vitest run tests/vehicle-photo-read-observer.test.ts');
          if (selected.startsWith('bd03')) expect(result.stdout).toContain('tests/iancar-one-api.test.ts');
        }
        expect(result.stdout).not.toContain('docker push');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    expect(workflow.indexOf('Validate selected photo source before publication')).toBeLessThan(workflow.indexOf('Authenticate deploy identity'));
    expect(validationScript.indexOf('chmod 0444 "$probe_file"')).toBeGreaterThan(validationScript.indexOf('git show "$WORKFLOW_SOURCE_SHA:scripts/verify-photo-rendition-runtime.mjs"'));
    expect(validationScript.indexOf('chmod 0444 "$probe_file"')).toBeLessThan(validationScript.indexOf('docker run --rm'));
    expect(validationScript).not.toContain('--user');
    expect(readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')).toMatch(/^USER node\s*$/m);
    expect(workflow.indexOf('SELECTED_PHOTO_SOURCE_CHECKED:-false')).toBeLessThan(workflow.indexOf('docker push "$image"'));
  }, 15_000);

  it('restores archive public-file scanning with an exact temporary Git index and no remote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-archive-index-'));
    const run = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
    try {
      const original = join(dir, 'original'), archived = join(dir, 'archived');
      mkdirSync(original); mkdirSync(archived);
      writeFileSync(join(original, '.gitignore'), 'kept.txt\nnode_modules/\n');
      writeFileSync(join(original, 'kept.txt'), 'public source evidence\n');
      expect(run(original, 'init', '--quiet').status).toBe(0);
      expect(run(original, '-c', 'core.autocrlf=false', 'add', '--force', '--all').status).toBe(0);
      const tree = run(original, 'write-tree').stdout.trim();
      const sourceFiles = join(dir, 'source-files');
      writeFileSync(sourceFiles, run(original, 'ls-tree', '-r', '--name-only', '-z', tree).stdout);
      expect(run(original, '-c', 'core.autocrlf=false', 'archive', '--output=' + join(dir, 'source.tar'), tree).status).toBe(0);
      const unpack = spawnSync(bash, ['-c', 'tar -xf source.tar -C archived'], { cwd: dir, encoding: 'utf8' });
      expect(unpack.status, unpack.stderr).toBe(0);
      expect(run(archived, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').status).not.toBe(0);
      const preparation = workflow.split('          cd "$source_dir"\n')[1]!.split('          npm ci')[0]!;
      const initialized = spawnSync(bash, ['-s'], { cwd: archived, input: preparation.replace('712c286a842dea616e7360b421fdd5e068540a40', tree), encoding: 'utf8', env: { ...process.env, source_files: sourceFiles.replaceAll('\\', '/'), expected_tree: tree } });
      expect(initialized.status, initialized.stderr).toBe(0);
      expect(run(archived, 'write-tree').stdout.trim()).toBe(tree);
      mkdirSync(join(archived, 'node_modules'));
      writeFileSync(join(archived, 'node_modules', 'generated.txt'), 'generated dependency\n');
      const files = run(archived, 'ls-files', '--cached', '--others', '--exclude-standard', '-z');
      expect(files.status).toBe(0);
      expect(files.stdout.split('\0').filter(Boolean)).toEqual(['.gitignore', 'kept.txt']);
      expect(run(archived, 'remote').stdout).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

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
          EXPECTED_BASELINE_REVISION: 'freepass-data-read-00030-bfq', EXPECTED_BASELINE_SOURCE_SHA: ancestor,
          EXPECTED_BASELINE_IMAGE_DIGEST: 'sha256:' + 'b'.repeat(64), USE_CONSUMER_SECRETS: 'true',
          ALLOW_UNAUTHENTICATED: 'false', GRANT_PUBLIC_INVOKER: 'false',
          RUNTIME_ENTRYPOINT: 'dist/src/api/consumer-server.js',
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
