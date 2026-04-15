# TODO

## Improve arXiv paper and PDF paper parsing

- Unpack arXiv source packages saved from the browser clipper.
- Detect the main `.tex` entrypoint and resolve `\input` / `\include` files.
- Merge bibliography context from `.bib` / `.bbl` files when available.
- Preserve paper structure: title, abstract, sections, equations, citations, figures, tables, captions, and appendix boundaries.
- Improve PDF paper parsing beyond plain text extraction, including section-aware extraction, equation/citation handling, figure/table captions, and cleaner reading order.
- Prefer LaTeX source when available; fall back to the improved PDF parser otherwise.
