// Worker do Atlas: consome pedidos (coleção `requests`) e pede ao LLM para decidir entre
// apontar página existente, inserir seção em página existente, ou criar página nova; depois
// build + commit + push. Roda no PC (systemd --user), lê secrets.env e o repo local.
import PocketBase from 'pocketbase';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFs } from './fs-ops.mjs';
import { complete, llmConfig } from './llm.mjs';
import { renderCheck } from './validate.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(readFileSync(join(ROOT, 'secrets.env'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => l.split('=', 2)));
const LLM = llmConfig({ ...process.env, ...env });
const PB_URL = process.env.PB_URL || 'http://localhost:8090';
const pb = new PocketBase(PB_URL); pb.autoCancellation(false);
await pb.collection('_superusers').authWithPassword(env.PB_EMAIL || process.env.PB_EMAIL, env.PB_PASS || process.env.PB_PASS);

const fs = makeFs(ROOT, pb);
const CORE = join(ROOT, 'node_modules/@lucasgiraldelli/atlas-core');
const SKILL = readFileSync(env.ATLAS_SKILL || process.env.ATLAS_SKILL || join(CORE, 'skill/learn/SKILL.md'), 'utf8');
const skillPart = (from, to) => { const a = SKILL.indexOf(from); const b = to ? SKILL.indexOf(to, a) : SKILL.length; return SKILL.slice(a, b); };
const RULES = [skillPart('## 0. REGRAS ABSOLUTAS', '## 1.'), skillPart('## 2. MODO', '## 3.'), skillPart('## 3. ESTRUTURA', '## 4.'), skillPart('## 4. PROSA', '## 5.'), skillPart('## 5. CORES', '## 6.'), skillPart('## 6. MATEMÁTICA', '## 7.'), skillPart('## 7. DIAGRAMAS', '## 8.')].join('\n');
const CONTRACT = readFileSync(join(CORE, 'docs/PAGE-CONTRACT.md'), 'utf8');
const TEMPLATE = readFileSync(join(CORE, 'docs/page-template.html'), 'utf8');

const kebab = (s) => s.replace(/\s*\(EN\)\s*$/, '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/(^-|-$)/g, '').toLowerCase();
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

/** índice compacto de todas as páginas: slug, título, descrição, seções */
function index() {
  return walk(join(ROOT, 'content')).filter((f) => f.endsWith('.html')).map((f) => {
    const t = readFileSync(f, 'utf8'); if (!t.includes('atlas-mode')) return null;
    const g = (re) => (t.match(re)?.[1] ?? '').trim();
    const sections = [...t.matchAll(/<h3[^>]*>(?:<span class="n">\d+<\/span>)?\s*([^<]+)/g)].map((m) => m[1].trim());
    return { slug: f.slice(join(ROOT, 'content').length + 1, -5), title: g(/<title>(.*?)<\/title>/s), mode: g(/atlas-mode" content="([^"]*)"/), description: g(/name="description" content="([^"]*)"/), sections };
  }).filter(Boolean);
}

async function fetchRef(ref) {
  if (!/^https?:\/\//.test(ref || '')) return '';
  try {
    const html = await (await fetch(ref, { headers: { 'user-agent': 'Mozilla/5.0 atlas-worker' }, signal: AbortSignal.timeout(20000) })).text();
    return html.replace(/<(script|style|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 60000);
  } catch { return ''; }
}

const ask = (prompt) => complete(prompt, { json: true, cfg: LLM });

function buildPrompt(req, idx, refText, groupIndex = {}) {
  return `Você é o autor didático do Atlas, um site pessoal de estudo. Siga estritamente as regras abaixo.

# REGRAS DE ESCRITA (da skill /learn)
${RULES}

# CONTRATO DA PÁGINA
${CONTRACT}

# TEMPLATE (blocos disponíveis; use só os que couberem; remova placeholders não usados)
${TEMPLATE}

# ÍNDICE ATUAL DO ATLAS (slug, título, modo, descrição, seções)
${JSON.stringify(idx, null, 1)}

# CATEGORIAS E SUBCATEGORIAS EXISTENTES (pasta → nome exibido)
${JSON.stringify(groupIndex, null, 1)}

# PEDIDO DO USUÁRIO
conteúdo/tema: ${req.content}
referência: ${req.ref || '(nenhuma)'}
modo desejado: ${req.mode || '(decida)'}
categoria sugerida: ${req.cat || '(decida; use uma existente do índice se couber)'}
${refText ? `\n# TEXTO DA REFERÊNCIA (extraído da URL)\n${refText}` : ''}

# SUA TAREFA
Decida UMA das três ações e responda em JSON estrito. Ordem de preferência: exists > insert > create.
Antes de decidir, percorra o ÍNDICE: se alguma página (mesmo com outro título) tem uma seção cujo título ou descrição cobre o pedido, a resposta é obrigatoriamente "exists" apontando essa seção. "create" só quando nenhuma página do índice trata do tema nem poderia recebê-lo como seção; criar uma página que repete assunto de outra é o pior erro possível.
1. "exists": o Atlas já cobre isso o suficiente. Responda {"action":"exists","slug":"<slug existente>","section":"<título da seção que responde>","note":"<1 frase explicando>"}.
2. "insert": cabe como uma seção nova dentro de uma página existente. Responda {"action":"insert","slug":"<slug existente>","title":"<título da seção>","section_html":"<section class=\\"topic\\" id=\\"<kebab>\\">…</section>","note":"<1 frase>"}. A seção segue o contrato (h3 com span.n vazio "+", p.lede, componentes), em HTML puro, sem style/script.
3. "create": merece página própria. Responda {"action":"create","cat":"<categoria[/sub]>","title":"<título; inglês recebe sufixo (EN)>","lang":"pt-BR|en","mode":"referencia|leitura|apostila","page_html":"<documento HTML completo no contrato, do <!DOCTYPE> ao </html>>","note":"<1 frase>","groups":{"<pasta>":"<nome exibido>"},"rename_groups":{"<pasta existente>":"<novo nome exibido>"}}.
   Categoria: reaproveite uma pasta existente quando o sentido coincide (mesmo em outro idioma). Se a sugerida for nova, "cat" é a pasta em kebab-case e "groups" dá o nome exibido de cada pasta nova (categoria e subcategoria). Se uma pasta existente ficar ambígua ao lado da nova (por exemplo "engineering" e uma nova de engenharia civil), use "rename_groups" para renomear a existente com um nome que diferencie ("engenharia de software") e dê à nova um nome igualmente específico ("engenharia civil"). Omitir "groups"/"rename_groups" quando não há nada a nomear.
Mermaid: labels em inglês entre aspas; cor por papel com "classDef nome stroke:#hex,color:#hex" e aplicação inline Id["…"]:::nome; PROIBIDA a instrução "class A,B nome" e qualquer vírgula solta; "<" como "&lt;"; um diagrama simples e válido vale mais que um elaborado com erro.
Regras absolutas: registro de livro didático conforme a seção PROSA acima (terceira pessoa, sem "você", sem coloquialismos, sem títulos metafóricos, ledes declarativos); sem travessões (—) em lugar nenhum; código em <pre data-lang="x"><code> com texto escapado; checklist com data-ref; metas atlas-mode, atlas-source (a referência) e atlas-date (${new Date().toISOString().slice(0, 10)}); labels de Mermaid em inglês entre aspas. Escreva no idioma do pedido. Seja fiel à referência; não invente fatos.`;
}

function sh(cmd) { return execSync(cmd, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' }); }
function publish(msg, { built = false } = {}) { if (!built) sh('pnpm build'); sh('git add -A content'); if (!sh('git status --porcelain content').trim()) return false; // nada mudou (o LLM devolveu o mesmo texto)
  sh(`git commit -qm ${JSON.stringify(msg)}`); sh('git push -q'); return true; }
const clean = (s) => s.replace(/ — /g, ': ').replace(/—/g, ',');

/** pasta → nome exibido (grupos do PocketBase + pastas de content/ sem registro) */
async function groupsIndex() {
  const out = {};
  for (const g of await pb.collection('groups').getFullList()) out[g.path] = g.title || g.path.split('/').pop();
  for (const f of walk(join(ROOT, 'content'))) { const rel = f.slice(join(ROOT, 'content').length + 1).split('/'); if (rel.length > 1) { out[rel[0]] ??= rel[0]; if (rel.length > 2) out[`${rel[0]}/${rel[1]}`] ??= rel[1]; } }
  return out;
}
/** Registra nomes exibidos das pastas novas (do LLM ou do que o usuário digitou) e renomeia grupos existentes se pedido. */
async function applyGroups(cat, groups = {}, renames = {}, typed = '') {
  const typedParts = (typed || '').replace(/^\/|\/$/g, '').split('/');
  const parts = cat.split('/');
  for (let i = 0; i < parts.length; i++) {
    const path = parts.slice(0, i + 1).join('/');
    const title = groups?.[path] || (kebab(typedParts[i] || '') === parts[i] ? typedParts[i] : '') || '';
    let g = null; try { g = await pb.collection('groups').getFirstListItem(`path = ${JSON.stringify(path)}`); } catch {}
    if (!g) await pb.collection('groups').create({ path, title }); else if (title && !g.title) await pb.collection('groups').update(g.id, { title });
  }
  for (const [path, title] of Object.entries(renames || {})) {
    if (!title || path === cat || cat.startsWith(path + '/')) continue;
    try { const r = await fs.ops['rename-group']({ path, title }); console.log('grupo renomeado', path, '→', r.path, `"${title}"`); }
    catch (e) { console.log('rename_groups ignorado', path, e.message); }
  }
}

/** Constrói, renderiza a página e conserta (ou remove) diagramas Mermaid inválidos antes de publicar. */
async function ensureRenders(file, slug) {
  sh('pnpm build');
  let check = await renderCheck(ROOT, slug);
  if (check.ok || check.skipped) return check;
  let html = readFileSync(file, 'utf8');
  for (const bad of check.brokenDiagrams) {
    if (!bad.trim() || !html.includes(bad)) continue;
    let fixed = '';
    try {
      const r = await ask(`O diagrama Mermaid abaixo tem erro de sintaxe e não renderiza (Mermaid 11). Corrija mantendo o mesmo conteúdo e as mesmas cores por papel. Regras: labels entre aspas; cores só com classDef (stroke e color) aplicadas inline com :::nome; nunca a instrução "class"; "<" como "&lt;". Responda em JSON {"mermaid":"<texto corrigido>"}.\n\n${bad}`);
      fixed = String(r.mermaid || '').trim();
    } catch {}
    html = fixed ? html.replace(bad, '\n' + fixed + '\n') : html.replace(new RegExp(`\\s*<figure class="diagram">\\s*<pre class="mermaid">${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</pre>[\\s\\S]*?</figure>`), '');
  }
  writeFileSync(file, html);
  sh('pnpm build');
  check = await renderCheck(ROOT, slug);
  if (!check.ok) { // segunda falha: remove o que sobrou quebrado
    html = readFileSync(file, 'utf8');
    for (const bad of check.brokenDiagrams) if (bad.trim() && html.includes(bad)) html = html.replace(new RegExp(`\\s*<figure class="diagram">\\s*<pre class="mermaid">${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</pre>[\\s\\S]*?</figure>`), '');
    writeFileSync(file, html); sh('pnpm build');
    check = { ...check, ok: true, removed: check.brokenDiagrams.length };
  }
  return check;
}

async function handleFs(req) {
  await pb.collection('requests').update(req.id, { status: 'running' });
  const { op, ...args } = req.payload ?? {};
  try {
    if (!fs.ops[op]) throw new Error('operação desconhecida: ' + op);
    const result = await fs.ops[op](args);
    if (sh('git status --porcelain content').trim()) publish(`chore(content): ${op} ${args.slug ?? args.path ?? ''} → ${result.slug ?? result.path ?? ''}`);
    await pb.collection('requests').update(req.id, { status: 'done', result: { action: op, ...result } });
    console.log(new Date().toISOString(), 'fs', op, result.slug ?? result.path);
  } catch (e) {
    console.error(new Date().toISOString(), 'fs error', op, e.message);
    await pb.collection('requests').update(req.id, { status: 'error', result: { action: op, note: e.message.slice(0, 500) } });
  }
}

async function handleEdit(req) {
  await pb.collection('requests').update(req.id, { status: 'running' });
  const { slug, anchor, instruction } = req.payload ?? {};
  try {
    const file = join(ROOT, 'content', slug + '.html'); if (!existsSync(file)) throw new Error('página inexistente: ' + slug);
    let html = readFileSync(file, 'utf8');
    if (!anchor) { // documento inteiro
      const raw = await complete(`Você é o autor didático do Atlas. Reescreva o documento abaixo seguindo a instrução do leitor e, obrigatoriamente, as regras de escrita e o contrato da página: registro de livro didático (terceira pessoa, sem "você", sem coloquialismos, sem travessões, títulos que nomeiam o conteúdo), fórmulas em KaTeX ($…$ e $$…$$ dentro de div.eq, com as macros de cor \\hlb \\hla \\hlg \\hlr quando ajudarem), Mermaid válido (labels em inglês entre aspas; classDef com stroke e color aplicados inline com :::nome; nunca a instrução "class"), seção de exercícios com resolução revelável e checklist final com data-ref. Mantenha o mesmo <title>, as metas e o id das seções que continuarem existindo.

# REGRAS DE ESCRITA
${RULES}

# CONTRATO DA PÁGINA
${CONTRACT}

# INSTRUÇÃO DO LEITOR
${instruction}

# DOCUMENTO ATUAL
${html}

Responda SOMENTE com o documento HTML completo, do <!DOCTYPE html> ao </html>, sem cercas de código.`, { cfg: LLM, json: false, maxTokens: 32000 });
      const doc = String(raw).match(/<!DOCTYPE html>[\s\S]*<\/html>/i); if (!doc) throw new Error('resposta sem documento completo');
      const next = clean(doc[0]); if (!/atlas-mode/.test(next) || !/<main/.test(next) || !/<ul class="checklist"/.test(next)) throw new Error('documento fora do contrato');
      writeFileSync(file, next);
      const v = await ensureRenders(file, slug);
      publish(`feat(content): ${slug}: reescrita (via Atlas + LLM)`, { built: true });
      await pb.collection('requests').update(req.id, { status: 'done', result: { action: 'edit', slug, url: `/${slug}/`, title: req.payload.heading, note: `documento reescrito${v.removed ? ' (diagrama inválido removido)' : ''}` } });
      console.log(new Date().toISOString(), 'edit(doc)', slug); return;
    }
    const re = new RegExp(`<section class="topic"[^>]*\\bid="${anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>[\\s\\S]*?</section>`);
    const m = html.match(re); if (!m) throw new Error('seção não encontrada: ' + anchor);
    const raw = await complete(`Você é o autor didático do Atlas. Reescreva a seção abaixo de uma página existente seguindo a instrução do leitor, mantendo o contrato da página, o mesmo id da seção, o mesmo registro (livro didático, terceira pessoa, sem "você", sem travessões, títulos que nomeiam o conteúdo) e as cores por papel já usadas. Pode ampliar, acrescentar exemplos, boxes, um diagrama Mermaid (labels em inglês entre aspas, classDef com stroke e color aplicados inline com :::nome, nunca a instrução "class") ou encurtar, conforme pedido. Não altere o que a instrução não pede. Código em <pre data-lang="x"><code> escapado.

# REGRAS DE ESCRITA
${RULES}

# CONTRATO DA PÁGINA
${CONTRACT}

# INSTRUÇÃO DO LEITOR
${instruction}

# SEÇÃO ATUAL
${m[0]}

Responda SOMENTE com o HTML da seção reescrita, começando em <section class="topic" id="${anchor}"> e terminando em </section>, sem cercas de código e sem comentários fora dela.`, { cfg: LLM, json: false });
    const mm = String(raw).match(/<section class="topic"[\s\S]*<\/section>/); if (!mm) throw new Error('resposta sem <section>');
    const sec = clean(mm[0]); if (!sec.includes(`id="${anchor}"`)) throw new Error('seção fora do contrato');
    const out = { note: 'seção reescrita conforme o pedido' };
    html = html.replace(m[0], sec.trim()); writeFileSync(file, html);
    const v = await ensureRenders(file, slug);
    const changed = publish(`feat(content): ${slug}: alteração em #${anchor} (via Atlas + LLM)`, { built: true });
    const result = { action: 'edit', slug, url: `/${slug}/#${anchor}`, title: req.payload.heading, note: changed === false ? 'o modelo não encontrou o que mudar; a seção ficou igual' : `${out.note ?? ''}${v.removed ? ' (diagrama inválido removido)' : ''}` };
    await pb.collection('requests').update(req.id, { status: 'done', result });
    console.log(new Date().toISOString(), 'edit', slug, anchor);
  } catch (e) {
    console.error(new Date().toISOString(), 'edit error', e.message);
    await pb.collection('requests').update(req.id, { status: 'error', result: { action: 'edit', note: e.message.slice(0, 500), tries: Number(req.result?.tries ?? 1) } });
  }
}

async function handle(req) {
  if (req.kind === 'fs') return handleFs(req);
  if (req.kind === 'edit') return handleEdit(req);
  await pb.collection('requests').update(req.id, { status: 'running' });
  try {
    const idx = index(); const refText = await fetchRef(req.ref);
    const groupIndex = await groupsIndex();
    const out = await ask(buildPrompt(req, idx, refText, groupIndex));
    let result;
    if (out.action === 'exists') {
      result = { action: 'exists', slug: out.slug, url: `/${out.slug}/`, title: idx.find((p) => p.slug === out.slug)?.title ?? out.slug, note: `${out.note} Seção: ${out.section ?? ''}` };
    } else if (out.action === 'insert') {
      const file = join(ROOT, 'content', out.slug + '.html'); if (!existsSync(file)) throw new Error('slug inexistente: ' + out.slug);
      let html = readFileSync(file, 'utf8');
      const sec = clean(out.section_html).replace(/<h3>/, '<h3><span class="n">+</span>').replace(/<section class="topic"/, `<section class="topic" data-added="${new Date().toISOString().slice(0, 10)}"`);
      // antes de erros / verificação / checklist, senão no fim do main
      const m = html.match(/<hr class="sep">|<section class="topic" id="(erros|verificacao|exercicios|checklist)"/);
      html = m ? html.slice(0, m.index) + sec + '\n\n' + html.slice(m.index) : html.replace('</main>', sec + '\n</main>');
      writeFileSync(file, html);
      await ensureRenders(file, out.slug);
      publish(`feat(content): ${out.slug}: seção "${out.title}" (via Atlas + LLM)`, { built: true });
      result = { action: 'insert', slug: out.slug, url: `/${out.slug}/#${(sec.match(/id="([^"]+)"/) || [])[1] ?? ''}`, title: out.title, note: out.note };
    } else if (out.action === 'create') {
      let html = clean(out.page_html);
      if (!/atlas-mode/.test(html) || !/<main/.test(html)) throw new Error('página fora do contrato');
      const cat = (out.cat || req.cat || 'general').replace(/^\/|\/$/g, '').split('/').map(kebab).join('/'); const slug = kebab(out.title);
      await applyGroups(cat, out.groups, out.rename_groups, req.cat);
      const dir = join(ROOT, 'content', cat); mkdirSync(dir, { recursive: true });
      const file = join(dir, slug + '.html'); if (existsSync(file)) throw new Error('já existe: ' + cat + '/' + slug);
      writeFileSync(file, html);
      const v = await ensureRenders(file, `${cat}/${slug}`);
      if (v.removed) out.note = `${out.note ?? ''} (${v.removed} diagrama(s) inválido(s) removido(s))`.trim();
      publish(`feat(content): ${cat}/${slug} (via Atlas + LLM)`, { built: true });
      // quem pediu é o dono do documento novo (só essa pessoa o vê na home; "compartilhado" pode ser escolhido depois)
      if (req.owner) { try { await pb.collection('overrides').create({ slug: `${cat}/${slug}`, owner: req.owner }); } catch (e) { console.log('owner não registrado:', e.message); } }
      result = { action: 'create', slug: `${cat}/${slug}`, url: `/${cat}/${slug}/`, title: out.title, note: out.note };
    } else throw new Error('ação desconhecida');
    await pb.collection('requests').update(req.id, { status: 'done', result });
    console.log(new Date().toISOString(), 'done', result.action, result.slug);
  } catch (e) {
    console.error(new Date().toISOString(), 'error', e.message);
    await pb.collection('requests').update(req.id, { status: 'error', result: { note: e.message.slice(0, 500), tries: Number(req.result?.tries ?? 1) } });
  }
}

async function tick() {
  // erros de sobrecarga do modelo (429/5xx) voltam para a fila, até 3 vezes
  for (const r of await pb.collection('requests').getFullList({ filter: 'status = "error"', sort: 'created' })) {
    const note = String(r.result?.note ?? ''); const tries = Number(r.result?.tries ?? 1);
    if (/\b(429|5\d\d)\b/.test(note) && tries < 3) await pb.collection('requests').update(r.id, { status: 'pending', result: { ...r.result, tries: tries + 1 } });
  }
  const pending = await pb.collection('requests').getFullList({ filter: 'status = "pending"', sort: 'created' });
  for (const r of pending) {
    try { await pb.collection('requests').getOne(r.id); } catch { continue; } // apagado enquanto esperava: não executa
    await handle(r);
  }
}
// Cão de guarda: um pedido não pode levar mais que TICK_MAX. Se levar (Chromium ou fetch que nunca
// respondem), o processo sai e o systemd o reinicia; o pedido que estava "running" volta para a fila.
const TICK_MAX = 15 * 60 * 1000;
async function guarded() {
  let timer; const bomb = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('tick travou por mais de 15 min')), TICK_MAX); });
  try { await Promise.race([tick(), bomb]); }
  catch (e) { console.error(new Date().toISOString(), 'tick', e.message); if (/travou/.test(e.message)) process.exit(1); }
  finally { clearTimeout(timer); }
}
// pedidos que ficaram "running" de um processo anterior (queda, reinício) voltam para a fila
for (const r of await pb.collection('requests').getFullList({ filter: 'status = "running"' })) await pb.collection('requests').update(r.id, { status: 'pending' });
if (process.argv.includes('--once')) { await tick(); process.exit(0); }
console.log('atlas worker: ouvindo', PB_URL, 'llm', LLM.provider, LLM.model);
for (;;) { await guarded(); await new Promise((r) => setTimeout(r, 30000)); }
