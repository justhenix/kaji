"""Typed DOCX worker for Kaji. Reads one bounded JSON request per input line."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Iterable

from docx import Document
from docx.shared import Pt
from docx.table import Table
from docx.text.paragraph import Paragraph

MAX_LINE_BYTES = 1_048_576
MAX_DOCUMENT_BYTES = 100 * 1024 * 1024
MAX_OPERATIONS = 100
MAX_BLOCKS = 100


class WorkerError(ValueError):
    pass


def _text(value: Any, name: str, maximum: int, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or "\x00" in value or len(value) > maximum:
        raise WorkerError(f"invalid {name}")
    if not allow_empty and not value.strip():
        raise WorkerError(f"invalid {name}")
    return value


def _object(value: Any, name: str, allowed: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - allowed:
        raise WorkerError(f"invalid {name}")
    return value


def _iter_paragraphs(parent: Any) -> Iterable[Paragraph]:
    for paragraph in getattr(parent, "paragraphs", ()):
        yield paragraph
    for table in getattr(parent, "tables", ()):
        yield from _iter_table_paragraphs(table)


def _iter_table_paragraphs(table: Table) -> Iterable[Paragraph]:
    for row in table.rows:
        for cell in row.cells:
            yield from _iter_paragraphs(cell)


def _all_paragraphs(document: Any) -> Iterable[Paragraph]:
    seen = set()
    parents = [document]
    for section in document.sections:
        parents.extend((section.header, section.footer))
    for parent in parents:
        for paragraph in _iter_paragraphs(parent):
            if paragraph._p not in seen:
                seen.add(paragraph._p)
                yield paragraph


def _text_nodes(paragraph: Paragraph) -> list[Any]:
    return paragraph._p.xpath("./w:r/w:t | ./w:hyperlink/w:r/w:t")


def _replace_span(nodes: list[Any], start: int, end: int, replacement: str) -> None:
    cursor = 0
    inserted = False
    for node in nodes:
        text = node.text or ""
        node_end = cursor + len(text)
        if cursor < end and node_end > start:
            left, right = max(0, start - cursor), min(len(text), end - cursor)
            node.text = text[:left] + (replacement if not inserted else "") + text[right:]
            if node.text and (node.text[0].isspace() or node.text[-1].isspace()):
                node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            inserted = True
        cursor = node_end


def _apply_edit(document: Any, raw: Any) -> int:
    if not isinstance(raw, list) or len(raw) > MAX_OPERATIONS:
        raise WorkerError("operations must be an array with at most 100 items")
    changed = 0
    body_paragraphs = list(document.paragraphs)
    all_paragraphs = list(_all_paragraphs(document))
    for index, operation in enumerate(raw):
        if not isinstance(operation, dict) or not isinstance(operation.get("kind"), str):
            raise WorkerError(f"operation {index} is invalid")
        kind = operation["kind"]
        if kind == "normalize_spacing":
            _object(operation, f"operation {index}", {"kind", "afterPt", "lineSpacing"})
            after = operation.get("afterPt", 6.0)
            line = operation.get("lineSpacing", 1.15)
            if not isinstance(after, (int, float)) or isinstance(after, bool) or not 0 <= after <= 72:
                raise WorkerError("afterPt must be between 0 and 72")
            if not isinstance(line, (int, float)) or isinstance(line, bool) or not 0.8 <= line <= 3:
                raise WorkerError("lineSpacing must be between 0.8 and 3")
            for paragraph in all_paragraphs:
                paragraph.paragraph_format.space_after = Pt(after)
                paragraph.paragraph_format.line_spacing = float(line)
            changed += len(all_paragraphs)
        elif kind == "trim_whitespace":
            _object(operation, f"operation {index}", {"kind"})
            for paragraph in all_paragraphs:
                nodes = _text_nodes(paragraph)
                if not nodes:
                    continue
                text = "".join(node.text or "" for node in nodes)
                trimmed = text.strip()
                if trimmed == text:
                    continue
                left = len(text) - len(text.lstrip())
                right = len(text.rstrip())
                # Edit text nodes only; Run.text also removes drawings and field markers.
                _replace_span(nodes, right, len(text), "")
                _replace_span(nodes, 0, min(left, right), "")
                changed += 1
        elif kind == "replace_text":
            _object(operation, f"operation {index}", {"kind", "find", "replace", "matchCase"})
            find = _text(operation.get("find"), "find text", 2000)
            replacement = _text(operation.get("replace"), "replacement text", 2000, allow_empty=True)
            match_case = operation.get("matchCase", True)
            if not isinstance(match_case, bool):
                raise WorkerError("matchCase must be boolean")
            pattern = re.compile(re.escape(find), 0 if match_case else re.IGNORECASE)
            for paragraph in all_paragraphs:
                nodes = _text_nodes(paragraph)
                original = "".join(node.text or "" for node in nodes)
                matches = list(pattern.finditer(original))
                for match in reversed(matches):
                    _replace_span(nodes, match.start(), match.end(), replacement)
                changed += len(matches)
        elif kind == "set_heading":
            _object(operation, f"operation {index}", {"kind", "paragraphIndex", "level"})
            paragraph_index = operation.get("paragraphIndex")
            level = operation.get("level")
            if not isinstance(paragraph_index, int) or isinstance(paragraph_index, bool) or not 0 <= paragraph_index < len(body_paragraphs):
                raise WorkerError("paragraphIndex is outside the document body")
            if not isinstance(level, int) or isinstance(level, bool) or not 1 <= level <= 9:
                raise WorkerError("heading level must be 1-9")
            body_paragraphs[paragraph_index].style = f"Heading {level}"
            changed += 1
        elif kind == "set_title":
            _object(operation, f"operation {index}", {"kind", "text"})
            document.core_properties.title = _text(operation.get("text"), "document title", 512)
            changed += 1
        else:
            raise WorkerError(f"unsupported document operation: {kind[:64]}")
    return changed


def _create_document(blocks: Any) -> tuple[Any, int]:
    if not isinstance(blocks, list) or not blocks or len(blocks) > MAX_BLOCKS:
        raise WorkerError("blocks must contain 1-100 items")
    document = Document()
    count = 0
    for index, block in enumerate(blocks):
        if not isinstance(block, dict) or not isinstance(block.get("kind"), str):
            raise WorkerError(f"block {index} is invalid")
        kind = block["kind"]
        if kind == "title":
            _object(block, f"block {index}", {"kind", "text"})
            document.add_heading(_text(block.get("text"), "title", 10_000), level=0)
        elif kind == "heading":
            _object(block, f"block {index}", {"kind", "text", "level"})
            level = block.get("level", 1)
            if not isinstance(level, int) or isinstance(level, bool) or not 1 <= level <= 9:
                raise WorkerError("heading level must be 1-9")
            document.add_heading(_text(block.get("text"), "heading", 10_000), level=level)
        elif kind in {"paragraph", "bullet", "numbered"}:
            _object(block, f"block {index}", {"kind", "text"})
            style = {"paragraph": None, "bullet": "List Bullet", "numbered": "List Number"}[kind]
            document.add_paragraph(_text(block.get("text"), "paragraph", 10_000), style=style)
        elif kind == "table":
            _object(block, f"block {index}", {"kind", "rows"})
            rows = block.get("rows")
            if not isinstance(rows, list) or not rows or len(rows) > 25:
                raise WorkerError("table must contain 1-25 rows")
            if any(not isinstance(row, list) or not row or len(row) > 8 for row in rows):
                raise WorkerError("table rows must contain 1-8 cells")
            width = len(rows[0])
            if any(len(row) != width for row in rows):
                raise WorkerError("table rows must have matching cell counts")
            table = document.add_table(rows=0, cols=width)
            for row in rows:
                cells = table.add_row().cells
                for cell, value in zip(cells, row, strict=True):
                    cell.text = _text(value, "table cell", 10_000, allow_empty=True)
        else:
            raise WorkerError(f"unsupported document block: {kind[:64]}")
        count += 1
    return document, count


def _validate_path(value: Any, name: str) -> Path:
    raw = _text(value, name, 4096)
    path = Path(raw).expanduser().resolve(strict=False)
    if path.suffix.lower() != ".docx":
        raise WorkerError(f"{name} must end in .docx")
    return path


def _write_verified(document: Any, output_path: Path) -> dict[str, Any]:
    if output_path.exists():
        raise WorkerError("output file already exists")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=".kaji-", suffix=".docx", dir=output_path.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        document.save(temporary)
        if temporary.stat().st_size == 0 or temporary.stat().st_size > MAX_DOCUMENT_BYTES:
            raise WorkerError("generated document has invalid size")
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip() is not None:
                raise WorkerError("generated DOCX archive failed verification")
        verified = Document(temporary)
        paragraphs = len(list(_all_paragraphs(verified)))
        tables = sum(1 for _ in verified.tables)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        os.rename(temporary, output_path)
        return {"paragraphs": paragraphs, "tables": tables, "bytes": output_path.stat().st_size}
    finally:
        temporary.unlink(missing_ok=True)


def process(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict) or set(request) - {
        "id", "operation", "sourcePath", "outputPath", "operations", "blocks"
    }:
        raise WorkerError("invalid request envelope")
    request_id = _text(request.get("id"), "request id", 128)
    operation = request.get("operation")
    if operation == "inspect":
        _object(request, "inspection request", {"id", "operation", "sourcePath"})
        source = _validate_path(request.get("sourcePath"), "sourcePath")
        if not source.is_file() or source.stat().st_size > MAX_DOCUMENT_BYTES:
            raise WorkerError("selected document is unavailable or too large")
        with zipfile.ZipFile(source) as archive:
            if sum(item.file_size for item in archive.infolist()) > MAX_DOCUMENT_BYTES:
                raise WorkerError("expanded document exceeds 100 MiB")
        document = Document(source)
        remaining = 24_000
        paragraphs = []
        for index, paragraph in enumerate(document.paragraphs):
            value = paragraph.text[:min(remaining, 2000)]
            paragraphs.append({"index": index, "text": value, "style": paragraph.style.name})
            remaining -= len(value)
            if remaining <= 0 or len(paragraphs) >= 200:
                break
        return {"id": request_id, "ok": True, "content": {"paragraphs": paragraphs, "tables": len(document.tables), "totalParagraphs": len(document.paragraphs), "truncated": len(paragraphs) < len(document.paragraphs)}}
    output = _validate_path(request.get("outputPath"), "outputPath")
    if operation == "edit":
        if "blocks" in request or not isinstance(request.get("operations"), list):
            raise WorkerError("edit requires operations")
        source = _validate_path(request.get("sourcePath"), "sourcePath")
        if source == output:
            raise WorkerError("source and output paths must differ")
        if not source.is_file():
            raise WorkerError("source DOCX does not exist")
        if source.stat().st_size > MAX_DOCUMENT_BYTES:
            raise WorkerError("source DOCX exceeds 100 MiB")
        with zipfile.ZipFile(source) as archive:
            if sum(item.file_size for item in archive.infolist()) > MAX_DOCUMENT_BYTES:
                raise WorkerError("expanded document exceeds 100 MiB")
            if archive.testzip() is not None:
                raise WorkerError("source DOCX archive failed verification")
        before = hashlib.sha256(source.read_bytes()).hexdigest()
        document = Document(source)
        changed = _apply_edit(document, request["operations"])
        verification = _write_verified(document, output)
        after = hashlib.sha256(source.read_bytes()).hexdigest()
        if before != after:
            output.unlink(missing_ok=True)
            raise WorkerError("source DOCX changed during processing")
        return {
            "id": request_id,
            "ok": True,
            "outputPath": str(output),
            "name": output.name,
            "changedItems": changed,
            "verification": verification,
        }
    if operation == "create":
        if "sourcePath" in request or "operations" in request:
            raise WorkerError("create accepts typed blocks only")
        document, changed = _create_document(request.get("blocks"))
        verification = _write_verified(document, output)
        return {
            "id": request_id,
            "ok": True,
            "outputPath": str(output),
            "name": output.name,
            "changedItems": changed,
            "verification": verification,
        }
    raise WorkerError("operation must be edit or create")


def main() -> int:
    for line in sys.stdin.buffer:
        request = None
        if len(line) > MAX_LINE_BYTES:
            print(json.dumps({"ok": False, "error": "request exceeds 1 MiB"}), flush=True)
            continue
        try:
            request = json.loads(line)
            response = process(request)
        except Exception as error:
            request_id = request.get("id") if isinstance(request, dict) else None
            response = {"id": request_id, "ok": False, "error": str(error)[:512]}
        print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
