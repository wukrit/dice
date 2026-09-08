#!/usr/bin/env node
// Run from web/: node tests/transport.mjs
// Optional: BASE_URL=http://localhost:3210 node tests/transport.mjs
// Uses Node 24 fetch and Playwright's installed Chromium for real Origin headers.
// This is an API/transport suite: it never loads or interacts with the app UI.
// Creates uniquely named, isolated ephemeral rooms; never deletes other rooms.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { chromium } from '@playwright/test';

const BASE = new URL(process.env.BASE_URL || 'http://localhost:3210').origin;
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(BASE).hostname), 'Transport tests must target a loopback Dice Room server');
const TIMEOUT = 15_000;
const RUN = randomUUID().slice(0, 8);
const SWIPE = { start: [0, 0.65], delta: [0.15, -0.85], duration_ms: 250 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const peers = new Map();
const failures = [];
let passed = 0;
let browser;
let page;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
    return true;
  } catch (error) {
    failures.push({ name, message: error.message });
    console.error(`FAIL ${name}\n${error.message.slice(0, 1800)}`);
    return false;
  }
}

async function api(path, { method = 'GET', body, status = 200 } = {}) {
  // Deliberately no authorization or cookie headers: invitation links are public.
  const response = await fetch(`${BASE}${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: expected ${status}, got ${response.status}: ${text.slice(0, 350)}`);
  const data = JSON.parse(text);
  if (status >= 400) assert.equal(typeof data.error, 'string', `${path}: expected JSON error`);
  return data;
}

class Peer {
  constructor(label) {
    this.id = randomUUID();
    this.label = label;
    this.events = [];
    this.waiters = new Set();
    peers.set(this.id, this);
  }
  receive(event) {
    this.events.push(event);
    for (const waiter of [...this.waiters]) waiter();
  }
  get mark() { return this.events.length; }
  get messages() { return this.events.filter(e => e.kind === 'message').map(e => e.data); }
  wait(predicate, label, { after = 0, allowClose = false, requestId } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, event) => {
        clearTimeout(timer);
        this.waiters.delete(inspect);
        if (error) reject(error); else resolve(event);
      };
      const inspect = () => {
        for (const event of this.events.slice(after)) {
          if (predicate(event)) return finish(null, event);
          if (event.kind === 'socket_error' || (!allowClose && event.kind === 'close')) {
            return finish(new Error(`${this.label}: ${label}: ${JSON.stringify(event)}`));
          }
          if (requestId && event.kind === 'message' && event.data.type === 'error' && event.data.request_id === requestId) {
            return finish(new Error(`${this.label}: request ${requestId}: ${event.data.message}`));
          }
        }
      };
      this.waiters.add(inspect);
      timer = setTimeout(() => finish(new Error(`${this.label}: timed out after 15s waiting for ${label}; received ${JSON.stringify(this.messages.slice(-8).map(m => ({ type: m.type, message: m.message, request_id: m.request_id, sequence: m.roll?.sequence })))}`)), TIMEOUT);
      inspect();
    });
  }
  async message(predicate, label, options) {
    return (await this.wait(e => e.kind === 'message' && predicate(e.data), label, options)).data;
  }
  async connect(roomId, token) {
    const url = new URL(`/api/rooms/${roomId}/ws`, BASE);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    await page.evaluate(({ id, url, token }) => {
      const ws = new WebSocket(url);
      window.transportSockets.set(id, ws);
      const emit = event => { void window.transportEvent(id, event); };
      ws.addEventListener('open', () => {
        emit({ kind: 'open' });
        ws.send(JSON.stringify({ type: 'hello', token }));
      });
      ws.addEventListener('message', event => {
        try { emit({ kind: 'message', data: JSON.parse(event.data) }); }
        catch { emit({ kind: 'socket_error', message: 'Non-JSON websocket message' }); }
      });
      ws.addEventListener('error', () => emit({ kind: 'socket_error', message: 'WebSocket handshake or transport failed' }));
      ws.addEventListener('close', event => emit({ kind: 'close', code: event.code, reason: event.reason }));
    }, { id: this.id, url: url.href, token });
    await this.wait(e => e.kind === 'open', 'WebSocket open');
    return this;
  }
  async send(data) {
    await page.evaluate(({ id, data }) => {
      const ws = window.transportSockets.get(id);
      if (ws?.readyState !== WebSocket.OPEN) throw new Error('Socket is not open');
      ws.send(JSON.stringify(data));
    }, { id: this.id, data });
  }
  async close() {
    if (this.events.some(e => e.kind === 'close')) return;
    await page.evaluate(id => window.transportSockets.get(id)?.close(1000, 'Transport test disconnect'), this.id);
    await this.wait(e => e.kind === 'close', 'close', { allowClose: true });
  }
  async barrier() {
    const after = this.mark;
    await this.send({ type: 'ping' });
    await this.message(m => m.type === 'pong', 'pong barrier', { after });
  }
}

function memberIds(members) { return members.map(m => m.id).sort(); }
async function presence(peer, members, after = 0) {
  const expected = memberIds(members);
  const event = await peer.message(m => m.type === 'presence' && JSON.stringify(memberIds(m.members)) === JSON.stringify(expected), `presence ${expected.join(',')}`, { after });
  assert.deepEqual([...event.members].sort((a, b) => a.id.localeCompare(b.id)), [...members].sort((a, b) => a.id.localeCompare(b.id)));
}
async function connectMember(label, identity) {
  const peer = await new Peer(label).connect(identity.room_id, identity.token);
  const welcome = await peer.message(m => m.type === 'welcome', 'authenticated welcome');
  assert.deepEqual(welcome.member, identity.member);
  assert.ok(welcome.members.some(m => m.id === identity.member.id));
  return { peer, welcome };
}

function handshake(roomId, origin) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/api/rooms/${roomId}/ws`, BASE);
    const headers = {
      Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      ...(origin === undefined ? {} : { Origin: origin }),
    };
    const req = (url.protocol === 'https:' ? https : http).request(url, { headers });
    const timer = setTimeout(() => req.destroy(new Error('Handshake timed out after 15s')), TIMEOUT);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.on('upgrade', (response, socket) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ status: response.statusCode, body: '' });
    });
    req.on('response', response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', error => { clearTimeout(timer); reject(error); });
      response.on('end', () => { clearTimeout(timer); resolve({ status: response.statusCode, body }); });
    });
    req.end();
  });
}

function validateRoll(event, identity, requestId, sequence) {
  const { roll, simulation } = event;
  assert.match(roll.id, UUID);
  assert.equal(roll.request_id, requestId);
  assert.equal(roll.member_id, identity.member.id);
  assert.equal(roll.name, identity.member.name);
  assert.equal(roll.sequence, sequence);
  assert.equal(roll.die, 6);
  assert.ok(Number.isInteger(roll.value) && roll.value >= 1 && roll.value <= 6);
  assert.ok(Number.isFinite(Date.parse(roll.created_at)));
  assert.equal(simulation.value, roll.value);
  assert.equal(simulation.duration_ms, roll.duration_ms);
  assert.ok(simulation.duration_ms > 0);
  assert.equal(simulation.tracks.length, 1);
  for (const track of simulation.tracks) {
    assert.equal(track.kind, 6);
    assert.equal(track.value, roll.value);
    assert.ok(track.frames.length > 1, 'Expected recorded trajectory, not just a result');
    let previous = -1;
    for (const frame of track.frames) {
      assert.ok(Number.isInteger(frame.t) && frame.t > previous && frame.t <= simulation.duration_ms);
      assert.equal(frame.p.length, 3);
      assert.equal(frame.q.length, 4);
      assert.ok([...frame.p, ...frame.q].every(Number.isFinite));
      previous = frame.t;
    }
  }
}
async function throwDie(sender, receivers, identity, sequence) {
  const requestId = randomUUID();
  await sender.send({ type: 'roll', request_id: requestId, die: 6, swipe: SWIPE });
  await sender.message(m => m.type === 'accepted' && m.request_id === requestId, 'roll accepted', { requestId });
  const events = await Promise.all(receivers.map(peer => peer.message(m => m.type === 'roll' && m.roll.request_id === requestId, 'authoritative roll', { requestId })));
  validateRoll(events[0], identity, requestId, sequence);
  for (const event of events.slice(1)) assert.deepEqual(event, events[0], 'Members must receive exactly identical roll IDs, values and trajectories');
  return events[0];
}

async function run() {
  // One bounded probe: do not poll indefinitely or accidentally test another service.
  try {
    const response = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(3000) });
    const body = await response.text();
    if (response.status !== 200 || JSON.parse(body).status !== 'ok') throw new Error(`HTTP ${response.status}: ${body.slice(0, 400)}`);
  } catch (error) {
    console.error(`NOT READY: Dice Rust server at ${BASE}: ${error.message}\nStart the current Rust server, verify GET /healthz returns {"status":"ok"}, then rerun:\n  cd web && BASE_URL=${BASE} node tests/transport.mjs\nNo test rooms were created; no readiness polling was performed.`);
    process.exitCode = 2;
    return;
  }

  console.log(`Transport suite ${RUN} against ${BASE}`);
  browser = await chromium.launch({ headless: true, timeout: TIMEOUT });
  page = await browser.newPage();
  page.setDefaultTimeout(TIMEOUT);
  await page.goto(`${BASE}/healthz`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.exposeFunction('transportEvent', (id, event) => peers.get(id)?.receive(event));
  await page.evaluate(() => { window.transportSockets = new Map(); });

  await check('invalid room-create names return 400', async () => {
    for (const name of ['', '   ', 'a'.repeat(33), 'bad\nname']) {
      await api('/api/rooms', { method: 'POST', body: { name }, status: 400 });
    }
  });

  // Setup failures abort dependent checks instead of producing misleading cascades.
  const owner = await api('/api/rooms', { method: 'POST', body: { name: `  Owner ${RUN}  ` } });
  const roomPath = `/api/rooms/${owner.room_id}`;
  const bob = await api(`${roomPath}/join`, { method: 'POST', body: { name: `  Bob ${RUN}  ` } });
  const carol = await api(`${roomPath}/join`, { method: 'POST', body: { name: `Carol ${RUN}` } });
  const other = await api('/api/rooms', { method: 'POST', body: { name: `Other ${RUN}` } });
  console.log(`Isolated rooms: ${owner.room_id}, ${other.room_id} (retained; no cleanup of other rooms)`);

  await check('create trims names and joining two members creates distinct room-scoped identities', async () => {
    assert.equal(owner.member.name, `Owner ${RUN}`);
    assert.equal(bob.member.name, `Bob ${RUN}`);
    assert.equal(bob.room_id, owner.room_id);
    assert.equal(carol.room_id, owner.room_id);
    for (const identity of [owner, bob, carol, other]) {
      for (const value of [identity.room_id, identity.member.id, identity.token]) assert.match(value, UUID);
    }
    assert.equal(new Set([owner, bob, carol, other].map(i => i.token)).size, 4);
    assert.equal(new Set([owner, bob, carol, other].map(i => i.member.id)).size, 4);
    assert.notEqual(owner.room_id, other.room_id);
  });
  await check('invalid join names return 400', async () => {
    for (const name of ['', '   ', 'a'.repeat(33), 'bad\nname']) {
      await api(`${roomPath}/join`, { method: 'POST', body: { name }, status: 400 });
    }
  });
  await check('anonymous invitation-link metadata and empty history; unknown rooms return 404', async () => {
    const info = await api(roomPath);
    assert.equal(info.id, owner.room_id);
    assert.ok(Number.isFinite(Date.parse(info.created_at)));
    assert.deepEqual(await api(`${roomPath}/rolls`), { rolls: [], has_more: false });
    const missing = `/api/rooms/${randomUUID()}`;
    await api(missing, { status: 404 });
    await api(`${missing}/rolls`, { status: 404 });
    await api(`${missing}/join`, { method: 'POST', body: { name: 'Missing room' }, status: 404 });
  });
  await check('foreign Origin and missing Origin WebSocket upgrades return 403', async () => {
    for (const origin of ['https://foreign-origin.invalid', undefined]) {
      const response = await handshake(owner.room_id, origin);
      assert.equal(response.status, 403, `Origin ${origin}: expected 403, got ${response.status}`);
      assert.match(JSON.parse(response.body).error, /origin/i);
    }
  });
  await check('a valid member token cannot authenticate to a different room', async () => {
    const intruder = await new Peer('cross-room token').connect(other.room_id, owner.token);
    await intruder.message(m => m.type === 'error' && /session|rejoin/i.test(m.message), 'invalid room session');
    const closed = await intruder.wait(e => e.kind === 'close', 'invalid token close', { allowClose: true });
    assert.equal(closed.code, 4001);
    assert.ok(!intruder.messages.some(m => ['welcome', 'presence', 'roll'].includes(m.type)));
  });

  let a = (await connectMember('owner', owner)).peer;
  await presence(a, [owner.member]);
  const b = (await connectMember('bob', bob)).peer;
  const c = (await connectMember('carol', carol)).peer;
  const outsider = (await connectMember('other room', other)).peer;
  await check('hello authenticates and presence broadcasts the exact room membership', async () => {
    await Promise.all([a, b, c].map(peer => presence(peer, [owner.member, bob.member, carol.member])));
    await presence(outsider, [other.member]);
  });

  await check('invalid die and swipe ranges are rejected without saving or broadcasting rolls', async () => {
    const before = await api(`${roomPath}/rolls`);
    // Bob has not rolled, so validation cannot be masked by the 800ms cooldown.
    for (const [die, swipe, expected] of [
      [7, SWIPE, /supported die/i],
      [6, { ...SWIPE, start: [1.02, 0] }, /swipe/i],
      [6, { ...SWIPE, delta: [0, 3.01] }, /swipe/i],
      [6, { ...SWIPE, duration_ms: 59 }, /swipe/i],
      [6, { ...SWIPE, duration_ms: 1201 }, /swipe/i],
    ]) {
      const requestId = randomUUID();
      await b.send({ type: 'roll', request_id: requestId, die, swipe });
      const error = await b.message(m => m.type === 'error' && m.request_id === requestId, 'validation error');
      assert.match(error.message, expected);
      assert.deepEqual(await api(`${roomPath}/rolls`), before);
    }
    await Promise.all([a, b, c, outsider].map(peer => peer.barrier()));
    for (const peer of [a, b, c, outsider]) assert.ok(!peer.messages.some(m => m.type === 'roll'));
  });

  const first = await throwDie(a, [a, b, c], owner, 1);
  await check('a roll broadcasts identical ID, result and complete trajectory to all members', async () => {
    validateRoll(first, owner, first.roll.request_id, 1);
  });
  await check('anonymous history matches broadcast metadata exactly', async () => {
    assert.deepEqual(await api(`${roomPath}/rolls`), { rolls: [first.roll], has_more: false });
  });
  const saved = await api(`${roomPath}/rolls/${first.roll.id}`);
  await check('anonymous recording matches the exact broadcast, including every trajectory float', async () => {
    assert.deepEqual(saved, { roll: first.roll, simulation: first.simulation });
  });
  await check('another room cannot read this recording and has no roll history', async () => {
    await api(`/api/rooms/${other.room_id}/rolls/${first.roll.id}`, { status: 404 });
    await api(`${roomPath}/rolls/${randomUUID()}`, { status: 404 });
    assert.deepEqual(await api(`/api/rooms/${other.room_id}/rolls`), { rolls: [], has_more: false });
  });

  const departedAt = b.mark;
  await a.close();
  await check('disconnect removes presence; reconnect restores the same identity and latest sequence', async () => {
    await presence(b, [bob.member, carol.member], departedAt);
  });
  const reconnect = await connectMember('owner reconnected', owner);
  a = reconnect.peer;
  await check('reconnected hello preserves identity and includes saved latest_sequence', async () => {
    assert.equal(reconnect.welcome.latest_sequence, first.roll.sequence);
    await presence(a, [owner.member, bob.member, carol.member]);
  });
  await a.send({ type: 'roll', request_id: first.roll.request_id, die: first.roll.die, swipe: SWIPE });
  const replay = await a.message(m => m.type === 'roll' && m.roll.request_id === first.roll.request_id, 'idempotent retry replay', { requestId: first.roll.request_id });
  await check('retry after reconnect returns the same saved row and does not insert another roll', async () => {
    assert.deepEqual(replay.roll, first.roll);
    assert.deepEqual({ roll: replay.roll, simulation: replay.simulation }, saved);
    assert.deepEqual(await api(`${roomPath}/rolls`), { rolls: [first.roll], has_more: false });
    assert.deepEqual(await api(`${roomPath}/rolls/${first.roll.id}`), saved);
    await Promise.all([b, c].map(peer => peer.barrier()));
    for (const peer of [b, c]) assert.equal(peer.messages.filter(m => m.type === 'roll' && m.roll.id === first.roll.id).length, 1, 'Idempotent reply must not rebroadcast to other members');
  });
  await check('retry trajectory is also exactly equal to the original live broadcast', async () => {
    assert.deepEqual(replay, first);
  });

  // Each sender's first new request avoids sleeps and the per-socket roll cooldown.
  const second = await throwDie(b, [a, b, c], bob, 2);
  const third = await throwDie(c, [a, b, c], carol, 3);
  await check('since catch-up is ascending and exclusive; before history is descending and exclusive', async () => {
    const expectHistory = async (query, rolls) => assert.deepEqual(await api(`${roomPath}/rolls${query}`), { rolls, has_more: false });
    await expectHistory('', [third.roll, second.roll, first.roll]);
    await expectHistory('?since=0', [first.roll, second.roll, third.roll]);
    await expectHistory(`?since=${first.roll.sequence}`, [second.roll, third.roll]);
    await expectHistory(`?since=${second.roll.sequence}`, [third.roll]);
    await expectHistory(`?since=${third.roll.sequence}`, []);
    await expectHistory(`?before=${third.roll.sequence}`, [second.roll, first.roll]);
    await expectHistory(`?before=${second.roll.sequence}`, [first.roll]);
    await expectHistory(`?before=${first.roll.sequence}`, []);
    await api(`${roomPath}/rolls?before=3&since=1`, { status: 400 });
  });
  console.log('SKIP full 50-row page overflow in transport suite (covered by server unit tests); since/before cursor boundaries tested via API-created rolls.');
  await check('separate room remains isolated throughout joins, disconnects, retries and three rolls', async () => {
    await outsider.barrier();
    assert.ok(!outsider.messages.some(m => m.type === 'roll' || m.type === 'accepted'));
    for (const event of outsider.messages.filter(m => m.type === 'welcome' || m.type === 'presence')) {
      assert.deepEqual(event.members, [other.member]);
    }
    for (const peer of [a, b, c]) {
      for (const event of peer.messages.filter(m => m.type === 'welcome' || m.type === 'presence')) {
        assert.ok(!event.members.some(m => m.id === other.member.id));
      }
    }
    assert.deepEqual(await api(`/api/rooms/${other.room_id}/rolls?since=0`), { rolls: [], has_more: false });
  });
}

try {
  await run();
} catch (error) {
  failures.push({ name: 'suite prerequisite/transport failure', message: error.message });
  console.error(`FAIL suite prerequisite/transport failure\n${error.stack?.slice(0, 2000) || error.message}`);
} finally {
  if (browser) {
    await Promise.allSettled([...peers.values()].map(peer => peer.close()));
    await browser.close();
  }
  if (failures.length) {
    console.error(`\n${passed} passed, ${failures.length} failed. Reproduce with: cd web && BASE_URL=${BASE} node tests/transport.mjs`);
    for (const failure of failures) console.error(`- ${failure.name}`);
    process.exitCode = 1;
  } else if (process.exitCode !== 2) {
    console.log(`\n${passed} transport checks passed.`);
  }
}
