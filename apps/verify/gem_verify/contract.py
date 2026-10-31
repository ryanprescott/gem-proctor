"""The sandbox contract: a small validator for the JSON Schema exported from Zod (P2.1.md §5).

No Pydantic: the parent stays small, and the runner's third-party list stays the one in SPEC §3A.3.1.
This covers exactly the keywords `z.toJSONSchema` writes for `packages/shared/src/verify.ts`; an unknown
keyword is an error, so a contract change can't silently stop being checked.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

CONTRACT: dict[str, Any] = json.loads((Path(__file__).parent / "contract.json").read_text())

_IGNORED = {"$schema", "description"}
_KNOWN = {
    "type",
    "properties",
    "required",
    "additionalProperties",
    "propertyNames",
    "items",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "pattern",
    "minimum",
    "maximum",
    "enum",
    "const",
    "anyOf",
    "oneOf",
}


def _type_ok(kind: str, value: object) -> bool:
    if kind == "object":
        return isinstance(value, dict)
    if kind == "array":
        return isinstance(value, list)
    if kind == "string":
        return isinstance(value, str)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if kind == "number":
        return isinstance(value, int | float) and not isinstance(value, bool)
    if kind == "null":
        return value is None
    raise ValueError(f"contract: unknown type {kind}")


def _value_ok(schema: dict[str, Any], value: object) -> bool:
    if "enum" in schema and value not in schema["enum"]:
        return False
    if "const" in schema and value != schema["const"]:
        return False
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", len(value)):
            return False
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            return False
    is_number = isinstance(value, int | float) and not isinstance(value, bool)
    return not is_number or schema.get("minimum", value) <= value <= schema.get("maximum", value)


def _object_ok(schema: dict[str, Any], value: dict[str, object]) -> bool:
    props = schema.get("properties", {})
    if any(k not in value for k in schema.get("required", [])):
        return False
    extra = schema.get("additionalProperties", True)
    for key, item in value.items():
        if "propertyNames" in schema and not valid(schema["propertyNames"], key):
            return False
        if key in props:
            if not valid(props[key], item):
                return False
        elif extra is False or (isinstance(extra, dict) and not valid(extra, item)):
            return False
    return True


def _array_ok(schema: dict[str, Any], value: list[object]) -> bool:
    if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", len(value)):
        return False
    items = schema.get("items")
    return items is None or all(valid(items, v) for v in value)


def valid(schema: dict[str, Any], value: object) -> bool:
    """Whether `value` matches `schema`."""
    unknown = set(schema) - _KNOWN - _IGNORED
    if unknown:
        raise ValueError(f"contract: unsupported keyword {sorted(unknown)}")
    if "type" in schema:
        kinds = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_type_ok(kind, value) for kind in kinds):
            return False
    if not _value_ok(schema, value):
        return False
    if "anyOf" in schema and not any(valid(s, value) for s in schema["anyOf"]):
        return False
    if "oneOf" in schema and sum(1 for s in schema["oneOf"] if valid(s, value)) != 1:
        return False
    if isinstance(value, dict) and not _object_ok(schema, value):
        return False
    return not (isinstance(value, list) and not _array_ok(schema, value))


def valid_request(request: object) -> bool:
    return valid(CONTRACT["request"], request)


def valid_reply(kind: str, reply: object) -> bool:
    return valid(CONTRACT["replies"][kind], reply)
