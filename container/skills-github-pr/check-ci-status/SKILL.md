---
name: check-ci-status
description: Check CI status on the current PR. If checks are failing, investigate the failure, diagnose the root cause, and attempt a fix. Use when the user asks about CI, checks, or runs /check-ci-status.
---

# /check-ci-status — Check and Fix CI Failures

Check the CI status of the current PR and fix any failures.

## Step 1: Identify the PR

Read `CLAUDE.md` in the workspace to find the PR number and repository. Look for fields like:
- Issue/PR identifier
- Repository (e.g. `cmraible/seb`)

If you can't determine the PR, ask the user.

## Step 2: Check CI status

Use the GitHub MCP tools to get PR status and check runs:

```
mcp__github__get_pull_request  — to get PR details
mcp__github__list_pull_request_files — to see changed files
```

You can also fetch check run details via the GitHub API:

```bash
curl -s "https://api.github.com/repos/<owner>/<repo>/commits/<sha>/check-runs" \
  | jq '.check_runs[] | {name, status, conclusion}'
```

If all checks are passing, report success and stop.

## Step 3: Investigate failures

For failing checks, use the GitHub MCP tools or the API to get run logs:

```bash
curl -s "https://api.github.com/repos/<owner>/<repo>/actions/runs/<run-id>/jobs" \
  | jq '.jobs[] | select(.conclusion == "failure") | {name, steps: [.steps[] | select(.conclusion == "failure")]}'
```

Read the logs carefully. Common failures include:
- Lint/format errors
- Type errors
- Test failures
- Build failures

## Step 4: Fix the issue

1. Clone the repo via SSH and check out the PR branch
2. Make the fix
3. Commit and push

```bash
cd /tmp
git clone git@github.com:<owner>/<repo>.git ci-fix --depth=50
cd ci-fix
git fetch origin pull/<number>/head:pr-branch
git checkout pr-branch
# ... make fixes ...
git add <files>
git commit -m "fix: resolve CI failure"
git push origin pr-branch:<head-branch>
```

## Step 5: Report

Tell the user what failed and what you fixed. If you couldn't fix it automatically, explain the failure and suggest next steps.
