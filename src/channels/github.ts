/**
 * GitHub channel — receives webhook events from a GitHub App and
 * injects them into the NanoClaw message pipeline.
 *
 * JID format: gh:{owner}/{repo}  (e.g. gh:cmraible/seb)
 *
 * Implements the Channel interface so it integrates with the existing
 * multi-channel routing, message loop, and group registration.
 */
import crypto from 'crypto';
import express from 'express';
import http from 'http';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/** Read the webhook secret from .env at startup (not cached in process.env). */
export function readWebhookSecret(): string {
  const secrets = readEnvFile(['GITHUB_WEBHOOK_SECRET']);
  return (
    process.env.GITHUB_WEBHOOK_SECRET || secrets.GITHUB_WEBHOOK_SECRET || ''
  );
}

/** GitHub username that the agent operates as. */
const GITHUB_USERNAME = 'seb-writes-code';

export interface GitHubChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** HMAC secret shared with the GitHub App. */
  webhookSecret: string;
  /** Port to listen on. */
  port: number;
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
      if (issue.assignee?.login !== GITHUB_USERNAME) return null;
      return `${sender} assigned you to issue ${repo}#${issue.number}: "${issue.title}"\nhttps://github.com/${repo}/issues/${issue.number}`;
    }

    case 'pull_request': {
      if (action !== 'review_requested') return null;
      const pr = payload.pull_request;
      if (!pr) return null;
      const requested = payload.requested_reviewer?.login;
      if (requested !== GITHUB_USERNAME) return null;
      return `${sender} requested your review on PR ${repo}#${pr.number}: "${pr.title}"\nhttps://github.com/${repo}/pull/${pr.number}`;
    }

    case 'issue_comment': {
      if (action !== 'created') return null;
      const issue = payload.issue;
      const comment = payload.comment;
      if (!issue || !comment) return null;
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
      const state = review.state;
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

/** Convert a repo full_name (e.g. "cmraible/seb") to a channel JID. */
export function repoToJid(repoFullName: string): string {
  return `gh:${repoFullName}`;
}

// -------------------------------------------------------------------
// Channel implementation
// -------------------------------------------------------------------

export class GitHubChannel implements Channel {
  name = 'github';

  private opts: GitHubChannelOpts;
  private server: http.Server | null = null;
  private connected = false;

  constructor(opts: GitHubChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const { webhookSecret, port } = this.opts;

    const app = express();

    // Parse raw body for signature verification, then JSON
    app.use('/webhooks/github', express.raw({ type: 'application/json' }));

    app.get('/health', (_req, res) => {
      res.json({ status: 'ok' });
    });

    app.post('/webhooks/github', (req, res) => {
      const body = req.body as Buffer;

      // Verify signature
      const signature = req.headers['x-hub-signature-256'] as
        | string
        | undefined;
      if (!verifySignature(webhookSecret, body, signature)) {
        logger.warn('GitHub webhook: invalid signature');
        res.status(401).send('Invalid signature');
        return;
      }

      // Parse event
      const eventType = req.headers['x-github-event'] as string | undefined;
      const deliveryId = req.headers['x-github-delivery'] as string | undefined;
      if (!eventType) {
        res.status(400).send('Missing X-GitHub-Event header');
        return;
      }

      let payload: Record<string, any>;
      try {
        payload = JSON.parse(body.toString('utf-8'));
      } catch {
        res.status(400).send('Invalid JSON');
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
        const repoFullName = payload.repository?.full_name ?? 'unknown/unknown';
        const chatJid = repoToJid(repoFullName);

        // Store chat metadata for discovery
        this.opts.onChatMetadata(
          chatJid,
          new Date().toISOString(),
          repoFullName,
          'github',
          false,
        );

        // Prepend trigger prefix so the message loop picks it up
        const content = `@${ASSISTANT_NAME} ${message}`;

        this.opts.onMessage(chatJid, {
          id: `github-${deliveryId || Date.now()}`,
          chat_jid: chatJid,
          sender: 'github',
          sender_name: 'GitHub',
          content,
          timestamp: new Date().toISOString(),
          is_from_me: false,
          is_bot_message: false,
        });

        logger.info(
          { event: eventType, action, chatJid },
          'GitHub webhook stored as message',
        );
      }

      // Always ACK quickly
      res.json({ received: true });
    });

    // Start listening
    await new Promise<void>((resolve) => {
      this.server = app.listen(port, '0.0.0.0', () => {
        this.connected = true;
        logger.info({ port }, 'GitHub webhook server listening');
        console.log(
          `\n  GitHub webhook server: http://0.0.0.0:${port}/webhooks/github\n`,
        );
        resolve();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // GitHub channel currently receives only — outbound replies go
    // through whichever channel the user is chatting on (WhatsApp/Telegram).
    // Future: post comments on issues/PRs via gh CLI.
    logger.debug(
      { jid, length: text.length },
      'GitHubChannel.sendMessage called (no-op for now)',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gh:');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
      this.connected = false;
      logger.info('GitHub webhook server stopped');
    }
  }
}
