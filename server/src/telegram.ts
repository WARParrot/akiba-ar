import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramLogin {
  id: number;
  first_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
  // Telegram may add fields; they all take part in the hash, so keep them.
  [key: string]: unknown;
}

const MAX_AUTH_AGE_S = 86400;

/**
 * Telegram Login Widget check: HMAC-SHA256 over the sorted "key=value\n" data string,
 * keyed by SHA256(bot_token). See core.telegram.org/widgets/login#checking-authorization.
 */
export function verifyLogin(data: TelegramLogin, botToken: string, nowS = Date.now() / 1000): boolean {
  const { hash, ...fields } = data as Record<string, unknown> & { hash: string };
  if (!hash || typeof data.auth_date !== 'number') return false;
  if (nowS - data.auth_date > MAX_AUTH_AGE_S || data.auth_date - nowS > 60) return false;

  const checkString = Object.keys(fields)
    .filter((k) => fields[k] !== undefined && fields[k] !== null)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');

  const secret = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest('hex');
  // Length-check first: timingSafeEqual throws on mismatched buffer sizes.
  return expected.length === hash.length && timingSafeEqual(Buffer.from(expected), Buffer.from(hash));
}

/** Residents are members of the residents channel; everyone else is a guest. */
export async function isChannelMember(telegramId: number): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.RESIDENTS_CHAT_ID;
  if (!token || !chat) return false;
  const url = `https://api.telegram.org/bot${token}/getChatMember?chat_id=${encodeURIComponent(chat)}&user_id=${telegramId}`;
  const res = await fetch(url);
  const body = (await res.json()) as { ok: boolean; result?: { status: string } };
  if (!body.ok || !body.result) return false;
  return ['creator', 'administrator', 'member'].includes(body.result.status);
}

/** Bot-API push for notification triggers (rare spawn, new hint in zone). */
export async function sendBotMessage(telegramId: number, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: telegramId, text }),
  });
}
