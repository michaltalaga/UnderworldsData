/** Records and the review page of a `npm run pairings -- --rebuild` run (extraction/pairings/<run>/). */

export interface PairingEntry {
  deck: string;
  stars: number;
  /** A rebuild's rating votes, in the order they came; `stars` is their median. */
  votes?: number[];
  note: string | null;
  notePl: string | null;
}

/** A warband's playstyle and ratings, as they are in the data files (old) or as the run wrote them (new). */
export interface PairingSnapshot {
  playstyle: string | null;
  playstylePl: string | null;
  ratings: PairingEntry[];
}

/** extraction/pairings/<run>/<slug>/result.json */
export interface PairingRecord {
  slug: string;
  name: string;
  opLegal: boolean;
  fighters: number;
  complete: boolean;
  error?: string;
  old: PairingSnapshot;
  new: PairingSnapshot | null;
}

/** extraction/pairings/<run>/summary.json */
export interface PairingsRunSummary {
  runId: string;
  model: string;
  provider: string;
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  seconds: number;
  sessions: number;
  selection: string[];
  /** Rating votes per warband (--votes). */
  votes?: number;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const stars = (n: number | undefined) => (n === undefined ? '–' : `${'★'.repeat(n)}${'☆'.repeat(3 - n)}`);
const words = (s: string | null) => (s ? s.trim().split(/\s+/).length : 0);

const isSplit = (e: PairingEntry) => Boolean(e.votes && new Set(e.votes).size > 1);

/**
 * Short counts for the console and the page: how many ratings change, the 3-star fits before
 * and after, and on how many decks the rating votes did not all agree.
 */
export function changeSummary(r: PairingRecord): { changed: number; total: number; oldTop: number; newTop: number; split: number } {
  const after = r.new?.ratings ?? [];
  const before = new Map(r.old.ratings.map((e) => [e.deck, e.stars]));
  return {
    changed: after.filter((e) => before.get(e.deck) !== e.stars).length,
    total: after.length,
    oldTop: r.old.ratings.filter((e) => e.stars === 3).length,
    newTop: after.filter((e) => e.stars === 3).length,
    split: after.filter(isSplit).length,
  };
}

const CSS = `
body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f5f2;color:#1f1d1a}
main{max-width:1180px;margin:0 auto;padding:28px 24px 64px}
h1{font-size:26px;margin:0 0 6px}h2{font-size:20px;margin:36px 0 8px;padding-top:12px;border-top:1px solid #ddd8cf}
.lead{color:#4a463f;max-width:820px}.hint{color:#6b665d;font-size:13px;margin:4px 0 10px}
.tiles{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}.tile{background:#fff;border:1px solid #e3ded4;border-radius:8px;padding:10px 14px;min-width:130px}
.tile b{display:block;font-size:22px}.tile span{color:#6b665d;font-size:13px}
nav{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px}nav a{color:#7a4b12}
.tag{font-size:12px;font-weight:500;background:#ece6da;color:#5b5346;border-radius:4px;padding:1px 6px;margin-left:8px;vertical-align:middle}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}.pair>div{background:#fff;border:1px solid #e3ded4;border-radius:8px;padding:10px 14px}
.pair h4{margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6b665d}.pair p{margin:0}
details{margin:8px 0 0;font-size:14px}summary{cursor:pointer;color:#6b665d}
table{border-collapse:collapse;width:100%;margin-top:12px;background:#fff;border:1px solid #e3ded4;font-size:14px}
th,td{text-align:left;vertical-align:top;padding:6px 10px;border-bottom:1px solid #eee9df}th{font-size:12px;color:#6b665d;font-weight:600}
td.s{white-space:nowrap;font-family:ui-monospace,Consolas,monospace;color:#8a5a12}tr.up td.new{background:#e5f3e3}tr.down td.new{background:#f8e3e0}
.votes{display:block;font-size:11px;color:#8b857a}td.note{color:#3d3a34}td.note .old{color:#8b857a;text-decoration:line-through;text-decoration-color:#c9c2b6}
.err{color:#a3271c}
@media (max-width:760px){.pair{grid-template-columns:1fr}}
`;

/**
 * The review page: per warband, the playstyle now and as the run wrote it side by side, then
 * every deck rating with its 3-star note, changed ratings marked.
 */
export function renderPairingsReport(summary: PairingsRunSummary | null, records: PairingRecord[], decks: { slug: string; code: string; name: string }[]): string {
  const deckBy = new Map(decks.map((d) => [d.slug, d]));
  const done = records.filter((r) => r.complete && r.new);
  const counts = done.map(changeSummary);
  const changed = counts.reduce((n, c) => n + c.changed, 0);
  const total = counts.reduce((n, c) => n + c.total, 0);
  const oldTop = counts.reduce((n, c) => n + c.oldTop, 0);
  const newTop = counts.reduce((n, c) => n + c.newTop, 0);
  const split = counts.reduce((n, c) => n + c.split, 0);
  const votes = summary?.votes ?? 1;
  const minutes = summary ? Math.round(summary.seconds / 60) : 0;

  const sections = records.map((r) => {
    const head = `<h2 id="${esc(r.slug)}">${esc(r.name)}${r.opLegal ? '' : '<span class="tag">Vaulted</span>'}<span class="tag">${r.fighters} fighters</span></h2>`;
    if (!r.complete || !r.new) return `${head}<p class="err">Not done${r.error ? `: ${esc(r.error)}` : ''}.</p>`;
    const c = changeSummary(r);
    const before = new Map(r.old.ratings.map((e) => [e.deck, e]));
    const rows = r.new.ratings.map((e) => {
      const old = before.get(e.deck);
      const deck = deckBy.get(e.deck);
      const cls = old === undefined || old.stars === e.stars ? '' : e.stars > old.stars ? 'up' : 'down';
      const noteChanged = (old?.note ?? null) !== e.note;
      const note = [
        old?.note && noteChanged ? `<div class="old">${esc(old.note)}</div>` : '',
        e.note ? `<div>${esc(e.note)}</div>` : '',
      ].join('');
      const votes = isSplit(e) ? `<span class="votes" title="the rating votes; the median is kept">${e.votes!.join(' · ')}</span>` : '';
      return `<tr class="${cls}"><td>${esc(deck ? `${deck.name.replace(/ Rivals Deck$/, '')} (${deck.code})` : e.deck)}</td><td class="s">${stars(old?.stars)}</td><td class="s new">${stars(e.stars)}${votes}</td><td class="note">${note}</td></tr>`;
    });
    return `${head}
<p class="hint">${c.changed} of ${c.total} ratings change; 3-star fits ${c.oldTop} → ${c.newTop}${c.split ? `; the votes split on ${c.split} deck(s) (shown under the stars)` : ''}.</p>
<div class="pair">
  <div><h4>Playstyle now (${words(r.old.playstyle)} words)</h4><p>${esc(r.old.playstyle ?? '(none)')}</p></div>
  <div><h4>Playstyle from the new data (${words(r.new.playstyle)} words)</h4><p>${esc(r.new.playstyle)}</p></div>
</div>
<details><summary>Polish playstyle</summary><div class="pair" style="margin-top:8px">
  <div><p>${esc(r.old.playstylePl ?? '(none)')}</p></div><div><p>${esc(r.new.playstylePl ?? '(none)')}</p></div>
</div></details>
<table><thead><tr><th>Deck</th><th>Now</th><th>New</th><th>3-star note (crossed out: the current one)</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  });

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pairings rebuild ${esc(summary?.runId ?? '')}</title><style>${CSS}</style></head><body><main>
<h1>Playstyles and pairings: review</h1>
<p class="lead">Each warband's playstyle, deck ratings and 3-star notes were written again from its current <code>fighters.json</code> and warscroll, without seeing the current text. Ratings are calibrated against the other warbands' current ratings${votes > 1 ? `, and each is the median of ${votes} independent votes` : ''}. Nothing in the data files has changed yet: <code>npm run pairings -- --apply ${esc(summary?.runId ?? '<run>')}</code> replaces the entries of every warband below.</p>
<div class="tiles">
  <div class="tile"><b>${done.length}</b><span>of ${records.length} warbands done</span></div>
  <div class="tile"><b>${changed}</b><span>of ${total} ratings change</span></div>
  <div class="tile"><b>${oldTop} → ${newTop}</b><span>3-star fits</span></div>
  ${votes > 1 ? `<div class="tile"><b>${split}</b><span>ratings where the votes split</span></div>` : ''}
  <div class="tile"><b>${summary ? `$${summary.costUsd.toFixed(2)}` : '?'}</b><span>${summary ? `${summary.calls} AI calls, ${minutes} min` : ''}</span></div>
</div>
<nav>${records.map((r) => `<a href="#${esc(r.slug)}">${esc(r.name)}</a>`).join('')}</nav>
${sections.join('\n')}
</main></body></html>
`;
}
