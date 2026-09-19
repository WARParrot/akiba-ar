import express from 'express';
import type { Pool } from 'pg';
import { authenticate, onsite, requireOnsite, requireRole, sign, type AuthedRequest } from './auth.js';
import { sanitizeHintHtml } from './hintHtml.js';
import { createFixedWindowLimiter, rateLimit } from './rateLimit.js';
import { resolveVariant } from './creatures.js';
import type { SpeciesTemplate, SpeciesVariant } from './types.js';
import { isChannelMember, sendBotMessage, verifyLogin, type TelegramLogin } from './telegram.js';
import type { Hint, HintType, Role, User, Visibility } from './types.js';

const HINT_TYPES: HintType[] = ['practical', 'lore', 'joke'];

// Rate limits: per-user fixed-window counters on value-moving endpoints. Generous defaults, env-tunable.
// Reads/earning higher than spends; catches bounded tighter (flood + first-writer-wins already bounds races).
const SPEND_LIMIT = Number(process.env.RATE_LIMIT_SPEND ?? 30);
const VIEW_LIMIT = Number(process.env.RATE_LIMIT_VIEW ?? 120);
// #9: dedicated, tighter limit on POST /auth/telegram — pre-auth HMAC brute-force guard.
// Generous enough for real logins, far below the shared spend limit. IP-keyed (no claims yet).
const AUTH_LIMIT = Number(process.env.RATE_LIMIT_AUTH ?? 10);
const VISIBILITIES: Visibility[] = ['public', 'residents', 'private'];

export function createApp(db: Pool) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  const authLimit = createFixedWindowLimiter({ limit: AUTH_LIMIT, windowMs: 60_000 });
  const viewLimit = createFixedWindowLimiter({ limit: VIEW_LIMIT, windowMs: 60_000 });
  const spendLimit = createFixedWindowLimiter({ limit: SPEND_LIMIT, windowMs: 60_000 });
  const rlAuth = rateLimit(authLimit);
  const rlView = rateLimit(viewLimit);
  const rlSpend = rateLimit(spendLimit);

  app.get('/health', (_req, res) => res.json({ ok: true, onsite: onsite() }));

  // --- Scenario 1: Telegram onboarding & role assignment ---
  app.post('/auth/telegram', rlAuth, async (req, res) => {
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
  app.get('/markers/:id/hints', rlView, async (req: AuthedRequest, res) => {
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
  app.post('/markers/:id/hints', rlSpend, requireRole('resident', 'admin'), requireOnsite, async (req: AuthedRequest, res) => {
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

  app.post('/hints/:id/vote', rlSpend, async (req: AuthedRequest, res) => {
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

  app.post('/hints/:id/report', rlSpend, async (req, res) => {
    // Auto-moderation: at the threshold, hide the hint (visibility -> private) and reset the counter.
    // One atomic UPDATE with a scalar subquery: both SET clauses see the same computed new_reports.
    const { rows } = await db.query(
      `UPDATE hints
          SET reports = (SELECT CASE WHEN h.reports + 1 >= $2::int THEN 0 ELSE h.reports + 1 END FROM hints h WHERE h.id = $1),
              visibility = CASE WHEN (SELECT h.reports + 1 FROM hints h WHERE h.id = $1) >= $2::int THEN 'private' ELSE visibility END
        WHERE id = $1
        RETURNING reports`,
      [req.params.id, Number(process.env.REPORT_THRESHOLD ?? 5)],
    );
    res.status(rows[0] ? 202 : 404).end();
  });

  app.post('/hints/:id/reapprove', requireRole('admin'), async (req, res) => {
    const { rows } = await db.query(
      `UPDATE hints SET visibility = 'public', reports = 0 WHERE id = $1 RETURNING id`,
      [req.params.id],
    );
    if (!rows[0]) {
      res.status(404).end();
      return;
    }
    res.json({ hint: rows[0] });
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

  app.post('/spawns/:id/catch', rlSpend, requireOnsite, async (req: AuthedRequest, res) => {
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
    // Rare-species notification: fire-and-forget so Telegram latency never slows the response.
    const rarityThreshold = Number(process.env.RARE_SPAWN_MIN_RARITY ?? 4);
    const species = await db.query('SELECT name, rarity FROM creature_species WHERE id = $1', [species_id]);
    const sp = species.rows[0];
    if (sp && sp.rarity >= rarityThreshold) {
      const chat = process.env.RESIDENTS_CHAT_ID;
      if (chat && /^-?\d+$/.test(chat)) {
        sendBotMessage(Number(chat), `${sp.name} (rarity ${sp.rarity}) just spawned!`).catch(() => {});
      }
    }
    res.status(201).json({ spawn: rows[0] });
  });

  app.get('/admin/reported', requireRole('admin'), async (_req, res) => {
    const { rows } = await db.query(
      'SELECT id, marker_id, author_id, text, html, reports FROM hints WHERE reports > 0 ORDER BY reports DESC',
    );
    res.json({ hints: rows });
  });


  // --- Admin: creature species CRUD (#14) — species management without psql ---
  app.get('/admin/species', requireRole('admin'), async (_req, res) => {
    const { rows } = await db.query(
      'SELECT id, name, rarity, onsite_only FROM creature_species ORDER BY rarity DESC, id',
    );
    res.json({ species: rows });
  });

  app.post('/admin/species', requireRole('admin'), async (req, res) => {
    const { id, name, rarity, onsite_only } = req.body as {
      id?: string; name?: string; rarity?: number; onsite_only?: boolean;
    };
    if (!id || !name) {
      res.status(400).json({ error: 'id and name required' });
      return;
    }
    const rar = rarity ?? 1;
    if (!Number.isInteger(rar) || rar < 1 || rar > 5) {
      res.status(400).json({ error: 'rarity must be an integer 1-5' });
      return;
    }
    try {
      const { rows } = await db.query(
        `INSERT INTO creature_species (id, name, rarity, onsite_only)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, rarity, onsite_only`,
        [id, name, rar, onsite_only ?? false],
      );
      res.status(201).json({ species: rows[0] });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        res.status(409).json({ error: 'species id already exists' });
        return;
      }
      throw err;
    }
  });

  app.patch('/admin/species/:id', requireRole('admin'), async (req, res) => {
    const { name, rarity, onsite_only } = req.body as {
      name?: string; rarity?: number; onsite_only?: boolean;
    };
    if (rarity !== undefined && (!Number.isInteger(rarity) || rarity < 1 || rarity > 5)) {
      res.status(400).json({ error: 'rarity must be an integer 1-5' });
      return;
    }
    // species has no deactivated state (#14 says delete/deactivate): hard delete, cascades to spawns/captures.
    if ((req.body as { delete?: boolean }).delete) {
      const { rowCount } = await db.query('DELETE FROM creature_species WHERE id = $1', [req.params.id]);
      res.status(rowCount ? 204 : 404).end();
      return;
    }
    const { rows } = await db.query(
      `UPDATE creature_species SET
         name = COALESCE($2, name),
         rarity = COALESCE($3, rarity),
         onsite_only = COALESCE($4, onsite_only)
       WHERE id = $1
       RETURNING id, name, rarity, onsite_only`,
      [req.params.id, name ?? null, rarity ?? null, onsite_only ?? null],
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ species: rows[0] });
  });

  // --- Admin: species templates + variants (#16) — the data-driven layer ---
  app.get('/admin/templates', requireRole('admin'), async (_req, res) => {
    const { rows } = await db.query<SpeciesTemplate>(
      'SELECT id, name, rarity, onsite_only, config, active FROM species_templates ORDER BY id',
    );
    res.json({ templates: rows });
  });

  app.post('/admin/templates', requireRole('admin'), async (req, res) => {
    const { id, name, rarity, onsite_only, config } = req.body as Partial<SpeciesTemplate>;
    if (!id || !name) {
      res.status(400).json({ error: 'id and name required' });
      return;
    }
    const rar = rarity ?? 1;
    if (!Number.isInteger(rar) || rar < 1 || rar > 5) {
      res.status(400).json({ error: 'rarity must be an integer 1-5' });
      return;
    }
    try {
      const { rows } = await db.query<SpeciesTemplate>(
        `INSERT INTO species_templates (id, name, rarity, onsite_only, config)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING id, name, rarity, onsite_only, config, active`,
        [id, name, rar, onsite_only ?? false, JSON.stringify(config ?? {})],
      );
      res.status(201).json({ template: rows[0] });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        res.status(409).json({ error: 'template id already exists' });
        return;
      }
      throw err;
    }
  });

  app.patch('/admin/templates/:id', requireRole('admin'), async (req, res) => {
    const { name, rarity, onsite_only, config, active, delete: del } = req.body as Partial<SpeciesTemplate> & { delete?: boolean };
    if (rarity !== undefined && (!Number.isInteger(rarity) || rarity < 1 || rarity > 5)) {
      res.status(400).json({ error: 'rarity must be an integer 1-5' });
      return;
    }
    if (del) {
      const { rowCount } = await db.query('DELETE FROM species_templates WHERE id = $1', [req.params.id]);
      res.status(rowCount ? 204 : 404).end();
      return;
    }
    const { rows } = await db.query<SpeciesTemplate>(
      `UPDATE species_templates SET
         name = COALESCE($2, name),
         rarity = COALESCE($3, rarity),
         onsite_only = COALESCE($4, onsite_only),
         config = COALESCE($5::jsonb, config),
         active = COALESCE($6, active),
         updated_at = now()
       WHERE id = $1
       RETURNING id, name, rarity, onsite_only, config, active`,
      [req.params.id, name ?? null, rarity ?? null, onsite_only ?? null,
       config ? JSON.stringify(config) : null, active ?? null],
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ template: rows[0] });
  });

  app.get('/admin/templates/:id/variants', requireRole('admin'), async (req, res) => {
    const { rows } = await db.query<SpeciesVariant>(
      'SELECT id, template_id, name, overrides, active FROM species_variants WHERE template_id = $1 ORDER BY id',
      [req.params.id],
    );
    res.json({ variants: rows });
  });

  app.post('/admin/templates/:id/variants', requireRole('admin'), async (req, res) => {
    const { id, name, overrides } = req.body as { id?: string; name?: string; overrides?: Record<string, unknown> };
    if (!id || !name) {
      res.status(400).json({ error: 'id and name required' });
      return;
    }
    const tpl = await db.query('SELECT 1 FROM species_templates WHERE id = $1', [req.params.id]);
    if (!tpl.rowCount) {
      res.status(404).json({ error: 'unknown template' });
      return;
    }
    try {
      const { rows } = await db.query<SpeciesVariant>(
        `INSERT INTO species_variants (id, template_id, name, overrides)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id, template_id, name, overrides, active`,
        [id, req.params.id, name, JSON.stringify(overrides ?? {})],
      );
      res.status(201).json({ variant: rows[0] });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        res.status(409).json({ error: 'variant id already exists' });
        return;
      }
      throw err;
    }
  });

  // Spawning from a template resolves the variant config at write time: the spawn row
  // carries the resolved stats so catches never depend on later template edits.
  app.post('/admin/templates/:id/spawn', requireRole('admin'), async (req, res) => {
    const { variant_id, marker_id, ttl_minutes } = req.body as {
      variant_id?: string; marker_id?: string; ttl_minutes?: number;
    };
    if (!marker_id) {
      res.status(400).json({ error: 'marker_id required' });
      return;
    }
    const tpl = await db.query<SpeciesTemplate>(
      'SELECT id, name, rarity, onsite_only, config, active FROM species_templates WHERE id = $1',
      [req.params.id],
    );
    if (!tpl.rows[0]) {
      res.status(404).json({ error: 'unknown template' });
      return;
    }
    const template = tpl.rows[0];
    let config = template.config;
    let speciesId = template.id;
    if (variant_id) {
      const v = await db.query<SpeciesVariant>(
        'SELECT id, template_id, name, overrides, active FROM species_variants WHERE id = $1',
        [variant_id],
      );
      if (!v.rows[0]) {
        res.status(404).json({ error: 'unknown variant' });
        return;
      }
      if (v.rows[0].template_id !== template.id) {
        res.status(400).json({ error: 'variant belongs to another template' });
        return;
      }
      config = resolveVariant(template.config, v.rows[0].overrides);
      speciesId = v.rows[0].id;
    }
    if (!template.active) {
      res.status(400).json({ error: 'template is inactive' });
      return;
    }
    // Runtime species row (creature_species) is keyed by template-or-variant id and stores
    // the resolved config, so existing spawns/captures joins keep working unchanged.
    await db.query(
      `INSERT INTO creature_species (id, name, rarity, onsite_only)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, rarity = EXCLUDED.rarity, onsite_only = EXCLUDED.onsite_only`,
      [speciesId, template.name, template.rarity, template.onsite_only],
    );
    const { rows } = await db.query(
      `INSERT INTO spawns (marker_id, species_id, expires_at)
       VALUES ($1, $2, now() + make_interval(mins => $3::int)) RETURNING id, marker_id, species_id, expires_at`,
      [marker_id, speciesId, ttl_minutes ?? 30],
    );
    // Rare-species notification: same fire-and-forget policy as /admin/spawns.
    const rarityThreshold = Number(process.env.RARE_SPAWN_MIN_RARITY ?? 4);
    if (template.rarity >= rarityThreshold) {
      const chat = process.env.RESIDENTS_CHAT_ID;
      if (chat && /^-?\d+$/.test(chat)) {
        sendBotMessage(Number(chat), `${template.name} (rarity ${template.rarity}) just spawned!`).catch(() => {});
      }
    }
    res.status(201).json({ spawn: rows[0], resolved_config: config });
  });

  return app;
}
