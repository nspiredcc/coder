# Task card template (v1)

A task card is the versioned, machine-readable authorization and acceptance contract shared by the harness, implementer, verifier, and operator. The harness must validate required fields before creating any workspace. Keep the card immutable for a run; edits create a new revision and run ID.

```yaml
schema_version: 1
task_id: "<unique-id>"
authorization:
  requested_by: "<operator identity>"
  approved_at: "<RFC3339 timestamp>"
  scope: "<what may be changed>"
repository:
  url: "<repository URL>"
  base_commit: "<full commit SHA>"
implementation:
  instructions: "<bounded change request>"
  allowed_paths:
    - "<path or glob>"
  prohibited_actions:
    - "commit to a durable branch"
    - "merge or deploy"
verification:
  commands:
    - ["npm", "test"]
  timeout_seconds: 300
  acceptance_criteria:
    - "<observable pass condition>"
  required_checks:
    candidate_unchanged: true
    verifier_worktree_clean: true
operator_gate:
  require_approval_before_durable_action: true
```

## Field rules

- `task_id` must be unique; `base_commit` must resolve to a full commit object before work begins.
- Authorization is explicit and scoped. A blank `allowed_paths` is not an implicit allow-all; the harness should reject it unless the card intentionally declares a documented repository-wide scope.
- Commands are argument arrays, not shell strings. The harness invokes them without shell interpolation, in the verifier worktree, with a timeout and bounded resource/output policy.
- The verifier must not be allowed to edit the candidate. A nonzero command exit, timeout, candidate identity change, or dirty checkout is a failed verification.
- Task cards do not grant permission to commit, merge, deploy, access secrets, or expand scope. Those require separate operator-controlled authorization.
- Store approval events and evidence separately from the card so approvals cannot be fabricated by an implementer editing its workspace.

## Example first proof task

Use a deliberately small fixture task: add or change a file under one allowed path, build an immutable candidate, then verify it from a fresh detached worktree. Include a verifier command that writes a sentinel only in its own worktree. Assert the implementer worktree is unchanged by that command, the sentinel is absent from the implementation worktree, and a separate failing command produces a rejected run with captured stdout/stderr/exit code. Do not use this fixture to claim security against malicious repository code.
