import fs from "fs/promises";
import path from "path";

/**
 * Project ignore handling for Codiee — gitignore-style `.codieeignore`
 * patterns (simplified semantics) plus project-root detection.
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

export interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

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

// Snapshot builder (file tree + key-file excerpts) added later.
