---
name: Lanterel (renter app)
description: The player app after sign-in, set in the launch lobby's light world. Paper ground, card panels on hairlines, and one dark screen lit by the game's key art.
colors:
  paper: "#e8e9e8"
  card: "#f4f4f2"
  card-lift: "#ffffff"
  grey: "#d3d4d3"
  ink: "#131313"
  ink-press: "#000000"
  ink-2: "#4a4b4b"
  ink-3: "#636464"
  line: "rgb(19 19 19 / 0.16)"
  line-2: "rgb(19 19 19 / 0.34)"
  screen: "#131313"
  screen-2: "#1d1e1d"
  on-screen: "#e8e9e8"
  on-screen-2: "rgb(232 233 232 / 0.78)"
  lime: "#d4f53c"
  lime-edge: "#9cb52a"
  lime-deep: "#5f6f12"
typography:
  display:
    fontFamily: "Michroma, system-ui, sans-serif"
    fontSize: "clamp(40px, 5.6vw, 96px)"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.01em"
  headline:
    fontFamily: "Michroma, system-ui, sans-serif"
    fontSize: "clamp(32px, 3.6vw, 54px)"
    fontWeight: 400
    lineHeight: 1.02
    letterSpacing: "0.01em"
  title:
    fontFamily: "Michroma, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0.02em"
  figure:
    fontFamily: "Michroma, system-ui, sans-serif"
    fontSize: "64px"
    fontWeight: 400
    lineHeight: 1
  wordmark:
    fontFamily: "Michroma, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.08em"
  lead:
    fontFamily: "Outfit, system-ui, sans-serif"
    fontSize: "clamp(19px, 1.6vw, 24px)"
    fontWeight: 300
    lineHeight: 1.25
  body:
    fontFamily: "Outfit, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 300
    lineHeight: 1.5
  item:
    fontFamily: "Outfit, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 500
    lineHeight: 1.2
  control:
    fontFamily: "Outfit, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.1em"
  label:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0.06em"
rounded:
  frame: "9px"
  card: "14px"
  screen: "16px"
  panel: "22px"
  pill: "999px"
  circle: "50%"
spacing:
  bar: "80px"
  gut: "clamp(28px, 4.44vw, 96px)"
  col-left: "clamp(220px, 20.83vw, 400px)"
  col-right: "clamp(320px, 27.78vw, 520px)"
  tile-gap: "14px"
  card-pad: "14px 16px"
  panel-pad: "clamp(20px, 2.6vw, 30px)"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "6px 6px 6px 22px"
    height: "52px"
  button-primary-hover:
    backgroundColor: "{colors.ink-press}"
    textColor: "{colors.paper}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "6px 6px 6px 22px"
    height: "52px"
  button-outline-small:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "4px 4px 4px 18px"
    height: "42px"
  game-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    typography: "{typography.item}"
    rounded: "{rounded.card}"
    padding: "8px 8px 14px"
  game-card-hover:
    backgroundColor: "{colors.card-lift}"
  machine-row:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "14px 16px 14px 14px"
  machine-row-chosen:
    backgroundColor: "{colors.screen}"
    textColor: "{colors.on-screen}"
  panel:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel-pad}"
  account-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "5px 16px 5px 5px"
  free-chip:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "2px 8px 2px 6px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    typography: "{typography.control}"
    height: "80px"
  nav-item-current:
    textColor: "{colors.ink}"
  screen:
    backgroundColor: "{colors.screen}"
    textColor: "{colors.on-screen}"
    rounded: "{rounded.screen}"
---

# Design System: Lanterel (renter app)

Scope: the renter screens in `src/swiff` (the wall, a game's page, Ignition, coming back and machine lost, profile and settings, Share your PC, the shared bar). Out of scope by intent: the in-session HUD over the stream keeps the `@swiff/ui` library's dark look; the host app (`/host`) keeps the library palette; the crew pages (`crew.css`) are a separate lane on the same tokens. The tokens live on `.sw` in `src/swiff/swiff.css`, which also re-points the library's `--color-*` tokens for these screens so the library primitives (Button, Segment, EmptyState) read as ink on paper. Fonts are self-hosted in `src/swiff/fonts.css`. The wordmark still reads "Swiff" until the rename lands separately.

## Overview

**Creative North Star: "The Lobby's Room"**

The app is a drafting-table room in daylight: grey-white paper under a fine static grain, panels laid on it as cards with hairline edges, and one dark television, the screen, where the game's key art lives. The art is never the page. It sits on a 16:9 screen with a rounded bezel and a stand, and the lit screen casts a warm spill of light onto the paper beneath it. Everything else is ink on paper: titles drafted in wide uppercase between dimension lines with end ticks, machine readings set in small mono like annotations on a technical drawing, and rulers of ticks along the bottom of bands and pickers.

The density is calm and instrument-like. A screen holds one name, one screen, one strip of facts and one action. Actions are pills and circles, never boxes: the main press is a filled ink pill or a circular dial (Resume, the hold-to-launch Reticle) drawn with tick rings and corner brackets. Lime is not a colour of the interface; it is a mark, a small signal that something is live, chosen, or done.

Motion is slow, eased, and physical: the screen's dashed lime frame breathes while it waits, Ignition opens the picture from one bright line to the full frame as the connection comes up, a freed machine rings its card once in lime. Under reduced motion nothing moves on its own.

**Key Characteristics:**

- Paper ground, card panels on 1px hairlines, ink type; no dark pages.
- Key art only on the screen: a dark rounded 16:9 with a 6px bezel, a stand, and a warm light spill.
- Michroma uppercase titles drafted between dimension lines; Outfit for reading; IBM Plex Mono for readings and annotations.
- Lime used only as a mark: live dots, the current tab's bar, done ticks, the waiting screen's dashed frame.
- Everything you press is a pill or a circle.

## Colors

A near-monochrome paper-and-ink palette with one dark object and one acid mark.

### Primary

- **Drafting Ink** (`ink`): all type, the filled primary pill, the account avatar, the chosen machine card, focus rings (2px solid, 3px offset), text selection. Hover on a filled pill deepens to **Press Black** (`ink-press`).
- **The Screen** (`screen`, with `screen-2` as its off-state glow): the one dark object on every page. The bezel, the stand, the off screen's radial glow, the chosen machine card. Text on it is `on-screen` and `on-screen-2`.

### Secondary

- **Signal Lime** (`lime`): the mark. Live dots (7px), the current nav item's and tab's 18x3px bar, done steps in Ignition's legend, the waiting screen's dashed frame, the one-time ring when a machine frees up.
- **Lime Edge** (`lime-edge`): the 1px inset edge that keeps a lime bar or done dot visible on paper.
- **Lime Ink** (`lime-deep`): the 1px inset edge of a live dot on paper, and the outline of the Free mark's dot.

### Neutral

- **Lobby Paper** (`paper`): the ground of every renter screen, the html and body under it, and the disc fill inside the Resume and Reticle dials.
- **Card Stock** (`card`): every panel, tile, machine row, strip and note on the paper. Hover lifts a card to **Lift White** (`card-lift`), which is also the QR code's backing.
- **Cool Grey** (`grey`): the library's lowest accent step, re-pointed; quiet fills only.
- **Ink 2** (`ink-2`): secondary copy, annotations, inactive nav and tabs, dt labels.
- **Ink 3** (`ink-3`): the faintest text (fine print, next steps' dashed dots). Never lighter than this for text.
- **Hairline** (`line`): dividers inside a card, the bar's bottom edge, rules between legend rows.
- **Hairline Strong** (`line-2`): card and panel borders, dimension lines and their end ticks, tab baselines.

### Named Rules

**The Mark Rule.** Lime is a mark, never a fill, a surface, or text on paper. If a lime element is wider than 18px it is a frame line or a ring, not an area.

**The One Screen Rule.** The only dark surface on a renter page is the screen (and the chosen machine card that borrows its colour). Key art is painted on the screen and nowhere else; no art bands behind copy, no full-bleed dark pages.

## Typography

**Display Font:** Michroma (with system-ui, sans-serif)
**Body Font:** Outfit (with system-ui, sans-serif), weights 300, 500, 600
**Label/Mono Font:** IBM Plex Mono (with ui-monospace, monospace)

**Character:** Michroma is wide and engineered, set uppercase so a game's name reads like a part number on a drawing. Outfit is light and round for reading, so sentences feel spoken rather than stamped. Plex Mono carries the readings: milliseconds, hours free, GPU names, steps.

### Hierarchy

- **Display** (Michroma 400, clamp(40px, 5.6vw, 96px), line-height 1, uppercase): the wall's lead game name, fitted to its column by measurement. One per screen.
- **Headline** (Michroma 400, clamp(32px, 3.6vw, 54px), 1.02, uppercase): a game page's name; Ignition's title at clamp(32px, 3.8vw, 56px); the profile name at 30px.
- **Title** (Michroma 400, 18px, 1.2, 0.02em, uppercase): profile section headings; Steam sign-in heading at 22px.
- **Figure** (Michroma 400, 64px, 1): the big numbers (Ignition's percent, the free-machine count, the come-back timer up to clamp(64px, 6.2vw, 104px)); latency in a machine row at 38px. Units sit beside in mono or at 24px ink-2.
- **Lead** (Outfit 300, clamp(19px, 1.6vw, 24px), 1.25): the one line under a name ("On Glasshouse, free until 00:30"); bold spans at 600.
- **Body** (Outfit 300, 16px, 1.5): running copy; notes at 14 to 15px; measures held to 30 to 60ch.
- **Item** (Outfit 500, 17px, 1.2): a game card's title; a machine's name at 600 18px; reading values at 500 19px.
- **Control** (Outfit 500, 13px, 0.1em, uppercase): nav items, band tabs, tier names (13.5px, 0.06em).
- **Label** (IBM Plex Mono 400, 11.5px, 1.55, 0.06em, uppercase): readings, dt terms, card meta, the Ignition legend, ledger heads, hashes (12 to 12.5px). Sentences set in mono (the band's footnote) drop the uppercase.

### Named Rules

**The Drafted Name Rule.** Every screen's name is Michroma uppercase between a cap line and a base line of `line-2`, each with 9px end ticks, running 14px past the word on both sides.

**The Annotation Rule.** A mono label sits under the name or value it describes, as a drawing's annotation, never above it as an eyebrow. The build enforces this by reordering every label below its title.

## Layout

The desktop is the 1440 x 900 lobby grid made fluid: an 80px bar (96px on ultra displays) split into a left column (clamp(220px, 20.83vw, 400px)), a fluid middle, and a right column (clamp(320px, 27.78vw, 520px)), with a side gutter of clamp(28px, 4.44vw, 96px). One scroller per app; the bar scrolls away with the page.

- **Wall:** the first viewport is the drafted name in 5/11 and the screen with its stand in 6/11, then a full-width card strip (facts in three cells, the Resume dial at the right edge). Below the fold, the band: four tabs over a four-column grid of game cards with 14px gaps, ending on a tick ruler (ticks every 10, 50 and 100px). While the games load, the same geometry is drawn empty (the name's dimension lines, the off screen with a line of light) so nothing jumps.
- **Game page:** the name, line and annotations top left, the screen filling the left column with readings in a hairline-divided row under its stand; the right column holds the ranked machine cards and the hold-to-launch Reticle, separated by a vertical hairline.
- **Ignition and coming back:** two equal halves split by a hairline: the screen on the left, the paper on the right with the big figure, the dial, and the step legend.
- **Profile:** cards up to 860px wide; from 1180px a 5/7 two-column grid, settings on the right.
- **Below 861px:** one column, a 64px bar with a 20px gutter, nav hidden; the screen sits under the name, cards and machines under the screen. Between 861 and 1279px the nav drops its live count and tightens to 12px.

## Elevation & Depth

The system is flat, with one exception that is the point. Cards and panels sit on the paper with hairline borders and no shadow; hover answers with an ink border and a lift to white, never with a shadow. Depth belongs only to the screen, which casts a soft shadow and spills warm light onto the paper under it, as a lit television would. A static fractal-noise grain at 12% opacity in overlay blend lies over the whole app.

### Shadow Vocabulary

- **Bezel** (`box-shadow: 0 0 0 6px #131313`): the screen's frame, always.
- **Screen cast** (`0 24px 44px -24px rgb(19 19 19 / 0.55)`): under every screen, lit or off.
- **Warm spill** (`0 46px 56px -34px rgb(236 140 24 / 0.5)`): added only when the screen shows its picture.
- **Hairline inset** (`inset 0 0 0 1px ...`): edges on lime marks, the art frame inside a card, the time ring. Not elevation.

### Named Rules

**The One Shadow Rule.** Only the screen casts a shadow. A card that needs to stand out gets an ink border or the screen's colour, not a shadow.

## Shapes

Soft rectangles for things you read, full rounds for things you press. Corner steps: 9px for the art frame inside a card, 14px for cards, machine rows and notes, 16px for the screen, 22px for panels and the hero strip. Buttons, nav focus, the account card and chips are 999px pills; avatars, dials, the Reticle and dots are circles. The stand under each screen is a 30x17px neck on a 132x5px foot with a 5px bottom radius. Borders are 1px hairlines throughout; the drafting devices (dimension lines with 9px end ticks, tick rulers, corner brackets and tick rings on dials, a crosshair on the game's lens) are drawn in the same hairline weight.

## Components

### Buttons

Calm pills with a turning circle.

- **Shape:** full pill (999px), 52px tall; the small size is 42px.
- **Primary:** filled ink with paper text, Outfit 500 16px, padding 6px 6px 6px 22px, ending in a 38px hairline circle holding an arrow glyph.
- **Outline:** transparent with a 1px currentColor border; used for sign in, retry, cancel.
- **Hover / Focus:** primary deepens to black; outline takes a 5% ink wash; the end circle rotates 45deg over 0.45s. Press nudges down 1px and scales to 0.99. Focus is a 2px ink outline at 3px offset. Disabled is 50% opacity.

### Dials (Resume and the Reticle)

The signature control. A paper disc inside a ring of ticks with four corner brackets, the label and a mono reading inside. Resume (140 to 156px) spins its ticks slowly and draws its brackets in on hover or focus. The Reticle (200px) is hold-to-launch: holding draws the outer ring and pulls the brackets to 0.9, done to 0.8; idle, the brackets settle in and out every 3s.

### Chips

- **Free mark:** a 1px ink-ringed pill, mono 500 11px uppercase, led by a 7px lime dot with a lime-deep edge.
- **Live dot:** 7px lime circle with a 1px lime-deep inset, before live counts and the best machine.

### Cards / Containers

- **Corner Style:** 14px for game cards, machine rows, notes; 22px for panels and the hero strip.
- **Background:** card stock on paper; white on hover.
- **Shadow Strategy:** none (see The One Shadow Rule).
- **Border:** 1px `line-2`, turning ink on hover; internal dividers in `line`.
- **Internal Padding:** game card 8px 8px 14px around a 9px-radius art frame; machine row 14px 16px; panels clamp(20px, 2.6vw, 30px); strip cells 16px 30px.
- **Locked game:** grey-scaled art under an ink veil with a 40px hairline lock circle; the text stays full strength.

### Machine Ledger

Each machine is a card: latency as a 38px Michroma figure on the left, the name and owner, then a mono meta row (the tag, time left). The chosen machine is printed in the screen's colour with on-screen text; the best one carries the lime dot.

### Inputs / Fields

Settings checkboxes are native at 20px with an ink accent. The estimate's sliders are real range inputs over a drawn hairline ruler with an ink-centred paper knob. The tier picker is four cells on a ticked ruler; the chosen cell turns ink with the lime bar under it.

### Navigation

The 80px paper bar: the wordmark (Michroma 17px, 0.08em) left; four equal cells of uppercase Outfit 500 13px in ink-2, turning ink on hover over 0.3s; the current page is ink with an 18x3px lime bar under it. The account card on the right is a pill on card stock (38px ink avatar, name, connection line) beside a 14px-radius "Tonight" card with the hours left. Band tabs repeat the pattern: ink-2, an ink underline and the lime bar for the current tab, a mono count at the right.

### The Screen

The world's one object. A 16:9 rounded rectangle in the screen's colour with the bezel, the cast, and a stand. Off, it shows a radial glow from the top left, a 1.5px dashed lime frame inset 12px that breathes between 40% and full lime every 2.8s, and on the waiting wall a single line of light across the middle. Lit, the frame goes and the warm spill appears. On Ignition the picture opens in steps (clip from one line at 49.6% to the full frame, brightness from 2.4 down to 1, saturation back up) as each step of the connection completes. On a game's page the art sits under a grey desaturating veil, with the lens circle left in full colour behind a hairline crosshair and lens dial.

## Do's and Don'ts

### Do:

- **Do** set every renter screen on paper (#e8e9e8), with card-stock panels bordered by 1px `line-2` hairlines at 14px or 22px radius.
- **Do** put a game's key art on the screen: 16:9, 16px radius, 6px bezel, stand, and the warm spill once lit.
- **Do** draft each screen's name in Michroma uppercase between dimension lines with 9px end ticks.
- **Do** set readings and annotations in IBM Plex Mono 11.5px uppercase, placed under the thing they describe.
- **Do** make every pressable thing a pill or a circle, with the primary in filled ink.
- **Do** use `cubic-bezier(0.16, 1, 0.3, 1)` for state changes (0.3s colour, 0.35s pills, 0.45s to 0.5s turns) and gate any self-running motion behind `prefers-reduced-motion: no-preference`.
- **Do** give lime on paper a 1px `lime-edge` or `lime-deep` inset so the mark holds against the grey.

### Don't:

- **Don't** paint key art full-bleed behind copy or as a dark page band; the Share page's art band is hidden in the build for this reason.
- **Don't** use lime as a fill, a surface, or text on paper.
- **Don't** add drop shadows to cards, pills or panels; only the screen casts one.
- **Don't** set a mono label above a title as an eyebrow.
- **Don't** bring the library's dark glass or gradient buttons onto renter screens; they are re-pointed to ink and paper here, and the dark look belongs to the in-session HUD only.
- **Don't** set text lighter than `ink-3` (#636464) on paper.
