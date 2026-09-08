---
name: Dice Room
description: A practical shared dice tray with a quiet, functional interface.
colors:
  accent: "#284c63"
  ink: "#233746"
  muted: "#596b79"
  page: "#f4f6f8"
  surface: "#ffffff"
  line: "#d8e0e6"
  secondary: "#e3ebf0"
  selected: "#dce8f0"
  notice-bg: "#fae8de"
  notice-ink: "#733619"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "16px"
    fontWeight: 400
  section-title:
    fontSize: "19px"
    fontWeight: 700
    letterSpacing: "-.02em"
  label:
    fontSize: "14px"
    fontWeight: 650
  result:
    fontSize: "32px"
    fontWeight: 750
    letterSpacing: "-.025em"
rounded:
  icon: "8px"
  choice: "9px"
  control: "10px"
  container: "16px"
spacing:
  compact: "8px"
  control: "12px"
  standard: "16px"
  section: "20px"
  wide: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "12px 20px"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.accent}"
    rounded: "{rounded.control}"
    padding: "12px 20px"
  button-icon:
    rounded: "{rounded.icon}"
    width: "44px"
    height: "44px"
  text-link:
    textColor: "{colors.accent}"
    padding: "8px 0"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "13px 15px"
  die-choice:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.choice}"
    padding: "6px"
  die-choice-selected:
    backgroundColor: "{colors.selected}"
    rounded: "{rounded.choice}"
  notice:
    backgroundColor: "{colors.notice-bg}"
    textColor: "{colors.notice-ink}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
---

# Design System: Dice Room

## Overview

**Creative North Star: "A practical shared dice tray"**

Cool light surfaces, slate-blue felt, navy dice, system UI type, and clear rectangular controls support a simple shared-table task. Expression comes from the working 3D tray, not fantasy-dashboard decoration. This records the built interface, not a replacement direction.

**Key Characteristics:**
- Quiet controls around a tactile, bounded tray.
- Readable results and replay actions outside the canvas.
- Flat interface surfaces; physical depth inside the tray.

Evidence: `web/src/styles.css`, `web/src/App.tsx`, `web/src/DiceTable.tsx`, `web/index.html`, and `.impeccable/review/{mobile,desktop}.png`. The brief-pinned functional direction supersedes seed `65ba90ca`. Screenshots evidence composition; current source governs behavior.

## Colors

Frontmatter values are extracted from the build. Sidecar tonal ramps are synthesized panel previews, not additional shipping tokens.

### Primary
Slate navy (`accent`) identifies primary actions, links, results, and die face panels. Pale blue (`secondary`, `selected`) distinguishes supporting actions and chosen dice; selected dice also have a darker border and text.

### Neutral
Cool paper (`page`) carries the interface; white (`surface`) carries fields and die choices. Dark slate (`ink`) is primary text, softer slate (`muted`) is supporting text, and pale slate (`line`) separates regions and history rows. Warm notices signal problems; green connection text and a dot accompany the explicit “Connected” label.

**The State Has Words Rule.** Selection, connection, errors, and roll progress use text or accessible state as well as color.

## Typography

Use the frontmatter's platform UI stack, with tabular numerals across the interface. There is no custom typeface or font download. Hierarchy is functional rather than a proportional type scale: room titles are 26px desktop / 22px phone; history titles use the section-title role; results are larger than player names and timestamps. Fields remain 16px on phones. Body paragraphs specify local line heights (1.5–1.7); there is no global line-height token.

The join screen currently has a larger system-font heading (`clamp(34px, 4vw, 50px)`, 39px on phones). This is an observed local style, not a reusable display-font system. Existing 10–11px ancillary metadata is likewise not a recommended text minimum.

## Layout

The room container is capped at 1160px with 32px side space; its desktop grid is `minmax(0, 1.7fr) minmax(290px, 1fr)` with a 40px gap. History has a left divider and 32px inset. The tray is `clamp(380px, 55svh, 580px)` high, followed by result, die choices, and full-width throw action. Desktop history scrolls within a 610px maximum height.

At 760px and below, room side space becomes 16px, history moves below the controls with a top divider, and its list uses page scrolling. The tray becomes `clamp(300px, 44svh, 440px)` high. The join screen becomes one column and hides its explanatory aside. Safe-area insets and `viewport-fit=cover` support iPhone Safari. Below 360px, seven 44px die choices scroll horizontally; room code and the secondary throw hint hide. The page supports a 320px minimum width.

Spacing uses recurring 8/12/16/20/32px steps, with local adjustments rather than a rigid global grid. The entire physical tray stays framed on resize; the camera does not zoom during a gesture.

## Elevation & Depth

There are no CSS box shadows. Dividers, tonal fills, and whitespace distinguish controls and regions. Inside the canvas, an orthographic camera, directional light, soft shadow mapping, inset die faces, and rounded wooden rails provide real scene depth. Slate felt gets a procedural canvas bump texture; dice numbers are generated canvas textures, with underlines distinguishing six and nine. Material colors are lighting inputs, not promises of exact rendered swatches.

**The Depth Belongs to the Tray Rule.** Keep interface chrome flat; retain physical lighting and shadows in the 3D scene.

## Shapes

Controls are softly rectangular: icon buttons use the icon radius, fields and standard buttons the control radius, and die choices the choice radius. The tray and join aside use the container radius (tray reduces to 13px on phones). History rows stay square and separated by thin rules. The unused CSS `--radius: 12px` is not an adopted token.

## Components

- **Buttons and links:** primary navy, secondary pale blue, transparent icon buttons, and underlined text actions. Standard buttons are at least 48px high; throw and input controls are at least 52px. Phone invite is a local 42px exception. Hover changes fill without lift; button color transitions use 140ms ease-out. Disabled buttons use half opacity and a not-allowed cursor. Keyboard focus is a 3px blue outline with 4px offset; history focus is inset.
- **Fields:** explicit labels, white fill, a darker one-pixel border, and visible placeholders. Display-name and invitation-link fields share styling. Errors use a warm inline alert, optionally dismissible; no toast or modal system is established.
- **Die choices:** seven labeled toggle buttons in a fieldset, with `aria-pressed` selection. A pressed die uses blue fill, border, and text. Choices lock during pending throws, animation, and replay.
- **History:** full-width replay rows align result, player, die/time, sequence, and play icon. Hover and active selection share a pale fill. Long names truncate; accessible replay labels include the full player and result. Earlier rolls load through an explicit button.
- **Tray and result:** swipe starts on the felt and draws a direction cue. The Roll button is an equivalent non-gesture path; graphics failure leaves button rolling and textual results available. Results announce through a polite live region. Reduced motion shows final recorded poses, disables smooth replay scrolling, and nearly eliminates CSS animation/transition duration.
- **Replay:** history playback is visibly separated from live mode by “Back to live”; throwing is disabled in replay. Returning drains waiting live throws or restores the latest live final pose; with no live recording it restores the selected die preview, never a canceled historical frame.
- **Dice labeling:** standalone d10 uses 1–10; percentile uses tens 00–90 plus units 0–9, with 00 + 0 read as 100. The d4 repeats its upper-vertex value on adjacent faces. Preserve these distinctions in previews and playback.
- **Assets:** interface icons are inline SVG via Lucide; the join illustration and favicon are SVG. No raster assets ship. Felt and face labels are runtime canvas materials; review PNGs are evidence, not application assets. There is a home brand link and room actions, not a tab/sidebar navigation system.

## Do's and Don'ts

### Do:
- **Do** keep the button alternative and textual result available outside the canvas.
- **Do** pair selected and connection colors with explicit labels or accessible state.
- **Do** preserve reduced-motion final poses and the separation between replay and live state.
- **Do** keep the complete tray visible while responsive history moves below the controls.

### Don't:
- **Don't** extend physical scene shadows into raised interface cards.
- **Don't** replace the pinned functional interface with fantasy-dashboard ornament.
- **Don't** treat temporary history as a permanent archive; keep the six-hour idle/server-restart disclosure visible.
- **Don't** turn local large join headings or tiny ancillary metadata into reusable typography defaults.
