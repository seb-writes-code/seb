/**
 * GitHub webhook server — receives GitHub App events and injects them
 * into the NanoClaw message pipeline.
 *
 * Uses Node's built-in http module (no Express). Events are verified
 * via HMAC-SHA256, filtered for relevance, and stored as NewMessage
 * objects for the existing message loop to pick up.
 */
import crypto from 'crypto';
import http from 'http';

import { storeMessage, storeChatMetadata } from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import type { NewMessage } from './types.js';

/** Read the webhook secret from .env at startup (not cached in process.env). */
export function readWebhookSecret(): string {
  const secrets = readEnvFile(['GITHUB_WEBHOOK_SECRET']);
  return (
    process.env.GITHUB_WEBHOOK_SECRET || secrets.GITHUB_WEBHOOK_SECRET || ''
  );
}

/** GitHub username that the agent operates as. */
const GITHUB_USERNAME = 'seb-writes-code';

export interface WebhookServerOpts {
  /** HMAC secret shared with the GitHub App. */
  secret: string;
  /** Port to listen on. */
  port: number;
  /** JID of the group to route messages to. */
  targetJid: string;
  /** Trigger prefix (e.g. "@Seb") to prepend so the message matches the trigger pattern. */
  triggerPrefix: string;
}

// -------------------------------------------------------------------
// Signature verification
// -------------------------------------------------------------------

function verifySignature(
  secret: string,
  payload: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signatureHeader),
    );
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------
// Event filtering & formatting
// -------------------------------------------------------------------

interface GitHubEvent {
  event: string;
  action: string;
  payload: Record<string, any>;
}

/**
 * Determine if a GitHub event is relevant and return a human-readable
 * summary. Returns null for events we should ignore.
 */
export function formatEvent(ev: GitHubEvent): string | null {
  const { event, action, payload } = ev;

  // Never react to our own actions
  if (payload.sender?.login === GITHUB_USERNAME) return null;

  const repo = payload.repository?.full_name ?? 'unknown';
  const sender = payload.sender?.login ?? 'unknown';

  switch (event) {
    case 'issues': {
      if (action !== 'assigned') return null;
      const issue = payload.issue;
      if (!issue) return null;
      // Only care if assigned to us
      if (issue.assignee?.login !== GITHUB_USERNAME) return null;
      return `${sender} assigned you to issue ${repo}#${issue.number}: "${issue.title}"\nhttps://github.com/${repo}/issues/${issue.number}`;
    }

    case 'pull_request': {
      if (action !== 'review_requested') return null;
      const pr = payload.pull_request;
      if (!pr) return null;
      // Only care if review requested from us
      const requested = payload.requested_reviewer?.login;
      if (requested !== GITHUB_USERNAME) return null;
      return `${sender} requested your review on PR ${repo}#${pr.number}: "${pr.title}"\nhttps://github.com/${repo}/pull/${pr.number}`;
    }

    case 'issue_comment': {
      if (action !== 'created') return null;
      const issue = payload.issue;
      const comment = payload.comment;
      if (!issue || !comment) return null;
      // Only care if on an issue/PR we authored or are assigned to
      const isOurs =
        issue.user?.login === GITHUB_USERNAME ||
        issue.assignee?.login === GITHUB_USERNAME ||
        (issue.assignees ?? []).some((a: any) => a.login === GITHUB_USERNAME);
      if (!isOurs) return null;
      const type = issue.pull_request ? 'PR' : 'issue';
      return `${sender} commented on ${type} ${repo}#${issue.number}: "${issue.title}"\n\n${truncate(comment.body, 500)}\n\nhttps://github.com/${repo}/issues/${issue.number}#issuecomment-${comment.id}`;
    }

    case 'pull_request_review': {
      if (action !== 'submitted') return null;
      const pr = payload.pull_request;
      const review = payload.review;
      if (!pr || !review) return null;
      if (pr.user?.login !== GITHUB_USERNAME) return null;
      const state = review.state; // approved, changes_requested, commented
      const stateLabel =
        state === 'approved'
          ? 'approved'
          : state === 'changes_requested'
            ? 'requested changes on'
            : 'commented on';
      const body = review.body ? `\n\n${truncate(review.body, 500)}` : '';
      return `${sender} ${stateLabel} your PR ${repo}#${pr.number}: "${pr.title}"${body}\nhttps://github.com/${repo}/pull/${pr.number}#pullrequestreview-${review.id}`;
    }

    case 'pull_request_review_comment': {
      if (action !== 'created') return null;
      const pr = payload.pull_request;
      const comment = payload.comment;
      if (!pr || !comment) return null;
      if (pr.user?.login !== GITHUB_USERNAME) return null;
      return `${sender} commented on a diff in your PR ${repo}#${pr.number}: "${pr.title}"\n\n${truncate(comment.body, 500)}\n\n${comment.html_url}`;
    }

    case 'check_suite': {
      if (action !== 'completed') return null;
      const suite = payload.check_suite;
      if (!suite) return null;
      // Only care about failures on our PRs
      if (suite.conclusion === 'success') return null;
      const prs = suite.pull_requests ?? [];
      const ourPr = prs.find(
        (p: any) => p.head?.repo?.full_name && p.head?.ref,
      );
      if (!ourPr) return null;
      return `CI ${suite.conclusion} on PR ${repo}#${ourPr.number} (${suite.head_branch})\nhttps://github.com/${repo}/pull/${ourPr.number}/checks`;
    }

    default:
      return null;
  }
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

// -------------------------------------------------------------------
// HTTP server
// -------------------------------------------------------------------

export function startWebhookServer(opts: WebhookServerOpts): http.Server {
  const { secret, port, targetJid, triggerPrefix } = opts;

  const server = http.createServer((req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Only accept POST to /webhooks/github
    if (req.method !== 'POST' || req.url !== '/webhooks/github') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);

      // Verify signature
      const signature = req.headers['x-hub-signature-256'] as
        | string
        | undefined;
      if (!verifySignature(secret, body, signature)) {
        logger.warn('GitHub webhook: invalid signature');
        res.writeHead(401);
        res.end('Invalid signature');
        return;
      }

      // Parse event
      const eventType = req.headers['x-github-event'] as string | undefined;
      const deliveryId = req.headers['x-github-delivery'] as string | undefined;
      if (!eventType) {
        res.writeHead(400);
        res.end('Missing X-GitHub-Event header');
        return;
      }

      let payload: Record<string, any>;
      try {
        payload = JSON.parse(body.toString('utf-8'));
      } catch {
        res.writeHead(400);
        res.end('Invalid JSON');
        return;
      }

      const action = (payload.action as string) ?? '';

      logger.info(
        { event: eventType, action, delivery: deliveryId },
        'GitHub webhook received',
      );

      // Format and filter
      const message = formatEvent({ event: eventType, action, payload });

      if (message) {
        // Ensure the chat exists in the chats table
        storeChatMetadata(
          targetJid,
          new Date().toISOString(),
          'GitHub',
          'github',
          false,
        );

        const msg: NewMessage = {
          id: `github-${deliveryId || Date.now()}`,
          chat_jid: targetJid,
          sender: 'github',
          sender_name: 'GitHub',
          content: `${triggerPrefix} ${message}`,
          timestamp: new Date().toISOString(),
          is_from_me: false,
          is_bot_message: false,
        };

        storeMessage(msg);
        logger.info(
          { event: eventType, action },
          'GitHub webhook stored as message',
        );
      }

      // Always ACK to GitHub quickly
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    });
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'GitHub webhook server listening');
  });

  return server;
}
