// Variant resolution (#16): a resolved creature config = template config + variant overrides.
// Shallow merge per section (stats/skills/level_curve): an override replaces the whole
// section value for that key, so removal is an admin operation, not a merge artifact.
export interface CreatureConfig {
  stats?: Record<string, number>;
  skills?: Array<{ id: string; name: string; unlock_level: number }>;
  level_curve?: { base: number; growth: number };
  [key: string]: unknown;
}

export function resolveVariant(templateConfig: CreatureConfig, overrides: CreatureConfig): CreatureConfig {
  const resolved: CreatureConfig = { ...templateConfig };
  if (overrides.stats) {
    resolved.stats = { ...(templateConfig.stats ?? {}), ...overrides.stats };
  }
  if (overrides.skills) {
    resolved.skills = overrides.skills;
  }
  if (overrides.level_curve) {
    resolved.level_curve = overrides.level_curve;
  }
  // Any other top-level section merges key-by-key when both sides are plain objects.
  for (const key of Object.keys(overrides)) {
    if (key === 'stats' || key === 'skills' || key === 'level_curve') continue;
    const base = templateConfig[key];
    const over = overrides[key];
    if (base && over && typeof base === 'object' && typeof over === 'object' && !Array.isArray(base) && !Array.isArray(over)) {
      resolved[key] = { ...(base as Record<string, unknown>), ...(over as Record<string, unknown>) };
    } else {
      resolved[key] = over;
    }
  }
  return resolved;
}
