#!/usr/bin/env python3
"""Generate duplicate-field schemas from a pinned Rust request DTO baseline.

This emits only the object/array/property shape used by server-support's
schema-aware Serde duplicate-field checker. It does not replace runtime input
validation. Unsupported or ambiguous Rust types stay unmodeled and are listed
in the audit report instead of being guessed.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
BASELINES = {
    "growth": ("kasitek-growth", "abd419c6ae0d84ca19a0a9cb802cc2bb2626d963"),
    "agency": ("kasitek-agency", "2c7902170a8f75257c0e47b86ffaf38068dd2227"),
    "analytics": ("kasitek-labs", "4eb66ad"),
}
TOKEN = re.compile(r'//[^\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z_0-9]*|::|[^\s]')


def git(owner: str, *args: str) -> str:
    repo, commit = BASELINES[owner]
    return subprocess.check_output(
        ["git", "-C", str(ROOT / repo), *args], text=True
    )


def tokens(source: str) -> list[tuple[str, int]]:
    return [
        (m.group(), m.start())
        for m in TOKEN.finditer(source)
        if not m.group().startswith(("//", "/*"))
    ]


def balanced(items: list[tuple[str, int]], index: int) -> int:
    pairs = {"(": ")", "{": "}", "[": "]", "<": ">"}
    opener = items[index][0]
    if opener not in pairs:
        raise ValueError(f"not an opener: {opener}")
    depth = 1
    for cursor in range(index + 1, len(items)):
        value = items[cursor][0]
        if value == opener:
            depth += 1
        elif value == pairs[opener]:
            depth -= 1
            if depth == 0:
                return cursor
    raise ValueError(f"unclosed {opener}")


def split_top(items: list[tuple[str, int]], delimiter: str = ",") -> list[list[tuple[str, int]]]:
    parts: list[list[tuple[str, int]]] = []
    start = 0
    cursor = 0
    while cursor < len(items):
        if items[cursor][0] in "([{<":
            cursor = balanced(items, cursor)
        elif items[cursor][0] == delimiter:
            parts.append(items[start:cursor])
            start = cursor + 1
        cursor += 1
    if start < len(items):
        parts.append(items[start:])
    return parts


def text_of(items: list[tuple[str, int]]) -> str:
    return "".join(token for token, _ in items)


def rust_string(value: str) -> str | None:
    if not (value.startswith('"') and value.endswith('"')):
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


def attributes_before(items: list[tuple[str, int]], index: int) -> tuple[list[list[tuple[str, int]]], int]:
    """Return contiguous outer attributes before a declaration/field body."""
    attrs: list[list[tuple[str, int]]] = []
    cursor = index - 1
    while cursor >= 0:
        # Skip field/declaration visibility, including pub(crate).
        if items[cursor][0] == ")":
            depth = 1
            opener = cursor - 1
            while opener >= 0 and depth:
                if items[opener][0] == ")":
                    depth += 1
                elif items[opener][0] == "(":
                    depth -= 1
                opener -= 1
            if opener >= 0 and items[opener][0] == "pub":
                cursor = opener - 1
                continue
        if items[cursor][0] == "pub":
            cursor -= 1
            continue
        if items[cursor][0] != "]":
            break
        depth = 1
        opener = cursor - 1
        while opener >= 0 and depth:
            if items[opener][0] == "]":
                depth += 1
            elif items[opener][0] == "[":
                depth -= 1
            opener -= 1
        if opener < 0 or items[opener][0] != "#":
            break
        attrs.append(items[opener + 2:cursor])
        cursor = opener - 1
    attrs.reverse()
    return attrs, cursor + 1


def leading_attributes(items: list[tuple[str, int]]) -> tuple[list[list[tuple[str, int]]], int]:
    attrs: list[list[tuple[str, int]]] = []
    cursor = 0
    while cursor + 1 < len(items) and items[cursor][0] == "#" and items[cursor + 1][0] == "[":
        close = balanced(items, cursor + 1)
        attrs.append(items[cursor + 2:close])
        cursor = close + 1
    return attrs, cursor


def serde_options(attrs: list[list[tuple[str, int]]]) -> dict[str, Any]:
    options: dict[str, Any] = {"aliases": []}
    for attr in attrs:
        if not attr or attr[0][0] != "serde" or len(attr) < 3 or attr[1][0] != "(":
            continue
        close = balanced(attr, 1)
        for part in split_top(attr[2:close]):
            if not part:
                continue
            key = part[0][0]
            if len(part) > 1 and part[1][0] == "=":
                value = part[2:]
                if key in ("rename", "rename_all") and value and value[0][0] == "(":
                    end = balanced(value, 0)
                    nested = {}
                    for option in split_top(value[1:end]):
                        if len(option) >= 3 and option[1][0] == "=":
                            nested[option[0][0]] = rust_string(option[2][0])
                    options[key] = nested.get("deserialize") or nested.get("serialize")
                else:
                    parsed = rust_string(value[0][0]) if value else None
                    options[key] = parsed if parsed is not None else text_of(value)
                    if key == "alias" and parsed:
                        options["aliases"].append(parsed)
            else:
                options[key] = True
    return options


def rename_case(name: str, case: str | None) -> str:
    if not case:
        return name
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", name).split("_")
    lowered = [word.lower() for word in words if word]
    if case == "camelCase":
        return "".join([lowered[0], *(part.title() for part in lowered[1:])]) if lowered else name
    if case == "PascalCase":
        return "".join(part.title() for part in lowered)
    if case in ("snake_case", "lowercase"):
        return "_".join(lowered) if case == "snake_case" else "".join(lowered)
    if case == "SCREAMING_SNAKE_CASE":
        return "_".join(lowered).upper()
    if case == "kebab-case":
        return "-".join(lowered)
    if case == "SCREAMING-KEBAB-CASE":
        return "-".join(lowered).upper()
    if case == "UPPERCASE":
        return "".join(lowered).upper()
    if case == "lowercase":
        return "".join(lowered)
    return name


def declaration_body(items: list[tuple[str, int]], kind: str, name: str) -> dict[str, Any] | None:
    for index in range(len(items) - 1):
        if items[index][0] != kind or items[index + 1][0] != name:
            continue
        attrs, _ = attributes_before(items, index)
        cursor = index + 2
        if cursor < len(items) and items[cursor][0] == "<":
            cursor = balanced(items, cursor) + 1
        while cursor < len(items):
            value = items[cursor][0]
            if value == "{":
                return {"kind": kind, "attrs": serde_options(attrs), "body": items[cursor + 1:balanced(items, cursor)]}
            if value == "(":
                if kind == "struct":
                    return {"kind": "tuple", "attrs": serde_options(attrs), "body": items[cursor + 1:balanced(items, cursor)]}
                # Enum unit variants may contain payload groups. Keep searching to the body.
                cursor = balanced(items, cursor) + 1
                continue
            if value in (";", "="):
                if kind == "type" and value == "=":
                    end = cursor + 1
                    while end < len(items) and items[end][0] != ";":
                        if items[end][0] in "([{<":
                            end = balanced(items, end)
                        end += 1
                    return {"kind": "type", "attrs": serde_options(attrs), "body": items[cursor + 1:end]}
                return {"kind": kind, "attrs": serde_options(attrs), "body": []}
            if value in "([{<":
                cursor = balanced(items, cursor)
            cursor += 1
    return None


def field_parts(body: list[tuple[str, int]]) -> list[dict[str, Any]]:
    fields = []
    for part in split_top(body):
        attrs, cursor = leading_attributes(part)
        while cursor < len(part) and part[cursor][0] in ("pub", "crate", "self", "super"):
            cursor += 1
            if cursor < len(part) and part[cursor][0] == "(":
                cursor = balanced(part, cursor) + 1
        if cursor < len(part) and part[cursor][0] == "r" and cursor + 2 < len(part) and part[cursor + 1][0] == "#":
            name = part[cursor + 2][0]
            cursor += 3
        elif cursor < len(part):
            name = part[cursor][0]
            cursor += 1
        else:
            continue
        colon = next((i for i in range(cursor, len(part)) if part[i][0] == ":"), None)
        if colon is None:
            continue
        fields.append({"name": name, "type": part[colon + 1:], "attrs": serde_options(attrs)})
    return fields


def enum_variants(body: list[tuple[str, int]]) -> list[dict[str, Any]]:
    variants = []
    for part in split_top(body):
        attrs, cursor = leading_attributes(part)
        while cursor < len(part) and part[cursor][0] == "pub":
            cursor += 1
        if cursor >= len(part):
            continue
        name = part[cursor][0]
        cursor += 1
        payload: Any = None
        if cursor < len(part) and part[cursor][0] == "{":
            payload = {"kind": "struct", "fields": field_parts(part[cursor + 1:balanced(part, cursor)])}
        elif cursor < len(part) and part[cursor][0] == "(":
            payload = {"kind": "tuple", "types": [p for p in split_top(part[cursor + 1:balanced(part, cursor)])]}
        variants.append({"name": name, "attrs": serde_options(attrs), "payload": payload})
    return variants


def generic_type(items: list[tuple[str, int]]) -> tuple[str, list[list[tuple[str, int]]]] | None:
    cursor = 0
    while cursor < len(items) and items[cursor][0] in ("&", "mut", "*", "const"):
        cursor += 1
    # Discard a reference lifetime.
    if cursor < len(items) and items[cursor][0] == "'":
        cursor += 2
    opener = next((i for i in range(cursor, len(items)) if items[i][0] == "<"), None)
    if opener is None:
        return None
    close = balanced(items, opener)
    if close != len(items) - 1:
        return None
    base = text_of(items[cursor:opener]).split("::")[-1]
    return base, split_top(items[opener + 1:close])


def type_name(items: list[tuple[str, int]]) -> str:
    out = text_of(items)
    out = re.sub(r"^&(?:'[A-Za-z_][A-Za-z_0-9]*)?mut?", "", out)
    return out.split("<", 1)[0].split("::")[-1]


def path_for_source(owner: str, workspace_source: str) -> str:
    return workspace_source.removeprefix(BASELINES[owner][0] + "/")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner", choices=BASELINES, required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--audit", required=True, type=Path)
    args = parser.parse_args()
    owner = args.owner
    repo_name, commit = BASELINES[owner]
    route_inventory = json.loads((ROOT / "plans/typescript-migration/ROUTES.json").read_text())
    rows = [r for r in route_inventory["rows"] if r["owner"] == owner]

    declaration_pattern = r"^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(struct|enum|type)\s+([A-Za-z_][A-Za-z_0-9]*)"
    grep_pattern = r"^[[:space:]]*(pub([[:space:]]*\([^)]*\))?[[:space:]]+)?(struct|enum|type)[[:space:]]+[A-Za-z_][A-Za-z_0-9]*([[:space:]]|<|;|=)"
    try:
        grep = git(owner, "grep", "-n", "-E", grep_pattern, commit, "--", "*.rs")
    except subprocess.CalledProcessError as error:
        if error.returncode != 1:
            raise
        grep = ""
    declarations: dict[str, list[dict[str, Any]]] = {}
    for record in grep.splitlines():
        _, path, line, source_line = record.split(":", 3)
        match = re.match(declaration_pattern, source_line)
        if not match:
            continue
        kind, name = match.group(1), match.group(2)
        declarations.setdefault(name, []).append({"kind": kind, "name": name, "path": path, "line": int(line)})

    @lru_cache(maxsize=None)
    def source_text(path: str) -> str:
        return git(owner, "show", f"{commit}:{path}")

    @lru_cache(maxsize=None)
    def source_tokens(path: str) -> list[tuple[str, int]]:
        return tokens(source_text(path))

    unresolved: set[str] = set()
    ambiguous: set[str] = set()
    unsupported: set[str] = set()

    def resolve(name: str, origin: str) -> dict[str, Any] | None:
        candidates = declarations.get(name.rsplit("::", 1)[-1], [])
        exact = [entry for entry in candidates if entry["path"] == origin]
        if len(exact) == 1:
            return exact[0]
        if len(exact) > 1:
            ambiguous.add(f"{origin}:{name}")
            return None
        if len(candidates) == 1:
            return candidates[0]
        if len(candidates) > 1:
            ambiguous.add(f"{origin}:{name}")
        else:
            unresolved.add(f"{origin}:{name}")
        return None

    def parse_decl(entry: dict[str, Any]) -> dict[str, Any] | None:
        return declaration_body(source_tokens(entry["path"]), entry["kind"], entry["name"])

    def parse_field_schema(field_type: list[tuple[str, int]], origin: str, seen: tuple[str, ...], depth: int) -> dict[str, Any]:
        if depth > 18:
            unsupported.add(f"depth:{origin}:{text_of(field_type)}")
            return {}
        raw = text_of(field_type)
        generic = generic_type(field_type)
        if generic:
            base, params = generic
            if base in {"Option", "Box", "Rc", "Arc", "Pin", "Cow", "ManuallyDrop"} and params:
                return parse_field_schema(params[-1] if base == "Cow" else params[0], origin, seen, depth + 1)
            if base in {"Vec", "VecDeque", "LinkedList", "SmallVec", "ArrayVec"} and params:
                return {"type": "array", "items": parse_field_schema(params[-1], origin, seen, depth + 1)}
            if base in {"HashMap", "BTreeMap", "IndexMap", "Map"} and len(params) >= 2:
                return {"type": "object", "additionalProperties": parse_field_schema(params[-1], origin, seen, depth + 1)}
            if base in {"HashSet", "BTreeSet", "IndexSet"} and params:
                return {"type": "array", "items": parse_field_schema(params[0], origin, seen, depth + 1)}
            if base == "Result" and params:
                return parse_field_schema(params[0], origin, seen, depth + 1)
            unsupported.add(f"generic:{origin}:{raw}")
            return {}
        if field_type and field_type[0][0] == "[":
            end = balanced(field_type, 0)
            inner = field_type[1:end]
            item = inner[:next((i for i, token in enumerate(inner) if token[0] == ";"), len(inner))]
            return {"type": "array", "items": parse_field_schema(item, origin, seen, depth + 1)}
        if field_type and field_type[0][0] == "(":
            end = balanced(field_type, 0)
            parts = split_top(field_type[1:end])
            branches = [parse_field_schema(part, origin, seen, depth + 1) for part in parts]
            return {"type": "array", "items": {"anyOf": branches}}
        name = type_name(field_type)
        if name in {"Value", "String", "str", "bool", "char", "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize", "f32", "f64", "Uuid", "DateTime", "NaiveDate", "NaiveDateTime", "Decimal", "BigDecimal", "Bytes", "PathBuf"}:
            return {}
        entry = resolve(name, origin)
        if entry is None:
            return {}
        identity = f"{entry['path']}::{entry['name']}"
        if identity in seen:
            unsupported.add(f"recursive:{identity}")
            return {}
        decl = parse_decl(entry)
        if decl is None:
            unresolved.add(identity)
            return {}
        next_seen = (*seen, identity)
        if decl["kind"] == "type":
            return parse_field_schema(decl["body"], entry["path"], next_seen, depth + 1)
        if decl["kind"] == "tuple":
            fields = split_top(decl["body"])
            if decl["attrs"].get("transparent") and len(fields) == 1:
                field_type = fields[0]
                colon = next((i for i, token in enumerate(field_type) if token[0] == ":"), None)
                if colon is not None:
                    field_type = field_type[colon + 1:]
                return parse_field_schema(field_type, entry["path"], next_seen, depth + 1)
            return {"type": "array", "items": {"anyOf": [parse_field_schema(part, entry["path"], next_seen, depth + 1) for part in fields]}}
        if decl["kind"] == "struct":
            opts = decl["attrs"]
            fields = field_parts(decl["body"])
            if opts.get("transparent") and len(fields) == 1:
                return parse_field_schema(fields[0]["type"], entry["path"], next_seen, depth + 1)
            properties: dict[str, Any] = {}
            additional: Any = None
            for field in fields:
                fopts = field["attrs"]
                if fopts.get("skip") or fopts.get("skip_deserializing") or fopts.get("deserialize_with"):
                    continue
                child = parse_field_schema(field["type"], entry["path"], next_seen, depth + 1)
                if fopts.get("flatten"):
                    properties.update(child.get("properties", {}))
                    if "additionalProperties" in child:
                        additional = child["additionalProperties"]
                    continue
                name_in_json = fopts.get("rename") or rename_case(field["name"], opts.get("rename_all"))
                properties[name_in_json] = child
                for alias in fopts.get("aliases", []):
                    properties[alias] = child
            schema: dict[str, Any] = {"type": "object", "properties": properties}
            if additional is not None:
                schema["additionalProperties"] = additional
            return schema
        if decl["kind"] == "enum":
            options = decl["attrs"]
            variants = enum_variants(decl["body"])
            branches = []
            for variant in variants:
                vopts = variant["attrs"]
                wire_name = vopts.get("rename") or rename_case(variant["name"], options.get("rename_all"))
                payload = variant["payload"]
                if payload is None:
                    variant_schema = (
                        {"type": "object", "properties": {options["tag"]: {}}}
                        if options.get("tag")
                        else {}
                    )
                elif payload["kind"] == "struct":
                    payload_properties: dict[str, Any] = {}
                    for field in payload["fields"]:
                        fopts = field["attrs"]
                        if fopts.get("skip") or fopts.get("skip_deserializing") or fopts.get("deserialize_with"):
                            continue
                        name_in_json = fopts.get("rename") or rename_case(field["name"], options.get("rename_all_fields"))
                        payload_properties[name_in_json] = parse_field_schema(field["type"], entry["path"], next_seen, depth + 1)
                        for alias in fopts.get("aliases", []):
                            payload_properties[alias] = payload_properties[name_in_json]
                    payload_schema = {"type": "object", "properties": payload_properties}
                    if options.get("untagged"):
                        variant_schema = payload_schema
                    elif options.get("tag") and options.get("content"):
                        variant_schema = {"type": "object", "properties": {options["tag"]: {}, options["content"]: payload_schema}}
                    elif options.get("tag"):
                        tagged = dict(payload_properties)
                        tagged[options["tag"]] = {}
                        variant_schema = {"type": "object", "properties": tagged}
                    else:
                        variant_schema = {"type": "object", "properties": {wire_name: payload_schema}}
                elif payload["kind"] == "tuple":
                    payload_items = [parse_field_schema(part, entry["path"], next_seen, depth + 1) for part in payload["types"]]
                    payload_schema = {"type": "array", "items": {"anyOf": payload_items}}
                    if options.get("untagged"):
                        variant_schema = payload_schema
                    elif options.get("tag") and options.get("content"):
                        variant_schema = {"type": "object", "properties": {options["tag"]: {}, options["content"]: payload_schema}}
                    elif options.get("tag"):
                        variant_schema = {"type": "object", "properties": {options["tag"]: {}}}
                    else:
                        variant_schema = {"type": "object", "properties": {wire_name: payload_schema}}
                else:
                    variant_schema = {}
                branches.append(variant_schema)
            if not branches:
                return {}
            if options.get("untagged") or options.get("tag"):
                return {"anyOf": branches}
            return {"type": "object", "properties": {key: value for branch in branches for key, value in branch.get("properties", {}).items()}}
        return {}

    generated: dict[str, Any] = {}
    skips: set[str] = set()
    for row in rows:
        json_inputs = [inp for inp in row.get("requestInputs", []) if inp.get("kind") == "json"]
        if not json_inputs:
            continue
        input_schema = json_inputs[0].get("schemaType")
        if not input_schema or input_schema.split("::")[-1] == "Value":
            continue
        handler_source = row.get("handlerSource")
        if handler_source:
            handler_path = path_for_source(owner, handler_source)
        else:
            handler_path = next(iter(declarations.values()))[0]["path"] if declarations else ""
        if not handler_path:
            skips.add(f"missing-handler-source:{row['method']} {row['path']}:{input_schema}")
            continue
        schema = parse_field_schema(tokens(input_schema), handler_path, (), 0)
        if schema:
            key_path = re.sub(r"\{([^}]+)\}", r":\1", row["path"])
            generated[f"{row['method']} {key_path}"] = schema
        else:
            type_id = input_schema.split("::")[-1]
            if type_id not in {"Value", "String", "str", "bool", "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize", "f32", "f64"}:
                skips.add(f"empty-schema:{row['method']} {row['path']}:{input_schema}")

    output = "// Generated from Rust source baseline " + commit + ". Do not edit by hand.\n"
    output += "export const GENERATED_SERDE_BODY_SCHEMAS: Record<string, unknown> = "
    output += json.dumps(generated, indent=2, ensure_ascii=False) + " as const;\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(output)
    report = {
        "owner": owner,
        "baseline": commit,
        "generatedRoutes": len(generated),
        "routeKeys": sorted(generated),
        "ambiguousTypes": sorted(ambiguous),
        "unresolvedTypes": sorted(unresolved),
        "unsupportedTypes": sorted(unsupported),
        "skippedRoutes": sorted(skips),
    }
    args.audit.parent.mkdir(parents=True, exist_ok=True)
    args.audit.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"generatedRoutes": len(generated), "skippedRoutes": len(skips), "ambiguousTypes": len(ambiguous), "unresolvedTypes": len(unresolved), "unsupportedTypes": len(unsupported)}))


if __name__ == "__main__":
    main()
