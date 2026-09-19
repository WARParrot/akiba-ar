-- Data-driven creature architecture (#16): species templates + variants, admin-editable.
-- Additive: creature_species (runtime spawn/capture table) is untouched. A template is the
-- admin-editable definition layer; species rows can reference a template for resolved config.
CREATE TABLE IF NOT EXISTS species_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  rarity      INT NOT NULL CHECK (rarity BETWEEN 1 AND 5),
  onsite_only BOOLEAN NOT NULL DEFAULT false,
  -- Stats/skills/level curve as JSONB: admin CRUD editable without a deploy.
  -- stats: {"power": 5, "speed": 3}; skills: [{"id":"zap","name":"Zap","unlock_level":2}];
  -- level_curve: {"base": 10, "growth": 1.5} (xp for level n = base * growth^(n-1))
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Variants: per-variant stat/skill overrides resolved against the template config.
-- overrides: {"stats": {"power": 7}, "skills": [{"id":"frost","name":"Frost","unlock_level":3}]}
CREATE TABLE IF NOT EXISTS species_variants (
  id           TEXT PRIMARY KEY,
  template_id  TEXT NOT NULL REFERENCES species_templates(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  overrides    JSONB NOT NULL DEFAULT '{}'::jsonb,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS species_variants_template_idx ON species_variants(template_id);

ALTER TABLE spawns ADD COLUMN IF NOT EXISTS variant_name TEXT;
ALTER TABLE spawns ADD COLUMN IF NOT EXISTS appearance JSONB;
ALTER TABLE captures ADD COLUMN IF NOT EXISTS variant_name TEXT;
ALTER TABLE captures ADD COLUMN IF NOT EXISTS appearance JSONB;
