import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, Dices, History, LoaderCircle, Play, Radio, RotateCcw, Share2, Users, WifiOff, X } from 'lucide-react';
import { DiceTable } from './DiceTable';
import type { DiceTableHandle } from './DiceTable';
import { api, dieLabel, storageGet, storageRemove, storageSet } from './api';
import { useRoom } from './useRoom';
import type { DieGeometry, DieKind, RollRecording, Session, Swipe } from './types';

const DICE: DieKind[] = [4, 6, 8, 10, 12, 20, 100];
const roomMatch = /^\/r\/([a-f0-9-]{36})\/?$/i.exec(location.pathname);
const roomId = roomMatch?.[1] ?? null;

function randomSwipe(): Swipe {
  const angle = Math.random() * Math.PI * 2;
  const distance = 0.24 + Math.random() * 0.52;
  return {
    start: [-Math.cos(angle) * 0.25, -Math.sin(angle) * 0.25],
    delta: [Math.cos(angle) * distance, Math.sin(angle) * distance],
    duration_ms: Math.round(180 + Math.random() * 180),
  };
}

function Brand() { return <a href="/" className="brand" aria-label="Dice Room home"><Dices size={25} strokeWidth={1.7} /><span>Dice Room</span></a>; }
function Notice({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  return <div className="notice" role="alert"><span>{children}</span>{onClose && <button className="icon-button" onClick={onClose} aria-label="Dismiss message"><X size={18} /></button>}</div>;
}
function Join({ onJoin }: { onJoin: (session: Session) => void }) {
  const [name, setName] = useState(() => storageGet<string>('dice:name') || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [roomExists, setRoomExists] = useState(!roomId);
  useEffect(() => {
    if (roomId) api(`/api/rooms/${roomId}`).then(() => setRoomExists(true)).catch(cause => setError(cause.message));
  }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {
      const session = await api<Session>(roomId ? `/api/rooms/${roomId}/join` : '/api/rooms', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      storageSet('dice:name', name.trim()); storageSet(`dice:session:${session.room_id}`, session);
      if (roomId) onJoin(session); else location.assign(`/r/${session.room_id}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open the room. Please try again.'); }
    finally { setBusy(false); }
  }
  return <div className="join-page">
    <header className="site-header"><Brand /><span className="header-note">A table for your party.</span></header>
    <main className="join-layout">
      <section className="join-copy">
        <div className="join-die" aria-hidden="true"><svg viewBox="0 0 180 190"><path d="M90 8 164 53v84l-74 45-74-45V53Z M16 53l74-15 74 15-34 78-40 51-40-51Z M90 38l40 93H50Z M16 137l34-6M164 137l-34-6M90 8v30" /><text x="90" y="109" textAnchor="middle">20</text></svg></div>
        <h1>{roomId ? 'Your seat is ready.' : 'Good company.\nShared rolls.'}</h1>
        <p>{roomId ? 'Join the table, pick your die, and let it fly.' : 'One shared dice table for the whole party. Swipe to throw. See every roll. Replay the memorable ones.'}</p>
        <form onSubmit={submit} className="join-form">
          <label htmlFor="display-name">What should we call you?</label>
          <input id="display-name" autoComplete="nickname" autoCapitalize="words" maxLength={32} value={name} onChange={event => setName(event.target.value)} placeholder="Your display name" required disabled={busy} />
          <button className="button primary" type="submit" disabled={busy || !name.trim() || !roomExists}>{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowUpRight size={19} />}{busy ? 'Opening the table…' : roomId ? 'Join this room' : 'Create a room'}</button>
          {error && <Notice>{error}</Notice>}
        </form>
        <p className="quiet join-footnote">No account. No download. Rooms expire after 6 hours idle or a server restart.</p>
        {roomId && <a className="text-link" href="/">Or start a new room</a>}
      </section>
      <aside className="join-aside" aria-label="How it works"><div className="aside-dice" aria-hidden="true"><Dices strokeWidth={0.8} /></div><h2>The whole party.<br />The same throw.</h2><p>Share a private room link. Everyone sees the same dice motion and the same result—even when they replay it later.</p><div className="supported-dice">d4 · d6 · d8 · d10 · d12 · d20 · d100</div></aside>
    </main>
    <footer className="join-footer">Built for the table. Wherever you gather.</footer>
  </div>;
}

function Room({ session, onLeave }: { session: Session; onLeave: () => void }) {
  const [catalog, setCatalog] = useState<DieGeometry[]>([]);
  const [selected, setSelected] = useState<DieKind>(20);
  const [active, setActive] = useState<RollRecording | null>(null);
  const [playing, setPlaying] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [loadingReplay, setLoadingReplay] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const [shareFallback, setShareFallback] = useState(false);
  const [graphicsError, setGraphicsError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const table = useRef<DiceTableHandle>(null);
  const queue = useRef<RollRecording[]>([]);
  const latestLive = useRef<RollRecording | null>(null);
  const busy = useRef(false);
  const historyMode = useRef(false);
  const generation = useRef(0);
  const alive = useRef(true);
  const shareTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const drain = useRef<() => void>(() => {});
  drain.current = () => {
    if (busy.current || historyMode.current || !queue.current.length) return;
    if (!table.current) {
      if (graphicsError) {
        setActive(queue.current[queue.current.length - 1]!);
        queue.current = []; setQueueCount(0);
      }
      return;
    }
    const recording = queue.current.shift()!;
    setQueueCount(queue.current.length);
    busy.current = true; setPlaying(true); setActive(recording);
    const current = ++generation.current;
    void table.current.play(recording.simulation).then(() => {
      if (!alive.current || generation.current !== current) return;
      busy.current = false; setPlaying(false); drain.current();
    });
  };
  const onRoll = useCallback((recording: RollRecording) => {
    latestLive.current = recording;
    if (document.visibilityState === 'hidden') return;
    // Keep only the latest ten animations; all rolls remain in the room's temporary history.
    queue.current = [...queue.current, recording].slice(-10);
    setQueueCount(queue.current.length); drain.current();
  }, []);
  const room = useRoom(session, onRoll, onLeave);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    api<DieGeometry[]>('/api/dice', { signal: controller.signal }).then(setCatalog).catch(cause => { if (!controller.signal.aborted) setCatalogError(cause.message); });
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    media.addEventListener('change', update);
    return () => { alive.current = false; controller.abort(); media.removeEventListener('change', update); clearTimeout(shareTimer.current); };
  }, []);
  useEffect(() => { drain.current(); }, [catalog, graphicsError]);
  const throwDie = useCallback((swipe: Swipe) => {
    if (busy.current || historyMode.current || loadingReplay) return;
    room.roll(selected, swipe);
  }, [room.roll, selected, loadingReplay]);
  const canThrow = room.status === 'live' && !room.pending && !playing && !replaying && !loadingReplay && catalog.length > 0;
  async function share() {
    if (navigator.share) {
      try { await navigator.share({ title: 'Join my Dice Room', text: 'Pull up a seat at our dice table.', url: location.href }); return; }
      catch (cause) { if (cause instanceof DOMException && cause.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(location.href); setCopied(true);
      clearTimeout(shareTimer.current); shareTimer.current = setTimeout(() => setCopied(false), 2500);
    } catch { setShareFallback(true); }
  }
  async function replay(id: string) {
    if (room.pending) return;
    historyMode.current = true; setReplaying(true); setLoadingReplay(true);
    const current = ++generation.current;
    table.current?.cancel(); busy.current = false; setPlaying(false);
    try {
      const recording = await api<RollRecording>(`/api/rooms/${session.room_id}/rolls/${id}`);
      if (generation.current !== current || !alive.current) return;
      setActive(recording); setLoadingReplay(false); setPlaying(true); busy.current = true;
      document.querySelector('.table-panel')?.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'start' });
      await table.current?.play(recording.simulation);
      if (generation.current === current && alive.current) { busy.current = false; setPlaying(false); }
    } catch (cause) {
      if (generation.current === current && alive.current) {
        setLoadingReplay(false); room.setError(cause instanceof Error ? cause.message : 'Replay could not be loaded.');
      }
    }
  }
  function returnLive() {
    generation.current++; table.current?.cancel(); busy.current = false; historyMode.current = false;
    setPlaying(false); setLoadingReplay(false); setReplaying(false);
    if (queue.current.length) { drain.current(); return; }
    const latest = latestLive.current;
    setActive(latest);
    if (latest) {
      // Restore the final recorded pose, never a canceled historical mid-flight frame.
      void table.current?.play({ ...latest.simulation, duration_ms: 0, tracks: latest.simulation.tracks.map(track => ({ ...track, frames: [{ ...track.frames[track.frames.length - 1]!, t: 0 }] })) });
    } else table.current?.showPreview();
  }
  function chooseDie(die: DieKind) {
    setSelected(die); setActive(null);
    if (die === selected) table.current?.showPreview();
  }
  const connectionText = { live: 'Connected', connecting: 'Connecting…', reconnecting: 'Reconnecting…', offline: 'Offline', full: 'Room full' }[room.status];
  return <div className="room-page">
    <header className="site-header room-header"><Brand /><button className="button secondary share-button" onClick={share}>{copied ? <Check size={17} /> : <Share2 size={17} />}<span>{copied ? 'Link copied' : 'Invite party'}</span></button></header>
    <main className="room-main">
      <div className="room-context"><div className="room-title"><h1>The table</h1><span className="room-code">{session.room_id.slice(0, 8)}</span></div><div className={`connection ${room.status === 'live' ? 'connected' : ''}`} role="status">{room.status === 'live' ? <span className="status-dot" /> : <WifiOff size={14} />}{connectionText}{room.status !== 'live' && room.status !== 'connecting' && <button className="text-link" onClick={room.reconnect}>Retry</button>}</div></div>
      {shareFallback && <div className="share-fallback"><label htmlFor="room-link">Copy this invitation link</label><div><input id="room-link" value={location.href} readOnly onFocus={event => event.target.select()} /><button className="icon-button" onClick={() => setShareFallback(false)} aria-label="Close invitation link"><X size={18} /></button></div></div>}
      {room.error && <Notice onClose={() => room.setError('')}>{room.error}</Notice>}
      {catalogError && <Notice>Couldn't load the dice. <button className="text-link" onClick={() => location.reload()}>Reload to try again</button></Notice>}
      <div className="room-layout">
        <section className="table-panel" aria-label="Dice table">
          <div className="party-strip"><Users size={16} aria-hidden="true" /><span className="sr-only">Players connected:</span><div className="party-names">{room.members.length ? room.members.slice(0, 5).map(member => <span key={member.id} className={member.id === session.member.id ? 'player self' : 'player'}>{member.name}{member.id === session.member.id && <span className="you"> (you)</span>}</span>) : <span className="quiet">Joining as {session.member.name}</span>}{room.members.length > 5 && <span className="quiet">+{room.members.length - 5} more</span>}</div><span className="party-count">{room.members.length}/32</span></div>
          <div className="tray-wrap">
            {catalog.length > 0 && !graphicsError ? <DiceTable ref={table} catalog={catalog} selected={selected} disabled={!canThrow} onSwipe={throwDie} onError={setGraphicsError} reducedMotion={reducedMotion} /> : <div className="table-fallback">{graphicsError ? <><Dices size={48} /><h2>3D isn't available</h2><p>{graphicsError}</p><p>You can still roll with the button below and read every result.</p><button className="text-link" onClick={() => location.reload()}>Reload 3D view</button></> : <><LoaderCircle className="spin" size={28} /><p>Setting the table…</p></>}</div>}
            {!playing && !replaying && !room.pending && !active && <div className="swipe-hint" aria-hidden="true"><ArrowUpRight size={22} /><span>Swipe across the table to throw</span></div>}
            {replaying && <button className="return-live" onClick={returnLive}><Radio size={15} />Back to live{queueCount > 0 && ` (${queueCount})`}</button>}
          </div>
          <div className="roll-status" role="status" aria-live="polite" aria-atomic="true">
            {loadingReplay ? <><LoaderCircle className="spin" size={18} /><span>Loading the original throw…</span></> : room.pending ? <><LoaderCircle className="spin" size={18} /><span>{room.status === 'live' ? 'Preparing your throw…' : 'Reconnecting to confirm your roll…'}</span></> : active ? <><span className={`result-value ${playing ? 'result-moving' : ''}`}>{playing ? <Dices size={25} /> : active.roll.value}</span><div><strong>{active.roll.name}{active.roll.member_id === session.member.id ? ' (you)' : ''}</strong><span>{playing ? `Rolling ${dieLabel(active.roll.die)}…` : `rolled ${dieLabel(active.roll.die)}${active.roll.die === 100 ? ' · percentile dice' : ''}`}</span></div>{!playing && <button className="icon-button replay-again" aria-label="Replay this roll" onClick={() => replay(active.roll.id)}><RotateCcw size={18} /></button>}</> : <><Dices size={25} /><div><strong>{dieLabel(selected)} is ready</strong><span>{selected === 100 ? 'Tens + units · 00 and 0 count as 100' : 'Your next adventure starts with a roll.'}</span></div></>}
            {queueCount > 0 && !replaying && <span className="queue-count">{queueCount} waiting</span>}
          </div>
          <fieldset className="die-picker" disabled={playing || !!room.pending || replaying || loadingReplay}><legend>Choose your die</legend><div className="die-options">{DICE.map(die => <button key={die} type="button" aria-pressed={selected === die} className={`die-option ${selected === die ? 'selected' : ''}`} onClick={() => chooseDie(die)}>{dieLabel(die)}</button>)}</div></fieldset>
          <button className="button primary roll-button" disabled={!canThrow} onClick={() => throwDie(randomSwipe())}>{room.pending ? <LoaderCircle className="spin" size={20} /> : <Dices size={20} />}{replaying ? 'Return to live to roll' : `Roll ${dieLabel(selected)}`}<span className="roll-button-hint">or swipe the table</span></button>
          <p className="table-note">{reducedMotion ? 'Reduced motion is on. Rolls show their final position.' : 'Swipe direction and speed shape your throw.'}</p>
        </section>
        <aside className="history-panel" aria-label="Roll history"><div className="history-heading"><h2>Roll history</h2><History size={19} aria-hidden="true" /></div><p className="history-intro">Every roll belongs to the room. Tap one to replay.</p>
          {room.rolls.length === 0 ? <div className="empty-history"><div className="empty-rule" /><Dices size={30} strokeWidth={1.4} /><h3>{room.status === 'live' ? 'A fresh start.' : 'Finding your rolls…'}</h3><p>{room.status === 'live' ? 'The first roll is yours. Invite your party and give the dice a throw.' : 'Your room’s history will appear here when connected.'}</p></div> : <ol className="roll-list">{room.rolls.map(roll => <li key={roll.id}><button className={`history-row ${active?.roll.id === roll.id ? 'active-roll' : ''}`} onClick={() => replay(roll.id)} disabled={!!room.pending} aria-label={`Replay ${roll.name}'s ${dieLabel(roll.die)} roll of ${roll.value}, roll ${roll.sequence}`}><span className="history-result">{roll.value}</span><span className="history-detail"><strong>{roll.name}</strong><span>{dieLabel(roll.die)}<span className="history-dot">·</span><time dateTime={roll.created_at}>{new Date(roll.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></span></span><span className="history-sequence">#{roll.sequence}</span><Play size={15} className="history-play" aria-hidden="true" /></button></li>)}</ol>}
          {room.hasMore && <button className="button load-more" onClick={room.loadMore} disabled={room.loadingMore}>{room.loadingMore ? <LoaderCircle className="spin" size={16} /> : <ChevronDown size={16} />}{room.loadingMore ? 'Loading…' : 'Load earlier rolls'}</button>}
          <div className="history-footer"><span>Temporary room · expires after 6 hours idle or a server restart. Up to 1,000 rolls, within available memory.</span><button className="text-link" onClick={onLeave} disabled={!!room.pending}><ArrowLeft size={13} />Change name / leave seat</button></div>
        </aside>
      </div>
    </main>
  </div>;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(() => {
    const saved = roomId ? storageGet<Session>(`dice:session:${roomId}`) : null;
    return saved?.room_id === roomId && saved.token && saved.member?.name ? saved : null;
  });
  function leave() {
    if (session) { storageRemove(`dice:session:${session.room_id}`); storageRemove(`dice:pending:${session.room_id}`); }
    setSession(null);
  }
  return session ? <Room key={session.token} session={session} onLeave={leave} /> : <Join onJoin={setSession} />;
}
