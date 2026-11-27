# Isolated verifier MVP

A small TypeScript harness to prove workspace separation and verification provenance with exactly one implementer worktree and one independently created verifier worktree. No model/provider integration is included. This is **not a security sandbox**; do not run hostile repository code or expose credentials.

## Requirements

- Node.js 20+
- Git

Install dependencies with `npm install`; run `npm test` and `npm run build`.

## Run the proof

Task cards are JSON for this MVP. Copy the shape below into `task-card.json`, replacing the base commit and scope with values for your repository:

```json
{
  "schema_version": 1,
  "task_id": "small-doc-change",
  "authorization": {
    "requested_by": "operator-name",
    "approved_at": "2026-01-15T12:00:00Z",
    "scope": "Update one documentation file"
  },
  "repository": { "base_commit": "<full-base-commit-sha>" },
  "implementation": {
    "instructions": "Make the authorized documentation change",
    "allowed_paths": ["docs/"],
    "prohibited_actions": ["commit to a durable branch", "merge or deploy"]
  },
  "verification": {
    "commands": [["node", "--version"]],
    "timeout_seconds": 60,
    "acceptance_criteria": ["The prescribed command exits successfully"],
    "required_checks": { "candidate_unchanged": true, "verifier_worktree_clean": true }
  },
  "operator_gate": { "require_approval_before_durable_action": true }
}
```

Prepare exactly one implementer worktree at the pinned base:

```sh
npm start -- prepare --card task-card.json --repo /path/to/repository --work-root /tmp/coder-work
```

The command prints `runDir` and `implementationPath`. Make the authorized changes in `implementationPath` only. Then independently pin and verify the resulting candidate:

```sh
npm start -- verify --run-dir /tmp/coder-work/<run-id> --evidence-dir /path/to/evidence
```

The harness stages the implementer changes, rejects paths outside `allowed_paths`, creates an immutable candidate commit object, then creates a **new detached verifier worktree** at that exact commit. Commands are argument arrays (no shell), run in the verifier directory with a timeout, minimal inherited environment, and bounded output. Evidence is written once to `<evidence-dir>/<run-id>.json`; failed commands yield `REJECTED` and exit code 1. The implementer worktree is retained for operator review until explicitly cleaned up:

```sh
npm start -- cleanup --run-dir /tmp/coder-work/<run-id>
```

The verifier worktree is removed after verification, including on failure. Evidence contains candidate/base IDs, changed paths, patch digest, worktree identities and cleanliness checks, command argv, timestamps, stdout/stderr, exit codes, and environment versions. Existing evidence files are never overwritten.

## Scope and security notes

- `allowed_paths` entries are exact paths or directory prefixes ending in `/`; glob syntax is not implemented.
- Git worktrees have distinct filesystems paths but share the repository object database and run under the same OS identity. This proves workspace separation/provenance only—not containment against malicious tests.
- Verification commands receive only a small environment allowlist, but filesystem access remains that of the invoking user. Do not rely on this as credential isolation; use a container or VM with restricted mounts, network, secrets, and resources before evaluating untrusted code.
- Verification evidence is append-only by run ID, but the filesystem is not tamper-proof against the local operator or process owner. Store/export records to a separately controlled system if stronger audit guarantees are required.
- No command commits to a durable branch, merges, deploys, or treats implementer-reported test results as evidence.
