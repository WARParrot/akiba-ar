import type { Capture, Spawn } from './types';

type CreatureAppearance = { color?: string; emoji?: string; sprite?: string };

export function creatureLabel(creature: Pick<Spawn | Capture, 'name'> & { variant_name?: string | null }): string {
  if (!creature.variant_name) return creature.name;
  return creature.variant_name.startsWith(creature.name) ? creature.variant_name : `${creature.name} — ${creature.variant_name}`;
}

export function creatureAppearance(creature: { appearance?: CreatureAppearance | null }): CreatureAppearance {
  return creature.appearance ?? {};
}
