// Mirrored from server/src/types.ts
export type Role = 'guest' | 'resident' | 'admin';
export type HintType = 'practical' | 'lore' | 'joke';
export type Visibility = 'public' | 'residents' | 'private';

export interface User {
  id: number;
  telegram_id: number;
  nickname: string;
  avatar_url: string | null;
  role: Role;
  insight_points: number;
}

export interface Hint {
  id: number;
  marker_id: string;
  author_id: number;
  text: string;
  html: string | null;
  theme: string;
  type: HintType;
  visibility: Visibility;
  score: number;
}

export interface Spawn {
  id: number;
  marker_id: string;
  species_id: string;
  name: string;
  rarity: number;
  expires_at: string;
}

export interface Capture {
  species_id: string;
  name: string;
  rarity: number;
  count: number;
  latest: string;
}

export interface SessionInfo {
  token: string;
  user: User;
  onsite: boolean;
}
