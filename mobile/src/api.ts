import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Capture, Hint, SessionInfo, Spawn, User } from './types';

// ponytail: hardcoded URLs, config file if you deploy to real hardware
const LOCAL_API = 'http://127.0.0.1:3100';
const REMOTE_API = 'http://127.0.0.1:3100'; // same in dev; swap for prod cloud URL

let token = '';
let baseUrl = LOCAL_API;

// Runtime override (AsyncStorage 'apiBase'): lets one APK target any on-site box
// without a rebuild. Takes precedence over the hardcoded LOCAL_API.
export async function setApiBase(url: string) {
  const clean = url.trim().replace(/\/+$/, '');
  if (clean) {
    await AsyncStorage.setItem('apiBase', clean);
  } else {
    await AsyncStorage.removeItem('apiBase');
  }
  baseUrl = clean || LOCAL_API;
}

export async function init() {
  token = (await AsyncStorage.getItem('token')) ?? '';
  const override = await AsyncStorage.getItem('apiBase');
  baseUrl = override ?? ((await AsyncStorage.getItem('onsite')) === 'true' ? LOCAL_API : REMOTE_API);
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(baseUrl + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...opts.headers },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export async function login(tgData: Record<string, unknown>): Promise<SessionInfo> {
  const sess = await req<SessionInfo>('/auth/telegram', { method: 'POST', body: JSON.stringify(tgData) });
  token = sess.token;
  await AsyncStorage.setItem('token', token);
  await AsyncStorage.setItem('onsite', String(sess.onsite));
  baseUrl = sess.onsite ? LOCAL_API : REMOTE_API;
  return sess;
}

export async function loginWithToken(jwt: string): Promise<{ user: User; onsite: boolean }> {
  token = jwt;
  await AsyncStorage.setItem('token', token);
  const d = await me();
  await AsyncStorage.setItem('onsite', String(d.onsite));
  baseUrl = d.onsite ? LOCAL_API : REMOTE_API;
  return d;
}

export const me = () => req<{ user: User; onsite: boolean }>('/me');
export const markerHints = (markerId: string) => req<{ hints: Hint[] }>(`/markers/${markerId}/hints`);
export const feed = () => req<{ hints: (Hint & { zone: string })[] }>('/feed');
export const createHint = (markerId: string, data: Partial<Hint>) =>
  req<{ hint: Hint; sanitized?: boolean }>(`/markers/${markerId}/hints`, { method: 'POST', body: JSON.stringify(data) });
export const vote = (hintId: number, delta: 1 | -1) =>
  req<{ score: number }>(`/hints/${hintId}/vote`, { method: 'POST', body: JSON.stringify({ delta }) });
export const markerSpawns = (markerId: string) => req<{ spawns: Spawn[] }>(`/markers/${markerId}/spawns`);
export const catchSpawn = (spawnId: number) => req<{ species_id: string }>(`/spawns/${spawnId}/catch`, { method: 'POST' });
export const collection = () => req<{ collection: Capture[] }>('/collection');
export const leaderboard = () => req<{ leaderboard: { nickname: string; catches: number }[] }>('/leaderboard');
