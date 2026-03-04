import crypto from 'crypto';
import http from 'http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { _initTestDatabase, storeMessage } from './db.js';
import { formatEvent, startWebhookServer } from './github-webhooks.js';

// -------------------------------------------------------------------
// formatEvent — pure function tests
// -------------------------------------------------------------------

describe('formatEvent', () => {
  it('ignores events from the bot itself', () => {
    const result = formatEvent({
      event: 'issues',
      action: 'assigned',
      payload: {
        sender: { login: 'seb-writes-code' },
        issue: {
          number: 1,
          title: 'Test',
          assignee: { login: 'seb-writes-code' },
        },
        repository: { full_name: 'cmraible/seb' },
      },
    });
    expect(result).toBeNull();
  });

  it('formats issue assignment', () => {
    const result = formatEvent({
      event: 'issues',
      action: 'assigned',
      payload: {
        sender: { login: 'cmraible' },
        issue: {
          number: 15,
          title: 'Add dark mode',
          assignee: { login: 'seb-writes-code' },
        },
        repository: { full_name: 'cmraible/seb' },
      },
    });
    expect(result).toContain('cmraible assigned you to issue cmraible/seb#15');
    expect(result).toContain('Add dark mode');
  });

  it('ignores issue assignment to someone else', () => {
    const result = formatEvent({
      event: 'issues',
      action: 'assigned',
      payload: {
        sender: { login: 'cmraible' },
        issue: {
          number: 15,
          title: 'Add dark mode',
          assignee: { login: 'other-user' },
        },
        repository: { full_name: 'cmraible/seb' },
      },
    });
    expect(result).toBeNull();
  });

  it('formats PR review request', () => {
    const result = formatEvent({
      event: 'pull_request',
      action: 'review_requested',
      payload: {
        sender: { login: 'cmraible' },
        pull_request: { number: 42, title: 'Fix bug' },
        requested_reviewer: { login: 'seb-writes-code' },
        repository: { full_name: 'cmraible/seb' },
      },
    });
    expect(result).toContain(
      'cmraible requested your review on PR cmraible/seb#42',
    );
    expect(result).toContain('Fix bug');
  });

  it('ignores PR review request for someone else', () => {
    const result = formatEvent({
      event: 'pull_request',
      action: 'review_requested',
      payload: {
        sender: { login: 'cmraible' },
        pull_request: { number: 42, title: 'Fix bug' },
        requested_reviewer: { login: 'other-user' },
        repository: { full_name: 'cmraible/seb' },
      },
    });
    expect(result).toBeNull();
  });

  it('formats issue comment on our issue', () => {
    const result = formatEvent({
      event: 'issue_comment',
      action: 'created',
      payload: {
        sender: { login: 'cmraible' },
        issue: {
          number: 10,
          title: 'Bug report',
          user: { login: 'seb-writes-code' },
          assignees: [],
        },
        comment: { id: 123, body: 'Looks good, can you fix it?' },
        repository: { full_name: 'cmraible/seb' },
      },
    });
    expect(result).toContain('cmraible commented on issue cmraible/seb#10');
    expect(result).toContain('Looks good, can you fix it?');
  });

  it('formats issue comment on issue assigned to us', () => {
    const result = formatEvent({
      event: 'issue_comment',
      action: 'created',
      payload: {
        sender: { login: 'cmraible' },
        issue: {
          number: 10,
          title: 'Bug report',
          user: { login: 'cmraible' },
          assignee: { login: 'seb-writes-code' },
          assignees: [{ login: 'seb-writes-code' }],
        },
        comment: { id: 123, body: 'Please look into this' },
        repository: { full_name: 'cmraible/seb' },
      },
    });
    expect(result).toContain('cmraible commented on issue cmraible/seb#10');
  });

  it('ignores comment on unrelated issue', () => {
    const result = formatEvent({
      event: 'issue_comment',
      action: 'created',
      payload: {
        sender: { login: 'cmraible' },
        issue: {
          number: 10,
          title: 'Bug report',
          user: { login: 'other-user' },
          assignees: [],
        },
        comment: { id: 123, body: 'Some comment' },
        repository: { full_name: 'cmraible/seb' },
      },
    });
    expect(result).toBeNull();
  });

  it('formats PR review (approved)', () => {
    const result = formatEvent({
      event: 'pull_request_review',
      action: 'submitted',
      payload: {
        sender: { login: 'cmraible' },
        pull_request: {
          number: 5,
          title: 'Add feature',
          user: { login: 'seb-writes-code' },
        },
        review: { id: 456, state: 'approved', body: 'Ship it!' },
        repository: { full_name: 'cmraible/seb' },
      },
    });
    expect(result).toContain('cmraible approved your PR cmraible/seb#5');
    expect(result).toContain('Ship it!');
  });

  it('formats PR review (changes requested)', () => {
    const result = formatEvent({
      event: 'pull_request_review',
      action: 'submitted',
      payload: {
        sender: { login: 'cmraible' },
        pull_request: {
          number: 5,
          title: 'Add feature',
          user: { login: 'seb-writes-code' },
        },
        review: { id: 456, state: 'changes_requested', body: 'Needs work' },
        repository: { full_name: 'cmraible/seb' },
      },
    });
    expect(result).toContain(
      'cmraible requested changes on your PR cmraible/seb#5',
    );
  });

  it("ignores PR review on someone else's PR", () => {
    const result = formatEvent({
      event: 'pull_request_review',
      action: 'submitted',
      payload: {
        sender: { login: 'cmraible' },
        pull_request: {
          number: 5,
          title: 'Add feature',
          user: { login: 'other-user' },
        },
        review: { id: 456, state: 'approved', body: '' },
        repository: { full_name: 'cmraible/seb' },
      },
    });
    expect(result).toBeNull();
  });

  it('formats diff comment on our PR', () => {
    const result = formatEvent({
      event: 'pull_request_review_comment',
      action: 'created',
      payload: {
        sender: { login: 'cmraible' },
        pull_request: {
          number: 7,
          title: 'Refactor',
          user: { login: 'seb-writes-code' },
        },
        comment: {
          body: 'This function is too long',
          html_url: 'https://github.com/cmraible/seb/pull/7#discussion_r123',
        },
        repository: { full_name: 'cmraible/seb' },
      },
    });
    expect(result).toContain(
      'cmraible commented on a diff in your PR cmraible/seb#7',
    );
    expect(result).toContain('This function is too long');
  });

  it('formats CI failure', () => {
    const result = formatEvent({
      event: 'check_suite',
      action: 'completed',
      payload: {
        sender: { login: 'github-actions[bot]' },
        check_suite: {
          conclusion: 'failure',
          head_branch: 'feat/github-webhooks',
          pull_requests: [
            {
              number: 6,
              head: {
                repo: { full_name: 'seb-writes-code/seb' },
                ref: 'feat/github-webhooks',
              },
            },
          ],
        },
        repository: { full_name: 'cmraible/seb' },
      },
    });
    expect(result).toContain('CI failure on PR cmraible/seb#6');
  });

  it('ignores CI success', () => {
    const result = formatEvent({
      event: 'check_suite',
      action: 'completed',
      payload: {
        sender: { login: 'github-actions[bot]' },
        check_suite: {
          conclusion: 'success',
          head_branch: 'main',
          pull_requests: [],
        },
        repository: { full_name: 'cmraible/seb' },
      },
    });
    expect(result).toBeNull();
  });

  it('ignores unhandled event types', () => {
    const result = formatEvent({
      event: 'star',
      action: 'created',
      payload: {
        sender: { login: 'cmraible' },
        repository: { full_name: 'cmraible/seb' },
      },
    });
    expect(result).toBeNull();
  });

  it('truncates long comment bodies', () => {
    const longBody = 'x'.repeat(1000);
    const result = formatEvent({
      event: 'issue_comment',
      action: 'created',
      payload: {
        sender: { login: 'cmraible' },
        issue: {
          number: 10,
          title: 'Bug',
          user: { login: 'seb-writes-code' },
          assignees: [],
        },
        comment: { id: 123, body: longBody },
        repository: { full_name: 'cmraible/seb' },
      },
    });
    expect(result!.length).toBeLessThan(longBody.length);
    expect(result).toContain('…');
  });
});

// -------------------------------------------------------------------
// HTTP server integration tests
// -------------------------------------------------------------------

describe('webhook HTTP server', () => {
  const SECRET = 'test-secret-123';
  const TARGET_JID = 'test@g.us';
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    _initTestDatabase();
    // Use port 0 to get a random available port
    server = startWebhookServer({
      secret: SECRET,
      port: 0,
      targetJid: TARGET_JID,
      triggerPrefix: '@Seb',
    });
    await new Promise<void>((resolve) => {
      server.once('listening', resolve);
    });
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  function sign(body: string): string {
    return `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
  }

  function post(
    path: string,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  it('rejects invalid signature', async () => {
    const body = JSON.stringify({ action: 'assigned' });
    const res = await post('/webhooks/github', body, {
      'X-Hub-Signature-256': 'sha256=invalid',
      'X-GitHub-Event': 'issues',
      'X-GitHub-Delivery': 'test-1',
    });
    expect(res.status).toBe(401);
  });

  it('rejects missing signature', async () => {
    const body = JSON.stringify({ action: 'assigned' });
    const res = await post('/webhooks/github', body, {
      'X-GitHub-Event': 'issues',
      'X-GitHub-Delivery': 'test-2',
    });
    expect(res.status).toBe(401);
  });

  it('accepts valid signed webhook and returns 200', async () => {
    const body = JSON.stringify({
      action: 'assigned',
      sender: { login: 'cmraible' },
      issue: {
        number: 1,
        title: 'Test issue',
        assignee: { login: 'seb-writes-code' },
      },
      repository: { full_name: 'cmraible/seb' },
    });
    const res = await post('/webhooks/github', body, {
      'X-Hub-Signature-256': sign(body),
      'X-GitHub-Event': 'issues',
      'X-GitHub-Delivery': 'test-3',
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true });
  });

  it('returns 404 for wrong path', async () => {
    const body = JSON.stringify({});
    const res = await post('/wrong-path', body, {
      'X-Hub-Signature-256': sign(body),
      'X-GitHub-Event': 'issues',
    });
    expect(res.status).toBe(404);
  });

  it('health check returns 200', async () => {
    const res = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/health',
            method: 'GET',
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () =>
              resolve({
                status: res.statusCode!,
                body: Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        req.on('error', reject);
        req.end();
      },
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });
});
