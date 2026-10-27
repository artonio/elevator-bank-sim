// Development server: serves the page straight from web/ and src/ (no build step) and
// reloads the browser whenever a file in either folder changes.
// Usage: node scripts/dev.mjs [--port 8000]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const portArg = process.argv.indexOf('--port');
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 8000;

/** Content types for the files the page loads. */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Added to every HTML page: reload when the server says a file changed. */
const RELOAD_SCRIPT = `<script>new EventSource('/__reload').onmessage = () => location.reload();</script>`;

/** @type {Set<import('node:http').ServerResponse>} open reload connections, one per browser tab */
const clients = new Set();

/**
 * Serve one file from the project folder. HTML gets the reload script; nothing is cached,
 * so a reload always fetches the current modules.
 * @param {string} urlPath path from the request, e.g. '/web/app.js'
 * @param {import('node:http').ServerResponse} res
 */
async function serveFile(urlPath, res) {
  try {
    const file = resolve(root, '.' + decodeURIComponent(urlPath));
    // Refuse anything outside the project folder, such as '/../secret'.
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(file);
    // A folder needs a trailing slash, or the page's relative links (app.js, styles.css)
    // would resolve one level too high.
    if (info.isDirectory() && !urlPath.endsWith('/')) {
      res.writeHead(302, { Location: urlPath + '/' }).end();
      return;
    }
    // A folder serves its index.html.
    const path = info.isDirectory() ? resolve(file, 'index.html') : file;
    let body = await readFile(path);
    const type = TYPES[extname(path)] ?? 'application/octet-stream';
    if (extname(path) === '.html') body = body.toString().replace('</body>', `${RELOAD_SCRIPT}\n</body>`);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  // The page lives in web/; its modules import from ../src, so the whole folder is served.
  if (pathname === '/') {
    res.writeHead(302, { Location: '/web/' }).end();
    return;
  }
  // There is no icon; answer with "no content" so the console stays free of 404s.
  if (pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  // Server-sent events: the connection stays open and gets a message on every change.
  if (pathname === '/__reload') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  serveFile(pathname, res);
});

// Editors often write a file in several steps, so wait for the changes to settle before
// telling the browsers to reload.
let pending = null;
for (const folder of ['src', 'web']) {
  watch(resolve(root, folder), (event, name) => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      console.log(`changed: ${folder}/${name ?? ''} → reloading ${clients.size} tab(s)`);
      for (const res of clients) res.write('data: reload\n\n');
    }, 100);
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${port} is in use. Try: npm run dev -- --port ${port + 1}`);
  else console.error(err);
  process.exit(1);
});

server.listen(port, () => {
  console.log(`Elevator bank: http://localhost:${port}/`);
  console.log('Serving web/ and src/ directly, no build needed. The page reloads when you save a file.');
  console.log('dist/elevator-bank.html is not updated; run npm run build for that.');
});
