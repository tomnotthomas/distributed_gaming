# Watching a crewmate play: how the stream reaches viewers

When a crewmate watches, the game's picture and sound must reach them as well as the
player, and everyone's voice must reach everyone. Who sends the extra copies decides what
it costs, and who pays for it. The design that shipped is in
[`renter.md`](../system-design/renter.md#watching-a-crewmate-play); this note says why.

## The numbers

The player's stream is 1080p60 at about 10 Mbit/s: **4.5 GB per hour**. A viewer's copy,
capped at 2.5 Mbit/s and 30 fps (`VIEWER_MAX_BITRATE`), is **1.125 GB per hour**. A voice
line is Opus at about 32 kbit/s, roughly 15 MB per hour, which is noise next to video.

Cloudflare Realtime (TURN and SFU share it) gives 1,000 GB a month free, then bills about
USD 0.05 per GB of egress. Only traffic that goes through Cloudflare counts: a direct
peer-to-peer path costs nothing.

## The options

|                      | Relay or SFU fan-out                                                                                                                                                     | A second peer from the PC per viewer                                                                                 | The player's page fans out (chosen)                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| How                  | The PC uploads once to an SFU, which forwards a copy to each viewer                                                                                                      | The PC opens one more peer connection per viewer                                                                     | The player's page passes on what it receives, on its own connection to each viewer   |
| PC upload            | Flat: one stream                                                                                                                                                         | +10 Mbit/s per viewer (the Swiff OS streamer can send the same encoded packets again; the desktop app encodes again) | Flat: one stream, as today                                                           |
| Player upload        | None                                                                                                                                                                     | None                                                                                                                 | +2.5 Mbit/s per viewer, at most 4 viewers (10 Mbit/s)                                |
| Cost per viewer-hour | Every viewer's copy leaves the SFU: 4.5 GB, so USD 0.225 past the free tier (or 1.125 GB, USD 0.056, with a second, smaller layer from the PC)                           | Free direct; USD 0.225 when the viewer's path needs TURN                                                             | Free direct; 1.125 GB, USD 0.056, when the viewer's path needs TURN                  |
| Free tier lasts      | ~222 viewer-hours a month at full quality                                                                                                                                | ~222 relayed viewer-hours                                                                                            | ~889 relayed viewer-hours                                                            |
| New service          | Cloudflare Realtime SFU needs an account and an app; a self-run SFU needs a server with public UDP, and Swiff's server sits behind cloudflared (HTTP and WebSocket only) | None                                                                                                                 | None                                                                                 |
| Viewers and the PC   | Through the SFU                                                                                                                                                          | Each viewer is a peer of the input-taking streamer, and learns its address                                           | The PC never hears of a viewer; no viewer frame reaches it                           |
| Viewer picture       | Full                                                                                                                                                                     | Full, or a second encode                                                                                             | 720p-ish at 30 fps, one more decode and encode (tens of ms, unnoticed when watching) |

**Relay or SFU fan-out** keeps the PC's upload flat and is the right shape at scale, but
it needs a paid service and an account Swiff does not have (the TURN relay is still in
review, issue #60, and the 2026-10-04 decision runs no paid relay during the free launch).
A TURN relay alone does not fan out: each allocation relays one peer to one peer.

**A second peer from the PC** needs nothing new, but the PC's upload multiplies. A home
connection's upload is often 10 to 40 Mbit/s: one or two viewers at full quality fill it,
and the player's own stream, which shares that link, loses frames and gains latency. It
also makes every viewer a peer of the process that injects input, which is the one thing
a viewer must never reach.

**The player's page fans out** keeps the PC's upload flat with nothing bought and no
account. It spends the player's upload instead, at a quarter of the bitrate per viewer and
at most 4 viewers, and a little of their device (one hardware encode per viewer, in a
browser that is already decoding the stream). The PC, the streamer and its input path are
untouched: a viewer cannot send input because nothing that takes input is ever connected
to them. The voice chat rides the same connections, with the player's page passing each
viewer's voice on to the others.

## Relay dependency

The TURN relay (`fm/swiff-turn-relay`) is not merged. Viewer connections use the same
provider-neutral ICE settings as everything else: the default STUN plus whatever the
server hands out in `joined` and `watching` (`server/src/ice.ts`). Until a relay is
configured, a viewer on a network with no direct path to the player (carrier NAT on both
ends, strict networks) cannot connect, as a player on such a network cannot reach a PC.
When the relay lands with credentials minted per seat and bound to the session, viewer
seats need theirs minted the same way, bound to the watch.
