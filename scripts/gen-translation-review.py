import json

LANGS = [("de","Deutsch"),("es","Español"),("fr","Français"),("it","Italiano"),
         ("ja","日本語"),("nl","Nederlands"),("pt-BR","Português (Brasil)"),
         ("sv","Svenska"),("zh-CN","简体中文")]

def leaves(d, prefix=""):
    out = {}
    for k, v in d.items():
        if isinstance(v, dict):
            out.update(leaves(v, prefix + k + "."))
        else:
            out[prefix + k] = v
    return out

admin_en = leaves(json.load(open("app/lib/i18n/locales/en.json")))
tpl_en = leaves(json.load(open("shared/templates/locales/en.json")))

PLAN_NS = ("library.", "templates.", "results.", "studio.", "confidence.",
           "ideas.", "home.", "setup.", "ready.", "smart_actions.")
admin_keys = sorted(k for k in admin_en if k.startswith(PLAN_NS))
tpl_keys = sorted(tpl_en)

admin_by_lang = {c: leaves(json.load(open(f"app/lib/i18n/locales/{c}.json"))) for c,_ in LANGS}
tpl_by_lang = {c: leaves(json.load(open(f"shared/templates/locales/{c}.json"))) for c,_ in LANGS}

L = []
L.append("# Translation review — Templates, Insight Library and Survey Studio")
L.append("")
L.append("Every string this build adds, grouped by language, so a native speaker can")
L.append("review it. **English (`en`) is the source** and is shown first; each other")
L.append("column is that language's translation of the same key.")
L.append("")
L.append("Two string sets:")
L.append("")
L.append(f"- **Template content** — `shared/templates/locales/<code>.json` ({len(tpl_keys)} keys).")
L.append("  Template names, one-liners, learn bullets, question text, answer options,")
L.append("  ideas, tag text and tooltips, packs and season banners. Highest review value.")
L.append("- **Admin UI** — `app/lib/i18n/locales/<code>.json`, the plan's namespaces")
L.append("  (`library.*`, `templates.*`, `results.*`, `studio.*`, `confidence.*`,")
L.append(f"  `ideas.*`, `home.*`, `setup.*`, `ready.*`, `smart_actions.*`) ({len(admin_keys)} keys).")
L.append("")
L.append("How to use this file: send the section for one language to a native speaker and")
L.append("ask them to flag anything that reads unnaturally, is too long for its button, or")
L.append("uses a wrong register. Brand names (Instagram, TikTok, …) are intentionally")
L.append("untranslated. German uses the formal *Sie*; the other languages use the informal form.")
L.append("")
L.append("A key-parity test (`tests/unit/template-locales.test.ts` and `tests/i18n.test.ts`)")
L.append("fails if any key in `en` is missing from another language, so coverage is enforced;")
L.append("this file is for *quality*, not coverage.")
L.append("")

def emit(title, keys, en_map, lang_maps):
    L.append(f"## {title}")
    L.append("")
    L.append("| Key | English | " + " | ".join(n for _, n in LANGS) + " |")
    L.append("|---|---|" + "---|" * len(LANGS))
    for k in keys:
        row = [f"`{k}`", str(en_map.get(k, "")).replace("|", "\\|")]
        for c, _ in LANGS:
            row.append(str(lang_maps[c].get(k, "")).replace("|", "\\|"))
        L.append("| " + " | ".join(row) + " |")
    L.append("")

emit("Template content", tpl_keys, tpl_en, tpl_by_lang)
emit("Admin UI", admin_keys, admin_en, admin_by_lang)

open("TRANSLATION_REVIEW.md", "w").write("\n".join(L) + "\n")
print("wrote", len(L), "lines; tpl", len(tpl_keys), "admin", len(admin_keys))
