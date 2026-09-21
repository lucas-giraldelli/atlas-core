<script lang="ts">
  import { onMount } from 'svelte';
  import { afterNavigate } from '$app/navigation';
  import { Pencil, Check, X, ArrowUp, ArrowDown, FolderInput, Plus, Archive, ArchiveRestore, BookCheck, BookOpen, MoreVertical, History, Trash2, ChevronRight, GripVertical, ArrowUpDown, BookMarked, Users, Copy, Lock, LockOpen } from '@lucide/svelte';
  import { byCat, type Page } from '$lib/content';
  import { kebab } from '$lib/content/slug';
  import { auth } from '$lib/db/client.svelte';
  import { listOverrides, saveOverride, listGroups, saveGroup, deleteGroup, type Override, type Group } from '$lib/db/overrides';
  import { enqueueFs } from '$lib/db/requests';
  import { listStates, saveState, type DocState } from '$lib/db/state';
  import { me } from '$lib/db/client.svelte';
  import { pb } from '$lib/db/client.svelte';
  import { listAllProgress } from '$lib/db/progress';
  import AskAtlas from '$lib/ui/AskAtlas.svelte';
  import RequestList from '$lib/ui/RequestList.svelte';
  let reqTick = $state(0);
  let showHistory = $state(false);
  let pendingReqs = $state(0);
  // aberto automaticamente ao enviar: some sozinho 8 s depois que o último pedido termina
  let autoOpened = $state(false);
  let dismissTimer: ReturnType<typeof setTimeout> | undefined;
  function onPending(n: number) {
    pendingReqs = n;
    clearTimeout(dismissTimer);
    if (autoOpened && n === 0) dismissTimer = setTimeout(() => { if (autoOpened) { showHistory = false; autoOpened = false; } }, 8000);
  }

  const fileCats = byCat();
  const allPages = Object.values(fileCats).flat();
  const catOf = (p: Page) => ov[p.slug]?.cat || p.cat;
  // categorias efetivas: pasta ou override; grupos criados sem páginas também aparecem
  const cats = $derived.by(() => { const m: Record<string, Page[]> = {}; for (const p of allPages) (m[catOf(p)] ??= []).push(p); for (const k of Object.keys(gr)) if (!k.includes('/')) m[k] ??= []; return m; });
  let q = $state('');
  // cache local só para a primeira pintura (evita o flick de recolher/renomear); o servidor sobrescreve em seguida
  const cache = <T,>(key: string): T | null => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
  const remember = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} };
  let ov = $state<Record<string, Override>>(cache<Record<string, Override>>('atlas-ov-cache') ?? {});
  let gr = $state<Record<string, Group>>(cache<Record<string, Group>>('atlas-gr-cache') ?? {});
  let doneCount = $state<Record<string, number>>({});
  let editing = $state<string | null>(null);   // slug da página ou "g:<path>" de um grupo
  let moving = $state<string | null>(null);    // slug em movimentação de subcategoria
  let draft = $state('');
  let showArchived = $state(false);
  let ready = $state(false);
  // estado pessoal (lido/arquivado/posição) por documento, do usuário logado
  let st = $state<Record<string, DocState>>({});
  // documentos de outra pessoa (overrides.owner) ficam fora da home, a menos que "ver todos" esteja ligado
  let showAll = $state(false);
  const owned = (p: Page) => ov[p.slug]?.owner || '';
  // com quem está compartilhado: o documento e as categorias/subcategorias que o contêm
  const sharedWith = (p: Page) => new Set([...(ov[p.slug]?.shared ?? []), ...(gr[catOf(p)]?.shared ?? []), ...(subOf(p) ? gr[`${catOf(p)}/${subOf(p)}`]?.shared ?? [] : [])]);
  const canSee = (p: Page) => !owned(p) || owned(p) === me() || sharedWith(p).has(me());
  // categoria/sub privada (ex.: da empresa): fora de "ver todos"; só quem pode ver por dono ou compartilhamento
  const isPrivate = (p: Page) => !!(gr[catOf(p)]?.private || (subOf(p) && gr[`${catOf(p)}/${subOf(p)}`]?.private));
  const mine = (p: Page) => canSee(p) || (showAll && !isPrivate(p));
  const isShared = (p: Page) => sharedWith(p).size > 0;
  const nHidden = $derived(allPages.filter((p) => !canSee(p) && !isPrivate(p)).length);
  const toggleIn = (list: string[] | undefined, id: string) => (list ?? []).includes(id) ? (list ?? []).filter((x) => x !== id) : [...(list ?? []), id];
  async function shareDoc(p: Page, id: string) { await save(p, { shared: toggleIn(ov[p.slug]?.shared, id) }); }
  async function shareGroup(path: string, id: string) { await saveG(path, { shared: toggleIn(gr[path]?.shared, id) }); }
  let sharing = $state<string | null>(null); // grupo com o painel de compartilhamento aberto
  // um grupo é "meu" quando nenhuma página dentro dele pertence a outra pessoa (vazio conta como meu)
  const groupMine = (path: string) => allPages.filter((x) => (path.includes('/') ? `${catOf(x)}/${subOf(x)}` === path : catOf(x) === path)).every((x) => !owned(x) || owned(x) === me());
  // usuários conhecidos (para atribuir dono): id → username, carregado do PocketBase
  let people = $state<{ id: string; username: string }[]>([]);
  // última página aberta (overrides.opened), para retomar de onde parou
  const last = $derived.by(() => { let best: DocState | null = null; for (const s of Object.values(st)) { const pg = allPages.find((x) => x.slug === s.slug); if (pg && s.opened && !s.archived && (!best || s.opened > best.opened) && (!owned(pg) || owned(pg) === me())) best = s; } return best ? allPages.find((x) => x.slug === best!.slug)! : null; });          // lista só aparece com overrides/grupos carregados (sem flick de recolher)

  afterNavigate(() => scrollTo(0, 0));
  onMount(async () => {
    scrollTo(0, 0); // a home abre sempre no topo, mesmo voltando pelo histórico
    const ovs = await listOverrides(); const grs = await listGroups();
    if (ovs.length || grs.length) { ov = Object.fromEntries(ovs.map((o) => [o.slug, o])); gr = Object.fromEntries(grs.map((g) => [g.path, g])); remember('atlas-ov-cache', ov); remember('atlas-gr-cache', gr); }
    st = Object.fromEntries((await listStates()).map((s) => [s.slug, s]));
    ready = true;
    for (const pr of await listAllProgress()) if (pr.done) doneCount[pr.slug] = (doneCount[pr.slug] ?? 0) + 1;
    try { people = (await pb.collection('users').getFullList<{ id: string; username: string }>()).map((u) => ({ id: u.id, username: u.username })); } catch {}
  });

  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const title = (p: Page) => (ov[p.slug]?.title || p.title).replace(/\s*\(EN\)\s*$/, '');
  // rota segue o título: renomeou, a URL vira o kebab do novo título (a antiga continua como alias)
  const href = (p: Page) => p.raw ? `/raw/${p.slug}.html` : ov[p.slug]?.title ? `/${p.slug.split('/').slice(0, -1).concat(kebab(ov[p.slug].title)).join('/')}/` : `/${p.slug}/`;
  const archived = (p: Page) => !!st[p.slug]?.archived;
  const isRead = (p: Page) => !!st[p.slug]?.read;
  async function saveSt(p: Page, data: Partial<DocState>) { st[p.slug] = await saveState(p.slug, data); }
  async function setOwner(p: Page, owner: string) { await save(p, { owner }); moving = null; }
  let menuFor = $state<string | null>(null); // menu de ações (3 pontos) aberto para este slug
  let menuArmed = $state(false);
  // categorias/subcategorias recolhidas: no PocketBase (groups.collapsed), sincronizado entre aparelhos
  const collapsed = $derived.by(() => { const m: Record<string, boolean> = {}; for (const [k, g] of Object.entries(gr)) if (g.collapsed) m[k] = true; return m; });
  async function toggleCat(c: string) { const v = !collapsed[c]; gr[c] = { ...(gr[c] ?? { path: c }), collapsed: v } as Group; await saveG(c, { collapsed: v }); }
  const stats = (list: Page[]) => { const v = list.filter((p) => !archived(p)); return { n: v.length, read: v.filter(isRead).length }; };
  function openMenu(slug: string) { menuFor = menuFor === slug ? null : slug; menuArmed = false; if (menuFor) setTimeout(() => (menuArmed = true), 350); }
  const order = (p: Page) => ov[p.slug]?.order ?? 1000;
  // subcategoria virtual sobrepõe a pasta; '' = sem override, '/' = movida para a raiz
  const subOf = (p: Page) => { const s = ov[p.slug]?.sub; if (s) return s === '/' ? '' : s; return ov[p.slug]?.cat ? '' : p.sub; }; // ao mudar de categoria, a sub da pasta deixa de valer
  const gname = (path: string) => gr[path]?.title || path.split('/').pop()!;
  const gorder = (path: string) => gr[path]?.order ?? 1000;
  const visible = (list: Page[]) =>
    list.filter((p) => mine(p) && archived(p) === showArchived && (!q || norm(`${title(p)} ${p.description} ${p.cat} ${subOf(p)}`).includes(norm(q))))
        .sort((a, b) => order(a) - order(b) || title(a).localeCompare(title(b), 'pt-BR'));
  // raiz primeiro, depois subcategorias em ordem alfabética pelo nome exibido
  const subsOf = (list: Page[], cat?: string) => [...new Set([...list.map(subOf), ...(cat ? Object.keys(gr).filter((k) => k.startsWith(cat + '/')).map((k) => k.slice(cat.length + 1)) : [])])].sort((a, b) => (a === '') !== (b === '') ? (a === '' ? -1 : 1) : gorder(`${cat}/${a}`) - gorder(`${cat}/${b}`) || gname(`${cat}/${a}`).localeCompare(gname(`${cat}/${b}`), 'pt-BR'));
  const all = allPages;
  const total = $derived(all.filter((p) => mine(p) && !archived(p)).length);
  const nArchived = $derived(all.filter((p) => mine(p) && archived(p)).length);

  // Conflito de nome: uma página por caminho no disco. Verifica antes de gravar a intenção.
  const taken = (slug: string, except?: string) => allPages.some((x) => x.slug === slug && x.slug !== except) || Object.values(ov).some((o) => o.title && o.slug !== except && `${o.slug.split('/').slice(0, -1).join('/')}/${kebab(o.title)}` === slug);
  const conflict = (slug: string) => { alert(`Já existe uma página em ${slug}. Escolha outro nome.`); return true; };
  async function save(p: Page, data: Partial<Override>) { ov[p.slug] = await saveOverride(p.slug, data); remember('atlas-ov-cache', ov); }
  async function saveG(path: string, data: Partial<Group>) { gr[path] = await saveGroup(path, data); remember('atlas-gr-cache', gr); }
  async function removeG(path: string) { await deleteGroup(path); delete gr[path]; remember('atlas-gr-cache', gr); await enqueueFs({ op: 'delete-group', path }); }
  function startEdit(key: string, current: string) { editing = key; draft = current; }
  async function commit(p?: Page, gpath?: string) {
    const v = draft.trim();
    if (p) {
      const target = `${p.slug.split('/').slice(0, -1).join('/')}/${kebab(v)}`;
      if (target !== p.slug && taken(target, p.slug)) return conflict(target);
      await save(p, { title: v }); await enqueueFs({ op: 'rename-page', slug: p.slug, title: v });
    } else if (gpath) {
      const target = [...gpath.split('/').slice(0, -1), kebab(v)].join('/');
      if (target !== gpath && (gr[target] || allPages.some((x) => x.slug.startsWith(target + '/')))) return conflict(target + '/');
      await saveG(gpath, { title: v }); await enqueueFs({ op: 'rename-group', path: gpath, title: v });
    }
    editing = null;
  }
  async function move(p: Page, list: Page[], dir: -1 | 1) {
    const sorted = visible(list).filter((x) => subOf(x) === subOf(p)); const i = sorted.indexOf(p); const j = i + dir;
    if (j < 0 || j >= sorted.length) return;
    const next = [...sorted]; [next[i], next[j]] = [next[j], next[i]];
    await Promise.all(next.map((x, k) => save(x, { order: (k + 1) * 10 })));
  }
  async function moveTo(p: Page, sub: string, cat?: string) {
    const c = cat ?? catOf(p), s = sub.trim(); const target = [c, s, p.slug.split('/').pop()].filter(Boolean).join('/');
    if (target !== p.slug && taken(target, p.slug)) return conflict(target);
    await save(p, { sub: s || '/', ...(cat !== undefined ? { cat: cat === p.cat ? '' : cat } : {}) });
    await enqueueFs({ op: 'move-page', slug: p.slug, cat: c, sub: s });
    moving = null; newSub = null; draft = '';
  }
  let cloning = $state(false); // o drawer de mover está em modo "clonar para mim"
  async function cloneTo(p: Page, sub: string, cat?: string) {
    await enqueueFs({ op: 'clone-page', slug: p.slug, cat: cat ?? catOf(p), sub: sub.trim(), owner: me() });
    moving = null; cloning = false; alert('Clone pedido. Aparece na home quando o worker terminar.');
  }
  const pick = (p: Page, sub: string, cat?: string) => (cloning ? cloneTo(p, sub, cat) : moveTo(p, sub, cat));
  let addingSub = $state<string | null>(null);
  // modo de reordenar subcategorias de uma categoria: lista temporária, salva ao confirmar
  let reorderCat = $state<string | null>(null);
  let reorderList = $state<string[]>([]);
  let dragging = $state<string | null>(null);
  function startReorder(cat: string) { reorderCat = cat; reorderList = subsOf(cats[cat], cat).filter(Boolean); }
  function moveSub(from: number, to: number) { if (to < 0 || to >= reorderList.length) return; const l = [...reorderList]; const [x] = l.splice(from, 1); l.splice(to, 0, x); reorderList = l; }
  async function saveReorder() { const cat = reorderCat!; await Promise.all(reorderList.map((s, i) => saveG(`${cat}/${s}`, { order: (i + 1) * 10 }))); reorderCat = null; }
  let newSub = $state<string | null>(null);
  let newCat = $state<string | null>(null);
  async function addSub(cat: string) { const s = draft.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); if (s) { await saveG(`${cat}/${s}`, { title: draft.trim() }); await enqueueFs({ op: 'create-group', path: `${cat}/${s}` }); } addingSub = null; draft = ''; }
</script>

<svelte:window onclick={(e) => { if (!(e.target as HTMLElement).closest('.more, .tools')) menuFor = null; }} />
<svelte:head><title>Atlas</title></svelte:head>

<main class="home">
  <div class="doc-head">
    <h1>{showArchived ? 'Arquivados' : 'Atlas'} <span class="count-docs">{showArchived ? nArchived : total}</span></h1>
    {#if showArchived}<p class="deck">{nArchived} página(s) arquivada(s).</p>{/if}
  </div>
  {#if last && !showArchived}
    <a class="resume" href={href(last)}><BookMarked size={16} /><span><i>Continuar</i>{title(last)}</span><em>{#if last.checklist}<b class:full={(doneCount[last.slug] ?? 0) >= last.checklist}>{doneCount[last.slug] ?? 0}/{last.checklist}</b> · {/if}{Math.round((st[last.slug]?.pos ?? 0) * 100)}%</em></a>
  {/if}
  <div class="bar">
    <input class="search" type="search" placeholder="Buscar…" bind:value={q} />
    {#if auth.ok}
      <AskAtlas cats={Object.keys(cats).flatMap((c) => [c, ...subsOf(cats[c], c).filter(Boolean).map((s) => `${c}/${s}`)])} onSent={() => { reqTick++; showHistory = true; autoOpened = true; }} />
      <button class="toggle" type="button" aria-pressed={showHistory} onclick={() => { showHistory = !showHistory; autoOpened = false; clearTimeout(dismissTimer); }} title="Histórico de pedidos" aria-label="Histórico de pedidos"><History size={18} />{#if pendingReqs}<span class="count">{pendingReqs}</span>{/if}</button>
    {/if}
    {#if nHidden}<button class="toggle" type="button" aria-pressed={showAll} onclick={() => (showAll = !showAll)} title={showAll ? 'Só os meus e compartilhados' : `Ver também os de outras pessoas (${nHidden})`} aria-label="Ver todos"><Users size={18} /></button>{/if}
    <button class="toggle" type="button" aria-pressed={showArchived} onclick={() => (showArchived = !showArchived)} title={showArchived ? 'Voltar aos ativos' : `Arquivados (${nArchived})`} aria-label="Arquivados">
      {#if showArchived}<ArchiveRestore size={18} />{:else}<Archive size={18} />{/if}
      {#if nArchived && !showArchived}<span class="count">{nArchived}</span>{/if}
    </button>
  </div>
  {#if auth.ok}<RequestList tick={reqTick} visible={showHistory} {onPending} />{/if}
  {#if !showHistory}
  {#if !ready}
    <div class="skeleton" aria-hidden="true">
      {#each [3, 5, 2, 4, 3, 6] as n, i}
        <div class="sk-cat"><span class="sk-bar" style:width="{18 + ((i * 7) % 16)}%"></span></div>
        {#each Array(n) as _, j}<div class="sk-row"><span class="sk-bar" style:width="{48 + ((i * 13 + j * 29) % 45)}%"></span></div>{/each}
      {/each}
    </div>
  {:else}
  {#each Object.keys(cats).sort((a, b) => gname(a).localeCompare(gname(b), 'pt-BR')) as cat}
    {@const list = visible(cats[cat])}
    {#if list.length || (auth.ok && !q && cats[cat].length === 0)}
      {#snippet groupName(path: string, cls: string, empty: boolean = false)}
        {#if editing === `g:${path}`}
          <form class="edit" onsubmit={(e) => { e.preventDefault(); commit(undefined, path); }}>
            <!-- svelte-ignore a11y_autofocus -->
            <input bind:value={draft} autofocus onkeydown={(e) => e.key === 'Escape' && (editing = null)} />
            <button type="submit" title="Salvar"><Check size={16} /></button>
            <button type="button" title="Cancelar" onclick={() => (editing = null)}><X size={16} /></button>
          </form>
        {:else}
          <div class="{cls} grp">
            {#if auth.ok}<button type="button" class="gname" title="Renomear" onclick={() => startEdit(`g:${path}`, gname(path))}>{gname(path)}</button>{:else}<span>{gname(path)}</span>{/if}
            {#if auth.ok && groupMine(path)}<span class="tools always"><button type="button" title="Renomear grupo" onclick={() => startEdit(`g:${path}`, gname(path))}><Pencil size={13} /></button>{#if cls === 'cat'}<button type="button" title="Nova subcategoria" onclick={() => { addingSub = path; draft = ''; }}><Plus size={13} /></button>{#if subsOf(cats[path], path).filter(Boolean).length > 1}<button type="button" title="Reordenar subcategorias" onclick={() => startReorder(path)}><ArrowUpDown size={13} /></button>{/if}{/if}{#if people.length > 1}<button type="button" title={gr[path]?.private ? 'Privada (fora de "ver todos"); clique para tornar visível' : 'Tornar privada (fora de "ver todos")'} class:active={!!gr[path]?.private} onclick={() => saveG(path, { private: !gr[path]?.private })}>{#if gr[path]?.private}<Lock size={13} />{:else}<LockOpen size={13} />{/if}</button>{/if}{#if people.length > 1}<button type="button" title="Compartilhar {cls === 'cat' ? 'categoria' : 'subcategoria'}" class:active={(gr[path]?.shared ?? []).length > 0} onclick={() => (sharing = sharing === path ? null : path)}><Users size={13} /></button>{/if}{#if empty}<button type="button" title="Excluir grupo vazio" class="danger" onclick={() => removeG(path)}><Trash2 size={13} /></button>{/if}</span>{/if}
            {#if sharing === path}<span class="share-panel">{#each people.filter((u) => u.id !== me()) as u (u.id)}<button type="button" class:current={(gr[path]?.shared ?? []).includes(u.id)} onclick={() => shareGroup(path, u.id)}>{(gr[path]?.shared ?? []).includes(u.id) ? '✓ ' : ''}{u.username}</button>{/each}</span>{/if}
          </div>
        {/if}
      {/snippet}

      <section class="catbox">
      <div class="cathead">
        <button type="button" class="fold" aria-expanded={!collapsed[cat]} title={collapsed[cat] ? 'Expandir' : 'Recolher'} onclick={() => toggleCat(cat)}><ChevronRight size={16} class={collapsed[cat] ? '' : 'down'} /></button>
        {@render groupName(cat, 'cat', cats[cat].length === 0)}
        {#if !q}{@const s = stats(cats[cat])}<span class="stat">{s.read}/{s.n}</span>{/if}
      </div>
      {#if !collapsed[cat] || q}
      {#if addingSub === cat}
        <form class="edit" onsubmit={(e) => { e.preventDefault(); addSub(cat); }}>
          <!-- svelte-ignore a11y_autofocus -->
          <input bind:value={draft} autofocus placeholder="nova subcategoria" onkeydown={(e) => e.key === 'Escape' && (addingSub = null)} />
          <button type="submit" title="Criar"><Check size={16} /></button>
          <button type="button" title="Cancelar" onclick={() => (addingSub = null)}><X size={16} /></button>
        </form>
      {/if}
      {#if reorderCat === cat}
        <div class="reorder">
          {#each reorderList as s, i (s)}
            <div class="ro-item" class:dragging={dragging === s} draggable="true"
              ondragstart={(e) => { dragging = s; e.dataTransfer?.setData('text/plain', s); }}
              ondragover={(e) => { e.preventDefault(); const from = reorderList.indexOf(dragging ?? ''); if (from >= 0 && from !== i) moveSub(from, i); }}
              ondragend={() => (dragging = null)}>
              <span class="grip"><GripVertical size={16} /></span>
              <span class="ro-name">{gname(`${cat}/${s}`)}</span>
              <button type="button" title="Subir" onclick={() => moveSub(i, i - 1)} disabled={i === 0}><ArrowUp size={14} /></button>
              <button type="button" title="Descer" onclick={() => moveSub(i, i + 1)} disabled={i === reorderList.length - 1}><ArrowDown size={14} /></button>
            </div>
          {/each}
          <div class="ro-actions">
            <button type="button" class="ok" onclick={saveReorder}><Check size={16} /> Salvar ordem</button>
            <button type="button" onclick={() => (reorderCat = null)}><X size={16} /> Cancelar</button>
          </div>
        </div>
      {:else}
      {#each (q ? subsOf(list) : subsOf(list, cat)) as sub}
        <fieldset class="subbox" class:root={!sub}>
        {#if sub}<legend><span class="subhead"><button type="button" class="fold" aria-expanded={!collapsed[`${cat}/${sub}`]} title={collapsed[`${cat}/${sub}`] ? 'Expandir' : 'Recolher'} onclick={() => toggleCat(`${cat}/${sub}`)}><ChevronRight size={14} class={collapsed[`${cat}/${sub}`] ? '' : 'down'} /></button>{@render groupName(`${cat}/${sub}`, 'sub', !list.some((p) => subOf(p) === sub))}</span></legend>{/if}
        {#if !sub || !collapsed[`${cat}/${sub}`] || q}
        <ul class="pages">
          {#if sub && !list.some((p) => subOf(p) === sub)}<li class="empty">vazia</li>{/if}
          {#if !sub && cats[cat].length === 0}<li class="empty">categoria vazia</li>{/if}
          {#each list.filter((p) => subOf(p) === sub) as p (p.slug)}
            <li class:read={isRead(p)}>
              {#if editing === p.slug}
                <form class="edit" onsubmit={(e) => { e.preventDefault(); commit(p); }}>
                  <!-- svelte-ignore a11y_autofocus -->
                  <input bind:value={draft} autofocus onkeydown={(e) => e.key === 'Escape' && (editing = null)} />
                  <button type="submit" title="Salvar"><Check size={16} /></button>
                  <button type="button" title="Cancelar" onclick={() => (editing = null)}><X size={16} /></button>
                </form>
              {:else}
                <a href={href(p)} data-sveltekit-reload={p.raw || undefined} onclick={(e) => { e.stopPropagation(); menuFor = null; }}>
                  <span class="ttl">{#if isRead(p)}<BookCheck size={14} class="readmark" />{/if}{title(p)}{#if p.en}<span class="lang">EN</span>{/if}</span>
                  <span class="meta">{#if isShared(p)}<span class="shared" title="compartilhado com {[...sharedWith(p)].map((id) => people.find((u) => u.id === id)?.username ?? '?').join(', ')}"><Users size={12} /></span>{' · '}{/if}{#if owned(p) && owned(p) !== me()}<span class="pill muted">{people.find((u) => u.id === owned(p))?.username ?? 'privado'}</span>{' · '}{/if}{#if p.checklist}<span class="prog" class:full={(doneCount[p.slug] ?? 0) >= p.checklist}>{doneCount[p.slug] ?? 0}/{p.checklist}</span>{' · '}{/if}{[p.mode, p.date].filter(Boolean).join(' · ')}</span>
                </a>
                {#if auth.ok}
                  <button type="button" class="more" title="Ações" aria-label="Ações" aria-expanded={menuFor === p.slug} onclick={() => openMenu(p.slug)}><MoreVertical size={16} /></button>
                  <span class="tools">
                    {#if owned(p) && owned(p) !== me()}<button type="button" title="Clonar para mim" onclick={() => { moving = p.slug; cloning = true; menuFor = null; }}><Copy size={14} /></button>{:else}
                    <button type="button" title="Renomear" onclick={() => { startEdit(p.slug, title(p)); menuFor = null; }}><Pencil size={14} /></button>
                    <button type="button" title="Mover para outra subcategoria" onclick={() => { moving = p.slug; cloning = false; draft = subOf(p); menuFor = null; }}><FolderInput size={14} /></button>
                    <button type="button" title="Subir" onclick={() => move(p, cats[cat], -1)}><ArrowUp size={14} /></button>
                    <button type="button" title="Descer" onclick={() => move(p, cats[cat], 1)}><ArrowDown size={14} /></button>
                    <button type="button" title={archived(p) ? 'Desarquivar' : 'Arquivar'} onclick={() => { saveSt(p, { archived: !archived(p) }); menuFor = null; }}>{#if archived(p)}<ArchiveRestore size={14} />{:else}<Archive size={14} />{/if}</button>
                    <button type="button" title={isRead(p) ? 'Marcar como não lido' : 'Marcar como lido'} onclick={() => { saveSt(p, { read: !isRead(p) }); menuFor = null; }}>{#if isRead(p)}<BookOpen size={14} />{:else}<BookCheck size={14} />{/if}</button>
                    {/if}
                  </span>
                {/if}
              {/if}
            </li>
          {/each}
        </ul>
        {:else}
        <div class="folded">{list.filter((p) => subOf(p) === sub).length} página(s)</div>
        {/if}
        </fieldset>
      {/each}
      {/if}
      {/if}
      </section>
    {/if}
  {/each}
  {/if}
  {/if}

  {#if menuFor && auth.ok}
    {@const p = allPages.find((x) => x.slug === menuFor)}
    {#if p}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="scrim" onclick={() => (menuFor = null)}></div>
      <div class="sheet" class:armed={menuArmed} role="menu">
        <div class="sheet-title">{title(p)}</div>
        {#if owned(p) && owned(p) !== me()}<button type="button" onclick={() => { moving = p.slug; cloning = true; menuFor = null; }}><Copy size={18} /> Clonar para mim</button>{:else}
        <button type="button" onclick={() => { startEdit(p.slug, title(p)); menuFor = null; }}><Pencil size={18} /> Renomear</button>
        <button type="button" onclick={() => { moving = p.slug; cloning = false; menuFor = null; }}><FolderInput size={18} /> Mover para outra categoria</button>
        <button type="button" onclick={() => move(p, cats[catOf(p)], -1)}><ArrowUp size={18} /> Subir</button>
        <button type="button" onclick={() => move(p, cats[catOf(p)], 1)}><ArrowDown size={18} /> Descer</button>
        <button type="button" onclick={() => { saveSt(p, { archived: !archived(p) }); menuFor = null; }}>{#if archived(p)}<ArchiveRestore size={18} /> Desarquivar{:else}<Archive size={18} /> Arquivar{/if}</button>
        <button type="button" onclick={() => { saveSt(p, { read: !isRead(p) }); menuFor = null; }}>{#if isRead(p)}<BookOpen size={18} /> Marcar como não lido{:else}<BookCheck size={18} /> Marcar como lido{/if}</button>
        {/if}
        <button type="button" class="cancel" onclick={() => (menuFor = null)}><X size={18} /> Cancelar</button>
      </div>
    {/if}
  {/if}

  {#if moving && auth.ok}
    {@const p = allPages.find((x) => x.slug === moving)}
    {#if p}
      {@const cur = catOf(p)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div class="scrim" onclick={() => { moving = null; cloning = false; }}></div>
      <div class="sheet mover" role="menu">
        <div class="sheet-title">{cloning ? 'Clonar para mim' : 'Mover'} <b>{title(p)}</b></div>
        <div class="sheet-body">
          {#each Object.keys(cats).sort((a, b) => (a === cur ? -1 : b === cur ? 1 : gname(a).localeCompare(gname(b), 'pt-BR'))) as c}
            <div class="grp-title">{gname(c)}{#if c === cur} <span class="pill muted">atual</span>{/if}</div>
            <button type="button" class:current={c === cur && subOf(p) === ''} onclick={() => pick(p, '', c)}>raiz de {gname(c)}</button>
            {#each subsOf(cats[c], c).filter(Boolean) as s}
              <button type="button" class="sub" class:current={c === cur && subOf(p) === s} onclick={() => pick(p, s, c)}>{gname(`${c}/${s}`)}</button>
            {/each}
          {/each}
          {#if !cloning}
          <div class="grp-title">Dono</div>
          <button type="button" class:current={!owned(p)} onclick={() => setOwner(p, '')}>de todos</button>
          {#each people as u (u.id)}<button type="button" class="sub" class:current={owned(p) === u.id} onclick={() => setOwner(p, u.id)}>{u.username}{#if u.id === me()} <span class="pill muted">eu</span>{/if}</button>{/each}
          {#if owned(p) && people.some((u) => u.id !== owned(p))}
            <div class="grp-title">Compartilhar com</div>
            {#each people.filter((u) => u.id !== owned(p)) as u (u.id)}<button type="button" class="sub" class:current={(ov[p.slug]?.shared ?? []).includes(u.id)} onclick={() => shareDoc(p, u.id)}>{(ov[p.slug]?.shared ?? []).includes(u.id) ? '✓ ' : ''}{u.username}</button>{/each}
          {/if}
          {/if}
          <div class="grp-title">Criar</div>
          {#if newSub === p.slug}
            <form class="edit" onsubmit={(e) => { e.preventDefault(); const s = kebab(draft); if (s) { saveG(`${cur}/${s}`, { title: draft.trim() }); moveTo(p, s, cur); } newSub = null; }}>
              <!-- svelte-ignore a11y_autofocus -->
              <input bind:value={draft} autofocus placeholder="nova subcategoria em {gname(cur)}" />
              <button type="submit" title="Criar e mover"><Check size={16} /></button>
            </form>
          {:else}
            <button type="button" class="new" onclick={() => { newSub = p.slug; draft = ''; }}><Plus size={16} /> Nova subcategoria em {gname(cur)}</button>
          {/if}
          {#if newCat === p.slug}
            <form class="edit" onsubmit={(e) => { e.preventDefault(); const c = kebab(draft); if (c) { saveG(c, { title: draft.trim() }); moveTo(p, '', c); } newCat = null; }}>
              <!-- svelte-ignore a11y_autofocus -->
              <input bind:value={draft} autofocus placeholder="nome da nova categoria" />
              <button type="submit" title="Criar e mover"><Check size={16} /></button>
            </form>
          {:else}
            <button type="button" class="new" onclick={() => { newCat = p.slug; draft = ''; }}><Plus size={16} /> Nova categoria</button>
          {/if}
        </div>
        <button type="button" class="cancel" onclick={() => (moving = null)}><X size={18} /> Cancelar</button>
      </div>
    {/if}
  {/if}
</main>

<style>
  .meta .shared { display: inline-flex; vertical-align: -2px; color: var(--teal); }
  .tools button.active { color: var(--teal); }
  .share-panel { display: inline-flex; gap: 6px; margin-left: 8px; }
  .share-panel button { font: inherit; font-size: 12px; padding: 2px 8px; border: 1px solid var(--rule-2); border-radius: 12px; background: none; color: var(--ink-2); cursor: pointer; }
  .share-panel button.current { border-color: var(--teal); color: var(--teal); }
  .resume { display: flex; align-items: center; gap: 12px; margin: 0 0 18px; padding: 12px 14px; border: 1px solid var(--rule-2); border-radius: 8px; background: var(--surface); color: var(--ink); text-decoration: none; }
  .resume:hover { border-color: var(--blue); }
  .resume span { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .resume span > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .resume i { font-style: normal; font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); }
  .resume em { font-style: normal; font-family: var(--mono); font-size: 12px; color: var(--ink-3); white-space: nowrap; }
  .resume em b { font-weight: 400; color: var(--amber); } .resume em b.full { color: var(--green); }
  main.home { margin: 0 auto; max-width: 1060px; padding: 70px 32px 120px; }
  .grp { display: flex; align-items: center; gap: 8px; line-height: 1.2; }
  .grp > span, .gname { display: inline-block; line-height: 1.2; }
  .cathead, .subhead { line-height: 1.2; }
  .count-docs { font-family: var(--mono); font-size: .45em; color: var(--ink-3); vertical-align: middle; margin-left: 6px; }
  .cathead { display: flex; align-items: center; gap: 6px; }
  .cathead :global(.cat) { margin: 6px 0; }
  .fold { display: inline-flex; align-items: center; line-height: 0; padding: 4px; margin-left: -6px; background: none; border: 0; color: var(--ink-3); cursor: pointer; }
  .fold :global(svg) { transition: transform .15s; } .fold :global(svg.down) { transform: rotate(90deg); }
  .stat { margin-left: auto; font-family: var(--mono); font-size: 12px; color: var(--ink-3); }
  .gname { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: text; text-align: left; }
  .gname:hover { text-decoration: underline dotted; }
  .catbox { margin: 34px 0 0; padding: 6px 18px 14px; border: 1px solid color-mix(in srgb, var(--rule) 70%, transparent); border-radius: 12px; background: color-mix(in srgb, var(--surface) 35%, transparent); }
  .catbox :global(.cat) { margin: 6px 0 8px; }
  .subbox { margin: 14px 0 4px; padding: 4px 14px 8px; border: 1px solid var(--rule-2); border-radius: 10px; min-width: 0; min-inline-size: 0; }
  .catbox { min-width: 0; }
  .subbox.root { border: 0; padding: 0; margin: 0; }
  .subbox legend { padding: 0 8px; margin-left: 4px; max-width: calc(100% - 24px); }
  .subbox legend .edit, .cathead .edit { width: 100%; min-width: 0; }
  .subbox legend .edit input, .cathead .edit input { flex: 1 1 auto; min-width: 0; width: auto; }
  .subbox legend :global(.sub) { margin: 0; }
  .subhead { display: inline-flex; align-items: center; gap: 2px; }
  .reorder { display: grid; gap: 6px; margin: 12px 0 4px; }
  .ro-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--surface); border: 1px solid var(--rule-2); border-radius: 8px; cursor: grab; }
  .ro-item.dragging { opacity: .5; }
  .ro-item .grip { color: var(--ink-3); display: inline-flex; }
  .ro-name { flex: 1; }
  .ro-item button, .ro-actions button { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 14px; padding: 6px 8px; color: var(--ink-3); background: none; border: 1px solid transparent; border-radius: 4px; cursor: pointer; }
  .ro-item button:hover, .ro-actions button:hover { color: var(--blue); border-color: var(--rule-2); }
  .ro-item button:disabled { opacity: .3; cursor: default; }
  .ro-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .ro-actions .ok { color: var(--green); border-color: var(--green); }
  .subhead .fold { margin-left: -4px; padding: 2px; }
  .folded { font-family: var(--mono); font-size: 12px; color: var(--ink-3); padding: 2px 4px 6px; }
  .subbox ul.pages { margin: 0; }
  .prog { color: var(--amber); } .prog.full { color: var(--green); }
  .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: stretch; margin: 26px 0 40px; }
  .bar :global(.search) { flex: 1 1 100%; margin: 0; }
  @media (min-width: 641px) { .bar :global(.search) { flex: 1 1 auto; } .bar :global(.ask), .toggle { height: 46px; width: 50px; flex: 0 0 auto; } }
  @media (max-width: 640px) { .bar :global(.ask), .toggle { width: 40px; height: 40px; flex: 0 0 auto; } .bar :global(.ask svg), .toggle > :global(svg) { width: 16px; height: 16px; } .count { top: -5px; right: -5px; min-width: 16px; height: 16px; font-size: 10px; line-height: 16px; } }
  .toggle { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 50px; color: var(--ink-2); background: var(--surface); border: 1px solid var(--rule-2); border-radius: 3px; cursor: pointer; }
  .count { position: absolute; top: -6px; right: -6px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; font-family: var(--mono); font-size: 11px; line-height: 18px; color: var(--bg); background: var(--amber); }
  .toggle:hover { color: var(--ink); border-color: var(--blue); }
  .toggle[aria-pressed="true"] { color: var(--blue); border-color: var(--blue); background: var(--blue-dim); }
  .sub { color: var(--ink-3); font-size: .85em; font-family: var(--mono); letter-spacing: .04em; }
  li { display: flex; align-items: center; gap: 8px; position: relative; }
  li :global(a) { flex: 1; min-width: 0; }
  li.read .ttl { color: var(--ink-2); }
  li :global(.readmark) { color: var(--green); margin-right: 8px; vertical-align: -2px; }
  .more { display: none; }
  .tools i { display: none; font-style: normal; }
  li .ttl { display: block; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  li.empty { color: var(--ink-3); font-size: .85em; padding: 10px 4px; border-bottom: 0; }
  /* ferramentas sobrepõem o meta ao passar o mouse, sem roubar largura do título */
  .tools.always { position: static; transform: none; opacity: 1; pointer-events: auto; background: none; padding-left: 0; }
  .tools .danger:hover { color: var(--red); }
  .tools { display: flex; gap: 2px; opacity: 0; pointer-events: none; transition: opacity .15s; position: absolute; right: 4px; top: 50%; transform: translateY(-50%); background: var(--bg); padding-left: 10px; }
  @media (hover: hover) { li:hover .tools, .grp:hover .tools { pointer-events: auto; } }
  .tools.open { pointer-events: auto; }
  @media (hover: hover) { li:hover .tools, li:focus-within .tools, .grp:hover .tools { opacity: 1; } }
  .tools:has(button:focus-visible) { opacity: 1; }
  .tools button, .edit button { display: inline-flex; align-items: center; justify-content: center; padding: 4px; line-height: 0; background: none; border: 1px solid transparent; border-radius: 4px; color: var(--ink-3); cursor: pointer; }
  .tools button:hover, .edit button:hover { color: var(--blue); border-color: var(--rule-2); }
  .edit { flex: 1; display: flex; align-items: center; gap: 6px; padding: 8px 0; }
  .edit input { flex: 1; font: inherit; font-size: 16px; padding: 6px 10px; color: var(--ink); background: var(--surface); border: 1px solid var(--blue); border-radius: 4px; }

  @media (max-width: 640px) {
    li .ttl { display: block; width: 100%; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    li :global(.meta) { font-size: 11px; }
    .more { display: inline-flex; padding: 8px; background: none; border: 0; color: var(--ink-3); cursor: pointer; }
    .tools { display: none; }
    .tools.always { display: flex; position: static; flex-direction: row; padding: 0; background: none; border: 0; box-shadow: none; pointer-events: auto; }
    .tools.always button { padding: 6px; font-size: 13px; color: var(--ink-3); }
    .tools button { display: flex; align-items: center; justify-content: flex-start; gap: 10px; padding: 9px 10px; font: inherit; font-size: 15px; line-height: 1; color: var(--ink); }
    .tools button :global(svg) { flex: none; }
    .tools i { display: inline; }
  }
  /* drawers (ações e mover): fixos na base, largura total, com scrim */
  .scrim { position: fixed; inset: 0; z-index: 150; background: rgba(0,0,0,.45); animation: fade .18s ease-out; }
  @keyframes fade { from { opacity: 0; } }
  @keyframes rise { from { transform: translateY(100%); } }
  @media (min-width: 641px) { @keyframes rise { from { transform: translate(-50%, 100%); } } }
  .skeleton { padding-top: 12px; min-height: 100vh; }
  .sk-cat { padding: 12px 14px; margin: 26px 0 8px; border: 1px solid var(--rule); border-radius: 8px; background: var(--surface); }
  .sk-row { padding: 0 14px; height: 40px; display: flex; align-items: center; border-bottom: 1px solid var(--rule); }
  .sk-bar { display: block; height: 12px; border-radius: 6px; background: var(--rule-2); opacity: .55; }
  .sk-cat .sk-bar { height: 14px; background: var(--ink-3); opacity: .35; }
  .sheet { animation: rise .22s cubic-bezier(.2,.8,.2,1); position: fixed; left: 0; right: 0; bottom: 0; z-index: 160; display: flex; flex-direction: column; gap: 2px; padding: 10px 12px calc(14px + env(safe-area-inset-bottom)); background: var(--surface); border-top: 1px solid var(--rule-2); border-radius: 16px 16px 0 0; box-shadow: 0 -10px 40px rgba(0,0,0,.45); max-height: 85vh; }
  .sheet:not(.armed):not(.mover) button { pointer-events: none; }
  .sheet.mover { pointer-events: auto; }
  .sheet .sheet-title { padding: 8px 10px 12px; font-size: 15px; color: var(--ink-2); border-bottom: 1px solid var(--rule); margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sheet .sheet-title b { color: var(--ink); font-weight: 600; }
  .sheet button { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; font: inherit; font-size: 16px; line-height: 1; padding: 13px 10px; color: var(--ink); background: none; border: 1px solid transparent; border-radius: 8px; cursor: pointer; }
  .sheet button:hover { border-color: var(--blue); }
  .sheet button.current { color: var(--blue); }
  .sheet button.sub { padding-left: 34px; color: var(--ink-2); font-size: 15px; }
  .sheet button.new { color: var(--violet); }
  .sheet button.cancel { color: var(--ink-3); margin-top: 6px; border-top: 1px solid var(--rule); border-radius: 0; }
  .sheet-body { overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
  .grp-title { font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); padding: 12px 10px 4px; }
  .sheet .edit { padding: 6px 10px; }
  .sheet .edit input { font-size: 15px; }
  /* desktop: mesmo drawer na base, limitado em largura e centralizado */
  @media (min-width: 641px) { .sheet { left: 50%; right: auto; transform: translateX(-50%); width: min(640px, 92vw); max-height: 70vh; } .sheet.mover .sheet-body { columns: 2; column-gap: 24px; display: block; } .sheet.mover .sheet-body > * { break-inside: avoid; } .sheet.mover .grp-title { break-after: avoid; } }
</style>
