/**
 * Reading source as SOURCE, for the tests that assert about code.
 *
 * Several guards in this suite are source scans: no second status map, no hardcoded
 * "today", no guest-contact field in a component. Every one of them is an assertion
 * about CODE — and every one of them will otherwise trip over a doc comment that
 * *explains* the defect being guarded against ("this table used to title itself…",
 * "never contact details"). That teaches the next reader to delete the explanation
 * rather than keep the guard, which is exactly backwards.
 *
 * So the scans run over source with its comments removed.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

export function readSource(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Source with block and line comments stripped. */
export function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments, JSDoc included
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments, sparing protocol slashes
}

/** Every application source file a UI rule could be broken in. */
export function uiSourceFiles(dirs: string[] = ['components', 'app', 'lib']): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) out.push(rel);
    }
  };
  for (const dir of dirs) walk(dir);
  return out;
}
