from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont


ROOT = Path(__file__).resolve().parent.parent
FONT_PATH = ROOT / "SagabonPrototype.otf"
OUTPUT_PATH = ROOT / "public" / "font-metadata.json"


def build_feature_map(font: TTFont) -> dict[str, list[int]]:
    feature_map: dict[str, list[int]] = defaultdict(list)
    gsub = font["GSUB"].table
    for record in gsub.FeatureList.FeatureRecord:
        feature_map[record.FeatureTag].extend(record.Feature.LookupListIndex)
    return feature_map


def iter_lookup_subtables(font: TTFont, lookup_indexes: list[int]):
    lookups = font["GSUB"].table.LookupList.Lookup
    for lookup_index in lookup_indexes:
        lookup = lookups[lookup_index]
        for subtable in lookup.SubTable:
            extended = getattr(subtable, "ExtSubTable", subtable)
            lookup_type = getattr(subtable, "ExtensionLookupType", lookup.LookupType)
            yield lookup_type, extended


def build_vertical_map(font: TTFont, feature_map: dict[str, list[int]]) -> dict[str, str]:
    vertical_map: dict[str, str] = {}
    for tag in ("vert", "vrt2"):
        for lookup_type, subtable in iter_lookup_subtables(font, feature_map.get(tag, [])):
            if lookup_type != 1 or not hasattr(subtable, "mapping"):
                continue
            vertical_map.update(subtable.mapping)
    return vertical_map


def detect_base_vertical_advance(font: TTFont, vertical_map: dict[str, str]) -> int:
    vmtx = font["vmtx"].metrics
    counts = Counter()
    for glyph_name in set(vertical_map.values()):
        if glyph_name in vmtx:
            counts[vmtx[glyph_name][0]] += 1
    if not counts:
        return font["head"].unitsPerEm
    return counts.most_common(1)[0][0]


def build_alternate_map(font: TTFont, feature_map: dict[str, list[int]]) -> dict[str, list[str]]:
    alternate_map: dict[str, set[str]] = defaultdict(set)
    for lookup_type, subtable in iter_lookup_subtables(font, feature_map.get("aalt", [])):
        if lookup_type == 1 and hasattr(subtable, "mapping"):
            for source, target in subtable.mapping.items():
                alternate_map[source].add(target)
        elif lookup_type == 3 and hasattr(subtable, "alternates"):
            for source, targets in subtable.alternates.items():
                alternate_map[source].update(targets)
    return {glyph: sorted(targets) for glyph, targets in alternate_map.items()}


def build_ligature_map(font: TTFont, feature_map: dict[str, list[int]]) -> dict[str, object]:
    trie: dict[str, object] = {}
    for lookup_type, subtable in iter_lookup_subtables(font, feature_map.get("liga", [])):
        if lookup_type != 4 or not hasattr(subtable, "ligatures"):
            continue
        for first_glyph, ligatures in subtable.ligatures.items():
            for ligature in ligatures:
                sequence = [first_glyph, *ligature.Component]
                cursor = trie
                for glyph_name in sequence:
                    cursor = cursor.setdefault(glyph_name, {})
                cursor["$"] = ligature.LigGlyph
    return trie


def build_reverse_cmap(font: TTFont) -> tuple[dict[str, str], dict[str, list[str]]]:
    char_to_glyph: dict[str, str] = {}
    glyph_to_chars: dict[str, set[str]] = defaultdict(set)
    for table in font["cmap"].tables:
        for codepoint, glyph_name in table.cmap.items():
            if codepoint in (0xFFFF,):
                continue
            char = chr(codepoint)
            char_to_glyph.setdefault(char, glyph_name)
            glyph_to_chars[glyph_name].add(char)
    return char_to_glyph, {glyph: sorted(chars) for glyph, chars in glyph_to_chars.items()}


def build_glyph_data(font: TTFont, glyph_to_chars: dict[str, list[str]]) -> dict[str, dict[str, object]]:
    glyph_set = font.getGlyphSet()
    glyph_data: dict[str, dict[str, object]] = {}

    hmtx = font["hmtx"].metrics
    vmtx = font["vmtx"].metrics
    vorg = font["VORG"]
    for glyph_name in font.getGlyphOrder():
        glyph = glyph_set[glyph_name]

        path_pen = SVGPathPen(glyph_set)
        glyph.draw(path_pen)
        path_data = path_pen.getCommands() or ""

        bounds_pen = BoundsPen(glyph_set)
        glyph.draw(bounds_pen)
        if bounds_pen.bounds:
            x_min, y_min, x_max, y_max = bounds_pen.bounds
        else:
            x_min = y_min = x_max = y_max = 0

        glyph_data[glyph_name] = {
            "path": path_data,
            "bounds": {"xMin": x_min, "yMin": y_min, "xMax": x_max, "yMax": y_max},
            "advanceWidth": hmtx.get(glyph_name, (0, 0))[0],
            "advanceHeight": vmtx.get(glyph_name, (font["head"].unitsPerEm, 0))[0],
            "topSideBearing": vmtx.get(glyph_name, (font["head"].unitsPerEm, 0))[1],
            "vertOriginY": vorg.VOriginRecords.get(glyph_name, vorg.defaultVertOriginY),
            "chars": glyph_to_chars.get(glyph_name, []),
        }
    return glyph_data


def main() -> None:
    font = TTFont(FONT_PATH)
    feature_map = build_feature_map(font)
    char_to_glyph, glyph_to_chars = build_reverse_cmap(font)
    vertical_map = build_vertical_map(font, feature_map)

    metadata = {
        "fontFile": FONT_PATH.name,
        "unitsPerEm": font["head"].unitsPerEm,
        "baseVerticalAdvance": detect_base_vertical_advance(font, vertical_map),
        "fontBounds": {
            "xMin": font["head"].xMin,
            "yMin": font["head"].yMin,
            "xMax": font["head"].xMax,
            "yMax": font["head"].yMax,
        },
        "charToGlyph": char_to_glyph,
        "glyphData": build_glyph_data(font, glyph_to_chars),
        "verticalMap": vertical_map,
        "alternateMap": build_alternate_map(font, feature_map),
        "ligatureTrie": build_ligature_map(font, feature_map),
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(metadata, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
