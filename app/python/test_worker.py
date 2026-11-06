from __future__ import annotations

import hashlib
import struct
import tempfile
import unittest
import zlib
from pathlib import Path

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

import worker


def tiny_png() -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">2I5B", 1, 1, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00\xff"))
        + chunk(b"IEND", b"")
    )


class DocumentWorkerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_edit_writes_verified_copy_and_preserves_original_and_structures(self) -> None:
        source = self.root / "source.docx"
        output = self.root / "tidy.docx"
        picture = self.root / "pixel.png"
        picture.write_bytes(tiny_png())
        document = Document()
        document.add_paragraph("  A heading  ")
        table = document.add_table(rows=1, cols=1)
        table.cell(0, 0).text = "Table content"
        document.add_picture(str(picture))
        document.sections[0].header.paragraphs[0].text = "Header content"
        document.save(source)
        before = hashlib.sha256(source.read_bytes()).hexdigest()

        result = worker.process(
            {
                "id": "request-1",
                "operation": "edit",
                "sourcePath": str(source),
                "outputPath": str(output),
                "operations": [
                    {"kind": "trim_whitespace"},
                    {"kind": "normalize_spacing", "afterPt": 6, "lineSpacing": 1.15},
                    {"kind": "set_title", "text": "Tidy heading"},
                ],
            }
        )

        self.assertTrue(result["ok"])
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)
        verified = Document(output)
        self.assertEqual(verified.paragraphs[0].text, "A heading")
        self.assertEqual(verified.tables[0].cell(0, 0).text, "Table content")
        self.assertEqual(len(verified.inline_shapes), 1)
        self.assertEqual(verified.sections[0].header.paragraphs[0].text, "Header content")
        self.assertEqual(verified.core_properties.title, "Tidy heading")
        self.assertGreater(result["verification"]["bytes"], 0)

    def test_unknown_operation_cannot_create_output_or_modify_source(self) -> None:
        source = self.root / "source.docx"
        output = self.root / "result.docx"
        document = Document()
        document.add_paragraph("Keep this text")
        document.save(source)
        before = source.read_bytes()

        with self.assertRaisesRegex(worker.WorkerError, "unsupported document operation"):
            worker.process(
                {
                    "id": "request-2",
                    "operation": "edit",
                    "sourcePath": str(source),
                    "outputPath": str(output),
                    "operations": [{"kind": "run_python", "code": "open('x','w')"}],
                }
            )

        self.assertEqual(source.read_bytes(), before)
        self.assertFalse(output.exists())

    def test_trim_preserves_drawing_and_field_inside_text_run(self) -> None:
        picture = self.root / "pixel.png"
        picture.write_bytes(tiny_png())
        document = Document()
        paragraph = document.add_paragraph()
        run = paragraph.add_run("  Keep picture ")
        run.add_picture(str(picture))
        field = OxmlElement("w:fldChar")
        field.set(qn("w:fldCharType"), "begin")
        run._r.append(field)
        run.add_text(" and field  ")
        source, output = self.root / "mixed.docx", self.root / "trimmed.docx"
        document.save(source)
        before = source.read_bytes()
        worker.process({"id": "mixed", "operation": "edit", "sourcePath": str(source), "outputPath": str(output), "operations": [{"kind": "trim_whitespace"}]})
        result = Document(output)
        self.assertEqual(result.paragraphs[0].text, "Keep picture  and field")
        self.assertEqual(len(result.inline_shapes), 1)
        self.assertEqual(len(result.paragraphs[0]._p.xpath(".//w:fldChar")), 1)
        self.assertEqual(source.read_bytes(), before)

    def test_replace_spans_formatted_runs_and_keeps_unicode_offsets(self) -> None:
        document = Document()
        paragraph = document.add_paragraph()
        paragraph.add_run("İstanbul ")
        paragraph.add_run("project ").bold = True
        paragraph.add_run("notes remain").italic = True
        worker._apply_edit(document, [{"kind": "replace_text", "find": "PROJECT NOTES", "replace": "plan", "matchCase": False}])
        self.assertEqual(paragraph.text, "İstanbul plan remain")
        self.assertTrue(paragraph.runs[1].bold)
        self.assertTrue(paragraph.runs[2].italic)
        worker._apply_edit(document, [{"kind": "replace_text", "find": "istanbul", "replace": "Jakarta", "matchCase": False}])
        self.assertEqual(paragraph.text, "Jakarta plan remain")

    def test_merged_cells_are_edited_once(self) -> None:
        document = Document()
        table = document.add_table(rows=1, cols=2)
        table.cell(0, 0).merge(table.cell(0, 1)).text = "task"
        worker._apply_edit(document, [{"kind": "replace_text", "find": "task", "replace": "task done"}])
        self.assertEqual(table.cell(0, 0).text, "task done")

    def test_create_accepts_only_bounded_typed_blocks(self) -> None:
        output = self.root / "new.docx"
        result = worker.process(
            {
                "id": "request-3",
                "operation": "create",
                "outputPath": str(output),
                "blocks": [
                    {"kind": "title", "text": "Project notes"},
                    {"kind": "heading", "text": "Next steps", "level": 1},
                    {"kind": "bullet", "text": "Review draft"},
                    {"kind": "table", "rows": [["Item", "Status"], ["Draft", "Ready"]]},
                ],
            }
        )
        self.assertTrue(result["ok"])
        document = Document(output)
        self.assertEqual(document.paragraphs[0].text, "Project notes")
        self.assertEqual(document.tables[0].cell(1, 1).text, "Ready")

    def test_refuses_source_overwrite_and_existing_output(self) -> None:
        source = self.root / "source.docx"
        document = Document()
        document.add_paragraph("Original")
        document.save(source)
        original = source.read_bytes()
        base = {"id": "request-4", "operation": "edit", "operations": []}

        with self.assertRaisesRegex(worker.WorkerError, "paths must differ"):
            worker.process({**base, "sourcePath": str(source), "outputPath": str(source)})
        self.assertEqual(source.read_bytes(), original)

        output = self.root / "existing.docx"
        output.write_bytes(b"keep")
        with self.assertRaisesRegex(worker.WorkerError, "already exists"):
            worker.process({**base, "sourcePath": str(source), "outputPath": str(output)})
        self.assertEqual(output.read_bytes(), b"keep")

    def test_rejects_unknown_fields_and_unbounded_operations(self) -> None:
        output = self.root / "new.docx"
        with self.assertRaisesRegex(worker.WorkerError, "invalid block"):
            worker.process(
                {
                    "id": "request-5",
                    "operation": "create",
                    "outputPath": str(output),
                    "blocks": [{"kind": "paragraph", "text": "Hello", "script": "no"}],
                }
            )
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
