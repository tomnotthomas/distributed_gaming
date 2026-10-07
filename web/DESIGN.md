---
name: Lanterel (renter app)
description: The player app in the Paper Band look. The game's key art full-bleed under a dark glass bar, a grey strip and a paper band of ruled cells beneath, hairline instruments, and lime only as a mark.
colors:
  bg: "#121212"
  ink: "#efefed"
  ink-2: "rgb(239 239 237 / 0.72)"
  ink-3: "rgb(239 239 237 / 0.45)"
  line: "rgb(239 239 237 / 0.16)"
  line-2: "rgb(239 239 237 / 0.34)"
  paper: "#e8e9e8"
  on-paper: "#131313"
  on-paper-2: "#4f5050"
  on-paper-3: "#838484"
  pline: "rgb(19 19 19 / 0.16)"
  pline-2: "rgb(19 19 19 / 0.34)"
  grey: "#d3d4d3"
  lime: "#d4f53c"
  lime-edge: "#9cb52a"
typography:
  display:
    fontFamily: "Michroma, system-ui, sans-serif"
    fontSize: "clamp(48px, 7.8vw, 112px)"
    fontWeight: 400
    lineHeight: 1
  headline:
    fontFamily: "Michroma, system-ui, sans-serif"
    fontSize: "clamp(34px, 3.9vw, 56px)"
    fontWeight: 400
    lineHeight: 1.02
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
    letterSpacing: "0.04em"
  lead:
    fontFamily: "Outfit, system-ui, sans-serif"
    fontSize: "clamp(20px, 1.7vw, 24px)"
    fontWeight: 200
    lineHeight: 1.2
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
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.08em"
  label:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0.06em"
rounded:
  pill: "999px"
  circle: "50%"
spacing:
  bar: "80px"
  gut: "clamp(28px, 4.44vw, 96px)"
  col-left: "clamp(220px, 20.83vw, 400px)"
  col-right: "clamp(320px, 27.78vw, 520px)"
  band-h: "352px"
---

# Design System: Lanterel (renter app)

Scope: the renter screens in `src/swiff` (the wall, a game's page, Ignition, coming back and machine lost, profile and settings, Share your PC, the shared bar). The in-session HUD over the stream keeps the `@swiff/ui` library's look, the host app (`/host`) keeps the library palette, and the crew, invite and seat pages (`crew.css`) keep their light lobby look on paper under this app's dark bar. The tokens live on `.sw` in `src/swiff/swiff.css`, which also re-points the library's `--color-*` tokens for these screens so the library primitives (Button, Segment, EmptyState) match. The fonts are self-hosted in `src/swiff/fonts.css`.

History: on 2026-10-07 #107 moved these screens to a light "paper and one screen" look. The captain asked the same day to restore the previous look, so this file again describes the Paper Band look the app had before #107, which is what `swiff.css` ships. The light look is superseded; its before and after screenshots stay in `docs/design/lanterel-light/` as a record, and the restore's own are in `docs/design/restored-look/`.

## Overview

**The Paper Band** (`prototypes/Swiff v7.dc.html`): full-colour key art, black, white and paper chrome, hairline instruments, and lime only as a mark.

The wall's first screen is the game. Its key art fills the viewport under an 80px bar of dark glass, with the game's name drafted bottom left in wide uppercase between a cap line and a base line and a tick ruler along the art's foot. Under the art a grey strip holds the line (the machine signed in, the pitch signed out) and the one action: the Resume dial, or Sign in with Steam. Below the fold the band starts: a ruled grid of game cells on paper, set on the bar's columns, ending on a tick ruler.

Everything you press is a circle or a pill. Lime is a mark, never a surface.

**Key Characteristics:**

- Full-bleed key art on the first screen, darkened by a scrim only where text sits on it.
- A dark ground (`bg`) with light ink, and paper (`paper`) or grey (`grey`) sheets with dark ink where the reading is dense: the band, the Ledger, the instrument column, the hero strip, the estimate sheet.
- Michroma uppercase for names and figures, Outfit for reading, IBM Plex Mono for readings and labels.
- 1px hairlines everywhere: `line` and `line-2` on dark, `pline` and `pline-2` on paper.
- Square cells and panels; only pills, dials and dots are round.

## Colors

### On the dark ground

- **Ground** (`bg`, #121212): the app's ground, Ignition and coming back, and the tint of every scrim and the bar's glass.
- **Ink** (`ink`, `ink-2`, `ink-3`): text on art and on the ground, from primary to faint.
- **Hairlines** (`line`, `line-2`): the bar's cell dividers and bottom edge, rules on the ground.

### On paper

- **Paper** (`paper`): the band, the Ledger, the profile's sheets, the estimate sheet, the account cell, the disc inside the Resume dial.
- **Grey** (`grey`): the hero strip and the instrument column's glass.
- **Paper ink** (`on-paper`, `on-paper-2`, `on-paper-3`) and **paper hairlines** (`pline`, `pline-2`). The chosen machine in the Ledger is printed in `on-paper`.

### The mark

- **Lime** (`lime`): live dots, the current tab's bar, done steps, the ring when a machine frees up.
- **Lime edge** (`lime-edge`): the version that holds on paper: focus rings (2px, 3px offset), pill hover borders, the Free mark's outline.

**The Mark Rule.** Lime is a mark, never a fill or a surface, and never body text.

## Typography

- **Display** (Michroma 400, clamp(48px, 7.8vw, 112px), uppercase): the wall's lead game, fitted to its width. One per screen.
- **Headline** (Michroma 400): a game page's name at clamp(34px, 3.9vw, 56px), Ignition's title at clamp(34px, 4.2vw, 60px), Share your PC's title, the profile name at 30px.
- **Figure** (Michroma 400, 64px): the big numbers, such as the free-machine count in the dial; latency in the Ledger at 40px.
- **Lead** (Outfit 200, clamp(20px, 1.7vw, 24px)): the hero strip's line, with bold spans at 600.
- **Body** (Outfit 300, 16px, 1.5).
- **Item** (Outfit 500, 17px): a game cell's title.
- **Control** (Outfit 500, 14px, 0.08em, uppercase): the bar's nav cells and the band's tabs.
- **Label** (IBM Plex Mono 400, 11.5px, 0.06em, uppercase, the `.mono` class): readings, kickers, leaders, footnotes.

## Layout

The 1440 × 900 mockup's grid, made fluid: an 80px bar (96px on ultra displays) split into a left column (`col-left`), a fluid middle and a right column (`col-right`), with copy set in from the left by `gut`. One scroller per app; the bar scrolls away with the page.

- **Wall:** the art, bar and grey strip are the first screen; the strip ends at the fold and the band starts just below it. The band's tabs and tiles run on the bar's columns.
- **Game page:** the art under a grey desaturating veil with the lens circle left in full colour; the Ledger of ranked machines and the hold-to-launch Reticle on a paper column at the right.
- **Ignition and coming back:** two halves on the dark ground: the art on the left, the figure, dial and steps on the right.
- **Share your PC:** the estimate over full-colour art with the instrument column, then the tier picker, the reasons and steps, and the trust band on paper.
- **Below 861px:** one column, a 64px bar with a 20px gutter, nav hidden; the instrument column and the Ledger sit under the art instead of beside it.

## Components

- **Bar:** dark glass over the art (`bg` at 32% with a 10px blur on the wall, 78% over the crew pages' paper), cells divided by hairlines, the wordmark left, four nav cells in `ink-3` turning `ink` when current, and the account cell on paper at the right.
- **Outline pill** (`.lpill`): 1px currentColor border, 999px, Outfit 500 16px, ending in a 38px hairline circle with an arrow; hover turns the borders `lime-edge`. Sign in with Steam, retry and cancel use it.
- **Resume dial:** a paper disc in a tick ring with four corner brackets; the ring turns and the brackets draw in while it is pointed at or focused.
- **Reticle:** the 200px hold-to-launch dial; holding draws the outer ring and pulls the brackets in.
- **Band cells:** square cells divided by `pline` hairlines, the art flush in its cell, the title, and where it would run in mono. A locked game's art is grey under an ink veil, with its text kept readable.
- **Free mark:** a `lime-edge` outlined pill in 10px mono.

## Motion

State changes ease on `cubic-bezier(0.16, 1, 0.3, 1)`. Signed out, the wall's hero crossfades through a few games over 1.4s, and the line under the name rises in. Under `prefers-reduced-motion: reduce` nothing moves on its own.

## Do's and Don'ts

- **Do** let the game's art fill the first screen, with a scrim only where text needs it.
- **Do** set dense reading (the band, the Ledger, the estimate) on paper or grey sheets with paper ink and hairlines.
- **Do** make every pressable thing a pill or a circle.
- **Don't** use lime as a fill or a surface.
- **Don't** round cells or panels; the grid is square and ruled.
