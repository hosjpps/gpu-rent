#!/usr/bin/env python3
"""Restore Unicode maps of the TrueType fonts embedded in existing reports.

LibreOffice subsets use document character codes in their cmap. The PDF's
ToUnicode map restores the Unicode characters before ReportLab embeds them.
Sources are read only; existing output files are never replaced.
"""
import argparse
import io
from pathlib import Path

from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
from fontTools.merge import Merger
from pypdf import PdfReader
from pypdf._cmap import _parse_to_unicode


def collect_fonts(paths):
    candidates = {}
    for path in paths:
        seen = set()
        for page in PdfReader(path).pages:
            for reference in page["/Resources"].get("/Font", {}).get_object().values():
                source = reference.get_object()
                name = str(source.get("/BaseFont", "")).split("+")[-1]
                if name in seen or source.get("/Subtype") != "/TrueType":
                    continue
                seen.add(name)
                descriptor = source.get("/FontDescriptor")
                if not descriptor or "/FontFile2" not in descriptor.get_object():
                    continue
                data = descriptor.get_object()["/FontFile2"].get_data()
                font = TTFont(io.BytesIO(data))
                # These LibreOffice subsets contain a Mac Roman table whose
                # keys are the PDF character codes, rather than Unicode.
                source_cmap = font["cmap"].getcmap(1, 0)
                if source_cmap is None:
                    raise ValueError(f"{path}: unsupported source cmap for {name}")
                original = source_cmap.cmap
                translations, _ = _parse_to_unicode(source)
                restored = {
                    ord(value): original[ord(code)]
                    for code, value in translations.items()
                    if isinstance(code, str) and len(code) == len(value) == 1
                    and ord(code) in original
                }
                if not restored:
                    raise ValueError(f"{path}: no Unicode glyph map for {name}")
                cmap = newTable("cmap")
                cmap.tableVersion = 0
                cmap.tables = []
                for platform, encoding in ((0, 3), (3, 1)):
                    table = CmapSubtable.newSubtable(4)
                    table.platformID = platform
                    table.platEncID = encoding
                    table.language = 0
                    table.cmap = restored
                    cmap.tables.append(table)
                font["cmap"] = cmap
                candidates.setdefault(name, []).append(font)
    return candidates


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", nargs="+", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    fonts = collect_fonts(args.pdf)
    if not fonts:
        parser.error("No supported embedded TrueType fonts found")
    destinations = {name: args.output_dir / f"{name}.ttf" for name in fonts}
    for path in destinations.values():
        if path.exists():
            parser.error(f"Refusing to overwrite {path}")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, sources in sorted(fonts.items()):
        # Each report embeds only its used glyphs. Combine subsets of the same
        # face so a new paragraph can use characters from another report.
        buffers = []
        for source in sources:
            buffer = io.BytesIO()
            source.save(buffer)
            buffer.seek(0)
            buffers.append(buffer)
        font = Merger().merge(buffers) if len(buffers) > 1 else sources[0]
        font.save(destinations[name])
        print(f"{destinations[name]}: {len(font.getBestCmap())} Unicode glyphs")


if __name__ == "__main__":
    main()
