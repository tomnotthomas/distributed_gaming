#!/usr/bin/env python3
"""VM session test build only: the game's sound, a 440 Hz tone as 48 kHz stereo
s16 on stdout, which sessiontest-session plays with pw-cat. Not GStreamer's
pipewiresink: under PipeWire 1.6 a playing pipewiresink audio stream stalls
every capture stream in the session, the streamer's included.
"""

import math
import struct
import sys

RATE = 48000
# A tenth of a second, a whole number of periods of 440 Hz.
chunk = b"".join(
    struct.pack("<hh", v, v) for v in (int(3000 * math.sin(2 * math.pi * 440 * i / RATE)) for i in range(RATE // 10)))
while True:
    sys.stdout.buffer.write(chunk)
