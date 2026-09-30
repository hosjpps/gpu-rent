#!/usr/bin/env python3
"""Рендер PlantUML-диаграмм docs/diagrams/src/*.puml -> docs/diagrams/png/*.png.

Запуск (из любого каталога):
    python3 tools/render_diagrams.py            # все диаграммы
    python3 tools/render_diagrams.py pr2-usecase pr3-erd   # только перечисленные
    (необязательно: --src КАТАЛОГ_PUML --out КАТАЛОГ_PNG)

Схема работы: короткие диаграммы (закодированный текст до ~7,5 КБ) уходят GET-запросом
на публичный сервер plantuml.com; более длинные - POST-запросом на kroki.io, потому что
plantuml.com принимает только GET, а длина URL у него ограничена (~8 КБ).
Сервер PlantUML при синтаксической ошибке отвечает HTTP 400 и рисует картинку с ошибкой -
такие ответы считаются сбоем, PNG на диск не записывается. Нужны только пакет plantuml
(для кодирования) и доступ в интернет.
"""
import argparse
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from plantuml import deflate_and_encode

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "diagrams" / "src"
OUT = ROOT / "docs" / "diagrams" / "png"

PLANTUML_GET = "https://www.plantuml.com/plantuml/png/"
KROKI_POST = "https://kroki.io/plantuml/png"
MAX_GET_CODE = 7500      # длина закодированной части URL, выше - POST
MIN_PNG_BYTES = 1024
SERVER_SIZE_LIMIT = 4096  # сервер режет картинки больше 4096 px по стороне
HEADERS = {"User-Agent": "curl/8.7.1"}  # Cloudflare отклоняет стандартный Python-urllib


class RenderError(Exception):
    pass


def _fetch(req):
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise RenderError(f"сервер недоступен: {last}")


def render_text(text):
    """Возвращает байты PNG или бросает RenderError."""
    code = deflate_and_encode(text)
    if len(code) <= MAX_GET_CODE:
        status, headers, body = _fetch(
            urllib.request.Request(PLANTUML_GET + code, headers=HEADERS))
        server = "plantuml.com"
    else:
        status, headers, body = _fetch(urllib.request.Request(
            KROKI_POST, data=text.encode("utf-8"),
            headers={**HEADERS, "Content-Type": "text/plain; charset=utf-8"}))
        server = "kroki.io"
    h = {k.lower(): v for k, v in headers.items()}
    if status != 200:
        err = h.get("x-plantuml-diagram-error")
        line = h.get("x-plantuml-diagram-error-line")
        detail = err or body[:300].decode("utf-8", "replace")
        if line:
            detail += f" (строка {line})"
        raise RenderError(f"{server} вернул HTTP {status}: {detail}")
    if not body.startswith(b"\x89PNG\r\n\x1a\n"):
        raise RenderError(f"{server} вернул не PNG: {body[:120]!r}")
    if len(body) < MIN_PNG_BYTES:
        raise RenderError(f"PNG слишком мал ({len(body)} байт) - похоже на картинку-ошибку")
    width, height = struct.unpack(">II", body[16:24])
    if max(width, height) >= SERVER_SIZE_LIMIT:
        print(f"    ПРЕДУПРЕЖДЕНИЕ: размер {width}x{height} упёрся в лимит сервера "
              f"{SERVER_SIZE_LIMIT} px - картинка может быть обрезана, разбейте диаграмму")
    return body


def main(argv):
    args = argparse.ArgumentParser(description="Рендер PlantUML в PNG")
    args.add_argument("names", nargs="*", help="имена диаграмм без расширения (по умолчанию все)")
    args.add_argument("--src", type=Path, default=SRC, help="каталог с *.puml")
    args.add_argument("--out", type=Path, default=OUT, help="каталог для PNG")
    opt = args.parse_args(argv)
    out, src = opt.out, opt.src
    out.mkdir(parents=True, exist_ok=True)
    files = sorted(src.glob("*.puml"))
    if opt.names:
        wanted = {a.removesuffix(".puml") for a in opt.names}
        files = [f for f in files if f.stem in wanted]
        missing = wanted - {f.stem for f in files}
        if missing:
            sys.exit(f"Нет исходников: {', '.join(sorted(missing))}")
    if not files:
        sys.exit(f"В {src} нет *.puml")
    failed = []
    for f in files:
        try:
            data = render_text(f.read_text(encoding="utf-8"))
        except RenderError as e:
            print(f"ОШИБКА  {f.name}: {e}")
            failed.append(f.name)
            continue
        target = out / (f.stem + ".png")
        target.write_bytes(data)
        w, h = struct.unpack(">II", data[16:24])
        print(f"ok      {f.name} -> {target} ({w}x{h}, {len(data) // 1024} КБ)")
    if failed:
        sys.exit(f"Не отрендерено: {', '.join(failed)}")


if __name__ == "__main__":
    main(sys.argv[1:])
