"""Compare local L08 source files to the T1 reference without printing document text."""

import argparse
import base64
import json
import re
import unicodedata
from collections import defaultdict
from difflib import SequenceMatcher
from pathlib import Path, PurePosixPath

from parsers import MAX_INPUT, LocalOCR, parse_document, sha256


def locate(root, relative):
    path = PurePosixPath(relative)
    if path.is_absolute() or any(part in {"..", "."} for part in path.parts):
        raise ValueError("path")
    current = root
    for part in path.parts:
        exact = current / part
        if exact.exists():
            current = exact.resolve(strict=True)
        else:
            name = unicodedata.normalize("NFC", part)
            matches = [entry for entry in current.iterdir() if unicodedata.normalize("NFC", entry.name) == name]
            if len(matches) != 1:
                raise ValueError("path")
            current = matches[0].resolve(strict=True)
        if not current.is_relative_to(root):
            raise ValueError("path")
    if not current.is_file() or current.stat().st_size > MAX_INPUT:
        raise ValueError("source")
    return current


def measure(old, new):
    return 1.0 if old == new else SequenceMatcher(None, old, new, autojunk=False).ratio()


def kind_for(document):
    extension = document["ext"].lower().lstrip(".")
    return "estar" if extension == "pdf" and document["source_type"] == "外层文件夹" and "estar" in document["name"].lower() else extension


def compare(input_root, reference):
    documents = json.loads((reference / "documents.json").read_text(encoding="utf-8"))
    expected = defaultdict(list)
    with (reference / "pages.jsonl").open(encoding="utf-8") as source:
        for line in source:
            result = json.loads(line)
            expected[result["doc"]].append(result)

    attachments = {}
    parsed = {}
    ocr = LocalOCR()
    issues = []
    notices = []
    summary = {"documents": 0, "pages": 0, "textPages": 0, "ocrPages": 0,
               "ocrBelowThreshold": 0, "officeTextChanges": 0, "xfaExact": False}

    for document in documents:
        label = document["id"] if re.fullmatch(r"D\d{3,4}", document["id"]) else "unknown"
        kind = kind_for(document)
        baseline = expected[label]
        try:
            if document["source_type"] == "eSTAR附件":
                data = attachments[(document["parent"], document["sha256"])]
            else:
                data = locate(input_root, document["path"]).read_bytes()
            digest = sha256(data)
            if digest != document["sha256"]:
                issues.append({"document": label, "reason": "input_hash_differs"})
                continue
            if kind not in {"pdf", "estar", "doc", "docx", "xlsx"}:
                if baseline:
                    issues.append({"document": label, "reason": "format_has_reference_pages"})
                summary["documents"] += 1
                continue
            key = (digest, kind)
            if key not in parsed:
                parsed[key] = parse_document(data, kind, ocr)
            actual = parsed[key]
            if kind == "estar":
                for item in actual["attachments"]:
                    attachments[(label, item["sha256"])] = base64.b64decode(item["bodyBase64"], validate=True)
                data_set = actual["xfaDatasetsBase64"]
                summary["xfaExact"] = bool(data_set) and base64.b64decode(data_set, validate=True) == (reference / "estar_datasets.xml").read_bytes()
                if not summary["xfaExact"]:
                    issues.append({"document": label, "reason": "xfa_differs"})
        except Exception as error:
            code = getattr(error, "code", "comparison_unavailable")
            reason = code if re.fullmatch(r"DOC_[A-Z0-9_]{1,60}", code) else "comparison_unavailable"
            issues.append({"document": label, "reason": reason})
            continue

        summary["documents"] += 1
        summary["pages"] += len(actual["pages"])
        if len(actual["pages"]) != len(baseline):
            issues.append({"document": label, "reason": "page_count_differs",
                           "expected": len(baseline), "actual": len(actual["pages"])})
        for before, after in zip(baseline, actual["pages"]):
            location = {"document": label, "page": before["page"]}
            if before["method"] == "text":
                summary["textPages"] += 1
                if before["text"] != after["text"] or after["method"] != "text":
                    issues.append({**location, "reason": "text_layer_differs",
                                   "whitespaceEquivalent": " ".join(before["text"].split()) == " ".join(after["text"].split()),
                                   "similarity": round(measure(before["text"], after["text"]), 4)})
            elif before["method"] == "ocr":
                summary["ocrPages"] += 1
                similarity = measure(before["text"], after["text"])
                if similarity < 0.98 or after["method"] != "ocr":
                    summary["ocrBelowThreshold"] += 1
                    issues.append({**location, "reason": "ocr_differs", "similarity": round(similarity, 4)})
            elif before["text"] != after["text"]:
                summary["officeTextChanges"] += 1
                notices.append({**location, "reason": "legacy_word_conversion" if kind == "doc" else "office_text_differs",
                                "similarity": round(measure(before["text"], after["text"]), 4)})

    if not summary["xfaExact"] and not any(item["reason"] == "xfa_differs" for item in issues):
        issues.append({"reason": "xfa_not_compared"})
    print(json.dumps({"summary": summary, "differences": issues, "officeDifferences": notices}, ensure_ascii=True, indent=2))
    return 1 if issues else 0


if __name__ == "__main__":
    arguments = argparse.ArgumentParser()
    arguments.add_argument("input_root", type=Path)
    arguments.add_argument("reference", type=Path)
    options = arguments.parse_args()
    try:
        raise SystemExit(compare(options.input_root.resolve(strict=True), options.reference.resolve(strict=True)))
    except (OSError, TypeError, ValueError):
        print('{"error":"DOC_L08_INPUT_UNAVAILABLE"}')
        raise SystemExit(1) from None
