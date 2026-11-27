import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, test } from 'node:test';
import { cleanupRun, prepareRun, type TaskCard, verifyRun } from './index.js';

const execFile = promisify(execFileCallback);
const temporary: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isolated-verifier-test-'));
  temporary.push(root);
  const repo = path.join(root, 'repo');
  await (await import('node:fs/promises')).mkdir(repo);
  const git = (args: string[]) => execFile('git', args, { cwd: repo });
  await git(['init', '-q']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await writeFile(path.join(repo, 'first.txt'), 'base\n');
  await git(['add', '.']);
  await git(['commit', '-qm', 'base']);
  const { stdout } = await git(['rev-parse', 'HEAD']);
  const card: TaskCard = {
    schema_version: 1, task_id: `test-${Date.now()}`,
    authorization: { requested_by: 'operator-test', approved_at: new Date().toISOString(), scope: 'Change fixture file only' },
    repository: { base_commit: stdout.trim() },
    implementation: { instructions: 'Update first.txt', allowed_paths: ['first.txt'] },
    verification: { commands: [[process.execPath, '-e', 'process.stdout.write(require("node:fs").readFileSync("first.txt", "utf8"))']], timeout_seconds: 10, acceptance_criteria: ['stdout contains candidate content'] },
  };
  return { root, repo, card };
}

afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('verifier gets a separate clean checkout of the exact candidate; later implementer edits stay out', async () => {
  const { root, repo, card } = await fixture();
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'first.txt'), 'candidate\n');
  const evidence = await verifyRun(prepared.runDir, path.join(root, 'evidence'));
  assert.equal(evidence.status, 'VERIFIED');
  assert.notEqual(evidence.implementer.worktree, evidence.verifier.worktree);
  assert.equal(evidence.verifier.clean_before, true);
  assert.equal(evidence.verifier.clean_after, true);
  assert.equal(evidence.verifier.candidate_unchanged, true);
  assert.equal(evidence.commands[0].stdout, 'candidate\n');
  await writeFile(path.join(prepared.implementationPath, 'first.txt'), 'late implementer mutation\n');
  assert.equal(await readFile(path.join(prepared.implementationPath, 'first.txt'), 'utf8'), 'late implementer mutation\n');
  assert.equal(evidence.commands[0].stdout.includes('late implementer'), false);
  const persisted = JSON.parse(await readFile(path.join(root, 'evidence', `${prepared.runId}.json`), 'utf8'));
  assert.equal(persisted.status, 'VERIFIED');
  await cleanupRun(prepared.runDir);
});

test('failing verifier command is rejected and raw output/exit code are persisted', async () => {
  const { root, repo, card } = await fixture();
  card.verification.commands = [[process.execPath, '-e', 'process.stdout.write("proof-output"); process.stderr.write("proof-error"); process.exit(7)']];
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'first.txt'), 'candidate\n');
  const evidence = await verifyRun(prepared.runDir, path.join(root, 'evidence'));
  assert.equal(evidence.status, 'REJECTED');
  assert.equal(evidence.commands[0].exit_code, 7);
  assert.equal(evidence.commands[0].stdout, 'proof-output');
  assert.equal(evidence.commands[0].stderr, 'proof-error');
  assert.match(evidence.findings[0], /command failed/);
  await cleanupRun(prepared.runDir);
});

test('changes outside the authorized paths are rejected before verifier execution', async () => {
  const { root, repo, card } = await fixture();
  const prepared = await prepareRun(card, repo, path.join(root, 'work'));
  await writeFile(path.join(prepared.implementationPath, 'unauthorized.txt'), 'nope');
  await assert.rejects(verifyRun(prepared.runDir, path.join(root, 'evidence')), /outside task scope/);
  await cleanupRun(prepared.runDir);
});
