# @swiff/rank

Which shared PCs a renter can play a game on, and in what order. One pure
function, `rank()`, used by the web page and later by the server matchmaker.
No AI and no weights: six gates, four bucketed scores, one fixed sort, and a
reason that names the rule that decided. The rules are in `src/rank.ts`.

## GPU scores

`src/gpu-scores.json` scores GPUs relative to an RTX 3060 = 100. Picture compares a
host's score with the game's recommended score, and E3 compares it with the
game's minimum.

The numbers are hand-set and illustrative. The anchors come from the plan's
worked example (RTX 4070 Ti 310, RX 7900 XTX 390, RTX 4090 510), and the other
cards sit between them roughly where public relative-performance charts put
them, rounded to 5. They only have to be right to within a bucket
(headroom 1.0, 1.4, 2.0). Measured or curated numbers can replace them without
changing any rule. An unknown GPU scores 0, so it fails E3 instead of being
guessed.

The older cards (GTX 9xx and 10xx, RX 4xx, 5xx and 5x00) are there because game
requirements name them: the server maps Steam's requirement text through this
table (`server/src/requirements.ts`).
