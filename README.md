# Atf-ı Memnu

A Windows desktop app for parsing academic PDFs, extracting their reference lists, and verifying each citation against a panel of scholarly databases — with a dedicated review UI for annotating, correcting, and approving the extracted sources before verification.

## What it does

1. **Ingest** — point it at a directory or drop in a batch of PDFs. Each file is parsed in the renderer via `pdfjs-dist`; the reference section is located and individual sources split into editable bounding-box rectangles.
2. **Review** — the parsing page shows each PDF in the middle with its detected source rectangles overlaid. You can draw new ones, edit the text, merge/split, add highlight and callout annotations, and export an annotated copy of the PDF.
3. **Extract fields (NER)** — for the selected source, a bundled fine-tuned ONNX citation-parser model (via `onnxruntime` + `tokenizers`) extracts title, authors, year, journal, DOI, etc. into structured fields.
4. **Verify** — the verification page pushes each approved source through the enabled database verifiers in parallel and shows per-database status as it streams in over WebSocket. Sources that don't match can be re-checked via the built-in Google Scholar scanner (a hidden Electron `<webview>` that scrapes results with CAPTCHA handoff).

## Supported verifiers

- [Crossref](https://www.crossref.org/) · [OpenAlex](https://openalex.org/) · [OpenAIRE](https://explore.openaire.eu/) · [Europe PMC](https://europepmc.org/)
- [arXiv](https://arxiv.org/) · [PubMed](https://pubmed.ncbi.nlm.nih.gov/) · [TR Dizin](https://trdizin.gov.tr/)
- [Open Library](https://openlibrary.org/) · [Semantic Scholar](https://www.semanticscholar.org/)

Each verifier shares a single pooled `aiohttp` session and reports `found` / `not_found` / `error` / `timeout` per source. API keys for OpenAlex, Semantic Scholar, and PubMed can be set in the Settings page.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Electron main process (Node)                                 │
│  ├─ Spawns the Python backend as a subprocess               │
│  ├─ Handles file dialogs, PDF read/write, auto-update       │
│  └─ Secure IPC via preload + contextBridge                  │
└──────────────┬───────────────────────────────────────────────┘
               │
┌──────────────▼───────────────┐      ┌────────────────────────┐
│ Renderer (React + TS + Vite) │◄────►│ Python backend         │
│  ├─ pdfjs-dist pipeline      │ HTTP │  (FastAPI + uvicorn)   │
│  │   (parse, render, detect, │  WS  │  ├─ NER field extract  │
│  │   extract, annotate)      │      │  │   (ONNX Runtime     │
│  ├─ Zustand stores           │      │  │   + DirectML/CPU)   │
│  ├─ Parsing/Verification/    │      │  ├─ Verifier panel     │
│  │   Settings pages          │      │  ├─ Match scorer       │
│  └─ Scholar scanner webview  │      │  └─ Author matcher     │
└──────────────────────────────┘      └────────────────────────┘
```

Key design notes:

- **PDF handling lives in the renderer.** Opening, rendering, reference detection, bbox text extraction, and annotation writing all run in the renderer via `pdfjs-dist` and `pdf-lib` — the Python side never touches PDF bytes. This keeps page switches fast and the backend small. There's an in-memory LRU cache of parsed `PDFDocumentProxy` instances so flipping between recently-viewed PDFs skips disk I/O and document parse.
- **NER is the only reason Python is in the loop.** A fine-tuned RoBERTa-based citation-parser model is bundled as a quantized INT8 ONNX file (~125 MB, tracked via git LFS). At runtime we use `onnxruntime-directml` with a DirectML → CPU fallback and a tiny `tokenizers`-based pipeline — no `transformers`, no `optimum`, no `torch`, so the packaged bundle stays lean.
- **PyInstaller + electron-builder.** The backend is frozen to a standalone exe via PyInstaller (spec excludes torch/tf/jax, disables UPX for onnxruntime DLL safety, and hard-fails the build if the LFS NER model is just a pointer file). The Electron app bundles that exe as `extraResources`.
- **Single-language bundle.** Only `en-US` and `tr` Chromium locale paks are shipped.

## Prerequisites

- **Node.js** ≥ 22
- **Python** ≥ 3.12 (managed by `uv`)
- **uv** — fast Python package manager (`pipx install uv` or see [uv docs](https://docs.astral.sh/uv/))
- **Git LFS** — required to pull the bundled NER model. After cloning, run `git lfs pull`.
- **Windows 10/11** — the release pipeline and the `onnxruntime-directml` provider are Windows-only. Linux/macOS development is possible with the CPU provider but untested for packaging.

## Getting started

```bash
# 1. Clone + pull LFS assets
git clone <repo-url>
cd atfimemnu
git lfs pull    # pulls the ~125 MB NER model

# 2. Install Node + Python deps
npm install
cd backend && uv sync && cd ..

# 3. Run in dev mode (Electron spawns the Python backend automatically)
npm run dev
```

## Building a release

Build order matters: the backend must be frozen before electron-builder packages it.

```bash
npm run build:backend   # PyInstaller → backend/dist/atfi-memnu-backend/
npm run build           # electron-vite: main + preload + renderer
npm run dist:win        # electron-builder: NSIS installer + portable exe
```

Or use the combined script that runs the full chain:

```bash
npm run dist:win
```

Output lands in `dist/` — an `Atf-I Memnu Setup X.Y.Z.exe` installer and a portable `Atf-I Memnu X.Y.Z.exe`.

### Cutting a tagged release

```bash
npm run release:tag    # bumps version, commits, tags, pushes
```

The push triggers `.github/workflows/release.yml` which runs on `windows-latest`, pulls LFS, syncs the frozen backend env (`uv sync --frozen`), builds, and publishes the installer to GitHub Releases.

## Project layout

```
.
├── backend/                    # Python FastAPI service (frozen into .exe)
│   ├── api/                    # REST routers
│   ├── services/               # NER, match scoring, author matcher, orchestrator
│   ├── verifiers/              # Per-database search modules + shared session
│   ├── models/citation-ner-int8/   # Bundled INT8 ONNX model (LFS)
│   ├── atfi-memnu-backend.spec # PyInstaller spec
│   └── pyproject.toml
├── src/
│   ├── main/                   # Electron main process
│   ├── preload/                # contextBridge IPC surface
│   └── renderer/src/
│       ├── lib/pdf/            # pdfjs pipeline (parser, detector, annotator, cache)
│       ├── lib/components/     # Parsing / Verification / Settings pages
│       ├── lib/stores/         # Zustand stores
│       └── lib/services/       # Scholar scanner
├── scripts/                    # Build + release + asset optimization
├── electron-builder.yml
├── electron.vite.config.ts
└── package.json
```

## License

(specify)
