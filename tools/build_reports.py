#!/usr/bin/env python3
"""Сборка отчётов: docs/reports/prN*.md -> build/prN.docx -> reports/prN.pdf.

Запуск (из любого каталога):
    python3 tools/build_reports.py              # все отчёты docs/reports/pr*.md
    python3 tools/build_reports.py 2 4          # только отчёты №2 и №4
    python3 tools/build_reports.py --md X.md --pdf Y.pdf   # произвольный файл (проверка)
    python3 tools/build_reports.py --docx-only  # только docx, без PDF (LibreOffice не нужен)

Требуется: python-docx; для PDF - LibreOffice (/Applications/LibreOffice.app). Рисунки
(docs/diagrams/png/*.png) предварительно готовятся tools/render_diagrams.py.
Формат markdown - см. BRIEF/README: front matter (number, topic), # / ## / ### заголовки
(нумерацию 1, 1.1, 1.1.1 ставит сборщик), списки "- " и "1. " (2 уровня вложенности),
pipe-таблицы с подписью "Таблица N - ..." строкой выше, рисунки ![Рисунок N - ...](путь),
fenced-код, **жирный**, *курсив*, `код`. Титульный лист и "Содержание" сборщик делает сам.
Оформление - по правилам РТУ МИРЭА (A4, поля 30/15/20/20 мм, Times New Roman 14, 1,5).
Номера страниц в оглавлении проставляет LibreOffice: Basic-макрос внутри soffice вызывает
UNO getDocumentIndexes().update() и экспортирует PDF (writer_pdf_Export).

Ограничения: вложенность списков - до 3 уровней; код внутри пунктов списка и вложенные
таблицы не поддерживаются; в оглавлении все записи выровнены влево (ненумеруемые
разделы в тексте - по центру); "Продолжение таблицы" не вставляется - шапка таблицы
повторяется на новой странице автоматически.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORTS_SRC = ROOT / "docs" / "reports"
BUILD = ROOT / "build"
PDF_OUT = ROOT / "reports"

SOFFICE = "/Applications/LibreOffice.app/Contents/MacOS/soffice"

YEAR = 2026
STUDENT = "Васин С. А."
GROUP = "ЭФБО-17-24"
TEACHER = "Макиевский С. Е."
DISCIPLINE = "Создание программного обеспечения"

# Геометрия страницы, мм
MARGIN_LEFT, MARGIN_RIGHT, MARGIN_TOP, MARGIN_BOTTOM = 30, 15, 20, 20
TEXT_WIDTH_CM = (210 - MARGIN_LEFT - MARGIN_RIGHT) / 10   # 16,5 см
MAX_IMG_W_CM, MAX_IMG_H_CM = 16.5, 22.0

UNNUMBERED = ("ВВЕДЕНИЕ", "ЗАКЛЮЧЕНИЕ", "СПИСОК ИСПОЛЬЗОВАННЫХ ИСТОЧНИКОВ", "ПРИЛОЖЕНИЕ")
BULLET = "–"  # "–"
SOURCES_TITLE = "СПИСОК ИСПОЛЬЗОВАННЫХ ИСТОЧНИКОВ"
TOC_PLACEHOLDER = "Оглавление будет построено при конвертации в PDF."


_FONTS = {}


class BuildError(Exception):
    pass


# =============================================================================
# Разбор markdown
# =============================================================================

def parse_front_matter(text):
    m = re.match(r"\A---\s*\n(.*?)\n---\s*\n", text, re.S)
    if not m:
        raise BuildError("нет front matter (--- number/topic ---) в начале файла")
    meta = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    for key in ("number", "topic"):
        if not meta.get(key):
            raise BuildError(f"в front matter нет поля «{key}»")
    return meta, text[m.end():]


SPECIAL = set("\\`*_{}[]()#+-.!|<>~")
LINK_RE = re.compile(r'\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)')
BR_RE = re.compile(r"<br\s*/?>", re.I)
AUTOLINK_RE = re.compile(r"<(https?://[^>\s]+)>")


def parse_inline(s, bold=False, italic=False):
    """-> список токенов (text, bold, italic, code) ; text == '\\n' - перенос строки."""
    out, buf, i = [], "", 0

    def flush():
        nonlocal buf
        if buf:
            out.append((buf, bold, italic, False))
            buf = ""

    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s) and s[i + 1] in SPECIAL:
            buf += s[i + 1]
            i += 2
            continue
        if c == "`":
            n = len(s[i:]) - len(s[i:].lstrip("`"))
            j = s.find("`" * n, i + n)
            if j > 0:
                flush()
                out.append((s[i + n:j].strip().replace("\\|", "|"), bold, italic, True))
                i = j + n
                continue
        if s.startswith("**", i):
            j = s.find("**", i + 2)
            if j > i + 2:
                flush()
                out += parse_inline(s[i + 2:j], True, italic)
                i = j + 2
                continue
        if c == "*" and i + 1 < len(s) and not s[i + 1].isspace() and s[i + 1] != "*":
            j = i + 1
            while True:
                j = s.find("*", j)
                if j < 0 or (not s[j - 1].isspace() and not s.startswith("**", j)):
                    break
                j += 1
            if j > i + 1:
                flush()
                out += parse_inline(s[i + 1:j], bold, True)
                i = j + 1
                continue
        if c == "[":
            m = LINK_RE.match(s, i)
            if m:
                flush()
                label, url = m.group(1), m.group(2)
                out += parse_inline(label, bold, italic)
                if re.match(r"https?://", url) and label.strip() != url:
                    out.append((f" ({url})", bold, italic, False))
                i = m.end()
                continue
        if c == "<":
            m = BR_RE.match(s, i)
            if m:
                flush()
                out.append(("\n", bold, italic, False))
                i = m.end()
                continue
            m = AUTOLINK_RE.match(s, i)
            if m:
                buf += m.group(1)
                i = m.end()
                continue
        buf += c
        i += 1
    flush()
    return out


FENCE_RE = re.compile(r"^\s*(```+|~~~+)\s*([\w+-]*)\s*$")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
IMAGE_RE = re.compile(r"^!\[(.*)\]\((.+?)\)\s*$")
LIST_RE = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")
HR_RE = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$")
TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
CAPTION_RE = re.compile(r"^(Таблица|Листинг)\s+\S+\s+[—–-]\s+\S")


def split_row(line):
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|") and not line.endswith("\\|"):
        line = line[:-1]
    return [c.strip() for c in re.split(r"(?<!\\)\|", line)]


def parse_blocks(body):
    lines = body.splitlines()
    blocks, i, n = [], 0, len(lines)

    def starts_block(idx):
        ln = lines[idx]
        if not ln.strip():
            return True
        if FENCE_RE.match(ln) or HEADING_RE.match(ln) or IMAGE_RE.match(ln.strip()) or HR_RE.match(ln):
            return True
        if LIST_RE.match(ln) and not ln.startswith("    ") or (LIST_RE.match(ln) and ln.lstrip() == ln):
            return True
        if ln.lstrip().startswith("|") and idx + 1 < n and TABLE_SEP_RE.match(lines[idx + 1]):
            return True
        return False

    while i < n:
        ln = lines[i]
        if not ln.strip():
            i += 1
            continue
        m = FENCE_RE.match(ln)
        if m:
            fence, lang = m.group(1), m.group(2)
            i += 1
            code = []
            while i < n and not lines[i].strip().startswith(fence[:3]):
                code.append(lines[i])
                i += 1
            if i >= n:
                raise BuildError("не закрыт блок кода ```")
            i += 1
            blocks.append(("code", lang, "\n".join(code)))
            continue
        if ln.strip().startswith("<!--") and ln.strip().endswith("-->"):
            i += 1
            continue
        if HR_RE.match(ln):
            i += 1
            continue
        m = HEADING_RE.match(ln)
        if m:
            blocks.append(("heading", len(m.group(1)), m.group(2)))
            i += 1
            continue
        m = IMAGE_RE.match(ln.strip())
        if m:
            blocks.append(("image", m.group(1), m.group(2)))
            i += 1
            continue
        if ln.lstrip().startswith("|") and i + 1 < n and TABLE_SEP_RE.match(lines[i + 1]):
            header = split_row(ln)
            aligns = []
            for cell in split_row(lines[i + 1]):
                aligns.append("center" if cell.startswith(":") and cell.endswith(":")
                              else "right" if cell.endswith(":") else "left")
            i += 2
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                row = split_row(lines[i])
                row += [""] * (len(header) - len(row))
                rows.append(row[:len(header)])
                i += 1
            blocks.append(("table", header, aligns, rows))
            continue
        m = LIST_RE.match(ln)
        if m:
            items = []  # (indent, ordered, number, text)
            while i < n:
                m = LIST_RE.match(lines[i])
                if m:
                    marker = m.group(2)
                    items.append([len(m.group(1).expandtabs(4)), marker[0].isdigit(),
                                  int(marker[:-1]) if marker[0].isdigit() else 0, m.group(3).strip()])
                    i += 1
                elif lines[i].strip() and lines[i][0] in " \t" and items:
                    items[-1][3] += " " + lines[i].strip()
                    i += 1
                elif not lines[i].strip() and i + 1 < n and (LIST_RE.match(lines[i + 1])
                                                               or lines[i + 1].startswith("  ")) and items:
                    i += 1
                else:
                    break
            blocks.append(("list", items))
            continue
        para = [ln.rstrip("\n")]
        i += 1
        while i < n and not starts_block(i):
            para.append(lines[i])
            i += 1
        text = ""
        for k, p in enumerate(para):
            hard = p.endswith("  ") or p.endswith("\\")
            p = p.strip().rstrip("\\").strip()
            text += p + ("<br>" if hard and k < len(para) - 1 else " ")
        blocks.append(("para", text.strip()))
    return blocks


# =============================================================================
# Сборка docx
# =============================================================================

class DocxBuilder:
    def __init__(self, meta, blocks, md_dir):
        from docx import Document
        self.meta, self.blocks, self.md_dir = meta, blocks, md_dir
        self.doc = Document()
        self.h = [0, 0, 0]
        self.appendix_letter = None
        self.in_unnumbered = False
        self.in_sources = False
        self.after_block = False  # следующий абзац получает отступ 6 пт (после таблицы/листинга)
        self.last_was_table = False
        self.first_h1_done = False

    # ---------- низкоуровневые помощники ----------
    @staticmethod
    def _fonts(rpr_parent, name):
        from docx.oxml.ns import qn
        from docx.oxml import OxmlElement
        rpr = rpr_parent.get_or_add_rPr()
        rf = rpr.find(qn("w:rFonts"))
        if rf is None:
            rf = OxmlElement("w:rFonts")
            rpr.insert(0, rf)
        for a in list(rf.attrib):
            del rf.attrib[a]
        for a in ("ascii", "hAnsi", "cs", "eastAsia"):
            rf.set(qn("w:" + a), name)

    def _run(self, par, text, size=None, bold=None, italic=None, font=None):
        from docx.shared import Pt
        r = par.add_run(text)
        if size:
            r.font.size = Pt(size)
        if bold is not None:
            r.bold = bold
        if italic is not None:
            r.italic = italic
        if font:
            self._fonts(r._element, font)
        return r

    def _inline(self, par, text, size=None, bold=False, italic=False, upper=False, code_size=None):
        for t, b, i, code in parse_inline(text, bold, italic):
            if t == "\n":
                par.add_run().add_break()
                continue
            if upper:
                t = t.upper()
            if code:
                self._run(par, t, size=code_size or ((size or 14) - 2), bold=b or None,
                          italic=i or None, font="Courier New")
            else:
                self._run(par, t, size=size, bold=b or None, italic=i or None)

    def _par(self, style=None, align=None, first=None, left=None, before=None, after=None,
             spacing=None, keep_next=False, page_break=False, keep_lines=False):
        from docx.shared import Pt, Cm
        p = self.doc.add_paragraph(style=style)
        f = p.paragraph_format
        if align is not None:
            f.alignment = align
        if first is not None:
            f.first_line_indent = Cm(first)
        if left is not None:
            f.left_indent = Cm(left)
        if before is None and self.after_block:
            before = 6
        self.after_block = False
        if before is not None:
            f.space_before = Pt(before)
        if after is not None:
            f.space_after = Pt(after)
        if spacing is not None:
            f.line_spacing = spacing
        if keep_next:
            f.keep_with_next = True
        if keep_lines:
            f.keep_together = True
        if page_break:
            f.page_break_before = True
        self.last_was_table = False
        return p

    def _field(self, par, instr, placeholder="1", size=14):
        from docx.oxml import OxmlElement
        from docx.oxml.ns import qn
        run = par.add_run()
        for kind in ("begin", None, "separate", "text", "end"):
            if kind is None:
                it = OxmlElement("w:instrText")
                it.set(qn("xml:space"), "preserve")
                it.text = instr
                run._element.append(it)
            elif kind == "text":
                t = OxmlElement("w:t")
                t.set(qn("xml:space"), "preserve")
                t.text = placeholder
                run._element.append(t)
            else:
                fc = OxmlElement("w:fldChar")
                fc.set(qn("w:fldCharType"), kind)
                run._element.append(fc)
        return run

    # ---------- стили и страница ----------
    def setup(self):
        from docx.shared import Pt, Cm, Mm, RGBColor
        from docx.enum.text import WD_ALIGN_PARAGRAPH as AL, WD_TAB_ALIGNMENT, WD_TAB_LEADER
        from docx.enum.style import WD_STYLE_TYPE
        from docx.oxml.ns import qn
        from docx.oxml import OxmlElement
        doc = self.doc

        # docDefaults: убрать тематические шрифты, язык ru-RU
        dd = doc.styles.element.find(qn("w:docDefaults"))
        if dd is not None:
            rpr = dd.find(qn("w:rPrDefault")).find(qn("w:rPr"))
            rf = rpr.find(qn("w:rFonts"))
            if rf is not None:
                for a in list(rf.attrib):
                    del rf.attrib[a]
                for a in ("ascii", "hAnsi", "cs", "eastAsia"):
                    rf.set(qn("w:" + a), "Times New Roman")
            lang = rpr.find(qn("w:lang"))
            if lang is None:
                lang = OxmlElement("w:lang")
                rpr.append(lang)
            lang.set(qn("w:val"), "ru-RU")
            lang.set(qn("w:eastAsia"), "ru-RU")
            lang.set(qn("w:bidi"), "ar-SA")

        def style_font(st, size, bold=False):
            self._fonts(st.element, "Times New Roman")
            st.font.size = Pt(size)
            st.font.bold = bold
            st.font.italic = False
            st.font.color.rgb = RGBColor(0, 0, 0)

        normal = doc.styles["Normal"]
        style_font(normal, 14)
        pf = normal.paragraph_format
        pf.alignment = AL.JUSTIFY
        pf.first_line_indent = Cm(1.25)
        pf.left_indent = Cm(0)
        pf.right_indent = Cm(0)
        pf.line_spacing = 1.5
        pf.space_before = Pt(0)
        pf.space_after = Pt(0)
        pf.widow_control = True

        for name, size, before in (("Heading 1", 18, 0), ("Heading 2", 16, 24), ("Heading 3", 14, 24)):
            st = doc.styles[name]
            style_font(st, size, True)
            f = st.paragraph_format
            f.alignment = AL.JUSTIFY
            f.first_line_indent = Cm(1.25)
            f.left_indent = Cm(0)
            f.space_before = Pt(before)
            f.space_after = Pt(12)
            f.line_spacing = 1.5
            f.keep_with_next = True
            f.keep_together = True

        # стили оглавления: точечный заполнитель и номер по правому краю
        n_toc = sum(1 for b in self.blocks if b[0] == "heading" and b[1] <= 3)
        toc_spacing = 1.5 if n_toc <= 24 else 1.15 if n_toc <= 34 else 1.0  # чтобы оглавление не вылезало на 3-ю страницу
        for lvl, indent in ((1, 0), (2, 0.75), (3, 1.5)):
            st = doc.styles.add_style(f"TOC {lvl}", WD_STYLE_TYPE.PARAGRAPH)
            st.element.find(qn("w:name")).set(qn("w:val"), f"toc {lvl}")
            st.base_style = normal
            style_font(st, 14)
            f = st.paragraph_format
            f.alignment = AL.LEFT
            f.first_line_indent = Cm(0)
            f.left_indent = Cm(indent)
            f.right_indent = Cm(0)
            f.line_spacing = toc_spacing
            f.tab_stops.add_tab_stop(Cm(TEXT_WIDTH_CM), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)

        sec = doc.sections[0]
        sec.page_width, sec.page_height = Mm(210), Mm(297)
        sec.left_margin, sec.right_margin = Mm(MARGIN_LEFT), Mm(MARGIN_RIGHT)
        sec.top_margin, sec.bottom_margin = Mm(MARGIN_TOP), Mm(MARGIN_BOTTOM)
        sec.footer_distance = Mm(10)
        sec.header_distance = Mm(10)
        sec.different_first_page_header_footer = True

        fp = sec.footer.paragraphs[0]
        fp.alignment = AL.CENTER
        fp.paragraph_format.first_line_indent = Cm(0)
        self._field(fp, "PAGE")
        ft = sec.first_page_footer.paragraphs[0]
        ft.alignment = AL.CENTER
        ft.paragraph_format.first_line_indent = Cm(0)
        self._run(ft, f"Москва {YEAR}")

        cp = doc.core_properties
        cp.author = STUDENT
        cp.last_modified_by = STUDENT
        cp.title = f"Отчёт по практическому занятию № {self.meta['number']}"
        cp.subject = DISCIPLINE
        cp.comments = ""

        # Word спросит об обновлении полей при открытии docx (оглавление)
        upd = OxmlElement("w:updateFields")
        upd.set(qn("w:val"), "true")
        doc.settings.element.append(upd)

    # ---------- титул и оглавление ----------
    def title_page(self):
        from docx.shared import Cm, Pt
        from docx.enum.text import WD_ALIGN_PARAGRAPH as AL
        num, topic = self.meta["number"], self.meta["topic"]
        if not topic.startswith("«"):
            topic = f"«{topic}»"

        def line(text, bold=False, size=14, before=0, after=0, align=AL.CENTER):
            p = self._par(align=align, first=0, before=before, after=after, spacing=1.15)
            self._run(p, text, size=size, bold=bold)
            return p

        line("МИНОБРНАУКИ РОССИИ", True)
        line("Федеральное государственное бюджетное образовательное учреждение высшего образования",
             before=6)
        line("«МИРЭА – Российский технологический университет»", True, before=6)
        line("РТУ МИРЭА", True, before=6, after=18)
        line("Институт перспективных технологий и индустриального программирования")
        line("Кафедра индустриального программирования", before=6)
        line("ОТЧЁТ", True, 20, before=110, after=12)
        line(f"по практическому занятию № {num}", before=0)
        line(f"по дисциплине «{DISCIPLINE}»", before=6)
        line(f"Тема: {topic}", before=18, after=80)

        tbl = self.doc.add_table(rows=1, cols=2)
        tbl.autofit = False
        widths = (8.0, 8.5)
        for c, w in zip(tbl.rows[0].cells, widths):
            c.width = Cm(w)
        right = tbl.rows[0].cells[1]
        entries = [("Выполнил:", True), (f"студент группы {GROUP}", False),
                   (f"{STUDENT}  ______________", False), ("", False),
                   ("Проверил:", True), (f"{TEACHER}  ______________", False)]
        first = True
        for text, bold in entries:
            p = right.paragraphs[0] if first else right.add_paragraph()
            first = False
            p.paragraph_format.first_line_indent = Cm(0)
            p.paragraph_format.line_spacing = 1.15
            p.paragraph_format.space_before = Pt(0)
            p.paragraph_format.space_after = Pt(3)
            p.alignment = AL.LEFT
            if text:
                self._run(p, text, size=14, bold=bold)
        self.last_was_table = True

    def toc_page(self):
        from docx.enum.text import WD_ALIGN_PARAGRAPH as AL
        p = self._par(align=AL.CENTER, first=0, before=0, after=12, keep_next=True, page_break=True)
        self._run(p, "СОДЕРЖАНИЕ", size=18, bold=True)
        p = self._par(align=AL.LEFT, first=0)
        self._field(p, 'TOC \\o "1-3" \\h \\z \\u', TOC_PLACEHOLDER)

    # ---------- блоки ----------
    def heading(self, level, raw):
        from docx.enum.text import WD_ALIGN_PARAGRAPH as AL
        text = raw.strip()
        plain = "".join(t for t, *_ in parse_inline(text))
        upper_plain = plain.upper()
        unnumbered_h1 = level == 1 and any(upper_plain.startswith(u) for u in UNNUMBERED)
        if level > 3:
            p = self._par(first=0, before=12, after=0, keep_next=True)
            self._inline(p, text, bold=True)
            return
        if level == 1:
            self.in_sources = upper_plain.startswith(SOURCES_TITLE)
            self.in_unnumbered = unnumbered_h1
            self.appendix_letter = None
            number = ""
            title_parts = None
            self.h[1] = self.h[2] = 0
            if unnumbered_h1:
                m = re.match(r"^ПРИЛОЖЕНИЕ\s+([А-ЯA-Z])\b[\s:.—–-]*(.*)$", upper_plain)
                if m:
                    self.appendix_letter = m.group(1)
                    title_parts = (f"ПРИЛОЖЕНИЕ {m.group(1)}", plain[len(m.group(0)) - len(m.group(2)):].strip()
                                   if m.group(2) else "")
            else:
                self.h = [self.h[0] + 1, 0, 0]
                number = f"{self.h[0]} "
            p = self._par("Heading 1", AL.CENTER if unnumbered_h1 else AL.JUSTIFY,
                          first=0 if unnumbered_h1 else 1.25, page_break=True)
            if title_parts:
                self._run(p, title_parts[0], size=14)
                if title_parts[1]:
                    p.add_run().add_break()
                    self._run(p, title_parts[1].upper(), size=14, bold=False)
            else:
                self._inline(p, number + text, upper=True)
            return
        # уровни 2 и 3
        if self.in_unnumbered and not self.appendix_letter:
            number = ""
        elif self.appendix_letter:
            if level == 2:
                self.h[1] += 1
                self.h[2] = 0
                number = f"{self.appendix_letter}.{self.h[1]} "
            else:
                self.h[2] += 1
                number = f"{self.appendix_letter}.{self.h[1]}.{self.h[2]} "
        elif level == 2:
            self.h[1] += 1
            self.h[2] = 0
            number = f"{self.h[0]}.{self.h[1]} "
        else:
            self.h[2] += 1
            number = f"{self.h[0]}.{self.h[1]}.{self.h[2]} "
        p = self._par(f"Heading {level}", AL.JUSTIFY, first=1.25)
        self._inline(p, number + text)

    def paragraph(self, text):
        from docx.enum.text import WD_ALIGN_PARAGRAPH as AL
        p = self._par(align=AL.JUSTIFY)
        self._inline(p, text)

    def lst(self, items):
        from docx.shared import Cm, Pt
        from docx.enum.text import WD_ALIGN_PARAGRAPH as AL
        stack = []       # отступы открытых уровней
        counters = {}    # уровень -> текущий номер
        for indent, ordered, number, text in items:
            while stack and indent < stack[-1]:
                counters.pop(len(stack) - 1, None)
                stack.pop()
            if not stack or indent > stack[-1]:
                stack.append(indent)
            level = min(len(stack) - 1, 2)
            if self.in_sources and ordered and level == 0:
                counters[0] = counters.get(0, number - 1) + 1
                p = self._par(align=AL.JUSTIFY, first=1.25)
                self._inline(p, f"{counters[0]}. {text}")
                continue
            if ordered:
                counters[level] = counters.get(level, number - 1) + 1
                n = counters[level]
                if level == 0:
                    marker = f"{n}."
                elif level == 1:
                    letters = "абвгдежиклмнпрстуфхцшщэюя"
                    marker = f"{letters[(n - 1) % len(letters)]})"
                else:
                    marker = f"{n})"
            else:
                counters.pop(level, None)
                marker = BULLET
            hang = 1.0
            left = 1.25 + hang + level * 1.0
            p = self._par(align=AL.JUSTIFY, first=-hang, left=left)
            p.paragraph_format.tab_stops.add_tab_stop(Cm(left))
            self._run(p, marker + "\t")
            self._inline(p, text)

    def image(self, alt, rel):
        from docx.shared import Cm
        from docx.enum.text import WD_ALIGN_PARAGRAPH as AL
        from docx.image.image import Image
        path = (self.md_dir / rel).resolve()
        if not path.is_file():
            raise BuildError(f"нет файла рисунка: {rel} (искали {path})")
        img = Image.from_file(str(path))
        w_cm = img.px_width / (img.horz_dpi or 96) * 2.54
        h_cm = img.px_height / (img.vert_dpi or 96) * 2.54
        k = min(1.0, MAX_IMG_W_CM / w_cm, MAX_IMG_H_CM / h_cm)
        p = self._par(align=AL.CENTER, first=0, before=6, after=0, spacing=1.0, keep_next=True)
        p.add_run().add_picture(str(path), width=Cm(w_cm * k), height=Cm(h_cm * k))
        cap = self._par(align=AL.CENTER, first=0, before=3, after=6, spacing=1.0, keep_lines=True)
        self._inline(cap, alt, size=12, bold=True)

    def caption(self, text):
        from docx.enum.text import WD_ALIGN_PARAGRAPH as AL
        p = self._par(align=AL.LEFT, first=0, before=6, after=0, spacing=1.0, keep_next=True,
                      keep_lines=True)
        self._inline(p, text, size=12, italic=True)

    @staticmethod
    def _borders(tbl_or_cell_pr, color="000000", sz="4", inside=True):
        from docx.oxml import OxmlElement
        from docx.oxml.ns import qn
        b = OxmlElement("w:tblBorders")
        for edge in ("top", "left", "bottom", "right") + (("insideH", "insideV") if inside else ()):
            e = OxmlElement(f"w:{edge}")
            e.set(qn("w:val"), "single")
            e.set(qn("w:sz"), sz)
            e.set(qn("w:space"), "0")
            e.set(qn("w:color"), color)
            b.append(e)
        tbl_or_cell_pr.append(b)

    @staticmethod
    def _cell_margins(tblpr, top=40, bottom=40, left=85, right=85):
        from docx.oxml import OxmlElement
        from docx.oxml.ns import qn
        m = OxmlElement("w:tblCellMar")
        for side, v in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
            e = OxmlElement(f"w:{side}")
            e.set(qn("w:w"), str(v))
            e.set(qn("w:type"), "dxa")
            m.append(e)
        tblpr.append(m)

    @staticmethod
    def _text_cm(text, bold=False):
        """Ширина строки в см при Times New Roman 12 пт (PIL); без шрифта - грубая оценка."""
        global _FONTS
        try:
            from PIL import ImageFont
            key = "bold" if bold else "reg"
            if key not in _FONTS:
                name = "Times New Roman Bold.ttf" if bold else "Times New Roman.ttf"
                for d in ("/System/Library/Fonts/Supplemental/", "/Library/Fonts/",
                          "C:/Windows/Fonts/", "/usr/share/fonts/truetype/msttcorefonts/"):
                    if os.path.exists(d + name):
                        _FONTS[key] = ImageFont.truetype(d + name, 120)
                        break
                else:
                    _FONTS[key] = None
            f = _FONTS[key]
            if f is not None:
                return f.getlength(text) / 10 * 0.03528 * 1.04
        except ImportError:
            pass
        return len(text) * (0.24 if bold else 0.215)

    def _col_widths(self, header, rows):
        cols = len(header)
        want, mn = [], []
        for c in range(cols):
            cells = [(header[c], True)] + [(r[c], False) for r in rows]
            plain = [("".join(t for t, *_ in parse_inline(x)).replace("\n", " "), b) for x, b in cells]
            want.append(max(self._text_cm(x, b) for x, b in plain) + 0.4)
            mn.append(min(max(self._text_cm(w, b) for x, b in plain for w in x.split() or [""]) + 0.4,
                          TEXT_WIDTH_CM / 2))
        W = TEXT_WIDTH_CM
        if sum(want) <= W:
            return [w * (W / sum(want)) if sum(want) > 0.7 * W else w for w in want]
        if sum(mn) >= W:
            return [W * m / sum(mn) for m in mn]
        spare = W - sum(mn)
        extra = [max(w - m, 0) for w, m in zip(want, mn)]
        return [m + spare * e / sum(extra) for m, e in zip(mn, extra)]

    def table(self, header, aligns, rows):
        from docx.shared import Cm, Pt
        from docx.enum.text import WD_ALIGN_PARAGRAPH as AL
        from docx.enum.table import WD_TABLE_ALIGNMENT
        from docx.oxml import OxmlElement
        from docx.oxml.ns import qn
        if self.last_was_table:
            sp = self._par(first=0, before=0, after=0, spacing=1.0)
            self._run(sp, "", size=4)
        widths = self._col_widths(header, rows)
        tbl = self.doc.add_table(rows=1 + len(rows), cols=len(header))
        tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
        tbl.autofit = False
        tblpr = tbl._tbl.tblPr
        self._borders(tblpr)
        self._cell_margins(tblpr)
        for col, w in zip(tbl.columns, widths):
            col.width = Cm(w)
        amap = {"left": AL.LEFT, "center": AL.CENTER, "right": AL.RIGHT}
        for ri, row in enumerate([header] + rows):
            tr = tbl.rows[ri]._tr
            trpr = tr.get_or_add_trPr()
            cs = OxmlElement("w:cantSplit")
            trpr.append(cs)
            if ri == 0:
                trpr.append(OxmlElement("w:tblHeader"))
            for ci, txt in enumerate(row):
                cell = tbl.rows[ri].cells[ci]
                cell.width = Cm(widths[ci])
                p = cell.paragraphs[0]
                f = p.paragraph_format
                f.first_line_indent = Cm(0)
                f.space_before = f.space_after = Pt(0)
                f.line_spacing = 1.0
                p.alignment = AL.CENTER if ri == 0 else (AL.LEFT if ci == 0 else amap[aligns[ci]])
                self._inline(p, txt, size=12, bold=(ri == 0), code_size=10)
        self.after_block = True
        self.last_was_table = True

    def code(self, text):
        from docx.shared import Cm, Pt
        from docx.enum.text import WD_ALIGN_PARAGRAPH as AL
        from docx.oxml import OxmlElement
        from docx.oxml.ns import qn
        if self.last_was_table:
            sp = self._par(first=0, before=0, after=0, spacing=1.0)
            self._run(sp, "", size=4)
        tbl = self.doc.add_table(rows=1, cols=1)
        tbl.autofit = False
        self._borders(tbl._tbl.tblPr, color="A6A6A6", inside=False)
        self._cell_margins(tbl._tbl.tblPr, 60, 60, 120, 120)
        tbl.columns[0].width = Cm(TEXT_WIDTH_CM)
        cell = tbl.rows[0].cells[0]
        cell.width = Cm(TEXT_WIDTH_CM)
        shd = OxmlElement("w:shd")
        shd.set(qn("w:val"), "clear")
        shd.set(qn("w:color"), "auto")
        shd.set(qn("w:fill"), "F2F2F2")
        cell._tc.get_or_add_tcPr().append(shd)
        first = True
        for ln in text.expandtabs(4).split("\n"):
            p = cell.paragraphs[0] if first else cell.add_paragraph()
            first = False
            f = p.paragraph_format
            f.first_line_indent = Cm(0)
            f.left_indent = Cm(0)
            f.space_before = f.space_after = Pt(0)
            f.line_spacing = 1.0
            p.alignment = AL.LEFT
            self._run(p, ln, size=10, font="Courier New")
        self.after_block = True
        self.last_was_table = True

    def build(self):
        self.setup()
        self.title_page()
        self.toc_page()
        blocks, i = self.blocks, 0
        while i < len(blocks):
            b = blocks[i]
            kind = b[0]
            if kind == "heading":
                self.heading(b[1], b[2])
            elif kind == "para":
                nxt = blocks[i + 1][0] if i + 1 < len(blocks) else None
                if CAPTION_RE.match(b[1]) and nxt in ("table", "code"):
                    self.caption(b[1])
                else:
                    self.paragraph(b[1])
            elif kind == "list":
                self.lst(b[1])
            elif kind == "image":
                if not b[1].startswith("Рисунок"):
                    print(f"  ! подпись рисунка не начинается со слова «Рисунок»: {b[1]!r}")
                self.image(b[1], b[2])
            elif kind == "table":
                self.table(b[1], b[2], b[3])
            elif kind == "code":
                self.code(b[2])
            i += 1
        return self.doc


def md_to_docx(md_path, docx_path):
    text = Path(md_path).read_text(encoding="utf-8")
    meta, body = parse_front_matter(text)
    blocks = parse_blocks(body)
    doc = DocxBuilder(meta, blocks, Path(md_path).resolve().parent).build()
    Path(docx_path).parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(docx_path))
    return meta


# =============================================================================
# docx -> PDF через LibreOffice: обновление оглавления (UNO из Basic-макроса) и экспорт
# =============================================================================
# Интерпретатор LibreOffice (Resources/python) на macOS подписан с hardened runtime и в
# ряде окружений не стартует, поэтому UNO-вызовы делает Basic-макрос внутри самого soffice:
# он открывает docx, вызывает update() у каждого индекса документа (getDocumentIndexes),
# затем экспортирует фильтром writer_pdf_Export. Пути передаются через временный ASCII-каталог
# (Basic читает файл заданий в системной кодировке, кириллица в путях ломается).
# Осторожно с именами в Basic: Base, PV и т.п. - зарезервированные слова; ошибка компиляции
# макроса в headless-режиме не выдаёт сообщения, soffice просто зависает (поэтому есть таймаут).

MACRO_LIBRARY = "Standard"
MACRO_SOURCE = """Function MkProp(nm As String, v As Variant) As Object
  Dim p As Object
  p = CreateUnoStruct("com.sun.star.beans.PropertyValue")
  p.Name = nm
  p.Value = v
  MkProp = p
End Function

Sub ConvertOne(pth As String)
  Dim doc As Object
  Dim idx As Object
  Dim i As Integer
  Dim k As Integer
  doc = StarDesktop.loadComponentFromURL(ConvertToURL(pth & ".docx"), "_blank", 0, Array(MkProp("Hidden", True)))
  For k = 1 To 2
    idx = doc.getDocumentIndexes()
    For i = 0 To idx.getCount() - 1
      idx.getByIndex(i).update()
    Next i
  Next k
  doc.storeToURL(ConvertToURL(pth & ".pdf"), Array(MkProp("FilterName", "writer_pdf_Export")))
  doc.close(True)
End Sub

Sub ConvertAll()
  Dim dir As String
  Dim n As Integer
  Dim ln As String
  dir = Environ("REPORT_JOBDIR")
  n = FreeFile
  Open dir & "/jobs.txt" For Input As #n
  Do While Not EOF(n)
    Line Input #n, ln
    If Len(Trim(ln)) > 0 Then ConvertOne(dir & "/" & Trim(ln))
  Loop
  Close #n
  StarDesktop.terminate()
End Sub
"""


def seed_lo_profile(profile):
    """Инициализирует чистый профиль LibreOffice и подменяет в нём модуль Standard.Module1."""
    from xml.sax.saxutils import escape
    subprocess.run([SOFFICE, "--headless", "--terminate_after_init", "--nologo",
                    f"-env:UserInstallation={profile.as_uri()}"],
                   timeout=180, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    module = profile / "user" / "basic" / "Standard" / "Module1.xba"
    if not module.parent.is_dir():
        raise BuildError("LibreOffice не создал профиль (каталог user/basic/Standard)")
    module.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE script:module PUBLIC '
        '"-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">\n'
        '<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" '
        f'script:language="StarBasic">{escape(MACRO_SOURCE)}</script:module>\n', encoding="utf-8")


def docx_to_pdf(pairs):
    import tempfile
    if not os.path.exists(SOFFICE):
        raise BuildError(f"не найден {SOFFICE} - установите LibreOffice")
    work = Path(tempfile.mkdtemp(prefix="reports_lo_"))
    try:
        seed_lo_profile(work / "profile")
        names = []
        for k, (docx, _) in enumerate(pairs):
            shutil.copyfile(docx, work / f"job{k}.docx")
            names.append(f"job{k}")
        (work / "jobs.txt").write_text("\n".join(names) + "\n", encoding="ascii")
        env = dict(os.environ, REPORT_JOBDIR=str(work))
        cmd = [SOFFICE, "--headless", "--invisible", "--norestore", "--nologo", "--nodefault",
               f"-env:UserInstallation={(work / 'profile').as_uri()}",
               f"macro:///{MACRO_LIBRARY}.Module1.ConvertAll"]
        limit = min(900, 90 + 60 * len(pairs))
        try:
            subprocess.run(cmd, env=env, timeout=limit, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            subprocess.run(["pkill", "-f", str(work)], check=False)
            raise BuildError(f"LibreOffice не завершил конвертацию за {limit} с "
                             "(частая причина - ошибка компиляции Basic-макроса)")
        for k, (_, pdf) in enumerate(pairs):
            out = work / f"job{k}.pdf"
            if not out.exists() or out.stat().st_size < 1024:
                raise BuildError(f"LibreOffice не создал PDF для {pdf.name}")
            Path(pdf).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(out, pdf)
            print(f"  pdf: {pdf}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def check_pdf(pdf):
    """Оглавление не должно остаться заглушкой; у записей должны быть номера страниц."""
    exe = shutil.which("pdftotext") or "/opt/homebrew/bin/pdftotext"
    if not os.path.exists(exe):
        print("  (pdftotext не найден - проверка оглавления пропущена)")
        return
    txt = subprocess.run([exe, "-layout", "-f", "2", "-l", "4", str(pdf), "-"],
                         capture_output=True, text=True).stdout
    if TOC_PLACEHOLDER in txt or "СОДЕРЖАНИЕ" not in txt:
        raise BuildError(f"{pdf}: оглавление не обновлено")
    toc = txt.split("СОДЕРЖАНИЕ", 1)[1]
    entries = [ln for ln in toc.splitlines() if re.search(r"\.{3,}", ln)]
    bad = [ln for ln in entries if not re.search(r"\d+\s*$", ln)]
    if not entries or bad:
        raise BuildError(f"{pdf}: в оглавлении нет номеров страниц: {bad[:3] or 'записей нет'}")
    print(f"  оглавление: {len(entries)} записей, номера страниц есть")


# =============================================================================

def main(argv):
    ap = argparse.ArgumentParser(description="md -> docx -> pdf (РТУ МИРЭА)")
    ap.add_argument("numbers", nargs="*", type=int, help="номера отчётов (по умолчанию все)")
    ap.add_argument("--md", type=Path, help="собрать один произвольный md-файл")
    ap.add_argument("--pdf", type=Path, help="куда сохранить PDF (вместе с --md)")
    ap.add_argument("--docx-only", action="store_true", help="не запускать LibreOffice")
    opt = ap.parse_args(argv)

    jobs = []  # (md, docx, pdf)
    if opt.md:
        pdf = opt.pdf or (PDF_OUT / (opt.md.stem + ".pdf"))
        jobs.append((opt.md, BUILD / (opt.md.stem + ".docx"), pdf))
    else:
        for md in sorted(REPORTS_SRC.glob("pr*.md")):
            m = re.match(r"pr(\d+)", md.name)
            if not m:
                continue
            n = int(m.group(1))
            if opt.numbers and n not in opt.numbers:
                continue
            jobs.append((md, BUILD / f"pr{n}.docx", PDF_OUT / f"pr{n}.pdf"))
        if not jobs:
            sys.exit(f"Нет отчётов в {REPORTS_SRC}" + (f" с номерами {opt.numbers}" if opt.numbers else ""))

    try:
        for md, docx, pdf in jobs:
            print(f"{md} -> {docx}")
            md_to_docx(md, docx)
        if not opt.docx_only:
            for _, _, pdf in jobs:
                pdf.parent.mkdir(parents=True, exist_ok=True)
            BUILD.mkdir(exist_ok=True)
            docx_to_pdf([(d, p) for _, d, p in jobs])
            for _, _, pdf in jobs:
                check_pdf(pdf)
    except BuildError as e:
        sys.exit(f"ОШИБКА: {e}")


if __name__ == "__main__":
    main(sys.argv[1:])
