# latex-cowrite

Self-hosted collaborative LaTeX editor (Overleaf-style).

This is **Phase 1**: an anonymous collaborative editor with a working compile pipeline.

* Multi-file **projects**, each with its own folder on disk under `projects/`
* File tree on the left you can browse, open, and edit (CodeMirror), alongside a project picker and "+ New Project" / "+ New File" / "+ New Folder"
* Selectable PDF preview in the browser's native PDF viewer on the right
* Real-time file sync for users in the same project, with live cursor/presence updates
* Project-scoped `Shared undo history` toggle (default off): live editing stays on for everyone, but each collaborator's Ctrl/Cmd+Z only undoes their own edits unless the project explicitly opts into shared undo history
* Compile on click using [`tectonic`](https://tectonic-typesetting.github.io/) — compiles the whole project (so `\input`, `\include`, and other in-project references resolve correctly), not just a single file
* Compile errors shown in a log panel
* Each compile runs against a throwaway copy of the project in its own temporary directory, with a timeout

## Step-by-step setup

### 1. Install Node.js

You need Node.js 18 or newer. The project has been tested with Node 22.

Check your current version:

```bash
node -v
```

If you do not have Node.js installed, download it from [nodejs.org](https://nodejs.org).

### 2. Install `tectonic`

`tectonic` is the LaTeX engine used by the application to convert `.tex` source files into PDFs. It is self-contained, so you do not need to install TeX Live separately.

Choose the instructions for your operating system.

<details>
<summary><b>Windows</b></summary>

Open PowerShell and run these commands one at a time.

```powershell
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
```

Then:

```powershell
iex ((New-Object System.Net.WebClient).DownloadString('https://drop-ps1.fullyjustified.net'))
```

This downloads and extracts `tectonic.exe` into the current directory.

Move it somewhere permanent and add it to your PATH:

```powershell
mkdir C:\tools\tectonic -Force
Move-Item .\tectonic.exe C:\tools\tectonic\
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";C:\tools\tectonic", "User")
```

Close and reopen PowerShell so the PATH change takes effect.

Verify the installation:

```powershell
tectonic --version
```

</details>

<details>
<summary><b>macOS</b></summary>

Install using Homebrew:

```bash
brew install tectonic
```

Verify:

```bash
tectonic --version
```

</details>

<details>
<summary><b>Linux</b></summary>

The easiest cross-distribution option is to download a prebuilt binary from the [Tectonic releases page](https://github.com/tectonic-typesetting/tectonic/releases/latest).

For example, download the appropriate `tectonic-<version>-x86_64-unknown-linux-gnu.tar.gz` archive, extract it, and move the `tectonic` binary somewhere on your PATH, such as `/usr/local/bin`.

If your distribution provides a package, you can use that instead.

For Arch Linux:

```bash
sudo pacman -S tectonic
```

You can also install it through Conda:

```bash
conda install conda-forge::tectonic
```

Verify:

```bash
tectonic --version
```

</details>

### 3. Warm the Tectonic package cache

The first time `tectonic` compiles a document, it may download a LaTeX package bundle. The bundle can be a few hundred MB and is stored in the local cache, usually under `~/.cache/Tectonic` or the equivalent directory on Windows.

Run a test compilation before using the application:

```bash
mkdir tectonic-test
cd tectonic-test
```

Create a file named `test.tex`:

```latex
\documentclass{article}

\begin{document}
hello
\end{document}
```

Compile it:

```bash
tectonic --untrusted -o . --keep-logs test.tex
```

If `test.pdf` is created successfully, the cache is ready.

You can delete the `tectonic-test` directory afterward.

### 4. Install project dependencies

From the project root:

```bash
npm install
```

### 5. Build the real-time collaboration bundle

Real-time collaborative editing is powered by [Yjs](https://yjs.dev), which
is published as ES modules meant for a bundler. Since the rest of this
app's frontend intentionally has no build step (CodeMirror is loaded from a
CDN `<script>` tag, and `app.js` is a plain script), only this piece gets
pre-bundled, into `public/collab-bundle.js`:

```bash
npm run build
```

Run this once after `npm install`, and again any time you change the
collaboration bundle's dependencies (`yjs`, `y-protocols`, `y-websocket`, or
`y-codemirror` in `package.json`, or `collab-src/index.js` itself).
`public/collab-bundle.js` (and its sourcemap) are build output, not meant to
be hand-edited.

### 6. Run the application

```bash
npm start
```

Open:

```text
http://localhost:3000
```

Enter some LaTeX in the left pane and click **Compile**. Open the same
project in a second browser tab (or from a second computer) to see live,
character-level collaborative editing, the "collaborating" pill above the
editor reflects that file's real-time connection status.

## Working with projects

Everything lives under a `projects/` folder at the repo root (created automatically on first run). Each subfolder is one project:

```text
projects/
  demo/
    main.tex
    sections/
      intro.tex
  your-project/
    main.tex
    figures/
      diagram.png
    refs.bib
```

* A **demo** project is seeded automatically the first time you run the app, so the UI never opens empty.
* Use the project dropdown in the header to switch between projects, and **+ Project** to create a new one (it's seeded with an empty `main.tex`).
* The file tree on the left shows the whole folder layout for the active project. Click a file to open it; click a folder to expand/collapse it.
* **+ File** / **+ Folder** create a new entry at a path you type (e.g. `sections/results.tex` or `figures`), including any missing parent folders.
* Only recognized text files are editable in the browser: `.tex .bib .cls .sty .txt .md .json .yml .yaml .log`. Anything else (images, existing PDFs, etc.) still shows in the tree so the layout is visible, but isn't opened as text.
* **Compile** always builds `main.tex` if one exists at the project's top level, otherwise the first `.tex` file it finds there. There's no per-file "set as main" yet, see Roadmap.
* You can also add files to a project directly on disk (drag a folder into `projects/your-project/`), the tree picks up anything there on next load, no restart needed.

## Project settings and shared undo history

Each project has a persisted settings file named `.longtex.json` at the project root. It is created automatically if it does not already exist.

```json
{
  "allowSharedClipboard": false
}
```

The field name is intentionally kept as `allowSharedClipboard` for compatibility with older configuration and tests, but the UI label is now shown as "Shared Clipboard".

The default is `false`:

* live collaboration remains enabled for all users in the project
* each user keeps their own Ctrl/Cmd+Z history private to their own edits

When `allowSharedClipboard` is set to `true`:

* collaborators can undo each other's edits with the same undo/redo stack behavior that older versions exposed
* the setting is synchronized across all open tabs for the same project immediately over a dedicated Yjs settings room, without a reload

This means the project toggle is now a shared collaborative state, not a per-browser-only setting.

## First-run network note

By default, if a document requires a package that is not already cached, Tectonic may try to download it during compilation.

If you want compilation to fail instead of accessing the network, use:

```bash
TECTONIC_ONLY_CACHED=1 npm start
```

This is recommended when the application is being used by multiple users.

## What's sandboxed and what isn't

Each compilation copies the whole project into its own temporary directory:

```text
os.tmpdir()/texcomp-<id>
```

Tectonic runs against that copy, never the project folder itself so build byproducts (`.aux`, `.log`, the output `.pdf`) never land in your actual project, and the temp copy is deleted after the compilation finishes, fails, or times out.

The following protections are currently enabled:

* `--untrusted` is always passed to Tectonic. This disables shell escape and other potentially dangerous TeX features.
* The compile process is started directly with `shell: false`.
* Arguments are passed directly to the operating system instead of through a shell.
* A timeout is applied to every compilation; the entire process group is terminated on timeout (not just the top process), so a hung compile can't outlive it or leak a subprocess.
* A single file save is limited to 2 MB; total project size is limited to 25 MB per compile.
* Path traversal is blocked on every file/folder API, a requested path that would resolve outside the project's own folder (e.g. `../../etc/passwd`) is rejected.

The following protections are **not** included in Phase 1:

* Filesystem access outside the temporary compilation directory
* Memory limits
* CPU limits
* OS-level network isolation for the Tectonic process

For a real multi-user deployment, compilation should run inside a container or another isolated environment. Docker with `--network none` and resource limits, gVisor, or firejail are possible options.

## Compile performance for large documents

Tectonic still processes the entire document on every compilation, but the app
now keeps a separate cached build workspace for each project. This preserves
`.aux`, `.toc`, bibliography, and other intermediate files between builds while
keeping generated files outside the project directory. Builds for the same
project are serialized so concurrent requests cannot corrupt that workspace.

After each compile, generated artifacts are copied into that project's
`outputs/` folder. This includes the PDF, log, auxiliary files, and other
Tectonic intermediates. The `outputs/` folder is excluded from the compiler's
source copy and is ignored by the repository's existing `projects/` rule.

The server allows up to 120 seconds for a compile. The first build can still be
slow because Tectonic may download packages; later builds reuse the local
Tectonic package cache.

Large or complex documents can take significantly longer to compile. This is especially common with:

* Large bibliographies
* TikZ or PGFPlots
* Documents with many pages
* Documents with many images
* Complex packages

The current implementation uses an asynchronous compile job with a 120-second
hard execution timeout. The client calls `/api/projects/:project/compile/start`
and receives a `jobId` immediately; it then polls `/status` and listens for log
updates until the build finishes, after which the PDF is fetched from `/pdf`.

For faster drafting, keep expensive TikZ/PGFPlots figures and large image
directories out of the document while working, and use a temporary lightweight
entry file that inputs only the chapter being edited. Restore `main.tex` for
the final full-report build. The app does not yet provide a draft/partial-build
mode automatically.

Async compilation with a job ID, polling, and live log streaming are now part
of the implemented workflow.

## API

### `GET /api/tectonic-status`

Returns the availability of Tectonic.

```json
{ "available": true, "detail": "Tectonic 0.17.0" }
```

### `GET /api/projects`

Lists project names.

```json
{ "projects": ["demo", "your-project"] }
```

### `POST /api/projects`

Creates a new project, seeded with an empty `main.tex`.

Request body: `{ "name": "your-project" }` and only letters, numbers, `-`, `_` are allowed as name for e.g. "test$&" is not allowed but "test_1-2" is allowed.

`201` on success, `409` if the name is already taken.

### `GET /api/projects/:project/settings`

Returns the current project settings. The persisted file is `.longtex.json` in the project root.

```json
{
  "settings": {
    "allowSharedClipboard": false
  }
}
```

The field name is kept as `allowSharedClipboard` for backward compatibility, but the UI label is shown as `Shared Clipboard`.

### `PATCH /api/projects/:project/settings`

Updates the project settings. `allowSharedClipboard` is the only supported setting at the moment.

Request body:

```json
{ "allowSharedClipboard": true }
```

Response:

```json
{
  "settings": {
    "allowSharedClipboard": true
  }
}
```

When a settings room is active for the project, the server updates the shared Yjs map and fans the change out to all connected clients immediately; otherwise it falls back to writing the file directly.

### `GET /api/projects/:project/tree`

Returns the project's file/folder layout.

```json
{
  "name": "demo",
  "path": "",
  "type": "dir",
  "children": [
    { "name": "main.tex", "path": "main.tex", "type": "file", "editable": true },
    { "name": "sections", "path": "sections", "type": "dir", "children": [ ... ] }
  ]
}
```

### `GET /api/projects/:project/file?path=<relative path>`

Returns a text file's content. `415` if the file's extension isn't in the editable text list.

```json
{ "path": "main.tex", "content": "\\documentclass{article}..." }
```

### `PUT /api/projects/:project/file`

Saves a text file's content.

Request body: `{ "path": "main.tex", "content": "..." }`

### `POST /api/projects/:project/entries`

Creates an empty file or folder (and any missing parent folders).

Request body: `{ "path": "sections/results.tex", "type": "file" }` (`type` is `"file"` or `"dir"`)

`201` on success, `409` if the path already exists.

### `POST /api/projects/:project/compile/start`

Starts an asynchronous compile job for the project's entry file (`main.tex` if present at the top level, otherwise the first top-level `.tex` file).

On success (`202 Accepted`):

```json
{
  "jobId": "0123456789abcdef",
  "entry": "main.tex",
  "status": "running"
}
```

### `GET /api/projects/:project/compile/:jobId/status`

Returns the current job state and result metadata.

```json
{
  "jobId": "0123456789abcdef",
  "status": "success",
  "entry": "main.tex",
  "error": null,
  "log": "<tectonic compilation log>",
  "cached": false,
  "hasPdf": true
}
```

### `GET /api/projects/:project/compile/:jobId/logs`

Streams live compile logs over Server-Sent Events (`text/event-stream`).

### `GET /api/projects/:project/compile/:jobId/pdf`

Returns the compiled PDF once the job has finished successfully.

```text
200 OK
Content-Type: application/pdf
X-Compiled-Entry: main.tex
```

On failure, the status endpoint returns an `error` payload along with the log and entry name.

## Roadmap

### Future improvements

* Compile concurrency limits for multi-user deployments (the current server
  serializes builds only within one project)
* Stronger filesystem isolation
* CPU and memory limits
* Container-based compilation
* Per-file "set as main" instead of always inferring `main.tex`