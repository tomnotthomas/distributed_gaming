---
version: 1
slug: "web-src-swiff-wall-tsx"
primary_target: "web/src/swiff/Wall.tsx"
related_targets:
  [
    "web/src/swiff/GameMenu.tsx",
    "web/src/swiff/Ignition.tsx",
    "web/src/swiff/Reconnect.tsx",
    "web/src/swiff/Profile.tsx",
    "web/src/swiff/Chrome.tsx",
    "web/src/swiff/swiff.css",
  ]
---

# Renter app after sign-in

> **Superseded (2026-10-07).** This brief drove #107's light look. The captain asked the same day to
> restore the previous look, so the app ships the Paper Band look again; `web/DESIGN.md` describes it.
> Kept as the record of the light redesign, not as the current direction.

Scope: web/src/swiff renter screens (wall, game page and booking notes, Ignition, coming back and lost
machine, profile and settings, the shared bar; Share your PC follows the same tokens). Out of scope: the
crew page and invite (crew.css), the Steam sign-up flow, the marketing pages, the host desktop app, the
in-session HUD over the stream. Mode: Operate. Behaviour, copy and DOM order stay as they are.

Job: pick a game, see which PC runs it and how well, hold to launch, wait, play, come back.
Unresolved: the wordmark still reads Swiff until the rename lands separately.

## Direction contract

THESIS: The app becomes the lobby's room: paper ground, one screen. The game's key art lives on that
screen, a dark rounded 16:9 with a bezel and a stand, never as a full-bleed dark page. Refuses the dark
streaming-catalogue page with art behind every pixel.

OWN-WORLD: Paper #e8e9e8 ground, card #f4f4f2 panels with 1px rgb(19 19 19 / .34) hairlines and 14 to 22px
radii, ink #131313 text and primary pills, the screen #131313 with a 6px bezel ring. Michroma uppercase for
titles drafted between dimension lines, Outfit 300/500 for reading, IBM Plex Mono uppercase kickers. Lime
only as the mark: live dots, the done tick, the chosen tab's bar, the screen's dashed frame.

STORY: A player signs in and lands on paper, not black. The lead game is on the screen, its name drafted
beside it with where it runs; Resume is one press. Below, the library as player cards. A game's page puts
its art on the screen with the ranked PCs as cards beside it, then hold to launch. Ignition powers the
screen on as the connection comes up.

FIRST VIEWPORT: Wall at 1440: the paper bar (wordmark, nav pills, account card). Left 5/11: mono leader,
the title in Michroma at 56 to 96px between dimension lines, the line "On Glasshouse, free until 00:30".
Right 6/11: the screen, art lit, stand under it with a warm light spill on the paper. Under both, a card
strip: the machine facts and the Resume dial at the right edge, the primary action.

FORM: The launch set's Impeccable lobby (lobby-impeccable.css), pinned by the captain, so no roll (a
brief-pinned direction beats the roll). The captain picked the Impeccable version for the crew and invite
pages ("use taste or impecable for the design please") and, to the proposal to redesign the app after login
in that light style so it reads as one product, answered "continue the overnight mode and add the actions to
your list". Code-led: no image generation on this machine. Signature
interaction: Ignition's screen powers on from one bright line to the full picture as progress climbs;
while the wall waits for its games the empty screen's dashed lime frame breathes.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
