# AGENTS.md instructions

## Working Agreements

1. Clarify before acting when requirements are ambiguous, scope is unclear, or the work affects product direction, data structures, permissions, security, compatibility, deployment, or user-visible behavior.
2. If the request is already clear and low risk, proceed directly and state any assumptions in the final response.
3. Use SDD for requirements, bugs, and non-trivial changes. Do not use TDD as the default workflow.
4. For medium or large requirements and bugs, create a plan/spec before implementation. Simple commands, explanations, single-line fixes, and clearly scoped small edits may be handled directly.
5. Prefer existing project patterns and keep changes narrowly scoped to the requested outcome.

## SDD Spec Requirements

For non-trivial work, the spec should include:

- Goal
- Background/context
- In scope
- Out of scope
- Affected pages, APIs, jobs, services, or data models
- User roles and permissions, when applicable
- Data model or interface changes, when applicable
- Error, empty, loading, and edge states, when applicable
- Rollback or compatibility notes, when applicable
- Acceptance criteria
- Verification commands or manual verification steps

## Forms, Payloads, and Fields

When the task involves forms, API payloads, database fields, configuration fields, or admin settings, document fields in a table before implementation.

Required fields must be marked with a red `*` before the field name.

| Field | Required | Type | Enum values | Limits | Default | Validation |
| --- | --- | --- | --- | --- | --- | --- |
| <span style="color:red">*</span> name | Yes | string | None | 1-50 chars | Empty | Required |

Each field table should make these items explicit:

- Whether the field is required
- Field type
- Enum values, if any
- Length, numeric range, file size, format, or business limits
- Default value
- Validation message or failure behavior

## Bug Workflow

For bugs, first identify:

- Reproduction steps
- Expected behavior
- Actual behavior
- Suspected scope
- Root cause
- Fix plan
- Regression risk
- Verification method

Do not jump to implementation before the root cause and affected surface are clear, unless the fix is trivial and self-evident.

## Implementation

1. Inspect existing code and conventions before editing.
2. Use CodeGraph first when the repository has a `.codegraph/` directory and the task requires understanding or locating code.
3. Avoid unrelated refactors and formatting churn.
4. Preserve user changes and do not revert work that was not made for the current task.
5. Use subagents only when tasks are independent and do not risk conflicting edits to the same files.

## Verification

Before reporting completion, run the most relevant available checks for the change, such as:

- Unit or integration tests
- Type checks
- Lint
- Build
- Manual browser/API verification

If a check cannot be run, explain why and state the remaining risk.

## Git and Release

Before committing or pushing to GitHub or Gitee:

1. Check the current branch.
2. Check `git status`.
3. Identify which changes belong to the current task.
4. Preserve unrelated user changes.
5. Run relevant checks.
6. Pull or fetch the latest code before committing/pushing when appropriate for the workflow.
7. Commit only after the above checks are complete.
8. Report the commit hash and verification results.

### Versioning

Versions are CalVer `vYYYY.M.D` (e.g. `v2026.7.31`); a second release on the same day appends `.1`, `.2`.

```bash
scripts/release.sh --dry-run   # preview what would be released, changes nothing
scripts/release.sh             # tag it, update CHANGELOG.md, push
```

`scripts/release.sh` derives the version, generates the changelog from conventional
commits since the previous tag, prepends it to `CHANGELOG.md`, commits, tags and pushes.
It refuses to run outside `base`, on a dirty tree, or when local `base` has diverged
from `origin/base`.

The release commit touches only `CHANGELOG.md`, and the CI push trigger has
`paths-ignore: '**/*.md'` — so releasing does not re-run the 17-minute test suite or
trigger a pointless redeploy.

`scripts/changelog.sh [from] [to]` can be used on its own to render any range.

