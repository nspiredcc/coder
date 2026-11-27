# MVP architecture: one implementer, one independent verifier

## Goal

Prove the harness can separate implementation from verification for one bounded task before introducing multiple agents or provider-specific orchestration.

The initial execution target is **Node.js with local Git worktrees**. The model/provider is intentionally out of scope: the first slice can accept a patch from a human or stub implementer so the trust boundary is testable without an API dependency.

## Roles and authority

- **Operator (human):** supplies authorization and scope; approves or rejects consequential actions. Only the operator may authorize commits to a lasting branch, merges, or deployments.
- **Supervisor (harness coordinator):** validates the task card, pins the base, tracks state, invokes one implementer and one verifier, and records evidence. It cannot approve its own implementation or bypass the operator gate.
- **Implementer (one worker):** reads the pinned base and proposes changes in an implementation worktree. It may not report its own test results as verification evidence.
- **Verifier (one worker):** receives a separately created, clean worktree for the immutable candidate commit, runs the acceptance commands, and returns evidence. It must not write to the implementation worktree or change the candidate.

## Workflow and state transitions

`DRAFT -> AUTHORIZED -> IMPLEMENTING -> CANDIDATE_PINNED -> VERIFYING -> VERIFIED | REJECTED -> OPERATOR_REVIEW -> APPROVED | DECLINED`

1. Validate a versioned task card. Reject missing authorization, scope, base commit, or acceptance criteria.
2. Create an implementation worktree at the exact base commit. The implementer works only there and returns a patch/change set.
3. Harness validates the change set against scope, applies it, and records changed paths. Do not treat implementer-reported tests as verifier evidence.
4. Capture the exact candidate as an immutable Git commit (or equivalent immutable Git object) derived from the pinned base. Record its commit and tree IDs. The candidate must not be modified after pinning.
5. Create a **new detached verifier worktree** at the candidate commit. Assert it is a distinct canonical path, has no tracked or untracked changes before tests, and resolves to the recorded commit and tree IDs.
6. Run only the task card's prescribed commands in the verifier worktree. Capture exact argv, working directory, timestamps, environment metadata (redacting secrets), stdout, stderr, and exit code. Do not accept a model summary in place of process output.
7. Mark verification passed only if all required commands exit successfully, the candidate identity is unchanged, and the verifier worktree is clean afterward. Otherwise mark rejected and preserve failure evidence.
8. Present the task card, patch, candidate identity, and verifier evidence to the operator. Stop pending explicit approval; no automatic commit to a lasting branch, merge, or deployment.
9. Clean up temporary worktrees and refs in a `finally` path, while retaining the evidence record and immutable candidate object for the configured retention period.

## Isolation boundary and limitations

The MVP proves **workspace separation and provenance**, not hostile-code containment. Git worktrees have distinct working directories but share a Git object database and usually run under the same OS identity. A verifier executing repository-provided tests can read files accessible to that user, including potentially reachable sibling directories. Do not run untrusted code with secrets or claim a security sandbox. If adversarial code is in scope, move verification into a container/VM with restricted mounts, network, credentials, and resource limits.

The verifier gets only the candidate checkout, task card, and required test instructions—not the implementer's mutable directory or claims. Tests must prove that the verifier path and implementation path are distinct and that verifier execution does not alter the candidate or implementation workspace.

## Evidence record

Persist one machine-readable record per run containing:

- schema version, task ID, authorization/operator identity, and state transitions;
- repository identity, base commit, candidate commit and tree IDs;
- patch digest and changed-file list;
- implementer/verifier identifiers and Node.js/Git/platform versions;
- verifier worktree path identity (avoid leaking sensitive absolute paths in exported records);
- each exact test command, start/end time, stdout, stderr, exit code, and environment summary;
- clean-worktree and immutable-candidate checks before and after execution;
- findings, limitations, and operator decision/approval timestamp.

Evidence is append-only from the harness perspective; never overwrite a failed run with a later successful run. Redact secrets and allow configuring output limits without discarding exit status or recording that truncation occurred.

## MVP acceptance criteria

- A task cannot enter implementation without a valid authorized task card and pinned base commit.
- Exactly one implementer workspace and one independently created verifier worktree are used.
- The verifier worktree starts at the exact candidate commit/tree and has a distinct canonical path from the implementer workspace.
- A test fixture proves changes in the implementer workspace after candidate pinning do not appear in the verifier checkout.
- Verifier commands run with the verifier worktree as their working directory; raw output and exit codes are recorded.
- A failing command, dirty verifier checkout, or candidate identity mismatch results in `REJECTED` and cannot be reported as verified.
- No commit to a durable branch, merge, or deployment occurs without explicit operator approval.
- Cleanup occurs on success and failure without deleting the retained evidence record.
- Tests document that this is not OS-level sandboxing and do not claim adversarial-code safety.

## Non-goals for this slice

- Multiple implementers/verifiers, autonomous delegation, or model-to-model consensus.
- OpenRouter-specific API integration, hosted shell, or provider session persistence.
- Automatic merge/deploy, credentials management, or production sandboxing.
- Treating prompts or role labels as enforcement; enforcement belongs in harness checks and OS/worktree boundaries.
