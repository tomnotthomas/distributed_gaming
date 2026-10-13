#!/usr/bin/env python3
"""What answers in vm/lan-test.sh's home network, run in its namespaces:

    lan-fixture.py router            the router's admin pages and the internet beyond it
    lan-fixture.py device IFACE      another device at home: a page, and discovery answers
    lan-fixture.py probe HOST PORT   connects as that device would; prints what came of it

Every page and answer is one line naming what answered, which the VM's
selftest-lan expects. Each datagram and connection is logged on stdout.
"""

import socket
import sys
import threading

# The router: admin pages on the home network's side, a page and a UDP echo
# (as a STUN server answers) on the internet's.
ROUTER = [
    ("tcp", "192.168.77.1", 80, "swiff-router-admin"),
    ("tcp", "192.168.77.1", 443, "swiff-router-admin"),
    ("tcp", "2001:db8:77::1", 80, "swiff-router-admin"),
    ("tcp", "fe80::1%br0", 80, "swiff-router-admin"),
    ("tcp", "198.51.100.10", 80, "swiff-internet"),
    ("tcp", "2001:db8:ffff::10", 80, "swiff-internet"),
    ("udp", "198.51.100.10", 3478, "swiff-internet-udp"),
    ("udp", "2001:db8:ffff::10", 3478, "swiff-internet-udp"),
]
# Another device: a page on every address, and what discovery asks on its
# multicast groups (or broadcast, for NetBIOS).
DEVICE_PAGE = "swiff-lan-device"
DISCOVERY = [
    ("mdns", 5353, "224.0.0.251", "ff02::fb"),
    ("ssdp", 1900, "239.255.255.250", "ff02::c"),
    ("llmnr", 5355, "224.0.0.252", "ff02::1:3"),
    ("netbios", 137, None, None),
]


def log(text):
    print(text, flush=True)


def bound(kind, host, port, dual=False):
    """A socket bound to host:port; dual: "::" takes IPv4 too."""
    sock_type = socket.SOCK_STREAM if kind == "tcp" else socket.SOCK_DGRAM
    family, _, _, _, address = socket.getaddrinfo(host, port, type=sock_type)[0]
    s = socket.socket(family, sock_type)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if family == socket.AF_INET6:
        s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0 if dual else 1)
    s.bind(address)
    return s


def serve_tcp(s, answer):
    s.listen()
    while True:
        conn, peer = s.accept()
        log(f"tcp {s.getsockname()[0]}:{s.getsockname()[1]} <- {peer[0]}")
        with conn:
            conn.sendall(f"{answer}\n".encode())


def serve_udp(s, answer):
    while True:
        data, peer = s.recvfrom(512)
        log(f"udp :{s.getsockname()[1]} <- {peer[0]} {data[:40]!r}")
        s.sendto(answer.encode(), peer)


def start(target, *args):
    threading.Thread(target=target, args=args, daemon=True).start()


def router():
    for kind, host, port, answer in ROUTER:
        start(serve_tcp if kind == "tcp" else serve_udp, bound(kind, host, port), answer)


def device(iface):
    start(serve_tcp, bound("tcp", "::", 80, dual=True), DEVICE_PAGE)
    index = socket.if_nametoindex(iface)
    for name, port, group4, group6 in DISCOVERY:
        s4 = bound("udp", "0.0.0.0", port)
        if group4:
            mreqn = socket.inet_aton(group4) + socket.inet_aton("0.0.0.0") + index.to_bytes(4, sys.byteorder)
            s4.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreqn)
        start(serve_udp, s4, f"swiff-lan-discovered {name}")
        if group6:
            s6 = bound("udp", "::", port)
            s6.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_JOIN_GROUP, socket.inet_pton(socket.AF_INET6, group6) + index.to_bytes(4, sys.byteorder))
            start(serve_udp, s6, f"swiff-lan-discovered {name}")


def probe(host, port):
    try:
        with socket.create_connection((host, int(port)), timeout=3):
            return "connected"
    except (socket.timeout, TimeoutError):
        return "timeout"
    except OSError as e:
        return e.strerror or str(e)


def main():
    role = sys.argv[1]
    if role == "probe":
        print(probe(sys.argv[2], sys.argv[3]))
        return
    router() if role == "router" else device(sys.argv[2])
    log(f"{role} ready")
    threading.Event().wait()


main()
