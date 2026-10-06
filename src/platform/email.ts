/**
 * Email adapter (ADR 0002). Resend is the only transactional email provider;
 * there is no SMS provider.
 *
 * No module imports the Resend SDK directly (platform R7) — swapping providers
 * must be one file.
 */
import { Resend } from 'resend';
import { config } from './config.js';
import { logger } from './logging/index.js';

export interface SendResult {
  messageId: string | null;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailTransport {
  send(msg: EmailMessage): Promise<SendResult>;
}

/** Dev default: print to the log instead of sending. */
class ConsoleTransport implements EmailTransport {
  async send(msg: EmailMessage): Promise<SendResult> {
    logger.info(
      { to: msg.to, subject: msg.subject, body: msg.text },
      'email (console transport)',
    );
    return { messageId: null };
  }
}

class ResendTransport implements EmailTransport {
  private client: Resend;
  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }
  async send(msg: EmailMessage): Promise<SendResult> {
    const res = await this.client.emails.send({
      from: config.RESEND_FROM,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
      ...(config.EMAIL_REPLY_TO ? { replyTo: config.EMAIL_REPLY_TO } : {}),
    });
    if (res.error) throw new Error(`Resend: ${res.error.message}`);
    return { messageId: res.data?.id ?? null };
  }
}

function build(): EmailTransport {
  if (config.EMAIL_TRANSPORT === 'resend') {
    if (!config.RESEND_API_KEY) {
      throw new Error('EMAIL_TRANSPORT=resend but RESEND_API_KEY is empty');
    }
    return new ResendTransport(config.RESEND_API_KEY);
  }
  return new ConsoleTransport();
}

/**
 * F20 — walk-in guests have addresses on a reserved `.invalid` domain. Mail
 * to one is dropped here, once, rather than at every call site.
 */
export function dropsGuestMail(inner: EmailTransport): EmailTransport {
  return {
    async send(msg: EmailMessage): Promise<SendResult> {
      if (/@guest\.pl4y\.invalid$/i.test(msg.to)) return { messageId: null };
      return inner.send(msg);
    },
  };
}

export const email: EmailTransport = dropsGuestMail(build());
export { ConsoleTransport, ResendTransport };
