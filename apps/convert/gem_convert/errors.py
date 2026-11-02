"""One error type for everything the service refuses or fails at; the code is the contract's (`ConvertErrorCode`)."""

from __future__ import annotations

STATUS = {
    "bad_request": 400,
    "too_large": 413,
    "not_pdf": 415,
    "too_many_pages": 422,
    "bad_pdf": 422,
    "bad_range": 422,
    "empty": 422,
    "timeout": 504,
    "failed": 500,
    "busy": 503,
}


class ConvertError(Exception):
    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(code)
        assert code in STATUS, code
        self.code = code
        self.message = message or code.replace("_", " ")

    @property
    def status(self) -> int:
        return STATUS[self.code]
