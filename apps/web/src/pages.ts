/* Rendu HTML sans dépendance : une page technique de contrôle, pas l'application des agents. */

type Row = Record<string, any>;

const esc = (v: unknown): string =>
  v === null || v === undefined
    ? '<span class="na">—</span>'
    : String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const fmtDate = (v: unknown) => (v ? esc(new Date(v as string).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })) : esc(null));
const fmtPrice = (v: unknown) => (typeof v === 'number' ? `${v.toLocaleString('fr-FR')} €` : esc(null));
const badge = (status: unknown) => `<span class="badge ${esc(status)}">${esc(status)}</span>`;

const STATUS_LABELS: Record<string, string> = {
  complete: 'toutes les pages prévues ont été lues',
  partial: 'périmètre incomplet : interruption, troncature ou lignes rejetées',
  blocked: 'la source refuse l’accès ou n’est pas autorisée ; arrêt sans contournement',
  failed: 'erreur technique ou format inattendu, rien d’exploitable',
  running: 'en cours',
};

const STYLE = `
:root { --bg:#fbfbfa; --fg:#1d1d1b; --muted:#6b6b66; --line:#e3e2de; --card:#fff;
  --ok:#1f7a4d; --warn:#9a6700; --bad:#b42318; --info:#2c5aa0; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --fg:#ecebe7; --muted:#a3a29c; --line:#34332f; --card:#1f1f1d;
  --ok:#5cc28f; --warn:#e0b04a; --bad:#f07a6e; --info:#8ab4f0; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; }
main { max-width: 1280px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 32px 0 8px; }
p.lead { color: var(--muted); margin: 0 0 16px; }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; white-space: nowrap; }
th { font-weight: 600; color: var(--muted); font-size: 12px; }
td.wrap { white-space: normal; min-width: 240px; }
tr:last-child td { border-bottom: 0; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.na { color: var(--muted); }
.badge { display:inline-block; padding: 0 8px; border-radius: 10px; font-size: 12px; border: 1px solid currentColor; }
.badge.complete, .badge.seen, .badge.authorized { color: var(--ok); }
.badge.partial, .badge.unverified, .badge.not_seen { color: var(--warn); }
.badge.blocked, .badge.failed, .badge.refused { color: var(--bad); }
.badge.running { color: var(--info); }
form.filters { display:flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
form.filters input, form.filters select, form.filters button { font: inherit; padding: 4px 8px; border:1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); }
.pager { display:flex; gap: 12px; align-items:center; margin-top: 8px; color: var(--muted); }
a { color: var(--info); }
dl.legend { display:grid; grid-template-columns: max-content 1fr; gap: 2px 12px; color: var(--muted); font-size: 12px; margin: 8px 0 0; }
.bar { display:inline-block; height: 8px; background: var(--info); border-radius: 4px; vertical-align: middle; }
`;

function layout(title: string, body: string) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function qs(query: Record<string, string>, patch: Record<string, string | number>) {
  const params = new URLSearchParams({ ...query, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, String(v)])) });
  for (const [k, v] of [...params]) if (v === '') params.delete(k);
  return `?${params.toString()}`;
}

export function renderTechnicalPage(d: { sources: Row[]; runs: Row[]; completeness: Row[]; listings: Row; dpe: Row[]; query: Record<string, string> }) {
  const sources = d.sources.map((s) => `<tr>
    <td>${esc(s.id)}</td><td>${esc(s.kind)}</td><td>${s.enabled ? 'oui' : 'non'}</td><td>${badge(s.accessStatus)}</td>
    <td class="num">${esc(s.listingCount)}</td><td>${fmtDate(s.lastSeenAt)}</td>
    <td>${s.lastRun ? badge(s.lastRun.status) : esc(null)}</td><td class="wrap">${esc(s.lastRun?.blockReason ?? null)}</td></tr>`).join('');

  const runs = d.runs.map((r) => {
    const errors = (r.errors as Row[]).map((e) => `${e.kind} : ${e.message}`);
    const rejected = (r.rejectedItems as Row[]).map((x) => `${x.itemRef} : ${(x.errors as string[]).join(', ')}`);
    return `<tr><td>${fmtDate(r.startedAt)}</td><td>${esc(r.sourceId)}</td><td>${badge(r.status)}</td>
      <td>${r.exhaustive ? 'oui' : 'non'}</td><td class="num">${esc(r.pagesFetched)} / ${esc(r.pagesExpected)}</td>
      <td class="num">${esc(r.seen)}</td><td class="num">${esc(r.created)}</td><td class="num">${esc(r.updated)}</td>
      <td class="num">${esc(r.unchanged)}</td><td class="num">${esc(r.rejected)}</td>
      <td class="wrap">${[...errors, ...rejected].map(esc).join('<br>') || esc(null)}</td></tr>`;
  }).join('');

  const fields = [...new Set(d.completeness.map((c) => c.field as string))];
  const bySource = new Map<string, Map<string, Row>>();
  for (const c of d.completeness) {
    if (!bySource.has(c.source_id)) bySource.set(c.source_id, new Map());
    bySource.get(c.source_id)!.set(c.field, c);
  }
  const completeness = fields.map((f) => `<tr><td>${esc(f)}</td>${[...bySource.values()].map((m) => {
    const c = m.get(f);
    const pct = c && c.total ? Math.round((100 * c.filled) / c.total) : 0;
    return `<td class="num"><span class="bar" style="width:${pct * 0.6}px"></span> ${pct} %</td>`;
  }).join('')}</tr>`).join('');

  const dpe = d.dpe.map((x) => `<tr><td>${esc(x.inseeCode)}</td><td class="num">${esc(x.total)}</td>
    <td class="num">${esc(x.notGeocoded)}</td><td class="num">${esc(x.replaced)}</td>
    <td>${esc(x.lastReceivedAt)}</td><td>${esc(x.lastModifiedAt)}</td></tr>`).join('');

  const l = d.listings;
  const listings = (l.items as Row[]).map((x) => `<tr>
    <td><a href="/listings/${esc(x.id)}">${esc(x.externalId)}</a></td><td>${esc(x.sourceId)}</td><td>${esc(x.propertyType)}</td>
    <td>${esc(x.sellerType)}</td><td class="num">${fmtPrice(x.price)}</td><td class="num">${esc(x.surfaceValue)}</td>
    <td class="num">${esc(x.rooms)}</td><td>${esc(x.postalCode)} ${esc(x.city)}</td><td>${esc(x.energyClass)}</td>
    <td>${badge(x.presenceStatus)}</td><td>${fmtDate(x.firstSeenAt)}</td><td>${fmtDate(x.lastSeenAt)}</td></tr>`).join('');

  const q = d.query;
  const sel = (name: string, opts: string[]) =>
    `<select name="${name}"><option value="">${name}</option>${opts.map((o) => `<option ${q[name] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;

  return layout('Imo-hub · contrôle des données', `
<h1>Imo-hub · contrôle des données</h1>
<p class="lead">Page technique : état des sources, collectes récentes, complétude des champs et annonces stockées. « — » signifie que la source ne fournit pas l’information.</p>

<h2>Sources</h2>
<div class="scroll"><table><thead><tr><th>Source</th><th>Type</th><th>Active</th><th>Accès réel</th><th class="num">Annonces</th><th>Dernière observation</th><th>Dernière collecte</th><th>Motif de blocage</th></tr></thead>
<tbody>${sources || '<tr><td colspan="8" class="na">Aucune source</td></tr>'}</tbody></table></div>

<h2>Dernières collectes</h2>
<div class="scroll"><table><thead><tr><th>Début</th><th>Source</th><th>Statut</th><th>Exhaustive</th><th class="num">Pages</th><th class="num">Vues</th><th class="num">Créées</th><th class="num">Modifiées</th><th class="num">Inchangées</th><th class="num">Rejetées</th><th>Erreurs et rejets</th></tr></thead>
<tbody>${runs || '<tr><td colspan="11" class="na">Aucune collecte</td></tr>'}</tbody></table></div>
<dl class="legend">${Object.entries(STATUS_LABELS).map(([k, v]) => `<dt>${badge(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>

<h2>DPE par commune</h2>
<div class="scroll"><table><thead><tr><th>Code INSEE</th><th class="num">DPE</th><th class="num">Non géocodés</th><th class="num">Remplacés</th><th>Dernière réception</th><th>Dernière modification</th></tr></thead>
<tbody>${dpe || '<tr><td colspan="6" class="na">Aucun DPE importé</td></tr>'}</tbody></table></div>
<p class="lead">Un DPE indique un diagnostic réalisé, pas une intention de vendre. API : <a href="/api/dpe">/api/dpe</a></p>

<h2>Complétude des champs des annonces (état courant)</h2>
<div class="scroll"><table><thead><tr><th>Champ</th>${[...bySource.keys()].map((s) => `<th class="num">${esc(s)}</th>`).join('')}</tr></thead>
<tbody>${completeness || '<tr><td class="na">Aucune donnée</td></tr>'}</tbody></table></div>

<h2>Annonces (${esc(l.total)})</h2>
<form class="filters" method="get">
  ${sel('source', d.sources.map((s) => s.id as string))}
  ${sel('propertyType', ['house', 'apartment', 'land', 'parking', 'other'])}
  ${sel('sellerType', ['private', 'professional'])}
  ${sel('presence', ['seen', 'not_seen'])}
  <input name="postalCode" placeholder="Code postal" value="${q.postalCode ? esc(q.postalCode) : ''}" size="8">
  <input name="maxPrice" placeholder="Prix max" value="${q.maxPrice ? esc(q.maxPrice) : ''}" size="9">
  <button>Filtrer</button>
</form>
<div class="scroll"><table><thead><tr><th>Identifiant</th><th>Source</th><th>Type</th><th>Annonceur</th><th class="num">Prix</th><th class="num">m²</th><th class="num">Pièces</th><th>Localisation</th><th>DPE</th><th>Présence</th><th>Première vue</th><th>Dernière vue</th></tr></thead>
<tbody>${listings || '<tr><td colspan="12" class="na">Aucune annonce</td></tr>'}</tbody></table></div>
<div class="pager">
  ${l.page > 1 ? `<a href="${qs(q, { page: l.page - 1 })}">← Précédent</a>` : ''}
  <span>Page ${esc(l.page)} / ${esc(Math.max(1, l.totalPages))}</span>
  ${l.page < l.totalPages ? `<a href="${qs(q, { page: l.page + 1 })}">Suivant →</a>` : ''}
  <span>· API : <a href="/api/listings${qs(q, {})}">/api/listings</a></span>
</div>`);
}

export function renderListingPage(x: Row) {
  const c = x.current as Row;
  const facts = Object.entries(c).filter(([k]) => !['description'].includes(k))
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td class="wrap">${esc(v)}</td></tr>`).join('');
  const events = (x.events as Row[]).map((e) => `<tr><td>${fmtDate(e.observedAt)}</td><td>${esc(e.kind)}</td><td class="wrap">${esc(JSON.stringify(e.payload))}</td></tr>`).join('');
  const obs = (x.observations as Row[]).map((o) => `<tr><td>${fmtDate(o.observedAt)}</td><td>${badge(o.runStatus)}</td><td>${esc(o.runId)}</td></tr>`).join('');
  return layout(`Annonce ${x.externalId}`, `
<p><a href="/">← Contrôle des données</a></p>
<h1>${esc(x.title)}</h1>
<p class="lead">${esc(x.sourceId)} · ${esc(x.externalId)} · ${badge(x.presenceStatus)} · ${x.sourceUrl ? `<a href="${esc(x.sourceUrl)}" rel="noreferrer">voir la source</a>` : 'pas de lien source'}</p>
<p class="lead">« not_seen » signifie seulement que l’annonce n’a pas été revue lors de collectes complètes ; ce n’est ni un retrait ni une vente.</p>
<h2>Événements</h2><div class="scroll"><table><thead><tr><th>Observé le</th><th>Événement</th><th>Détail</th></tr></thead><tbody>${events}</tbody></table></div>
<h2>Observations (${(x.observations as Row[]).length})</h2><div class="scroll"><table><thead><tr><th>Observé le</th><th>Collecte</th><th>Identifiant de collecte</th></tr></thead><tbody>${obs}</tbody></table></div>
<h2>Valeurs courantes</h2><div class="scroll"><table><tbody>${facts}</tbody></table></div>
<h2>Description</h2><p>${esc(c.description)}</p>`);
}
