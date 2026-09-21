# Page with the explorer (stashed 2026-09-21)

`index.html` is the live page as of commit 9a433cb, including the "Inspect SeeQ on a held-out
demonstration" section (the interactive explorer of validation episode 9), which was removed from
the live page afterwards. Its assets are in `static/explorer/` here.

To restore: copy `index.html` back to the site root, move `static/explorer/` back under the root
`static/`, and re-add `["explorer", null]` to the contents script's section list. The generator and
inputs live in the main repository under `writing/website/scripts/prepare_explorer.py` and
`writing/website/explorer/`.

Note: this snapshot also carries the "current section" marker on the left, which was removed from
the live page afterwards (it overlapped the text on small monitors); drop the `#toc-current` aside,
its CSS and its script branch when restoring.
