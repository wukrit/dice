export type DieKind = 4 | 6 | 8 | 10 | 12 | 20 | 100;
export interface Swipe { start: [number, number]; delta: [number, number]; duration_ms: number }
export interface DieGeometry { kind: DieKind; vertices: [number, number, number][]; faces: { indices: number[]; normal: [number, number, number]; value: number }[] }
export interface Frame { t: number; p: [number, number, number]; q: [number, number, number, number] }
export interface Track { kind: DieKind; value: number; frames: Frame[] }
export interface Simulation { duration_ms: number; tracks: Track[]; value: number }
export interface Roll { id: string; sequence: number; request_id: string; member_id: string; name: string; die: DieKind; value: number; created_at: string; duration_ms: number }
export interface RollRecording { roll: Roll; simulation: Simulation }
export interface Member { id: string; name: string }
export interface Session { room_id: string; member: Member; token: string }
export interface HistoryPage { rolls: Roll[]; has_more: boolean }
export type ServerEvent =
  | { type: 'welcome'; member: Member; members: Member[]; latest_sequence: number }
  | { type: 'presence'; members: Member[] }
  | { type: 'accepted'; request_id: string }
  | { type: 'roll'; roll: Roll; simulation: Simulation }
  | { type: 'error'; message: string; request_id?: string }
  | { type: 'pong' };
