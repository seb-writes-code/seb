---
name: respond-to-pr-comment
description: Find and address unresolved PR review comments. Clone the repo, make the requested changes, push, and reply to each comment thread. Use when the user asks to address review feedback or runs /respond-to-pr-comment.
---

# /respond-to-pr-comment — Address PR Review Comments

Find unresolved review comments on the current PR and address them.

## Step 1: Identify the PR

Read `CLAUDE.md` in the workspace to find the PR number and repository.

## Step 2: Fetch review comments

Use the GitHub MCP tools:

```
mcp__github__get_pull_request — get PR details
mcp__github__list_pull_request_reviews — get reviews
mcp__github__list_review_comments — get review comments
```

Filter for unresolved/pending comments. Group comments by thread.

## Step 3: Clone and check out the PR branch

```bash
cd /tmp
git clone git@github.com:<owner>/<repo>.git pr-review --depth=50
cd pr-review
git fetch origin pull/<number>/head:pr-branch
git checkout pr-branch
```

## Step 4: Address each comment

For each unresolved comment thread:

1. Read the comment and understand the request
2. Find the relevant file and line
3. Make the requested change
4. Stage the change

Keep changes minimal and focused on what the reviewer asked for.

## Step 5: Commit and push

```bash
git add <files>
git commit -m "address review feedback"
git push origin pr-branch:<head-branch>
```

## Step 6: Reply to comments

For each addressed comment, reply confirming the fix using the GitHub MCP tools:

```
mcp__github__create_review_comment_reply — reply to a review comment
```

Or via the API:

```bash
curl -s -X POST "https://api.github.com/repos/<owner>/<repo>/pulls/<number>/comments/<comment-id>/replies" \
  -H "Content-Type: application/json" \
  -d '{"body": "Done — fixed in the latest push."}'
```

## Step 7: Report

Summarize what you changed and which comments you addressed.
