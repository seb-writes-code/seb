import crypto from 'crypto';
import http from 'http';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { _initTestDatabase } from '../db.js';
import { NewMessage, RegisteredGroup } from '../types.js';
import { formatEvent, GitHubChannel, repoToJid } from './github.js';

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
// repoToJid
// -------------------------------------------------------------------

describe('repoToJid', () => {
  it('converts repo full name to JID', () => {
    expect(repoToJid('cmraible/seb')).toBe('gh:cmraible/seb');
  });
});

// -------------------------------------------------------------------
// GitHubChannel — Channel interface tests
// -------------------------------------------------------------------

describe('GitHubChannel', () => {
  const SECRET = 'test-secret-123';
  let channel: GitHubChannel;
  let port: number;
  let messages: NewMessage[];
  let metadataCalls: Array<{ jid: string; name?: string }>;

  beforeEach(async () => {
    _initTestDatabase();
    messages = [];
    metadataCalls = [];

    channel = new GitHubChannel({
      onMessage: (_chatJid, msg) => messages.push(msg),
      onChatMetadata: (chatJid, _ts, name) =>
        metadataCalls.push({ jid: chatJid, name }),
      registeredGroups: () => ({}),
      webhookSecret: SECRET,
      port: 0, // random available port
    });
    await channel.connect();

    const addr = (channel as any).server?.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await channel.disconnect();
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

  // Channel interface

  it('ownsJid matches gh: prefix', () => {
    expect(channel.ownsJid('gh:cmraible/seb')).toBe(true);
    expect(channel.ownsJid('tg:123')).toBe(false);
    expect(channel.ownsJid('12345@g.us')).toBe(false);
  });

  it('isConnected returns true after connect', () => {
    expect(channel.isConnected()).toBe(true);
  });

  it('isConnected returns false after disconnect', async () => {
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });

  it('has name "github"', () => {
    expect(channel.name).toBe('github');
  });

  // Webhook HTTP server

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

  it('accepts valid signed webhook and stores message', async () => {
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

    // Verify message was delivered via onMessage
    expect(messages).toHaveLength(1);
    expect(messages[0].chat_jid).toBe('gh:cmraible/seb');
    expect(messages[0].sender).toBe('github');
    expect(messages[0].content).toMatch(/^@\w+/); // trigger prefix
    expect(messages[0].content).toContain('Test issue');
  });

  it('stores chat metadata on relevant events', async () => {
    const body = JSON.stringify({
      action: 'assigned',
      sender: { login: 'cmraible' },
      issue: {
        number: 1,
        title: 'Test',
        assignee: { login: 'seb-writes-code' },
      },
      repository: { full_name: 'cmraible/seb' },
    });
    await post('/webhooks/github', body, {
      'X-Hub-Signature-256': sign(body),
      'X-GitHub-Event': 'issues',
      'X-GitHub-Delivery': 'test-4',
    });

    expect(metadataCalls).toHaveLength(1);
    expect(metadataCalls[0].jid).toBe('gh:cmraible/seb');
    expect(metadataCalls[0].name).toBe('cmraible/seb');
  });

  it('does not store message for filtered events', async () => {
    const body = JSON.stringify({
      action: 'created',
      sender: { login: 'cmraible' },
      repository: { full_name: 'cmraible/seb' },
    });
    const res = await post('/webhooks/github', body, {
      'X-Hub-Signature-256': sign(body),
      'X-GitHub-Event': 'star',
      'X-GitHub-Delivery': 'test-5',
    });
    expect(res.status).toBe(200);
    expect(messages).toHaveLength(0);
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
