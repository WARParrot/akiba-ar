import type { Hint, Spawn } from './types';

export interface MarkerResult {
  markerId: string;
  hints: Hint[];
  spawns: Spawn[];
}

export function addMarker(results: MarkerResult[], markerId: string): MarkerResult[] {
  return results.some((result) => result.markerId === markerId)
    ? results
    : [...results, { markerId, hints: [], spawns: [] }];
}

export function updateMarker(results: MarkerResult[], next: MarkerResult): MarkerResult[] {
  return results.map((result) => result.markerId === next.markerId ? next : result);
}