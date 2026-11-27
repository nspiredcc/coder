import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type TaskCard = {
  schema_version: 1;
  task_id: string;
  authorization: { requested_by: string; approved_at: string; scope: string };
  repository: { url?: string; base_commit: string };
  implementation: { instructions: string; allowed_paths: string[]; prohibited_actions?: string[] };
  verification: {
    commands: string[][];
    timeout_seconds: number;
    acceptance_criteria: string[];
    required_checks?: { candidate_unchanged?: boolean; verifier_worktree_clean?: boolean };
  };
  operator_gate?: { require_approval_before_durable_action?: boolean };
};

type RunManifest = {
  schema_version: 1;
  run_id: string;
  card: TaskCard;
  repo_path: string;
  implementation_path: string;
  created_at: string;
};

type CommandEvidence = {
  argv: string[];
  cwd: string;
  started_at: string;
  finished_at: string;
  exit_code: number;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  output_truncated: boolean;
};

export type VerificationEvidence = {
  schema_version: 1;
  run_id: string;
  task_id: string;
  status: 'VERIFIED' | 'REJECTED';
  created_at: string;
  repository: { path: string; base_commit: string; candidate_commit: string; candidate_tree: string };
  patch_sha256: string;
  changed_paths: string[];
  implementer: { worktree: string };
  verifier: { worktree: string; distinct_from_implementer: boolean; clean_before: boolean; clean_after: boolean; candidate_unchanged: boolean };
  environment: { node: string; git: string; platform: string; arch: string };
  commands: CommandEvidence[];
  findings: string[];
  limitation: string;
};

const MAX_OUTPUT_BYTES = 1024 * 1024;
const RUN_FILE = 'run.json';

async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`)));
  });
}

function validateCard(card: TaskCard): void {
  if (card?.schema_version !== 1 || !card.task_id?.trim()) throw new Error('task card must have schema_version 1 and task_id');
  if (!card.authorization?.requested_by?.trim() || !card.authorization.scope?.trim() || !Number.isFinite(Date.parse(card.authorization.approved_at))) {
    throw new Error('task card requires authorization requester, scope, and RFC3339 approval timestamp');
  }
  if (!/^[0-9a-f]{40,64}$/i.test(card.repository?.base_commit ?? '')) throw new Error('repository.base_commit must be a full Git object ID');
  if (!card.implementation?.instructions?.trim() || !Array.isArray(card.implementation.allowed_paths) || card.implementation.allowed_paths.length === 0) {
    throw new Error('implementation instructions and at least one allowed_paths entry are required');
  }
  for (const allowed of card.implementation.allowed_paths) {
    if (!allowed.trim() || path.isAbsolute(allowed) || allowed.split(/[\\/]/).includes('..')) throw new Error(`invalid allowed path: ${allowed}`);
  }
  if (!Array.isArray(card.verification?.commands) || card.verification.commands.length === 0 ||
      card.verification.commands.some(command => !Array.isArray(command) || command.length === 0 || command.some(arg => typeof arg !== 'string')) ||
      !Number.isFinite(card.verification.timeout_seconds) || card.verification.timeout_seconds <= 0 ||
      !Array.isArray(card.verification.acceptance_criteria) || card.verification.acceptance_criteria.length === 0) {
    throw new Error('verification requires non-empty argv commands, positive timeout, and acceptance criteria');
  }
}

async function readManifest(runDir: string): Promise<RunManifest> {
  const manifest = JSON.parse(await readFile(path.join(runDir, RUN_FILE), 'utf8')) as RunManifest;
  if (manifest.schema_version !== 1) throw new Error('unsupported run manifest version');
  validateCard(manifest.card);
  return manifest;
}

export async function prepareRun(card: TaskCard, repositoryPath: string, workRoot = path.join(os.tmpdir(), 'isolated-verifier')): Promise<{ runId: string; runDir: string; implementationPath: string }> {
  validateCard(card);
  const repoPath = await realpath(repositoryPath);
  const base = await git(repoPath, ['rev-parse', '--verify', `${card.repository.base_commit}^{commit}`]);
  if (base !== card.repository.base_commit) throw new Error('resolved base commit does not match task card');
  await mkdir(workRoot, { recursive: true });
  const runId = `${card.task_id}-${randomUUID()}`;
  const runDir = path.join(await realpath(workRoot), runId);
  const implementationPath = path.join(runDir, 'implementer');
  await mkdir(runDir, { recursive: true });
  try {
    await git(repoPath, ['worktree', 'add', '--detach', implementationPath, base]);
    const manifest: RunManifest = { schema_version: 1, run_id: runId, card, repo_path: repoPath, implementation_path: implementationPath, created_at: new Date().toISOString() };
    await writeFile(path.join(runDir, RUN_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    return { runId, runDir, implementationPath };
  } catch (error) {
    await git(repoPath, ['worktree', 'remove', '--force', implementationPath]).catch(() => undefined);
    await rm(runDir, { recursive: true, force: true });
    throw error;
  }
}

function allowedPath(file: string, allowlist: string[]): boolean {
  return allowlist.some(entry => {
    const normalized = entry.replaceAll('\\', '/').replace(/^\.\//, '');
    return file === normalized || (normalized.endsWith('/') && file.startsWith(normalized));
  });
}

function runCommand(argv: string[], cwd: string, timeoutSeconds: number): Promise<CommandEvidence> {
  return new Promise(resolve => {
    const started = new Date().toISOString();
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Do not pass the parent process's credentials/configuration wholesale to repository tests.
      env: Object.fromEntries(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR', 'CI'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key] as string]])),
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let outputTruncated = false;
    const collect = (target: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - bytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining).toString('utf8');
        if (target === 'stdout') stdout += kept; else stderr += kept;
        bytes += Math.min(chunk.length, remaining);
      }
      if (chunk.length > remaining) outputTruncated = true;
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutSeconds * 1000);
    child.once('error', error => {
      clearTimeout(timer);
      resolve({ argv, cwd, started_at: started, finished_at: new Date().toISOString(), exit_code: -1, timed_out: timedOut, stdout, stderr: `${stderr}${error.message}`, output_truncated: outputTruncated });
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({ argv, cwd, started_at: started, finished_at: new Date().toISOString(), exit_code: code ?? -1, timed_out: timedOut, stdout, stderr, output_truncated: outputTruncated });
    });
  });
}

export async function verifyRun(runDir: string, evidenceDir: string): Promise<VerificationEvidence> {
  const manifest = await readManifest(runDir);
  const { card, repo_path: repo, implementation_path: implementation, run_id: runId } = manifest;
  const verifier = path.join(runDir, 'verifier');
  let evidence: VerificationEvidence | undefined;
  try {
    const resolvedImplementation = await realpath(implementation);
    await git(implementation, ['add', '--all']);
    const candidateTree = await git(implementation, ['write-tree']);
    const changedRaw = await git(implementation, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', card.repository.base_commit, candidateTree]);
    const changedPaths = changedRaw ? changedRaw.split('\0').filter(Boolean) : [];
    const denied = changedPaths.filter(file => !allowedPath(file, card.implementation.allowed_paths));
    if (denied.length) throw new Error(`changed paths outside task scope: ${denied.join(', ')}`);
    const patch = await git(implementation, ['diff', '--binary', card.repository.base_commit, candidateTree]);
    const candidateCommit = await git(implementation, ['-c', 'user.name=Verifier MVP', '-c', 'user.email=verifier-mvp@localhost', 'commit-tree', candidateTree, '-p', card.repository.base_commit, '-m', `Candidate for ${card.task_id}`]);
    await git(repo, ['worktree', 'add', '--detach', verifier, candidateCommit]);
    const verifierRealPath = await realpath(verifier);
    const before = await git(verifier, ['status', '--porcelain', '--untracked-files=all']);
    const initialHead = await git(verifier, ['rev-parse', 'HEAD']);
    const initialTree = await git(verifier, ['rev-parse', 'HEAD^{tree}']);
    if (resolvedImplementation === verifierRealPath) throw new Error('implementer and verifier worktrees resolve to the same path');
    if (before) throw new Error('verifier worktree is not clean before tests');
    if (initialHead !== candidateCommit || initialTree !== candidateTree) throw new Error('verifier checkout does not match pinned candidate');
    const commands: CommandEvidence[] = [];
    for (const argv of card.verification.commands) commands.push(await runCommand(argv, verifierRealPath, card.verification.timeout_seconds));
    const afterStatus = await git(verifier, ['status', '--porcelain', '--untracked-files=all']);
    const finalHead = await git(verifier, ['rev-parse', 'HEAD']);
    const finalTree = await git(verifier, ['rev-parse', 'HEAD^{tree}']);
    const cleanAfter = !afterStatus;
    const candidateUnchanged = finalHead === candidateCommit && finalTree === candidateTree;
    const failedCommands = commands.filter(command => command.exit_code !== 0 || command.timed_out);
    const findings = [
      ...failedCommands.map(command => `command failed (exit ${command.exit_code}${command.timed_out ? ', timed out' : ''}): ${command.argv.join(' ')}`),
      ...(!cleanAfter ? ['verifier worktree is dirty after tests'] : []),
      ...(!candidateUnchanged ? ['candidate commit/tree changed during verification'] : []),
    ];
    evidence = {
      schema_version: 1, run_id: runId, task_id: card.task_id, status: findings.length ? 'REJECTED' : 'VERIFIED', created_at: new Date().toISOString(),
      repository: { path: repo, base_commit: card.repository.base_commit, candidate_commit: candidateCommit, candidate_tree: candidateTree },
      patch_sha256: (await import('node:crypto')).createHash('sha256').update(patch).digest('hex'), changed_paths: changedPaths,
      implementer: { worktree: resolvedImplementation }, verifier: { worktree: verifierRealPath, distinct_from_implementer: resolvedImplementation !== verifierRealPath, clean_before: !before, clean_after: cleanAfter, candidate_unchanged: candidateUnchanged },
      environment: { node: process.version, git: await git(repo, ['--version']), platform: process.platform, arch: process.arch }, commands, findings,
      limitation: 'Git worktrees prove workspace separation and provenance, not OS-level containment. Repository tests run as this user; never use with hostile code or secrets.',
    };
  } finally {
    await git(repo, ['worktree', 'remove', '--force', verifier]).catch(() => undefined);
  }
  if (!evidence) throw new Error('verification did not produce evidence');
  await mkdir(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, `${runId}.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  return evidence;
}

export async function cleanupRun(runDir: string): Promise<void> {
  const manifest = await readManifest(runDir);
  await git(manifest.repo_path, ['worktree', 'remove', '--force', manifest.implementation_path]);
  await rm(runDir, { recursive: true, force: true });
}

export async function loadTaskCard(file: string): Promise<TaskCard> {
  const card = JSON.parse(await readFile(file, 'utf8')) as TaskCard;
  validateCard(card);
  return card;
}
