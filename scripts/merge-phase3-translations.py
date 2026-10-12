#!/usr/bin/env python3
"""Merge Phase 3 survey-editor translations into each locale bundle.

Locale parity (tests/i18n.test.ts) requires every locale to define exactly the
English key set, and flags whole English strings left in place of a translation.
Each scripts/i18n-phase3/<locale>.json holds the translated sections for one
locale; this merges them in.

Run from the repo root: python3 scripts/merge-phase3-translations.py
"""
import json
import os
import sys

DIR = "app/lib/i18n/locales"
SRC = "scripts/i18n-phase3"


def main() -> int:
    with open(os.path.join(SRC, "validation.json")) as fh:
        validation = json.load(fh)
    with open(os.path.join(SRC, "_validation-en.json")) as fh:
        english_validation = json.load(fh)

    # English is the reference bundle: add the new keys there too.
    en_path = os.path.join(DIR, "en.json")
    with open(en_path) as fh:
        en = json.load(fh)
    en.setdefault("surveys", {}).update(english_validation["surveys"])
    with open(en_path, "w") as fh:
        json.dump(en, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print("updated en")

    for locale, sections in validation.items():
        path = os.path.join(DIR, f"{locale}.json")
        with open(path) as fh:
            data = json.load(fh)
        data.setdefault("surveys", {}).update(sections)
        with open(path, "w") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print("updated validation", locale)

    for filename in sorted(os.listdir(SRC)):
        if not filename.endswith(".json") or filename.startswith("_") or filename == "validation.json":
            continue
        locale = filename[: -len(".json")]
        with open(os.path.join(SRC, filename)) as fh:
            sections = json.load(fh)
        path = os.path.join(DIR, f"{locale}.json")
        with open(path) as fh:
            data = json.load(fh)
        for section, values in sections.items():
            data.setdefault(section, {})
            if section == "templates":
                for key, entry in values.items():
                    data[section].setdefault(key, {}).update(entry)
            else:
                data[section].update(values)
        with open(path, "w") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print("updated", locale)
    return 0


if __name__ == "__main__":
    sys.exit(main())
