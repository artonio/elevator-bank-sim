// Bundles web/index.html, styles.css and every ES module it imports into one
// self-contained HTML file that opens straight from disk (no server, no deps).
// Usage: node scripts/build.mjs [--fragment out.html]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT_RE = /^import\s+[^;]*?from\s+['"](.+?)['"];?\s*$/gm;

// Depth-first walk so every module lands after its dependencies.
/** @type {{ file: string, src: string }[]} modules in bundle order */
const ordered = [];
const seen = new Set();
/**
 * Add `file` to `ordered` after everything it imports. Each module is added once.
 * @param {string} file absolute path of a module
 */
function visit(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  for (const [, spec] of src.matchAll(IMPORT_RE)) visit(resolve(dirname(file), spec));
  ordered.push({ file, src });
}
visit(resolve(root, 'web/app.js'));

const js = ordered
  .map(({ file, src }) => `// ---- ${relative(root, file)}\n` + src.replace(IMPORT_RE, '').replace(/^export\s+(?=(const|let|function|class|async)\b)/gm, ''))
  .join('\n');
if (/^\s*export\s/m.test(js)) throw new Error('Unsupported export form left in bundle');

const css = readFileSync(resolve(root, 'web/styles.css'), 'utf8');
const html = readFileSync(resolve(root, 'web/index.html'), 'utf8')
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${css}</style>`)
  .replace('<script type="module" src="app.js"></script>', () => `<script>\n(() => {\n'use strict';\n${js}\n})();\n</script>`);

mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/elevator-bank.html'), html);
console.log(`dist/elevator-bank.html  ${(html.length / 1024).toFixed(1)} KB, ${ordered.length} modules`);

const i = process.argv.indexOf('--fragment');
if (i > 0) {
  // Body-only variant for hosts that supply their own document skeleton.
  const head = html.slice(html.indexOf('<head>') + 6, html.indexOf('</head>'))
    .replace(/<meta charset[^>]*>\s*/, '').replace(/<meta name="viewport"[^>]*>\s*/, '');
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
  writeFileSync(resolve(process.argv[i + 1]), head.trim() + '\n' + body.trim() + '\n');
}
