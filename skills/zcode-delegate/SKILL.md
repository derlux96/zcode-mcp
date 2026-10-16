---
name: zcode-delegate
description: Delegate coding tasks (multi-file changes, refactors, test suites, implementations) to a locally installed ZCode agent via the zcode_run MCP tool. Use when a task needs a real agent runtime that reads, edits, and tests code.
---

# ZCode Task Delegation

You are the orchestrator: you write the specification and verify the result. ZCode executes.
Answer trivial questions yourself — do not spawn a ZCode task for anything a single file read cannot justify.

## 1. Pre-flight

On the first delegation on a machine, call `zcode_check`. If it reports a missing binary,
tell the user to install ZCode or set `ZCODE_BIN`; do not retry until they confirm.

## 2. Mode matrix

| Situation | mode |
|---|---|
| Risky or novel change, unclear architecture | `plan` first — review the plan, then run again with `build` |
| Implementation with an approved plan or clear spec | `build` |
| Small, precisely located fix | `edit` |
| Well-scoped task that should finish autonomously (default) | `yolo` |

## 3. Writing delegation prompts

A good `prompt` is a specification, not a wish. Include:
- Goal in one sentence.
- Affected files/paths (absolute or repo-relative).
- Edge cases to handle.
- Test requirement ("run the test suite; add tests for X").
- Definition of done.

Bad: "fix the login bug".
Good: "In src/auth/login.ts the session cookie is not refreshed on rotation. Fix the refresh, handle the expired-refresh-token case by redirecting to /login, and add tests for both cases in src/auth/login.test.ts. Run npm test — done when all tests pass."

## 4. Verification loop

After every `zcode_run`:
1. Read the returned `status:` line. Non-zero exit or timeout means the task failed — read `--- zcode output ---` before retrying.
2. Check `changed_files:` / `diff_stat` (present when `isolate_worktree` was used) and the test output inside the zcode output.
3. On failure, iterate: call `zcode_run` again with `resume` set to the returned `session_id` (a `sess_...` id) and a correction hint. Do not start over from scratch — the session keeps context.
4. Maximum two retries, then report the failure to the user with the output excerpt.

## 5. Sessions

- `zcode_sessions` lists past runs; filter with `cwd`.
- Only `sess_...` ids are resumable. Ids marked `NOT-RESUMABLE` (server run-ids, `run_...`) exist only for bookkeeping.

## 6. Worktree isolation

Use `isolate_worktree: true` when the task might conflict with uncommitted local work or when the user wants a reviewable branch:
- ZCode works on a new `zcode/<slug>` branch in `.zcode-worktrees/<slug>/`.
- The worktree is NEVER cleaned up by the server. After verifying the diff, either merge it (`git merge <branch>`) or discard it (`git worktree remove <dir>` and `git branch -D <branch>`).
- Report leftover worktrees to the user explicitly.
