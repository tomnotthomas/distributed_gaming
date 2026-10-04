#!/usr/bin/env python3
"""Run one of the streamer's GStreamer pipelines (pipeline.ts builds the text).

    swiff-gst.py '<pipeline>'          run it; the pipeline's fdsink owns stdout
    swiff-gst.py --probe <element>...  print which of these elements exist, one per line
    swiff-gst.py --check '<pipeline>'  run a finite pipeline; exit 0 if it ends cleanly in time

While running, it takes commands on stdin, one per line:

    keyframe          the encoder (named "enc") sends a keyframe next
    bitrate <kbit/s>  the encoder's new target

It exits 0 at end of stream and 1 on any pipeline error, which the streamer
takes as the source gone (gamescope restarting) or the encoder unusable.
Everything it says goes to stderr: stdout carries RTP.
"""

import sys

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstVideo", "1.0")
from gi.repository import GLib, Gst, GstVideo  # noqa: E402


CHECK_SECONDS = 15


def log(msg):
    sys.stderr.write(f"[swiff-gst] {msg}\n")
    sys.stderr.flush()


def probe(names):
    for name in names:
        if Gst.ElementFactory.find(name) is not None:
            print(name)
    return 0


def run(description, check_seconds=None):
    pipeline = Gst.parse_launch(description)
    enc = pipeline.get_by_name("enc")
    loop = GLib.MainLoop()
    status = {"code": 0}

    def on_message(_bus, msg):
        if msg.type == Gst.MessageType.ERROR:
            err, debug = msg.parse_error()
            log(f"error from {msg.src.get_name()}: {err.message}")
            if debug:
                log(debug)
            status["code"] = 1
            loop.quit()
        elif msg.type == Gst.MessageType.EOS:
            loop.quit()
        return True

    def on_command(source, condition):
        if condition & (GLib.IO_HUP | GLib.IO_ERR):
            # The streamer is gone: nothing reads our packets any more.
            loop.quit()
            return False
        line = source.readline()
        if not line:
            loop.quit()
            return False
        words = line.split()
        if enc is not None and words == ["keyframe"]:
            event = GstVideo.video_event_new_upstream_force_key_unit(Gst.CLOCK_TIME_NONE, True, 0)
            enc.get_static_pad("src").send_event(event)
        elif enc is not None and len(words) == 2 and words[0] == "bitrate" and words[1].isdigit():
            enc.set_property("bitrate", int(words[1]))
        return True

    bus = pipeline.get_bus()
    bus.add_signal_watch()
    bus.connect("message", on_message)
    if check_seconds is None:
        stdin = GLib.IOChannel.unix_new(sys.stdin.fileno())
        GLib.io_add_watch(stdin, GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, on_command)
    else:
        # A check that has not reached its end in time has failed: a GPU
        # encoder that hangs is as unusable as one that errors.
        def on_timeout():
            log("the check did not finish in time")
            status["code"] = 1
            loop.quit()
            return False

        GLib.timeout_add_seconds(check_seconds, on_timeout)

    if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
        # The reason is on the bus, not in the return value.
        while True:
            msg = bus.pop_filtered(Gst.MessageType.ERROR)
            if msg is None:
                break
            err, debug = msg.parse_error()
            log(f"error from {msg.src.get_name()}: {err.message}")
            if debug:
                log(debug)
        log("the pipeline would not start")
        pipeline.set_state(Gst.State.NULL)
        return 1
    try:
        loop.run()
    finally:
        pipeline.set_state(Gst.State.NULL)
    return status["code"]


def main(argv):
    Gst.init(None)
    if argv and argv[0] == "--probe":
        return probe(argv[1:])
    check = len(argv) == 2 and argv[0] == "--check"
    if len(argv) != 1 and not check:
        log(__doc__)
        return 2
    try:
        return run(argv[-1], CHECK_SECONDS if check else None)
    except GLib.Error as e:
        log(f"bad pipeline: {e.message}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
