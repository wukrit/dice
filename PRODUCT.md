# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Confirmed: Rust server, Three.js rendering, WebSockets for live room traffic, HTTP for history and replay retrieval, Railway hosting. React/TypeScript in the browser; Axum/Tokio and Rapier on the server. Rooms and recordings are ephemeral, in-process memory. No database or durable storage is required.

## Users

Dungeons and Dragons players sharing a session. Primary devices are modern iPhones using Safari; desktop browsers are also supported.

## Product Purpose

Let players join a shared room by link, choose a die, and throw it with one swipe. Everyone can see who rolled, which die was used, its result, and the same animated throw, live or from history.

## Operating Context

No user accounts. A player provides a display name and creates a room or joins through its link. The room link grants access; names are not verified identities. Mobile browsers may disconnect when backgrounded or when networks change. A group typically creates a fresh room each play session; rooms may disappear and need not survive restarts.

## Capabilities and Constraints

- Standard D&D dice: d4, d6, d8, d10, d12, d20, and percentile rolls. Default selection is d20.
- Swipe direction, speed, and starting position affect the physical throw.
- A bounded 3D table contains collisions.
- Server-authoritative simulation and recorded motion make results and replays consistent across devices while a room exists.
- Temporary paginated room history. Server restarts and redeployments intentionally clear all rooms.
- Reconnection recovers missed events while the room exists; idempotent requests prevent duplicate rolls within that lifetime.
- The user asked for a simple, functional interface, not elaborate styling.
- Publish the repository publicly on GitHub and connect a single-replica Railway service to automatic deployments from the main branch.

## Implementation Defaults

These are implementation choices, not separately user-specified values: six-hour idle expiry, paused while connections remain active; 256 rooms per process; 32 simultaneous connections and 128 issued seats per room; up to 1,000 rolls per room subject to a 32 MiB room replay budget and 128 MiB process replay budget. Limits fail explicitly rather than silently discarding history. One application replica is required.

## Product Principles

- One swipe is enough to throw.
- The shared record is authoritative within the current room session.
- Recorded throws remain replayable for the room's lifetime.
- Losing a connection must not silently create another roll.
- Session-local state should stay simple; no database infrastructure for disposable rooms.

## Open Decisions

Production capacity targets, moderation, and alternate TTL values remain unspecified. Scaling beyond one process requires a shared ephemeral room store and cross-instance fan-out.
