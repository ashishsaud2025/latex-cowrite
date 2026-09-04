'use strict';

const path = require('path');
const fs = require('fs/promises');
const { PROJECTS_ROOT, DEFAULT_PROJECT_SETTINGS } = require('./constants');
const { writeProjectSettings } = require('./settings');

// Create the projects folder if missing, seed a demo project if there are no
// projects at all yet (so the UI never opens to an empty state on a fresh checkout).
async function ensureProjectsRoot() {
  await fs.mkdir(PROJECTS_ROOT, { recursive: true });
  const entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true });
  const hasAnyProject = entries.some((e) => e.isDirectory() && !e.name.startsWith('.'));
  if (!hasAnyProject) {
    await seedDemoProject();
  }
}

async function seedDemoProject() {
  const demoRoot = path.join(PROJECTS_ROOT, 'demo');
  await fs.mkdir(path.join(demoRoot, 'sections'), { recursive: true });
  await fs.writeFile(
    path.join(demoRoot, 'main.tex'),
    `\\documentclass{article}
\\title{Hello, latex-cowrite}
\\author{You}
\\begin{document}
\\maketitle

\\input{sections/intro}

\\end{document}
`,
    'utf8'
  );
  await fs.writeFile(
    path.join(demoRoot, 'sections', 'intro.tex'),
    `\\section{Introduction}
This file lives at \\texttt{sections/intro.tex} and is pulled in from
\\texttt{main.tex} via \\verb|\\input|. Edit either file in the tree on the
left, hit Compile, and both are included in the build.
`,
    'utf8'
  );
  await writeProjectSettings('demo', DEFAULT_PROJECT_SETTINGS);
}

module.exports = {
  ensureProjectsRoot,
  seedDemoProject,
};
