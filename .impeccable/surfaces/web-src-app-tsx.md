---
version: 1
slug: "web-src-app-tsx"
primary_target: "web/src/App.tsx"
related_targets: ["web/src/styles.css","web/src/DiceTable.tsx"]
---

## Scope and mode

Operate. Home/name entry and shared room at `/r/:id`, implemented in `web/src/App.tsx`.

## Task and composition

Get a player from a shared link to a named seat, then one swipe away from a throw. Keep the tray and die selector above history on phones; put history beside the tray on desktop. d20 is selected initially. Large tap targets and a Roll button complement swiping; the surrounding page remains scrollable.

## Direction

The user pinned a simple functional interface rather than an elaborate fantasy skin. A light, restrained shared dice tray is the visual center. Code-led build; seed 65ba90ca is subordinate to the pinned brief. The signature interaction is swipe position, direction, and speed becoming the recorded physical throw.

## State and proof

Show actual room presence and ordered roll history, no fabricated examples. Live and historical views consume the same recorded poses. Replay mode has an explicit return-to-live action that restores a settled live pose or selected-die preview. The percentile pair uses tens 00–90 and units 0–9. Expired links explain room loss and link to a new room. Temporary retention is disclosed at entry and in the history footer.

## Open verification

Desktop Chromium and iPhone-sized WebKit automation passed. Real iPhone touch, Safari background behavior, and actual Railway deployment remain to be tested.
