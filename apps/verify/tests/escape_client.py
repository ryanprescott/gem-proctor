"""Socket client for the escape suite. Runs in a container of its own, sharing the socket volume like the API.

One request per stdin line, one reply per stdout line. `{"raw": text}` is sent as it is.
"""

import json
import socket
import sys

PATH = "/run/verify/verify.sock"


def exchange(data: bytes) -> str:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(30)
        s.connect(PATH)
        s.sendall(data + b"\n")
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
    return buf.decode("utf8", "replace").strip()


for line in sys.stdin:
    try:
        print(json.dumps({"reply": exchange(json.loads(line)["raw"].encode())}), flush=True)
    except OSError as err:
        print(json.dumps({"down": type(err).__name__}), flush=True)
