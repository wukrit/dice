import type { Roll } from './types';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${response.status}). Please try again.`);
  }
  return response.json() as Promise<T>;
}
export function storageGet<T>(key: string): T | null {
  try { return JSON.parse(localStorage.getItem(key) || 'null') as T | null; } catch { return null; }
}
export function storageSet(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Session still works without storage. */ }
}
export function storageRemove(key: string): void { try { localStorage.removeItem(key); } catch { /* optional persistence */ } }
export function mergeRolls(existing: Roll[], incoming: Roll[]): Roll[] {
  const entries = new Map(existing.map(roll => [roll.id, roll]));
  incoming.forEach(roll => entries.set(roll.id, roll));
  return [...entries.values()].sort((a, b) => b.sequence - a.sequence);
}
export function dieLabel(die: number): string { return die === 100 ? 'd100' : `d${die}`; }
