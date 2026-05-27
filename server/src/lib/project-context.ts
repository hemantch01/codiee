import fs from "fs/promises";
import path from "path";

/**
 * Project context for Codiee — builds a compact textual snapshot of the
 * project (file tree + package.json/README excerpts) attached as AI system
 * context. Scope: built-in default ignores + optional gitignore-style
 * `.codieeignore` at the project root.
 */

/** Directories never included in the tree (unless the user negates them). */
export const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode",
]);

const CODEEIE_IGNORE_FILE = ".codieeignore";

/** Structured result of a project snapshot scan. */
export interface ProjectContextResult {
  root: string;
  context: string;
}

export interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

const PROJECT_CONTEXT_LIMITS = {
  maxDepth: 6,
  maxEntries: 200,
  maxReadmeChars: 800,
  maxContextChars: 9000,
};

// Ignore-pattern matching (simplified gitignore semantics)

function escapeRegex(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Convert a gitignore-style pattern into a matcher (#comments, !negation,
 * trailing-/ dir-only, / anchoring, * ** ? globs). */
function compilePattern(raw) {
  let p = raw.trim();
  if (!p || p.startsWith("#")) return null;

  let negate = false;
  if (p.startsWith("!")) {
    negate = true;
    p = p.slice(1).trim();
    if (!p) return null;
  }

  let dirOnly = false;
  if (p.endsWith("/")) {
    dirOnly = true;
    p = p.slice(0, -1);
    if (!p) return null;
  }

  const anchored = p.startsWith("/") || p.slice(1).includes("/");
  if (p.startsWith("/")) p = p.slice(1);

  // Build regex: split on ** first, then handle * and ? inside segments
  const regexSrc = p
    .split("**")
    .map((segment) =>
      segment
        .split("*")
        .map((part) => part.split("?").map(escapeRegex).join("[^/]"))
        .join("[^/]*")
    )
    .join(".*");

  let re;
  if (anchored) {
    // Match from project root (including anything below if it's a dir pattern)
    re = new RegExp(`^${regexSrc}(/.*)?$`);
  } else {
    // Match a path segment at any depth
    re = new RegExp(`(^|/)${regexSrc}(/|$)`);
  }

  return { re, negate, dirOnly };
}

/** Parse ignore rules from text content. */
export function parseIgnoreRules(text) {
  return (text || "")
    .split(/\r?\n/)
    .map((line) => compilePattern(line))
    .filter(Boolean);
}

/** Read `.codieeignore` from the given root; missing file → no extra rules. */
export async function loadCodieeIgnore(root) {
  try {
    const raw = await fs.readFile(path.join(root, CODEEIE_IGNORE_FILE), "utf-8");
    return parseIgnoreRules(raw);
  } catch {
    return [];
  }
}

/** Whether a project-relative path is ignored (last matching rule wins;
 * dir-only rules also ignore anything nested under the matched directory). */
export function isIgnored(relPath, isDir, rules) {
  const normalized = relPath.split(path.sep).join("/");
  let ignored = false;

  const matchesAncestor = (re, p) => {
    let cur = p;
    while (cur) {
      if (re.test(cur)) return true;
      const idx = cur.lastIndexOf("/");
      cur = idx === -1 ? "" : cur.slice(0, idx);
    }
    return false;
  };

  for (const rule of rules) {
    if (rule.re.test(normalized)) {
      ignored = !rule.negate;
    } else if (rule.dirOnly && !isDir && matchesAncestor(rule.re, normalized)) {
      // e.g. "dist/" also ignores "dist/out.js"
      ignored = !rule.negate;
    }
  }
  return ignored;
}

// File tree rendering

/** Recursively build the tree lines under `dir`. */
async function walkTree(dir, root, rules, lines, prefix, depth, state) {
  if (depth > PROJECT_CONTEXT_LIMITS.maxDepth) return;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable — skip silently
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(root, fullPath);
    const isDir = entry.isDirectory();

    if (isDir && DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    if (isIgnored(relPath, isDir, rules)) continue;

    if (state.count >= PROJECT_CONTEXT_LIMITS.maxEntries) {
      state.truncated = true;
      return;
    }
    state.count += 1;

    const last = i === entries.length - 1;
    const connector = last ? "└── " : "├── ";
    lines.push(prefix + connector + entry.name + (isDir ? "/" : ""));

    if (isDir) {
      await walkTree(
        fullPath,
        root,
        rules,
        lines,
        prefix + (last ? "    " : "│   "),
        depth + 1,
        state
      );
      if (state.truncated) return;
    }
  }
}

/** Build the file-tree string for the project. */
async function buildProjectTree(root, rules = null) {
  const ignoreRules = rules ?? (await loadCodieeIgnore(root));
  const lines = ["/"];
  const state = { count: 0, truncated: false };
  await walkTree(root, root, ignoreRules, lines, "", 1, state);
  return {
    tree: lines.join("\n"),
    fileCount: state.count,
    truncated: state.truncated,
  };
}

// Key-file extraction

/** Summarize package.json without dumping the whole file. */
async function summarizePackageJson(root) {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    const parts: string[] = [];
    if (pkg.name) parts.push(`name: ${pkg.name}`);
    if (pkg.version) parts.push(`version: ${pkg.version}`);
    const scripts = Object.keys(pkg.scripts || {});
    if (scripts.length) parts.push(`scripts: ${scripts.join(", ")}`);
    const deps = Object.keys(pkg.dependencies || {});
    if (deps.length)
      parts.push(`dependencies (${deps.length}): ${deps.slice(0, 15).join(", ")}`);
    return parts.join(" · ");
  } catch {
    return null;
  }
}

/** Excerpt of the README (first N chars, blank lines collapsed). */
async function readReadmeExcerpt(root) {
  const candidates = ["README.md", "readme.md", "Readme.md", "README"];
  for (const name of candidates) {
    try {
      const raw = await fs.readFile(path.join(root, name), "utf-8");
      const excerpt = raw
        .replace(/\r?\n\s*\r?\n/g, "\n")
        .trim()
        .slice(0, PROJECT_CONTEXT_LIMITS.maxReadmeChars);
      return (
        excerpt + (raw.length > PROJECT_CONTEXT_LIMITS.maxReadmeChars ? "…" : "")
      );
    } catch {
      continue;
    }
  }
  return null;
}

// Public API

/** Find the project root: nearest ancestor of startDir containing a marker
 * (.git, package.json, pyproject.toml, go.mod, Cargo.toml); falls back to startDir. */
export async function findProjectRoot(startDir: string = process.cwd()): Promise<string> {
  let dir = path.resolve(startDir);
  const markers = [".git", "package.json", "pyproject.toml", "go.mod", "Cargo.toml"];

  while (true) {
    for (const marker of markers) {
      try {
        await fs.access(path.join(dir, marker));
        return dir;
      } catch {
        continue;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir); // hit filesystem root
    dir = parent;
  }
}

/** Build the full project context block to attach as AI system context;
 * null when the directory has nothing worth sharing. */
export async function getProjectContext(rootOverride: string | null = null): Promise<ProjectContextResult | null> {
  const root = rootOverride ?? (await findProjectRoot());
  const rules = await loadCodieeIgnore(root);

  const { tree, fileCount, truncated } = await buildProjectTree(root, rules);
  if (fileCount === 0) return null;

  const pkgSummary = await summarizePackageJson(root);
  const readmeExcerpt = await readReadmeExcerpt(root);

  const sections = [
    `Project root: ${root}`,
    pkgSummary ? `\npackage.json summary:\n${pkgSummary}` : "",
    readmeExcerpt ? `\nREADME (excerpt):\n${readmeExcerpt}` : "",
    `\nFile tree (${fileCount}${truncated ? "+, truncated" : ""} entries; respects .codieeignore):\n${tree}`,
  ].filter(Boolean);

  let context =
    "You are Codiee running inside the user's project. " +
    "The following snapshot of the project was attached automatically as context. " +
    "Use it to give grounded answers. If the user asks about files not shown here, " +
    "say you cannot see them.\n\n" +
    sections.join("\n");

  if (context.length > PROJECT_CONTEXT_LIMITS.maxContextChars) {
    context =
      context.slice(0, PROJECT_CONTEXT_LIMITS.maxContextChars) +
      "\n… (project context truncated)";
  }

  return {
    root,
    context,
  };
}
