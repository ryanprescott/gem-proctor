"""Writes tests/fixtures/hostile/*.pdf: small PDFs that attack a parser (docs/P2.2.md M7). Run it to regenerate.

Each is hand-written bytes, no library. `scripts/check-convert.ts --hostile` feeds them to the converter's own engine in a
container with no network, a read-only root, no capabilities and a memory cap, and to the running service.
"""

from __future__ import annotations

import zlib
from pathlib import Path

OUT = Path(__file__).parent / "fixtures" / "hostile"


def pdf(objects: dict[int, bytes], root: int = 1, xref_ok: bool = True) -> bytes:
    """A PDF from numbered objects, with a correct xref unless `xref_ok` is false."""
    body = b"%PDF-1.7\n"
    offsets: dict[int, int] = {}
    for number, data in objects.items():
        offsets[number] = len(body)
        body += f"{number} 0 obj\n".encode() + data + b"\nendobj\n"
    start = len(body)
    size = max(objects) + 1
    xref = f"xref\n0 {size}\n0000000000 65535 f \n".encode()
    for n in range(1, size):
        offset = offsets.get(n, 0) if xref_ok else 7
        xref += f"{offset:010d} 00000 n \n".encode()
    body += xref + f"trailer\n<< /Size {size} /Root {root} 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()
    return body


def stream(data: bytes, extra: bytes = b"") -> bytes:
    return b"<< /Length " + str(len(data)).encode() + b" " + extra + b">>\nstream\n" + data + b"\nendstream"


def simple_page(
    media_box: bytes = b"[0 0 612 792]", content: bytes = b"BT /F1 12 Tf 72 700 Td (Hello) Tj ET"
) -> dict[int, bytes]:
    return {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: b"<< /Type /Page /Parent 2 0 R /MediaBox "
        + media_box
        + b" /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        4: stream(content),
        5: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    }


FILES: dict[str, bytes] = {}

# A file cut off in the middle, and one whose xref offsets are all wrong.
FILES["truncated.pdf"] = pdf(simple_page())[:200]
FILES["bad-xref.pdf"] = pdf(simple_page(), xref_ok=False)

# A page count that claims a hundred million pages for a document of one.
objects = simple_page()
objects[2] = b"<< /Type /Pages /Kids [3 0 R] /Count 100000000 >>"
FILES["pagecount-bomb.pdf"] = pdf(objects)

# A page tree that points at itself.
objects = simple_page()
objects[2] = b"<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>"
FILES["page-tree-loop.pdf"] = pdf(objects)

# A page of a hundred million points on a side: rendered naively, a bitmap of terabytes.
FILES["huge-page.pdf"] = pdf(simple_page(media_box=b"[0 0 100000000 100000000]"))
FILES["negative-page.pdf"] = pdf(simple_page(media_box=b"[0 0 -612 0]"))

# A content stream of 256 MB of zeros that deflates to a few hundred KB.
bomb = zlib.compress(b"\0" * (256 * 1024 * 1024), 9)
FILES["flate-bomb.pdf"] = pdf(simple_page(content=b"") | {4: stream(bomb, b"/Filter /FlateDecode ")})

# JavaScript on open, a launch action, a link to a URL, an embedded file: none of it may run or be fetched.
objects = simple_page()
objects[1] = (
    b"<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R /AA << /WC 6 0 R >>"
    b" /Names << /EmbeddedFiles << /Names [(payload.txt) 8 0 R] >> >> >>"
)
objects[3] = (
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [7 0 R 9 0 R]"
    b" /Resources << /Font << /F1 5 0 R >> >> >>"
)
objects[6] = b"<< /S /JavaScript /JS (app.alert('ran'); this.submitForm('http://127.0.0.1:1/probe');) >>"
objects[7] = b"<< /Type /Annot /Subtype /Link /Rect [0 0 612 792] /A << /S /URI /URI (http://127.0.0.1:1/probe) >> >>"
objects[8] = b"<< /Type /Filespec /F (payload.txt) /EF << /F 10 0 R >> >>"
objects[9] = b"<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /Launch /F (/bin/sh) >> >>"
objects[10] = stream(b"this is the embedded file", b"/Type /EmbeddedFile ")
FILES["active-content.pdf"] = pdf(objects)

# A document that asks for a password.
FILES["encrypted-stub.pdf"] = pdf(simple_page()).replace(
    b"trailer\n<<", b"trailer\n<< /Encrypt << /Filter /Standard /V 1 /R 2 /O (x) /U (y) /P -4 >> /ID [<00><00>]"
)

# Not a PDF at all after the signature.
FILES["garbage.pdf"] = b"%PDF-1.7\n" + bytes(range(256)) * 64

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, data in FILES.items():
        (OUT / name).write_bytes(data)
        print(f"{name}: {len(data)} bytes")
