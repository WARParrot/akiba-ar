-- Akiba AR hackerspace: minimal schema for scenarios 1-4 (onboarding, hints, discovery, creatures).
CREATE TABLE IF NOT EXISTS users (
  id             BIGSERIAL PRIMARY KEY,
  telegram_id    BIGINT UNIQUE NOT NULL,
  nickname       TEXT NOT NULL,
  avatar_url     TEXT,
  role           TEXT NOT NULL CHECK (role IN ('guest', 'resident', 'admin')),
  insight_points INT NOT NULL DEFAULT 0,
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS zones (
  id    BIGSERIAL PRIMARY KEY,
  name  TEXT UNIQUE NOT NULL
);

-- A marker is a QR/image target sticker; markers live in a zone and anchor hints and spawns.
CREATE TABLE IF NOT EXISTS markers (
  id      TEXT PRIMARY KEY,
  zone_id BIGINT NOT NULL REFERENCES zones(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS hints (
  id          BIGSERIAL PRIMARY KEY,
  marker_id   TEXT NOT NULL REFERENCES markers(id) ON DELETE CASCADE,
  author_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  html        TEXT,                       -- already sanitised on write
  theme       TEXT NOT NULL DEFAULT 'dark',
  type        TEXT NOT NULL CHECK (type IN ('practical', 'lore', 'joke')),
  visibility  TEXT NOT NULL CHECK (visibility IN ('public', 'residents', 'private')),
  score       INT NOT NULL DEFAULT 0,
  reports     INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hints_marker_idx ON hints(marker_id);

CREATE TABLE IF NOT EXISTS hint_views (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hint_id BIGINT NOT NULL REFERENCES hints(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, hint_id)
);

CREATE TABLE IF NOT EXISTS creature_species (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  rarity    INT NOT NULL,             -- 1 common .. 5 legendary
  onsite_only BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS spawns (
  id         BIGSERIAL PRIMARY KEY,
  marker_id  TEXT NOT NULL REFERENCES markers(id) ON DELETE CASCADE,
  species_id TEXT NOT NULL REFERENCES creature_species(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  caught_by  BIGINT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS spawns_marker_idx ON spawns(marker_id) WHERE caught_by IS NULL;

CREATE TABLE IF NOT EXISTS captures (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  species_id TEXT NOT NULL REFERENCES creature_species(id) ON DELETE CASCADE,
  caught_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
