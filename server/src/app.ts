import express from 'express';
import type { Pool } from 'pg';
import { authenticate, onsite, requireOnsite, requireRole, sign, type AuthedRequest } from './auth.js';
import { sanitizeHintHtml } from './hintHtml.js';
import { isChannelMember, verifyLogin, type TelegramLogin } from './telegram.js';
import type { Hint, HintType, Role, User, Visibility } from './types.js';

const HINT_TYPES: HintType[] = ['practical', 'lore', 'joke'];
const VISIBILITIES: Visibility[] = ['public', 'residents', 'private'];

export function createApp(db: Pool) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, onsite: onsite() }));

  // --- Scenario 1: Telegram onboarding & role assignment ---
  app.post('/auth/telegram', async (req, res) => {
    const body = req.body as TelegramLogin;
    const botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
    if (!botToken || !verifyLogin(body, botToken)) {
      res.status(401).json({ error: 'bad telegram signature' });
      return;
    }
    const role: Role = (await isChannelMember(body.id)) ? 'resident' : 'guest';
    const nickname = body.username ?? body.first_name ?? `tg${body.id}`;
    // Existing admins keep their manually granted role.
    const { rows } = await db.query<User>(
      `INSERT INTO users (telegram_id, nickname, avatar_url, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (telegram_id) DO UPDATE SET
         nickname = EXCLUDED.nickname,
         avatar_url = EXCLUDED.avatar_url,
         role = CASE WHEN users.role = 'admin' THEN 'admin' ELSE EXCLUDED.role END
       RETURNING id, telegram_id, nickname, avatar_url, role, insight_points`,
      [body.id, nickname, body.photo_url ?? null, role],
    );
    const user = rows[0]!;
    res.json({ token: sign({ uid: user.id, role: user.role }), user, onsite: onsite() });
  });

  app.use(authenticate);

  app.get('/me', async (req: AuthedRequest, res) => {
    const { rows } = await db.query<User>(
      'SELECT id, telegram_id, nickname, avatar_url, role, insight_points FROM users WHERE id = $1',
      [req.claims!.uid],
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ user: rows[0], onsite: onsite() });
  });

  // --- Scenario 3: AR discovery. Visibility enforced in SQL, never client-side. ---
  app.get('/markers/:id/hints', async (req: AuthedRequest, res) => {
    const { uid, role } = req.claims!;
    const { rows } = await db.query<Hint>(
      `SELECT id, marker_id, author_id, text, html, theme, type, visibility, score
         FROM hints
        WHERE marker_id = $1
          AND (visibility = 'public'
               OR (visibility = 'residents' AND $3 IN ('resident', 'admin'))
               OR author_id = $2)
        ORDER BY score DESC, created_at DESC`,
      [req.params.id, uid, role],
    );
    // Insight Points: one per newly discovered hint.
    if (rows.length) {
      const ids = rows.map((h) => h.id);
      const ins = await db.query(
        `INSERT INTO hint_views (user_id, hint_id)
         SELECT $1, id FROM unnest($2::bigint[]) AS id
         ON CONFLICT DO NOTHING`,
        [uid, ids],
      );
      if (ins.rowCount) {
        await db.query('UPDATE users SET insight_points = insight_points + $2 WHERE id = $1', [uid, ins.rowCount]);
      }
    }
    res.json({ hints: rows });
  });

  // Non-AR lore/joke feed for guests.
  app.get('/feed', async (_req, res) => {
    const { rows } = await db.query(
      `SELECT h.id, h.marker_id, h.text, h.type, h.theme, h.score, z.name AS zone
         FROM hints h JOIN markers m ON m.id = h.marker_id JOIN zones z ON z.id = m.zone_id
        WHERE h.visibility = 'public' AND h.type IN ('lore', 'joke')
        ORDER BY h.score DESC, h.created_at DESC LIMIT 100`,
    );
    res.json({ hints: rows });
  });

  // --- Scenario 2: placing a hint. Resident+, onsite only. ---
  app.post('/markers/:id/hints', requireRole('resident', 'admin'), requireOnsite, async (req: AuthedRequest, res) => {
    const { text, html, type, visibility, theme } = req.body as Partial<Hint>;
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'text required' });
      return;
    }
    if (!HINT_TYPES.includes(type as HintType) || !VISIBILITIES.includes(visibility as Visibility)) {
      res.status(400).json({ error: 'bad type or visibility' });
      return;
    }
    let clean: string | null = null;
    let dropped = false;
    if (typeof html === 'string' && html.trim()) {
      try {
        ({ html: clean, dropped } = sanitizeHintHtml(html));
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
        return;
      }
    }
    const marker = await db.query('SELECT 1 FROM markers WHERE id = $1', [req.params.id]);
    if (!marker.rowCount) {
      res.status(404).json({ error: 'unknown marker' });
      return;
    }
    const { rows } = await db.query<Hint>(
      `INSERT INTO hints (marker_id, author_id, text, html, theme, type, visibility)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, marker_id, author_id, text, html, theme, type, visibility, score`,
      [req.params.id, req.claims!.uid, text.trim(), clean, theme ?? 'dark', type, visibility],
    );
    res.status(201).json({ hint: rows[0], sanitized: dropped });
  });

  app.patch('/hints/:id', async (req: AuthedRequest, res) => {
    const { uid, role } = req.claims!;
    const { text, html } = req.body as { text?: string; html?: string };
    let clean: string | null | undefined;
    if (typeof html === 'string') {
      try {
        clean = html.trim() ? sanitizeHintHtml(html).html : null;
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
        return;
      }
    }
    const { rows } = await db.query<Hint>(
      `UPDATE hints SET text = COALESCE($3, text),
                        html = CASE WHEN $4::boolean THEN $5 ELSE html END,
                        updated_at = now()
        WHERE id = $1 AND (author_id = $2 OR $6 = 'admin')
        RETURNING id, marker_id, author_id, text, html, theme, type, visibility, score`,
      [req.params.id, uid, text ?? null, clean !== undefined, clean ?? null, role],
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'not found or not yours' });
      return;
    }
    res.json({ hint: rows[0] });
  });

  app.delete('/hints/:id', async (req: AuthedRequest, res) => {
    const { rowCount } = await db.query(
      `DELETE FROM hints WHERE id = $1 AND (author_id = $2 OR $3 = 'admin')`,
      [req.params.id, req.claims!.uid, req.claims!.role],
    );
    res.status(rowCount ? 204 : 404).end();
  });

  app.post('/hints/:id/vote', async (req: AuthedRequest, res) => {
    const delta = (req.body as { delta?: number }).delta === -1 ? -1 : 1;
    const { rows } = await db.query('UPDATE hints SET score = score + $2 WHERE id = $1 RETURNING score', [
      req.params.id,
      delta,
    ]);
    if (!rows[0]) {
      res.status(404).end();
      return;
    }
    res.json({ score: rows[0].score });
  });

  app.post('/hints/:id/report', async (req, res) => {
    await db.query('UPDATE hints SET reports = reports + 1 WHERE id = $1', [req.params.id]);
    res.status(202).end();
  });

  // --- Scenario 4: creatures, onsite only ---
  app.get('/markers/:id/spawns', requireOnsite, async (req, res) => {
    const { rows } = await db.query(
      `SELECT s.id, s.marker_id, s.species_id, s.expires_at, c.name, c.rarity
         FROM spawns s JOIN creature_species c ON c.id = s.species_id
        WHERE s.marker_id = $1 AND s.caught_by IS NULL AND s.expires_at > now()`,
      [req.params.id],
    );
    res.json({ spawns: rows });
  });

  app.post('/spawns/:id/catch', requireOnsite, async (req: AuthedRequest, res) => {
    // Single UPDATE claims the spawn: first writer wins, no transaction needed.
    const { rows } = await db.query<{ species_id: string }>(
      `UPDATE spawns SET caught_by = $2
        WHERE id = $1 AND caught_by IS NULL AND expires_at > now()
        RETURNING species_id`,
      [req.params.id, req.claims!.uid],
    );
    if (!rows[0]) {
      res.status(409).json({ error: 'already caught or expired' });
      return;
    }
    await db.query('INSERT INTO captures (user_id, species_id) VALUES ($1, $2)', [req.claims!.uid, rows[0].species_id]);
    res.status(201).json({ species_id: rows[0].species_id });
  });

  // Pokedex works offsite (remote mode).
  app.get('/collection', async (req: AuthedRequest, res) => {
    const { rows } = await db.query(
      `SELECT c.species_id, s.name, s.rarity, count(*)::int AS count, max(c.caught_at) AS latest
         FROM captures c JOIN creature_species s ON s.id = c.species_id
        WHERE c.user_id = $1 GROUP BY c.species_id, s.name, s.rarity ORDER BY s.rarity DESC`,
      [req.claims!.uid],
    );
    res.json({ collection: rows });
  });

  app.get('/leaderboard', async (_req, res) => {
    const { rows } = await db.query(
      `SELECT u.nickname, count(c.id)::int AS catches
         FROM users u LEFT JOIN captures c ON c.user_id = u.id
        GROUP BY u.id, u.nickname ORDER BY catches DESC, u.nickname LIMIT 20`,
    );
    res.json({ leaderboard: rows });
  });

  // --- Admin: zones, markers, spawns ---
  app.post('/admin/zones', requireRole('admin'), async (req, res) => {
    const name = (req.body as { name?: string }).name?.trim();
    if (!name) {
      res.status(400).json({ error: 'name required' });
      return;
    }
    const { rows } = await db.query('INSERT INTO zones (name) VALUES ($1) RETURNING id, name', [name]);
    res.status(201).json({ zone: rows[0] });
  });

  app.post('/admin/markers', requireRole('admin'), async (req, res) => {
    const { id, zone_id } = req.body as { id?: string; zone_id?: number };
    if (!id || !zone_id) {
      res.status(400).json({ error: 'id and zone_id required' });
      return;
    }
    await db.query('INSERT INTO markers (id, zone_id) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET zone_id = $2', [
      id,
      zone_id,
    ]);
    res.status(201).json({ marker: { id, zone_id } });
  });

  app.post('/admin/spawns', requireRole('admin'), async (req, res) => {
    const { marker_id, species_id, ttl_minutes } = req.body as {
      marker_id?: string;
      species_id?: string;
      ttl_minutes?: number;
    };
    if (!marker_id || !species_id) {
      res.status(400).json({ error: 'marker_id and species_id required' });
      return;
    }
    const { rows } = await db.query(
      `INSERT INTO spawns (marker_id, species_id, expires_at)
       VALUES ($1, $2, now() + make_interval(mins => $3::int)) RETURNING id, marker_id, species_id, expires_at`,
      [marker_id, species_id, ttl_minutes ?? 30],
    );
    res.status(201).json({ spawn: rows[0] });
  });

  app.get('/admin/reported', requireRole('admin'), async (_req, res) => {
    const { rows } = await db.query(
      'SELECT id, marker_id, author_id, text, html, reports FROM hints WHERE reports > 0 ORDER BY reports DESC',
    );
    res.json({ hints: rows });
  });

  return app;
}
