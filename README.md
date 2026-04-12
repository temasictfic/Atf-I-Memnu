# Atf-ı Memnu

Atf-ı Memnu is a desktop application designed to analyze, extract, and verify citations and references within academic PDF documents. It automates the process of checking reference validity against multiple major academic databases.

## Features

- **PDF Parsing & Extraction:** Automatically extract text and identify reference sections from academic papers.
- **Citation Verification:** Cross-reference extracted citations against major academic databases to verify their existence and accuracy.
- **Supported Databases:**
  - [arXiv](https://arxiv.org/)
  - [Crossref](https://www.crossref.org/)
  - [Europe PMC](https://europepmc.org/)
  - [OpenAlex](https://openalex.org/)
  - [Semantic Scholar](https://www.semanticscholar.org/)
  - [TR Dizin](https://trdizin.gov.tr/)
  - [PubMed](https://pubmed.ncbi.nlm.nih.gov/)
  - [CORE](https://core.ac.uk/)
  - [PLOS](https://journals.plos.org/)
  - [Open Library](https://openlibrary.org/)
- **Real-time Progress:** Uses WebSockets to provide real-time feedback during the parsing and verification process.
- **Modern Desktop UI:** Built with Electron and React for a smooth, cross-platform user experience.

## Architecture

The project is structured as a full-stack desktop application:

- **Frontend (Renderer):** React with TypeScript, built using Vite. Handles the user interface, PDF store management, and real-time updates.
- **Desktop Environment (Main/Preload):** Electron framework bridging the frontend UI with the local file system and background services.
- **Backend Service:** Python-based REST and WebSocket API built with FastAPI. It handles the heavy lifting of PDF text extraction, fuzzy matching, rate-limiting, and concurrent database scraping/verification.

## Prerequisites

To build and run this project locally, you will need:

- **Node.js** (v22 or higher recommended)
- **Python** (v3.12 or higher recommended)
- **uv** (Fast Python package installer and resolver)

## Getting Started

### 1. Install Node Dependencies

```bash
npm install
```

### 2. Set Up the Python Backend

The backend uses `uv` for dependency management. Navigate to the `backend` directory and set up the virtual environment:

```bash
cd backend
uv venv
# Activate the virtual environment
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

uv pip install -r pyproject.toml
```

*Alternatively, the application may have scripts (like `scripts/build-backend.ps1`) to automate backend building.*

### 3. Run the Application in Development Mode

From the root directory, start the Electron development server. This will launch both the Vite development server for the React frontend and the Electron application.

```bash
npm run dev
```

*(Note: Ensure your Python backend is running or that the Electron main process automatically spawns it, depending on your environment setup).*

## Building for Production

To build the application for your operating system:

```bash
npm run build
```

This uses `electron-builder` to package the React frontend, the Electron main process, and the bundled Python backend into a standalone windows executable.

## License

