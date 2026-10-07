#!/usr/bin/env python3
"""VM session test build only: stands in for gamescope in the renter's PipeWire.

A moving test picture published under gamescope's node name, which the
streamer captures. The game's sound is test-tone.py's.
"""

import sys

import gi

gi.require_version("Gst", "1.0")
from gi.repository import GLib, Gst  # noqa: E402

Gst.init(None)
pipeline = Gst.parse_launch(
    "videotestsrc is-live=true pattern=ball ! video/x-raw,format=BGRx,width=1280,height=720,framerate=30/1 ! "
    'pipewiresink mode=provide stream-properties="props,node.name=gamescope,media.class=Video/Source"')
loop = GLib.MainLoop()


def on_message(_bus, message):
    if message.type in (Gst.MessageType.ERROR, Gst.MessageType.EOS):
        print(f"fake-gamescope: {message.type.value_nicks[0]}", file=sys.stderr)
        loop.quit()


bus = pipeline.get_bus()
bus.add_signal_watch()
bus.connect("message", on_message)
pipeline.set_state(Gst.State.PLAYING)
loop.run()
sys.exit(1)
