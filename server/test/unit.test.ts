import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { sanitizeHintHtml } from '../src/hintHtml.js';
import { verifyLogin, type TelegramLogin } from '../src/telegram.js';

const BOT = '123456:test-bot-token';

// Not Omit<TelegramLogin,'hash'>: the interface's index signature makes Omit drop the required keys.
function signedLogin(fields: { id: number; auth_date: number; first_name?: string; username?: string }): TelegramLogin {
  const checkString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${(fields as Record<string, unknown>)[k]}`)
    .join('\n');
  const secret = createHash('sha256').update(BOT).digest();
  return { ...fields, hash: createHmac('sha256', secret).update(checkString).digest('hex') };
}

test('telegram login: valid signature accepted', () => {
  const now = 1_800_000_000;
  const login = signedLogin({ id: 42, first_name: 'Ivan', username: 'ivan', auth_date: now });
  assert.equal(verifyLogin(login, BOT, now), true);
});

test('telegram login: tampered id rejected', () => {
  const now = 1_800_000_000;
  const login = signedLogin({ id: 42, first_name: 'Ivan', auth_date: now });
  assert.equal(verifyLogin({ ...login, id: 43 }, BOT, now), false);
});

test('telegram login: wrong bot token rejected', () => {
  const now = 1_800_000_000;
  const login = signedLogin({ id: 42, auth_date: now });
  assert.equal(verifyLogin(login, 'other-token', now), false);
});

test('telegram login: stale auth_date rejected', () => {
  const then = 1_800_000_000;
  const login = signedLogin({ id: 42, auth_date: then });
  assert.equal(verifyLogin(login, BOT, then + 86_401), false);
});

test('telegram login: short/garbage hash does not throw', () => {
  assert.equal(verifyLogin({ id: 1, auth_date: 1_800_000_000, hash: 'ab' }, BOT, 1_800_000_000), false);
});

test('hint html: scripts and event handlers stripped', () => {
  const { html, dropped } = sanitizeHintHtml(
    '<div style="color:#0ff">hi</div><script>fetch("//evil")</script><img src="x" onerror="alert(1)">',
  );
  assert.equal(dropped, true);
  assert.ok(!/script/i.test(html), html);
  assert.ok(!/onerror/i.test(html), html);
  assert.match(html, /color:#0ff/);
});

test('hint html: javascript: href stripped, https kept', () => {
  const bad = sanitizeHintHtml('<a href="javascript:alert(1)">x</a>').html;
  assert.ok(!/javascript/i.test(bad), bad);
  const good = sanitizeHintHtml('<a href="https://akiba.example/wiki">wiki</a>').html;
  assert.match(good, /https:\/\/akiba\.example\/wiki/);
  assert.match(good, /rel="noreferrer"/);
});

test('hint html: css url() and unlisted properties dropped, animation kept', () => {
  const { html } = sanitizeHintHtml(
    '<div style="background-image:url(//evil/x.png);position:fixed;animation:pulse 2s infinite">neon</div>',
  );
  assert.ok(!/url\(/i.test(html), html);
  assert.ok(!/position/i.test(html), html);
  assert.match(html, /animation:pulse 2s infinite/);
});

test('hint html: oversized payload rejected', () => {
  assert.throws(() => sanitizeHintHtml('<p>' + 'a'.repeat(40_000) + '</p>'), /exceeds/);
});
