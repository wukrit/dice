# Dice Room

A mobile-first multiplayer D&D dice table. Enter a display name, create a room, share its link, and swipe to throw. No accounts, no database.

- **Rust / Axum / Tokio** server with native WebSockets.
- **Rapier 3D** authoritative rigid-body simulation, fixed 120 Hz timestep.
- **React / TypeScript / Three.js** browser rendering, designed for iPhone Safari and desktop.
- **Ephemeral in-memory rooms:** history and recordings live only for the current room session.
- **Railway-ready Docker image:** one Rust process serves the frontend and API. Node is build-time only.

## Run locally

Prerequisites: Rust 1.97+ and Node 24+. Docker is optional, for testing the production image.

```sh
cp .env.example .env
cd web && npm ci && npm run build && cd ..
cargo run
```

Open **http://localhost:3210**. No database, volume, or other services are needed.

For frontend hot reload, leave `cargo run` running and use another terminal:

```sh
cd web
npm run dev
```

Vite prints its URL and proxies `/api` (including WebSockets) to port 3210. Use one origin consistently to keep the same locally stored seat.

**Testing on a real iPhone:** serve through an HTTPS development tunnel or deploy to Railway. Mobile Safari requires a secure context for `crypto.randomUUID()`, sharing, and clipboard APIs. A phone cannot access your computer via `localhost`. Test actual touch interaction and background/foreground behavior on-device before a public launch.

## How to use it

1. Enter a name and create a room.
2. Use **Invite party** to open the native share sheet or copy the link.
3. Other players open the link and enter their names.
4. Select d4, d6, d8, d10, d12, d20, or d100. The default is d20.
5. Swipe **inside the felt tray**. Start position, direction, and duration affect the launch. The Roll button is a keyboard- and tap-accessible alternative.
6. Tap a history entry to replay the original throw. **Back to live** resumes queued live animations.

A percentile roll uses two colliding d10 bodies: tens (00–90) and units (0–9). Standalone d10 rolls display 1–10; percentile units display its 10 face as 0. `00 + 0 = 100`. The d4 is read at its upper vertex: its value is assigned to the opposite, downward face and repeated beside that vertex on the visible faces.

If WebGL is unavailable, the result log and Roll button still work. Reduced-motion preference displays the final physical pose without animation.

## Room lifetime

Rooms are intentionally disposable:

- All state lives in the Rust process. **A restart or redeploy clears every room.**
- Rooms expire after **six hours idle**. Connected players keep a room alive; the idle timer refreshes when the last connection leaves or the room is accessed.
- Cleanup runs every minute and before room lookup/creation.
- Expired links explain the situation and let players start a fresh room.
- Reconnection restores the seat and missed history only while the original room still exists.

Defaults in `src/server.rs` bound resource use:

| Limit | Default |
| --- | --- |
| Rooms per process | 256 |
| Simultaneous connections per room | 32 |
| Issued anonymous seats per room | 128 |
| Rolls per room | 1,000 |
| Serialized recording/event bytes per room | 32 MiB |
| Serialized recording/event bytes across all rooms | 128 MiB |
| Sockets per process | 512 |
| Concurrent/in-flight simulations | 4 |

The replay byte budgets count both HTTP and WebSocket serialized payloads, not the entire process's memory. Room metadata, buffers, renderer catalogs, runtime overhead, and transient copies use additional memory. At a roll/storage limit, new throws are explicitly rejected; existing history is **not silently evicted**. Expired rooms release their recording budget.

## Consistency and recovery

A swipe sends a unique request ID plus launch parameters, **not a desired result**. The server randomizes orientation and spin, simulates until the die settles on a readable face, and commits the recording to room memory before broadcasting. Cocked dice receive a small, recorded physical nudge; simulations that still cannot settle return an error rather than inventing a result.

Every client receives the same ordered roll event. Frames are sampled at approximately 30 Hz, then interpolated with quaternion slerp at the browser's refresh rate. Historical replays use the original position/quaternion samples, not a rerun from a seed. The render mesh and collision hull come from the same catalog. A canonical serialization preserves identical numerical values across live broadcasts, HTTP replay, and retries.

The table has side collisions and an invisible upper safety enclosure to prevent high-speed throws escaping. Visible rails are lower than that enclosure.

- The client stores an in-flight request ID before sending. Reconnection retries the same request.
- Per-room serialization and request-ID lookup prevent duplicate rolls during a room's lifetime.
- `accepted` means processing has started; the stored `roll` event is authoritative completion.
- Reconnect fetches missed history by sequence. Backgrounded phones catch up the log instead of replaying every missed animation.
- History is paginated in batches of 50. Live animation queues retain at most ten recent throws; all accepted completed rolls remain in history until the room expires.
- Socket queues, message sizes, room connections, and concurrent physics work are bounded.

Physics outcomes are server-controlled, but **this is not a statistically certified or cryptographically verifiable dice service**. There is no client-predictable seed. Swipe influence and collision dynamics have not been audited for distribution fairness.

## Deploy to Railway

### Set up deployment

Only **one application service** is needed. No database, persistent volume, or Redis.

1. Create or link the intended Railway project and application service.
2. Use the repository root as build context. `railway.toml` selects the multistage `Dockerfile`.
3. Generate a public domain and configure:

   | Variable | Value |
   | --- | --- |
   | `PUBLIC_ORIGIN` | Your `https://…up.railway.app` origin or custom domain, without trailing slash |
   | `TRUST_PROXY` | `true` only on Railway, to rate-limit by Railway's trusted `X-Real-IP` |
   | `RUST_LOG` | Optional; defaults to `dice_room=info,tower_http=info` |

4. Deploy from the linked project:

   ```sh
   railway up --ci
   ```

5. Verify **SUCCESS** and `/healthz`. Railway supplies TLS and `PORT`; the server binds `0.0.0.0:$PORT`.

Keep **one replica**. Rooms, presence, serialization, and fan-out all live in-process. Multiple replicas would split room state. A deploy intentionally starts fresh rooms; clients on the old deployment will see their old room expire when they reconnect to the new process. Horizontal scaling would require a shared ephemeral store and event bus; don't add those until needed.

No Railway resources are provisioned automatically by this repository.

To try the production container locally:

```sh
docker build -t dice-room .
docker run --rm -p 3210:3000 dice-room
```

Stop any local process using port 3210 first.

## Tests

With the application running on port 3210:

```sh
cargo test
cargo clippy --all-targets -- -D warnings
cargo test --release physics::tests::seeded_soak_test -- --ignored
cd web
npm test
npx playwright install chromium webkit
npm run test:e2e
node tests/transport.mjs
```

`BASE_URL` overrides the browser test URL. Transport tests require a loopback URL to avoid creating test rooms on someone else's server. All tests create isolated temporary rooms.

Browser coverage includes desktop Chromium and iPhone-sized WebKit: create/join, swipe, shared results, replay, percentile dice, reload, missed-event recovery, and expired room links. WebKit emulation is not a substitute for real-device Safari testing. Server unit tests cover geometry, settling, replay values, idle expiry, restart semantics, and cleanup accounting.

## Security and scope

- Random UUID room URLs act as bearer invitations. Anyone with the link can join and read its history. No identity verification, end-to-end encryption, moderation, or host ownership is claimed.
- Anonymous member tokens stay in local storage and are sent as the first WebSocket message, not in its URL. The server checks origins and scopes tokens to rooms.
- Names are plain text, limited to 32 characters. Requests and swipes are validated; clients cannot choose results.
- Creation/join/upgrade requests are limited to 60 per IP per minute. Roll commands have a per-socket cooldown.
- Defaults are suitable for a first single-process app, not a claim of internet-scale load testing. Add stronger abuse controls before unrestricted public promotion.

## Source map

```text
src/physics.rs          Hulls, collisions, face results, recorded motion
src/server.rs           HTTP/WebSocket API, in-memory rooms, expiry, limits
web/src/DiceTable.tsx   Numbered Three.js meshes and swipe/replay rendering
web/src/useRoom.ts      Reconnects, idempotent requests, history reconciliation
web/src/App.tsx         Create/join, controls, presence, history UI
web/tests/              Browser and transport integration tests
```
