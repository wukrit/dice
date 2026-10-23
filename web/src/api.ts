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
export function randomUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
