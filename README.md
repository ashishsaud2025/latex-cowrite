# latex-cowrite

Self-hosted collaborative LaTeX editor (Overleaf-style).

This is **Phase 1**: a single-user editor with a working compile pipeline. Real-time multi-user sync using Yjs is planned for Phase 2.

* LaTeX source editor (CodeMirror) on the left
* PDF preview (PDF.js) on the right
* Compile on click using [`tectonic`](https://tectonic-typesetting.github.io/)
* Compile errors shown in a log panel
* Each compile runs in its own temporary directory with a timeout

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

### 5. Run the application

```bash
npm start
```

Open:

```text
http://localhost:3000
```

Enter some LaTeX in the left pane and click **Compile**.

## First-run network note

By default, if a document requires a package that is not already cached, Tectonic may try to download it during compilation.

If you want compilation to fail instead of accessing the network, use:

```bash
TECTONIC_ONLY_CACHED=1 npm start
```

This is recommended when the application is being used by multiple users.

## What's sandboxed and what isn't

Each compilation runs in its own temporary directory:

```text
os.tmpdir()/texcomp-<id>
```

The directory is deleted after the compilation finishes, fails, or times out.

The following protections are currently enabled:

* `--untrusted` is always passed to Tectonic. This disables shell escape and other potentially dangerous TeX features.
* The compile process is started directly with `shell: false`.
* Arguments are passed directly to the operating system instead of through a shell.
* A timeout is applied to every compilation.
* The entire process group is terminated when a compilation times out.
* LaTeX input is limited to 2 MB.

The following protections are **not** included in Phase 1:

* Filesystem access outside the temporary compilation directory
* Memory limits
* CPU limits
* OS-level network isolation for the Tectonic process

For a real multi-user deployment, compilation should run inside a container or another isolated environment. Docker with `--network none` and resource limits, gVisor, or firejail are possible options.

## Known limitation: compile time on large documents

LaTeX compilation is not incremental. Tectonic rebuilds the entire document on every compilation.

Large or complex documents can take significantly longer to compile. This is especially common with:

* Large bibliographies
* TikZ or PGFPlots
* Documents with many pages
* Documents with many images
* Complex packages

The current implementation uses a synchronous request with a hard timeout.

An asynchronous job queue with polling or WebSocket support is planned for a future phase. This will allow longer compilations and provide live compilation logs.

## API

### `GET /api/tectonic-status`

Returns the availability of Tectonic.

Example response:

```json
{
  "available": true,
  "detail": "Tectonic is available"
}
```

### `POST /api/compile`

Request body:

```json
{
  "source": "<latex source>"
}
```

On success:

```text
200 OK
Content-Type: application/pdf
```

The response contains the raw PDF bytes.

On failure:

```text
4xx/5xx
```

Example response:

```json
{
  "error": "Compilation failed",
  "log": "<tectonic compilation log>"
}
```

## Roadmap

### Phase 2

Real-time multi-user editing using Yjs and `y-websocket`.

The goal is to use CRDT-based synchronization so multiple users can edit the same LaTeX document at the same time.

### Future improvements

* Async compilation with a job ID
* Polling or WebSocket support for compile status
* Live compilation log streaming
* Compile concurrency limits for multi-user deployments
* Stronger filesystem isolation
* CPU and memory limits
* Container-based compilation
* Better project and file management
