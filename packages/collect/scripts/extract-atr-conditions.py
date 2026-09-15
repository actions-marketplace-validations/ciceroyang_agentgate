#!/usr/bin/env python3
"""Extract detection conditions and catalog metadata from an ATR-style rule tree.

YAML scalar handling (single quotes, double quotes, block scalars, plain) is
delegated to a real parser instead of being reimplemented. A hand-rolled line
scanner that understood only double-quoted scalars silently kept 1128 of 3443
conditions and produced a false precision figure.

Read-only: reads a local checkout of the rules, writes only the --out file.
"""
import argparse
import glob
import hashlib
import json
import os
import re
import sys

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required: python3 -m pip install pyyaml")

CVE_RE = re.compile(r"CVE-\d{4}-\d+")


def string_list(value):
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("rules_dir")
    ap.add_argument("--out", required=True)
    ap.add_argument("--label", default=None, help="portable source label; defaults to the directory basename")
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.rules_dir, "**", "*.yaml"), recursive=True))
    conditions = []
    rules = []
    errors = []
    digest = hashlib.sha256()
    for path in files:
        with open(path, "rb") as fh:
            raw = fh.read()
        digest.update(raw)
        text = raw.decode("utf-8", "replace")
        try:
            doc = yaml.safe_load(text)
        except Exception as exc:  # noqa: BLE001 - reported, never swallowed
            errors.append({"file": path, "error": str(exc)[:200]})
            continue
        if not isinstance(doc, dict):
            continue
        rid = doc.get("id")
        tags = doc.get("tags") if isinstance(doc.get("tags"), dict) else {}
        refs = doc.get("references") if isinstance(doc.get("references"), dict) else {}
        comp = doc.get("compliance") if isinstance(doc.get("compliance"), dict) else {}
        asi = set()
        for tag in string_list(refs.get("owasp_agentic")):
            asi.add(tag.split(":")[0])
        for entry in comp.get("owasp_agentic") or []:
            if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                asi.add(entry["id"].split(":")[0])
        cves = set()
        for entry in string_list(refs.get("cve")):
            cves.update(CVE_RE.findall(entry))
        cves.update(CVE_RE.findall(text))
        detection = doc.get("detection") if isinstance(doc.get("detection"), dict) else {}
        mode = detection.get("condition")
        rules.append({
            "id": rid,
            "scanTarget": tags.get("scan_target") if isinstance(tags.get("scan_target"), str) else None,
            "asi": sorted(asi),
            "cves": sorted(cves),
            "tier": doc.get("detection_tier") if isinstance(doc.get("detection_tier"), str) else None,
            "severity": doc.get("severity") if isinstance(doc.get("severity"), str) else None,
            "conditionMode": mode if isinstance(mode, str) else None,
            "suppressInCodeBlocks": bool(tags.get("suppress_in_code_blocks")),
        })
        if not isinstance(detection, dict) or not detection:
            continue
        items = detection.get("conditions")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            value = item.get("value")
            conditions.append({
                "id": rid,
                "field": item.get("field") if isinstance(item.get("field"), str) else None,
                "operator": item.get("operator") if isinstance(item.get("operator"), str) else None,
                "value": value if isinstance(value, str) else json.dumps(value, ensure_ascii=False),
            })

    payload = {
        "source": args.label or os.path.basename(os.path.abspath(args.rules_dir.rstrip("/"))),
        "files": len(files),
        "rules_digest": "sha256:" + digest.hexdigest(),
        "rules": rules,
        "conditions": conditions,
        "parseErrors": errors,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    counts = {}
    for c in conditions:
        counts[c["field"]] = counts.get(c["field"], 0) + 1
    print("files {} conditions {} parseErrors {}".format(len(files), len(conditions), len(errors)))
    print("byField " + json.dumps(dict(sorted(counts.items(), key=lambda kv: -kv[1]))))


if __name__ == "__main__":
    main()