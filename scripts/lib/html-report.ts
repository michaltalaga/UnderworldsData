import { existsSync } from 'fs';
import { join, relative } from 'path';
import { CORE_IDS } from './catalog';
import { GA_KEYS, ROOT, loadWarbands, readJsonIfExists, warbandFile } from './data';
import { type Characteristic, type Fighter, type FighterSide, type FightersFile, type Weapon } from './fighters';
import { wordDiff, type RunSummary, type WarbandRecord } from './rebuild-report';
import { canonText } from './votes';

/**
 * The review page of a run (extraction/<run>/report.html), built only from the files the run
 * saved: what needs a person's decision (with the card picture and every answer the reads
 * gave), what changes if the run is applied (in words, per warband), and the cross-checks.
 * report.md keeps everything in full; this page is for reading.
 */

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

interface VoteField {
  field: string;
  status: string;
  value: unknown;
  votes: { answer: string; count: number; example?: unknown; reads: string[] }[];
}
interface VoteRegion {
  region: string;
  reads?: number;
  fields?: VoteField[];
}

interface Names {
  slug: string;
  /** Runemark id -> how to say it (Grot, Leader, the warband runemark...). */
  label: (id: string) => string;
}

function namesFor(runDir: string, slug: string): Names {
  const catalog = readJsonIfExists<{ runemarks: { id: string; keyword: string | null; label: string; source: string }[] }>(join(runDir, slug, 'runemarks', 'runemarks.json'));
  const byId = new Map((catalog?.runemarks ?? []).map((r) => [r.id, r]));
  const label = (id: string) => {
    if (id === slug) return 'warband runemark';
    const r = byId.get(id);
    if (r?.keyword) return r.keyword;
    if (id === 'crit') return 'Critical';
    return id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
  };
  return { slug, label };
}

// ---------- values in words ----------

const show = (v: Characteristic, n: Names) => (typeof v === 'number' ? String(v) : `${n.label(v)} runemark`);
const saveText = (s: FighterSide['save'], n: Names) => `${show(s.dice, n)} ${s.symbol}`;
const abilityText = (a: { name: string; critical: boolean }, n: Names) => `${a.critical ? 'Critical ' : ''}${n.label(a.name)}`;
const weaponText = (w: Weapon, n: Names) =>
  `${w.reach}, Range ${show(w.range, n)}, ${show(w.dice, n)} ${w.symbol}, Damage ${show(w.damage, n)}${w.abilities.length ? `, ${w.abilities.map((a) => abilityText(a, n)).join(' + ')}` : ''}`;

function valueText(field: string, value: unknown, n: Names): string {
  if (value === null || value === undefined) return '(none)';
  if (field === 'runemarks' && Array.isArray(value)) {
    return value.map((m: { id?: string } | string) => n.label(typeof m === 'string' ? m : m.id ?? '?')).join(', ') || 'none';
  }
  if (field.endsWith('.abilities') && Array.isArray(value)) {
    return value.map((a: { id?: string; name?: string; critical?: boolean }) => abilityText({ name: a.id ?? a.name ?? '?', critical: Boolean(a.critical) }, n)).join(' + ') || 'none';
  }
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** The current file's value of a voted field, to show next to the answers. */
function currentValue(old: Fighter | undefined, side: string, field: string, n: Names): string {
  if (!old) return '(no current file)';
  if (field === 'name') return old.name;
  if (field === 'rulesText') return old.cardRulesText ?? '(none)';
  const s = (old as unknown as Record<string, FighterSide>)[side];
  if (!s) return '?';
  if (field === 'runemarks') return s.runemarks.map((r) => n.label(r)).join(', ') || 'none';
  if (field === 'save.symbol') return s.save.symbol;
  if (field === 'save.dice') return show(s.save.dice, n);
  if (field === 'weapons.count') return String(s.weapons.length);
  const m = field.match(/^weapons\[(\d+)\]\.(\w+)$/);
  if (m) {
    const w = s.weapons[Number(m[1])];
    if (!w) return '(no such weapon)';
    if (m[2] === 'abilities') return w.abilities.map((a) => abilityText(a, n)).join(' + ') || 'none';
    return show(w[m[2] as 'range'], n);
  }
  const v = (s as unknown as Record<string, Characteristic>)[field];
  return v === undefined ? '?' : show(v, n);
}

function fieldName(field: string): string {
  const m = field.match(/^weapons\[(\d+)\]\.(\w+)$/);
  if (m) return `weapon ${Number(m[1]) + 1} ${({ abilities: 'runemarks', dice: 'Attack dice', range: 'Range', damage: 'Damage', reach: 'melee/ranged', symbol: 'dice symbol' } as Record<string, string>)[m[2]] ?? m[2]}`;
  return ({ 'save.dice': 'Save dice', 'save.symbol': 'Save symbol', 'weapons.count': 'number of weapons', rulesText: 'rules text', checker: 'checker' } as Record<string, string>)[field] ?? field;
}

// ---------- what changes ----------

function sideChanges(slug: string, a: FighterSide, b: FighterSide, n: Names): string[] {
  const out: string[] = [];
  const stat = (label: string, x: string, y: string) => x !== y && out.push(`${label} ${x} → ${y}`);
  stat('Move', show(a.move, n), show(b.move, n));
  stat('Save', saveText(a.save, n), saveText(b.save, n));
  stat('Health', show(a.health, n), show(b.health, n));
  stat('Bounty', show(a.bounty, n), show(b.bounty, n));

  // The warband's own runemark had many names in the old files; it is always the slug now.
  const known = (id: string) => id === slug || CORE_IDS.has(id) || ['minion', 'leader', 'fly', 'destined'].includes(id);
  const oldIds = new Set(a.runemarks);
  const newIds = new Set(b.runemarks);
  const renamed = !oldIds.has(slug) && newIds.has(slug) ? [...oldIds].filter((id) => !newIds.has(id) && !known(id) && !b.runemarks.includes(id))[0] : undefined;
  const added = [...newIds].filter((id) => !oldIds.has(id) && !(id === slug && renamed));
  const removed = [...oldIds].filter((id) => !newIds.has(id) && id !== renamed);
  if (added.length) out.push(`adds ${added.map((id) => n.label(id)).join(', ')}`);
  if (removed.length) out.push(`drops ${removed.map((id) => n.label(id)).join(', ')}`);

  if (a.weapons.length !== b.weapons.length) out.push(`${a.weapons.length} weapon(s) → ${b.weapons.length}`);
  b.weapons.forEach((w, i) => {
    const v = a.weapons[i];
    const at = b.weapons.length > 1 ? `weapon ${i + 1}` : 'weapon';
    if (!v) {
      out.push(`new ${at}: ${weaponText(w, n)}`);
      return;
    }
    if (v.reach !== w.reach) out.push(`${at} ${v.reach} → ${w.reach}`);
    stat(`${at} Range`, show(v.range, n), show(w.range, n));
    stat(`${at} dice`, `${show(v.dice, n)} ${v.symbol}`, `${show(w.dice, n)} ${w.symbol}`);
    stat(`${at} Damage`, show(v.damage, n), show(w.damage, n));
    const key = (x: { name: string; critical: boolean }) => `${x.critical}:${x.name}`;
    const plus = w.abilities.filter((x) => !v.abilities.some((y) => key(y) === key(x)));
    const minus = v.abilities.filter((x) => !w.abilities.some((y) => key(y) === key(x)));
    if (plus.length) out.push(`${at} adds ${plus.map((x) => abilityText(x, n)).join(', ')}`);
    if (minus.length) out.push(`${at} drops ${minus.map((x) => abilityText(x, n)).join(', ')}`);
  });
  return out;
}

/** Changes per fighter in words, said once when both sides change the same way. */
function fighterChanges(slug: string, oldF: Fighter | undefined, newF: Fighter, n: Names): string[] {
  if (!oldF) return ['new fighter'];
  const out: string[] = [];
  if (oldF.name !== newF.name) out.push(`name ${oldF.name} → ${newF.name}`);
  const u = sideChanges(slug, oldF.uninspired, newF.uninspired, n);
  const i = sideChanges(slug, oldF.inspired, newF.inspired, n);
  for (const c of u) out.push(i.includes(c) ? c : `${c} (uninspired)`);
  for (const c of i) if (!u.includes(c)) out.push(`${c} (inspired)`);
  if ((oldF.cardRulesText ?? null) !== (newF.cardRulesText ?? null)) out.push(newF.cardRulesText ? `card rules text: “${newF.cardRulesText}”` : 'drops the card rules text note');
  return out;
}

function diffHtml(line: string): string {
  return esc(line)
    .replace(/\[-(.*?)-\]/g, '<del>$1</del>')
    .replace(/\{\+(.*?)\+\}/g, '<ins>$1</ins>');
}

function warscrollChangeHtml(line: string): string {
  const moved = line.match(/^"(.+)": moved from (reactions|abilities) to (reactions|abilities)$/);
  if (moved) return `<b>${esc(moved[1])}</b>: moved to the ${moved[3] === 'reactions' ? 'left column' : 'right panel'}`;
  const m = line.match(/^"(.+)" (\w+): (.*)$/);
  if (m) return `<b>${esc(m[1])}</b>, ${esc(m[2] === 'text' ? 'text' : m[2])}: ${diffHtml(m[3])}`;
  const g = line.match(/^(\w+): (.*)$/);
  if (g) return `<b>${esc(g[1] === 'generalRules' ? 'Rule above the entries' : g[1])}</b>: ${diffHtml(g[2])}`;
  return diffHtml(line);
}

/** "checker said no to "<statement>" (card shows: X); <outcome>" as kept / checker sees / outcome. */
function checkerHtml(message: string): string {
  const m = message.match(/^checker said no to "(.*)"(?: \(card shows: (.*)\))?; (.*)$/s);
  if (!m) return `<div class="v">${esc(message)}</div>`;
  const kept = m[1].replace(/^(Uninspired|Inspired) side \([^)]*\): /, '');
  return `<div class="opt kept"><span class="n">run</span><span class="v">${esc(kept)}</span></div>` +
    (m[2] ? `<div class="opt"><span class="n">checker</span><span class="v">${esc(m[2])}</span></div>` : '') +
    `<div class="cur">${esc(m[3].replace(/^more reads kept the value$/, 'More reads kept the run\'s value.').replace(/^after more reads the value changed: /, 'After more reads the value changed: '))}</div>`;
}

// ---------- page ----------

const CSS = `
:root { --ink:#1d1d1f; --mute:#5f6368; --line:#e3e3e6; --bg:#fafafa; --card:#fff; --accent:#8a5a00; --ok:#1e7a3c; --warn:#b3261e; }
* { box-sizing: border-box; }
body { margin:0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color:var(--ink); background:var(--bg); }
main { max-width: 1080px; margin: 0 auto; padding: 32px 24px 80px; }
h1 { font-size: 26px; margin: 0 0 6px; } h2 { font-size: 20px; margin: 40px 0 6px; } h3 { font-size: 16px; margin: 0; }
.lead { color: var(--mute); margin: 0 0 20px; max-width: 760px; }
.tiles { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); gap:12px; margin: 20px 0; }
.tile { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
.tile b { display:block; font-size: 24px; } .tile span { color:var(--mute); font-size: 13px; }
nav { position: sticky; top: 0; background: var(--bg); padding: 10px 0; border-bottom:1px solid var(--line); z-index: 2; }
nav a { margin-right: 18px; color: var(--accent); text-decoration: none; font-weight: 600; }
.hint { color: var(--mute); font-size: 14px; margin: 0 0 14px; }
.item { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; margin: 10px 0; display:grid; grid-template-columns: 200px 1fr; gap: 16px; }
.item.text { grid-template-columns: 1fr; }
.item img { max-width: 200px; max-height: 260px; border-radius: 6px; border:1px solid var(--line); display:block; }
.where { color: var(--mute); font-size: 13px; }
.opt { display:flex; gap:10px; align-items: baseline; margin: 4px 0; }
.opt .n { min-width: 64px; font-variant-numeric: tabular-nums; color: var(--mute); font-size: 13px; }
.opt.kept .v { font-weight: 600; }
.opt.kept .n::after { content: " kept"; color: var(--ok); }
.opt .n:is(:empty) { display:none; }
.cur { color: var(--mute); font-size: 13px; margin-top: 6px; }
.note { font-size: 13px; color: var(--warn); margin-top: 6px; }
.v { white-space: pre-wrap; }
details { background:var(--card); border:1px solid var(--line); border-radius:10px; margin: 8px 0; }
summary { padding: 10px 14px; cursor: pointer; display:flex; gap: 12px; align-items: baseline; }
summary .count { color: var(--mute); font-size: 13px; margin-left: auto; }
details > div { padding: 0 14px 14px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
td, th { text-align: left; vertical-align: top; padding: 6px 8px; border-top: 1px solid var(--line); }
th { color: var(--mute); font-weight: 600; font-size: 13px; }
ul.changes { margin: 0; padding-left: 18px; }
del { background: #fde7e7; color: #8c1d18; text-decoration: line-through; }
ins { background: #e3f4e8; color: #14532d; text-decoration: none; }
.sheet { max-width: 100%; border:1px solid var(--line); border-radius:6px; margin-top: 8px; }
.pill { display:inline-block; font-size: 12px; padding: 1px 8px; border-radius: 10px; background: #f1ebe0; color: var(--accent); margin-left: 6px; }
`;

export function renderHtmlReport(runDir: string): string {
  const summary = readJsonIfExists<RunSummary>(join(runDir, 'summary.json'));
  const warbands = loadWarbands();
  const records = [
    ...warbands.map((wb) => ({ slug: wb.slug, name: wb.name, ga: false })),
    ...GA_KEYS.map((k) => ({ slug: `_ga/${k}`, name: `Grand Alliance ${k}`, ga: true })),
  ]
    .map((x) => ({ ...x, record: readJsonIfExists<WarbandRecord>(join(runDir, x.slug, 'result.json')) }))
    .filter((x) => x.record !== null) as { slug: string; name: string; ga: boolean; record: WarbandRecord }[];
  const toRoot = relative(runDir, ROOT).replace(/\\/g, '/');

  const fighterRecords = records.filter((r) => !r.ga);
  const fighters = fighterRecords.reduce((s, r) => s + r.record.fighters.length, 0);
  const values = fighterRecords.reduce((s, r) => s + r.record.stats.values, 0);
  const unanimous = fighterRecords.reduce((s, r) => s + r.record.stats.unanimous, 0);

  // ---------- needs a decision ----------
  const decisions: string[] = [];
  const warscrollDecisions: string[] = [];
  const minor: string[] = [];
  for (const { slug, record } of records) {
    const n = namesFor(runDir, slug.replace(/^_ga\//, ''));
    const oldFile = readJsonIfExists<FightersFile>(warbandFile(slug, 'fighters.json'));
    const votes = readJsonIfExists<VoteRegion[]>(join(runDir, slug, 'fighter-votes.json')) ?? [];
    for (const { index, name, flag } of record.flags) {
      const region = votes.find((v) => v.region.startsWith(`${index} `) && v.region.endsWith(`/ ${flag.side} / ${flag.region}`));
      const field = region?.fields?.find((f) => f.field === flag.field);
      const img =
        flag.region === 'rules'
          ? `${slug}/crops/${index}-uninspired-card.png`
          : `${slug}/crops/${index}-${flag.side}-${flag.region}.png`;
      const options = field
        ? field.votes
            .map((t, i) => `<div class="opt${i === 0 ? ' kept' : ''}"><span class="n">${t.count} vote${t.count === 1 ? '' : 's'}</span><span class="v">${esc(valueText(flag.field, t.example ?? t.answer, n))}</span></div>`)
            .join('')
        : checkerHtml(flag.message);
      const old = oldFile?.fighters.find((f) => f.index === index);
      const html = `<div class="item"><a href="${esc(`${slug}/crops/${index}-${flag.side === 'card' ? 'uninspired' : flag.side}-card.png`)}"><img src="${esc(img)}" alt=""></a><div>
        <h3>${esc(name)} <span class="pill">${esc(flag.side === 'card' ? 'both sides' : flag.side)}</span></h3>
        <div class="where">${esc(records.find((r) => r.slug === slug)!.name)} · ${esc(fieldName(flag.field))}</div>
        ${options}
        ${field ? `<div class="cur">Current file: ${esc(currentValue(old, flag.side, flag.field, n))}</div>` : ''}
        ${flag.field === 'checker' ? '' : flag.level === 'review' ? '<div class="note">No answer reached 12 of 15 votes.</div>' : ''}
      </div></div>`;
      (flag.level === 'review' ? decisions : minor).push(html);
    }
    if (record.warscroll) {
      const wsVotes = readJsonIfExists<VoteRegion[]>(join(runDir, slug, 'warscroll-votes.json'))?.[0]?.fields ?? [];
      const ws = readJsonIfExists<Record<string, unknown>>(join(runDir, slug.startsWith('_ga/') ? `${slug}.json` : `${slug}/warscroll.json`));
      for (const flag of record.warscroll.flags.filter((f) => !/reads: $/.test(f.message))) {
        const field = wsVotes.find((f) => f.field === flag.field);
        const m = flag.field.match(/^(reactions|abilities)\[(\d+)\]\.(\w+)$/);
        const entry = m ? ((ws?.[m[1]] as { name?: string }[] | undefined)?.[Number(m[2])]?.name ?? flag.field) : null;
        const label = m ? `${entry} — ${m[3] === 'rulesText' ? 'rules text' : m[3]}` : flag.field === 'generalRules' ? 'Rule above the entries' : flag.field;
        const kept = String(field?.votes[0]?.example ?? '');
        // Answers that differ only in formatting under the current voting rules (brackets around
        // an icon, a "v" before the version) are not a decision.
        const sameAnswer = (t: { answer: string; example?: unknown }) => canonText(String(t.example ?? t.answer)).replace(/^v(?=\d)/, '');
        const cosmetic = field && new Set(field.votes.map(sameAnswer)).size === 1;
        const options = field
          ? field.votes
              .map((t, i) => {
                const text = t.example === null || t.answer === 'null' ? '(none)' : String(t.example ?? t.answer);
                const shown = i === 0 || text.length < 120 ? esc(text) : wordDiff(kept, text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/\[-(.*?)-\]/g, '<del>$1</del>').replace(/\{\+(.*?)\+\}/g, '<ins>$1</ins>');
                return `<div class="opt${i === 0 ? ' kept' : ''}"><span class="n">${t.count} vote${t.count === 1 ? '' : 's'}</span><span class="v">${shown}</span></div>`;
              })
              .join('')
          : `<div class="v">${esc(flag.message)}</div>`;
        const image = slug.startsWith('_ga/') ? `${toRoot}/warbands/_ga/${slug.slice(4)}.png` : `${toRoot}/warbands/${slug}/warscroll.png`;
        const html = `<div class="item text"><div>
          <h3>${esc(records.find((r) => r.slug === slug)!.name)} warscroll <span class="pill">${esc(label)}</span></h3>
          <div class="where"><a href="${esc(image)}">open the warscroll</a>${field && field.votes.length > 1 ? ' · other answers show only what differs from the kept one' : ''}</div>
          ${options}
        </div></div>`;
        (flag.level === 'review' && !cosmetic ? warscrollDecisions : minor).push(html);
      }
    }
  }

  // ---------- changes per warband ----------
  const changeSections: string[] = [];
  let changedFighters = 0;
  let changedWarscrolls = 0;
  for (const { slug, name, ga, record } of records) {
    const n = namesFor(runDir, slug.replace(/^_ga\//, ''));
    const oldFile = ga ? null : readJsonIfExists<FightersFile>(warbandFile(slug, 'fighters.json'));
    const rows = record.fighters
      .map((f) => ({ f, changes: fighterChanges(slug, oldFile?.fighters.find((o) => o.index === f.index), f, n) }))
      .filter((x) => x.changes.length);
    changedFighters += rows.length;
    const ws = record.warscrollDiff.filter((l) => !l.startsWith('(no current'));
    if (ws.length) changedWarscrolls++;
    if (!rows.length && !ws.length) continue;
    const sheet = existsSync(join(runDir, slug, 'runemarks', 'fighter-runemarks.png')) && !ga ? `<img class="sheet" src="${esc(`${slug}/runemarks/fighter-runemarks.png`)}" alt="runemark reference sheet">` : '';
    changeSections.push(`<details><summary><h3>${esc(name)}</h3><span class="count">${rows.length ? `${rows.length} fighter${rows.length === 1 ? '' : 's'}` : ''}${rows.length && ws.length ? ' · ' : ''}${ws.length ? `warscroll ${ws.length} change${ws.length === 1 ? '' : 's'}` : ''}</span></summary><div>
      ${rows.length ? `<table><tr><th style="width:180px">Fighter</th><th>Changes</th></tr>${rows.map((r) => `<tr><td>${esc(r.f.name)}</td><td><ul class="changes">${r.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></td></tr>`).join('')}</table>` : ''}
      ${ws.length ? `<p class="hint" style="margin-top:12px">Warscroll</p><ul class="changes">${ws.map((l) => `<li>${warscrollChangeHtml(l)}</li>`).join('')}</ul>` : ''}
      ${record.polishNotes.length ? `<p class="hint" style="margin-top:12px">Polish file: ${esc(record.polishNotes.filter((x) => x.startsWith('translated again')).join('; ') || 'icons updated')}</p>` : ''}
      ${sheet ? `<details style="margin-top:12px"><summary>Runemark reference sheet</summary><div>${sheet}</div></details>` : ''}
    </div></details>`);
  }

  const checks = records.flatMap(({ name, record }) => record.crossChecks.map((c) => `<li><b>${esc(name)}</b>: ${esc(c)}</li>`));

  const minutes = summary ? Math.round(summary.seconds / 60) : 0;
  const decisionCount = decisions.length + warscrollDecisions.length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rebuild review ${esc(summary?.runId ?? '')}</title><style>${CSS}</style></head><body><main>
<h1>Fighter cards and warscrolls: review</h1>
<p class="lead">Every value was read several times and voted on. ${unanimous.toLocaleString('en')} of ${values.toLocaleString('en')} fighter values were unanimous. Nothing in <code>warbands/</code> has changed yet; applying this run replaces the files of every warband below.</p>
<div class="tiles">
  <div class="tile"><b>${decisionCount}</b><span>need your decision</span></div>
  <div class="tile"><b>${changedFighters}</b><span>of ${fighters} fighters change</span></div>
  <div class="tile"><b>${changedWarscrolls}</b><span>warscrolls change</span></div>
  <div class="tile"><b>${checks.length}</b><span>cross-check notes</span></div>
  <div class="tile"><b>${summary ? `$${Math.round(summary.costUsd)}` : '?'}</b><span>${summary ? `${summary.calls.toLocaleString('en')} AI calls, ${Math.floor(minutes / 60)}h ${minutes % 60}m` : ''}</span></div>
</div>
<nav><a href="#decide">Needs your decision (${decisionCount})</a><a href="#changes">What changes</a><a href="#checks">Cross-checks (${checks.length})</a>${minor.length ? `<a href="#minor">Accepted by majority (${minor.length})</a>` : ''}</nav>

<h2 id="decide">Needs your decision</h2>
<p class="hint">The reads did not agree well enough, or the separate checker disagreed. The first answer is the one the run kept; click a picture for the whole card.</p>
<h3 style="margin-top:18px">Fighter cards (${decisions.length})</h3>
${decisions.join('\n') || '<p>Nothing.</p>'}
<h3 style="margin-top:24px">Warscrolls (${warscrollDecisions.length})</h3>
${warscrollDecisions.join('\n') || '<p>Nothing.</p>'}

<h2 id="changes">What changes if this run is applied</h2>
<p class="hint">Per warband, in words. A change on both sides is listed once; "(inspired)" or "(uninspired)" marks a change on one side only. The warband's own runemark is now always called by the warband's id, so where the old file used another name for it, that rename is not listed.</p>
${changeSections.join('\n')}

<h2 id="checks">Cross-checks</h2>
<p class="hint">Rules the data should follow, flagged but not changed. Spot checks so far were real card features (a fighter losing a weapon or switching dice symbol when inspired).</p>
<ul class="changes">${checks.join('')}</ul>

${minor.length ? `<h2 id="minor">Accepted by majority</h2><p class="hint">Not unanimous, but at least 12 of 15 votes agreed (6 of 7 for warscrolls), or the answers differ only in formatting, so the run kept the majority answer.</p>${minor.join('\n')}` : ''}
</main></body></html>
`;
}
