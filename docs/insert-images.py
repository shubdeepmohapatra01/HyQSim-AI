#!/usr/bin/env python3
"""
Swap `<!-- IMAGE: name.png -->` placeholders for real markdown image tags.

Each placeholder in the docs is followed by a blockquote describing what to capture. Once
you drop the actual file into docs/images/, run this: it replaces the comment *and* its
description blockquote with a proper image tag, deriving the alt text from the description
so the result stays accessible.

Placeholders whose image file does not exist yet are left untouched, so it is safe to run
after every screenshot rather than waiting until they are all done.

    python3 docs/insert-images.py            # show what would change
    python3 docs/insert-images.py --apply    # write the changes

Screenshots live in docs/images/ and are referenced as `docs/images/<name>` — README.md and
WALKTHROUGH.md both sit at the repository root, so the same relative path works from either.
Capture at 1440 px wide on the dark theme, downscale to <=1600 px, keep each under ~400 KB,
and make sure no API key is legible before committing.

To do it by hand instead, replace the `<!-- IMAGE: name.png -->` comment AND the description
blockquote beneath it with a single line:

    ![Alt text describing the image](docs/images/name.png)
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMAGE_DIR = ROOT / "docs" / "images"
DOCS = ["README.md", "WALKTHROUGH.md", "AI_GUIDE.md", "CHANGELOG.md"]

PLACEHOLDER = re.compile(r"^<!-- IMAGE: (\S+) -->\s*$")


def alt_text_from(description: list[str], filename: str) -> str:
    """
    Builds alt text from the description blockquote.

    Prefers the bolded lead-in ("**Screenshot 8 — the Wigner function.**") since that is
    already a written summary of the image. Falls back to the filename.
    """
    joined = " ".join(line.lstrip("> ").strip() for line in description)
    # Drop capture instructions — they describe how to take the shot, not what it shows.
    joined = re.split(r"\bCapture this one\b|\bMake this\b|\bIdeally\b|\bFull window\b", joined)[0]
    bold = re.search(r"\*\*(.+?)\*\*", joined)
    if bold:
        text = bold.group(1)
        # "Screenshot 8 — the Wigner function." → "the Wigner function"
        text = re.sub(r"^Screenshot\s+\d+\s*[—–-]\s*", "", text)
        return text.rstrip(".").strip() or filename
    return filename


def process(path: Path, apply: bool) -> tuple[int, int]:
    lines = path.read_text().split("\n")
    out: list[str] = []
    inserted = waiting = 0
    i = 0

    while i < len(lines):
        match = PLACEHOLDER.match(lines[i])
        if not match:
            out.append(lines[i])
            i += 1
            continue

        filename = match.group(1)
        # Collect the description blockquote that follows the placeholder.
        j = i + 1
        description: list[str] = []
        while j < len(lines) and lines[j].startswith(">"):
            description.append(lines[j])
            j += 1

        if not (IMAGE_DIR / filename).exists():
            waiting += 1
            print(f"    waiting   {filename:28} (drop it in docs/images/)")
            out.extend(lines[i:j])
            i = j
            continue

        alt = alt_text_from(description, filename)
        out.append(f"![{alt}](docs/images/{filename})")
        inserted += 1
        print(f"    inserted  {filename:28} alt: \"{alt}\"")
        i = j

    if apply and inserted:
        path.write_text("\n".join(out))
    return inserted, waiting


def main() -> int:
    apply = "--apply" in sys.argv

    if not IMAGE_DIR.exists():
        print(f"No {IMAGE_DIR} directory. Create it and add your screenshots first.")
        return 1

    present = sorted(p.name for p in IMAGE_DIR.iterdir() if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".svg"})
    print(f"\n{len(present)} image(s) in docs/images/: {', '.join(present) or '(none yet)'}\n")

    total_inserted = total_waiting = 0
    for name in DOCS:
        path = ROOT / name
        if not path.exists():
            continue
        text = path.read_text()
        if "<!-- IMAGE:" not in text:
            continue
        print(f"  {name}")
        inserted, waiting = process(path, apply)
        total_inserted += inserted
        total_waiting += waiting
        print()

    if total_inserted == 0:
        print("Nothing to insert — add screenshots to docs/images/ first.\n")
    elif apply:
        print(f"Inserted {total_inserted} image(s). {total_waiting} placeholder(s) still waiting.\n")
    else:
        print(f"Would insert {total_inserted} image(s). {total_waiting} still waiting.")
        print("Re-run with --apply to write the changes.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
