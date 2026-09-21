// Validação de HTML gerado pelo LLM antes de publicar: renderiza no Chromium e devolve os
// diagramas Mermaid que falharam (texto original), para o worker pedir correção ou removê-los.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

/** Serve build/ e abre /<slug>/; devolve { ok, brokenDiagrams: [texto…] }. Sem Chromium devolve ok:true (não bloqueia). */
export async function renderCheck(ROOT, slug) {
  let chromium; try { ({ chromium } = await import('playwright-core')); } catch { return { ok: true, brokenDiagrams: [], skipped: 'playwright ausente' }; }
  const BUILD = join(ROOT, 'build');
  const server = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    let f = join(BUILD, p); if (!existsSync(f) || statSync(f).isDirectory()) f = join(BUILD, '200.html');
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
  }).listen(0);
  let browser;
  try { browser = await chromium.launch({ timeout: 60000 }); } catch (e) { server.close(); return { ok: true, brokenDiagrams: [], skipped: 'chromium indisponível' }; }
  // se o Chromium morrer no meio, nenhuma chamada fica pendurada para sempre
  const dead = new Promise((_, rej) => browser.on('disconnected', () => rej(new Error('chromium encerrou'))));
  try {
    const page = await Promise.race([browser.newPage(), dead]);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await Promise.race([dead, page.goto(`http://localhost:${server.address().port}/${slug}/`, { waitUntil: 'networkidle', timeout: 30000 })]);
    await page.waitForFunction(() => !document.querySelector('pre.mermaid:not([data-processed])'), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);
    const brokenDiagrams = await Promise.race([dead, page.evaluate(() => [...document.querySelectorAll('pre.mermaid')]
      .filter((p) => /syntax error/i.test(p.textContent || '') || p.querySelector('svg [id^="mermaid"] text')?.textContent?.match(/Syntax error/i) || !p.querySelector('svg') || /syntax error/i.test(p.querySelector('svg')?.textContent || ''))
      .map((p) => p.dataset.src || ''))]);
    return { ok: brokenDiagrams.length === 0, brokenDiagrams, errors };
  } finally { await browser.close().catch(() => {}); server.closeAllConnections?.(); server.close(); }
}
