"""One bounded native document operation, with no network or external output."""

import json
import sys

from parsers import DocError, LocalOCR, inspect_pdf, parse_document, pdf_for_render, render_page


def serialize(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("utf-8")


def perform(action, kind, arguments, source):
    if action == "render":
        count, image = render_page(source, int(arguments[0]))
        return count.to_bytes(4, "big") + image
    if action == "convert":
        return pdf_for_render(source, kind)
    if action == "inspect":
        return serialize(inspect_pdf(source))
    result = parse_document(source, kind, LocalOCR(), comparison=action == "text")
    if action == "text":
        return serialize({"sha256": result["sha256"], "pageCount": result["pageCount"],
                          "text": "\n\n".join(page["text"] for page in result["pages"])})
    return serialize(result)


if __name__ == "__main__":
    try:
        action, kind, *arguments = sys.argv[1:]
        output = perform(action, kind, arguments, sys.stdin.buffer.read())
    except DocError as error:
        sys.stdout.buffer.write(serialize({"code": error.code, "status": error.status}))
        raise SystemExit(1) from None
    except Exception:
        raise SystemExit(2) from None
    sys.stdout.buffer.write(output)
