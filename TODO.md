# TODO

## Improve arXiv paper and PDF paper parsing

- Unpack arXiv source packages saved from the browser clipper.
- Detect the main `.tex` entrypoint and resolve `\input` / `\include` files.
- Merge bibliography context from `.bib` / `.bbl` files when available.
- Preserve paper structure: title, abstract, sections, equations, citations, figures, tables, captions, and appendix boundaries.
- Improve PDF paper parsing beyond plain text extraction, including section-aware extraction, equation/citation handling, figure/table captions, and cleaner reading order.
- Prefer LaTeX source when available; fall back to the improved PDF parser otherwise.

## Adjust paper ingest prompts

- Add a dedicated prompt path for `type: arxiv-paper` sources.
- Treat `## alphaXiv Overview` as a high-quality secondary overview, not as a replacement for the original paper.
- Treat `## Paper Content` and original PDF/source artifacts as the primary source of evidence.
- Ask the model to extract paper-specific fields: problem, motivation, method, architecture/algorithm, experiments, datasets, metrics, results, ablations, limitations, and follow-up questions.
- Ask the model to use figure/image paths, captions, tables, and equations as evidence signals when present.
- For PDF-only papers, tell the model to preserve uncertainty around missing figures/layout and flag TODOs for future multimodal PDF parsing.
