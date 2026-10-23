import { useCallback, useEffect, useRef, useState } from 'react';
import { api, mergeRolls, randomUuid, storageGet, storageRemove, storageSet } from './api';
import type { DieKind, HistoryPage, Member, Roll, RollRecording, ServerEvent, Session, Swipe } from './types';

interface PendingRoll { request_id: string; die: DieKind; swipe: Swipe }
export function useRoom(session: Session, onRoll: (recording: RollRecording) => void, onExpired: () => void) {
  const [status, setStatus] = useState<'connecting' | 'live' | 'reconnecting' | 'offline' | 'full'>('connecting');
  const [members, setMembers] = useState<Member[]>([]);
  const [rolls, setRolls] = useState<Roll[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const pendingKey = `dice:pending:${session.room_id}`;
  const [pending, setPending] = useState<PendingRoll | null>(() => storageGet(pendingKey));
  const pendingRef = useRef(pending);
  const pendingSince = useRef(pending ? Date.now() : 0);
  const socketRef = useRef<WebSocket | null>(null);
  const latest = useRef(0);
  const initialized = useRef(false);
  const callbacks = useRef({ onRoll, onExpired });
  callbacks.current = { onRoll, onExpired };
  const reconnectRef = useRef<() => void>(() => {});
  const replayed = useRef(new Set<string>());

  const clearPending = useCallback(() => {
    pendingRef.current = null; setPending(null); storageRemove(pendingKey);
  }, [pendingKey]);

  useEffect(() => {
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let retry = 0;
    let activeSocket: WebSocket | null = null;
    let lastMessage = Date.now();
    const abort = new AbortController();
    const base = `/api/rooms/${session.room_id}`;

    async function sync() {
      if (!initialized.current) {
        const page = await api<HistoryPage>(`${base}/rolls`, { signal: abort.signal });
        if (stopped) return;
        setRolls(old => mergeRolls(old, page.rolls));
        setHasMore(page.has_more);
        latest.current = Math.max(latest.current, ...page.rolls.map(roll => roll.sequence), 0);
        initialized.current = true;
      } else {
        // Keep an independent cursor while retrieving the room's temporary history.
        let cursor = latest.current;
        let more = true;
        while (more && !stopped) {
          const page = await api<HistoryPage>(`${base}/rolls?since=${cursor}`, { signal: abort.signal });
          if (stopped) return;
          setRolls(old => mergeRolls(old, page.rolls));
          cursor = Math.max(cursor, ...page.rolls.map(roll => roll.sequence));
          latest.current = Math.max(latest.current, cursor);
          more = page.has_more && page.rolls.length > 0;
        }
      }
    }
    function sendPending(ws: WebSocket) {
      if (pendingRef.current && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'roll', ...pendingRef.current }));
        pendingSince.current = Date.now();
      }
    }
    function connect() {
      if (stopped) return;
      clearTimeout(reconnectTimer);
      if (!navigator.onLine) { setStatus('offline'); return; }
      if (activeSocket && activeSocket.readyState < WebSocket.CLOSING) return;
      setStatus(initialized.current ? 'reconnecting' : 'connecting');
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${location.host}${base}/ws`);
      activeSocket = ws; socketRef.current = ws;
      lastMessage = Date.now();
      // Buffer live events until history catch-up establishes a contiguous sequence watermark.
      let syncing = true;
      const buffered: Extract<ServerEvent, { type: 'roll' }>[] = [];
      function receiveRoll(event: Extract<ServerEvent, { type: 'roll' }>) {
        latest.current = Math.max(latest.current, event.roll.sequence);
        setRolls(old => mergeRolls(old, [event.roll]));
        if (event.roll.request_id === pendingRef.current?.request_id) clearPending();
        if (!replayed.current.has(event.roll.id)) {
          replayed.current.add(event.roll.id);
          if (replayed.current.size > 500) replayed.current.delete(replayed.current.values().next().value!);
          callbacks.current.onRoll(event);
        }
      }
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: session.token }));
      ws.onmessage = async message => {
        if (stopped || ws !== activeSocket) return;
        lastMessage = Date.now();
        let event: ServerEvent;
        try { event = JSON.parse(String(message.data)); } catch { setError('The server sent an unreadable message. Reconnecting…'); ws.close(); return; }
        if (event.type === 'welcome') {
          setMembers(event.members);
          try {
            await sync();
            if (stopped || ws !== activeSocket || ws.readyState !== WebSocket.OPEN) return;
            syncing = false;
            buffered.forEach(receiveRoll);
            retry = 0; setStatus('live'); setError('');
            sendPending(ws);
          } catch (cause) {
            if (!stopped) { setError(cause instanceof Error ? cause.message : 'Could not recover the room history.'); ws.close(); }
          }
        } else if (event.type === 'presence') setMembers(event.members);
        else if (event.type === 'roll') {
          if (syncing) buffered.push(event); else receiveRoll(event);
        } else if (event.type === 'error') {
          setError(event.message);
          if (event.request_id === pendingRef.current?.request_id) clearPending();
        } else if (event.type === 'accepted') pendingSince.current = Date.now();
      };
      ws.onclose = event => {
        if (stopped || ws !== activeSocket) return;
        activeSocket = null; socketRef.current = null;
        if (event.code === 4001) { callbacks.current.onExpired(); return; }
        if (event.code === 4002) { setStatus('full'); setError('This room has reached its 32-connection limit. Close another tab or try again later.'); return; }
        setStatus(navigator.onLine ? 'reconnecting' : 'offline');
        reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000) * (0.8 + Math.random() * 0.4));
      };
      ws.onerror = () => { /* onclose owns retry, preserving the pending request ID. */ };
    }
    function wake() {
      if (document.visibilityState === 'hidden') return;
      if (activeSocket?.readyState === WebSocket.OPEN && Date.now() - lastMessage > 35000) activeSocket.close();
      else connect();
    }
    const heartbeat = setInterval(() => {
      const ws = activeSocket;
      if (ws?.readyState === WebSocket.OPEN) {
        if (Date.now() - lastMessage > 60000 || (pendingRef.current && pendingSince.current > 0 && Date.now() - pendingSince.current > 20000)) ws.close();
        else ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 10000);
    reconnectRef.current = () => { if (activeSocket) activeSocket.close(); else connect(); };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    connect();
    return () => {
      stopped = true; abort.abort(); clearTimeout(reconnectTimer); clearInterval(heartbeat);
      window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake);
      activeSocket?.close(); socketRef.current = null;
    };
  }, [session.room_id, session.token, clearPending]);

  const roll = useCallback((die: DieKind, swipe: Swipe) => {
    if (pendingRef.current || socketRef.current?.readyState !== WebSocket.OPEN || status !== 'live') return;
    const request = { request_id: randomUuid(), die, swipe };
    pendingRef.current = request; pendingSince.current = Date.now(); setPending(request); storageSet(pendingKey, request); setError('');
    socketRef.current.send(JSON.stringify({ type: 'roll', ...request }));
  }, [pendingKey, status]);
  async function loadMore() {
    if (loadingMore || !rolls.length) return;
    setLoadingMore(true);
    try {
      const oldest = Math.min(...rolls.map(roll => roll.sequence));
      const page = await api<HistoryPage>(`/api/rooms/${session.room_id}/rolls?before=${oldest}`);
      setRolls(old => mergeRolls(old, page.rolls)); setHasMore(page.has_more);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load earlier rolls. Try again.'); }
    finally { setLoadingMore(false); }
  }
  return { status, members, rolls, hasMore, loadingMore, error, setError, pending, roll, loadMore, reconnect: () => reconnectRef.current() };
}
