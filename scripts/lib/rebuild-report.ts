import { CORE_IDS, fighterRunemarks, weaponRunemarks, type Catalog, type KeywordIcon } from './catalog';
import type { Flag, FighterReading } from './fighter-reader';
import { SIDES, type Characteristic, type Fighter, type FightersFile } from './fighters';
import { canonText, type FieldOutcome } from './votes';
import type { Warscroll, WarscrollReading } from './warscroll-reader';

// ---------- cross-checks (flag only, never fixed automatically) ----------

export function crossChecks(
  wb: { slug: string; name: string; fighters: number },
  readings: FighterReading[],
  catalog: Catalog,
  cardsFound: number,
): string[] {
  const out: string[] = [];
  if (cardsFound !== wb.fighters) out.push(`warband metadata says ${wb.fighters} fighters, but ${cardsFound} cards (both sides) were found`);
  if (readings.length !== wb.fighters) out.push(`${readings.length} of ${wb.fighters} fighters were read`);

  for (const r of readings) {
    const f = r.fighter;
    const who = `#${f.index} ${f.name}`;
    if (canonText(r.names.uninspired) !== canonText(r.names.inspired)) {
      out.push(`${who}: name differs between sides ("${r.names.uninspired}" / "${r.names.inspired}")`);
    }
    const u = f.uninspired;
    const i = f.inspired;
    // Characteristics given as a runemark (a variable value) cannot be compared.
    const lower = (label: string, a: Characteristic, b: Characteristic) =>
      typeof a === 'number' && typeof b === 'number' && b < a && out.push(`${who}: inspired ${label} (${b}) is lower than uninspired (${a})`);
    lower('Move', u.move, i.move);
    lower('Save dice', u.save.dice, i.save.dice);
    lower('Health', u.health, i.health);
    lower('Bounty', u.bounty, i.bounty);
    if (u.weapons.length !== i.weapons.length) {
      out.push(`${who}: ${u.weapons.length} weapon(s) uninspired but ${i.weapons.length} inspired`);
    } else {
      u.weapons.forEach((w, n) => {
        const v = i.weapons[n];
        lower(`weapon ${n + 1} Range`, w.range, v.range);
        lower(`weapon ${n + 1} Attack dice`, w.dice, v.dice);
        lower(`weapon ${n + 1} Damage`, w.damage, v.damage);
        if (w.reach !== v.reach) out.push(`${who}: weapon ${n + 1} is ${w.reach} uninspired but ${v.reach} inspired`);
      });
    }
    const um = [...u.runemarks].sort().join(', ');
    const im = [...i.runemarks].sort().join(', ');
    if (um !== im) out.push(`${who}: runemarks differ between sides (uninspired: ${um || 'none'}; inspired: ${im || 'none'}); check the card really shows this`);
    if (!u.runemarks.includes(wb.slug) && catalog.entries.some((e) => e.id === wb.slug)) {
      out.push(`${who}: does not have the warband's own runemark (${wb.slug})`);
    }
  }

  const leaders = readings.filter((r) => r.fighter.uninspired.runemarks.includes('leader') || r.fighter.inspired.runemarks.includes('leader'));
  if (leaders.length !== 1) {
    out.push(`${leaders.length} fighters have the leader runemark (${leaders.map((r) => r.fighter.name).join(', ') || 'none'}), expected exactly 1`);
  }

  const fighterIds = new Set(fighterRunemarks(catalog).map((e) => e.id));
  const weaponIds = new Set(weaponRunemarks(catalog).map((e) => e.id));
  // Only the warband's own keywords: the rules text also mentions core runemarks (for example
  // "cannot be affected by Cleave and Ensnare") without any fighter having them.
  for (const k of catalog.keywords.filter((k) => !CORE_IDS.has(k.id) && k.kind !== 'symbol')) {
    if (!fighterIds.has(k.id) && !weaponIds.has(k.id)) continue;
    if (!readings.some((r) => usesRunemark(r.fighter, k.id))) {
      out.push(`the warscroll names the ${k.keyword} runemark (${k.id}), but no fighter, weapon or characteristic has it`);
    }
  }
  return out;
}

/** Whether a fighter shows a runemark anywhere: its runemarks, a weapon's runemarks, or in place of a characteristic. */
export function usesRunemark(f: Fighter, id: string): boolean {
  return SIDES.some((side) => {
    const s = f[side];
    const values = [s.move, s.save.dice, s.health, s.bounty, ...s.weapons.flatMap((w) => [w.range, w.dice, w.damage])];
    return s.runemarks.includes(id) || s.weapons.some((w) => w.abilities.some((a) => a.name === id)) || values.includes(id);
  });
}

// ---------- diffs against the current files ----------

const fmtWeapon = (w: Fighter['uninspired']['weapons'][number]) =>
  `${w.reach} R${w.range} ${w.symbol} ${w.dice}d D${w.damage}${w.abilities.length ? ` [${w.abilities.map((a) => `${a.critical ? 'crit ' : ''}${a.name}`).join(', ')}]` : ''}`;

export function diffFighters(oldFile: FightersFile | null, newFile: FightersFile): string[] {
  if (!oldFile) return ['(no current fighters.json)'];
  const out: string[] = [];
  const indexes = [...new Set([...oldFile.fighters, ...newFile.fighters].map((f) => f.index))].sort((a, b) => a - b);
  for (const index of indexes) {
    const a = oldFile.fighters.find((f) => f.index === index);
    const b = newFile.fighters.find((f) => f.index === index);
    if (!a || !b) {
      out.push(`#${index}: ${a ? 'only in the current file' : 'new'}`);
      continue;
    }
    const who = `#${index} ${b.name}`;
    const change = (field: string, x: unknown, y: unknown) => {
      const sx = typeof x === 'string' ? x : JSON.stringify(x);
      const sy = typeof y === 'string' ? y : JSON.stringify(y);
      if (sx !== sy) out.push(`${who} ${field}: ${sx} -> ${sy}`);
    };
    change('name', a.name, b.name);
    for (const side of SIDES) {
      const x = a[side];
      const y = b[side];
      change(`${side} move`, x.move, y.move);
      change(`${side} save`, `${x.save.dice} ${x.save.symbol}`, `${y.save.dice} ${y.save.symbol}`);
      change(`${side} health`, x.health, y.health);
      change(`${side} bounty`, x.bounty, y.bounty);
      change(`${side} runemarks`, x.runemarks.join(', ') || 'none', y.runemarks.join(', ') || 'none');
      const n = Math.max(x.weapons.length, y.weapons.length);
      for (let i = 0; i < n; i++) {
        change(`${side} weapon ${i + 1}`, x.weapons[i] ? fmtWeapon(x.weapons[i]) : 'none', y.weapons[i] ? fmtWeapon(y.weapons[i]) : 'none');
      }
    }
    change('cardRulesText', a.cardRulesText ?? 'null', b.cardRulesText ?? 'null');
  }
  return out;
}

/**
 * Word-level difference of two texts: only the changed words with a few words around them,
 * removed words in [-...-] and added ones in {+...+}.
 */
export function wordDiff(a: string, b: string, context = 4): string {
  const x = a.split(/(\s+)/).filter((w) => w.trim());
  const y = b.split(/(\s+)/).filter((w) => w.trim());
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const ops: { kind: '=' | '-' | '+'; word: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      ops.push({ kind: '=', word: x[i++] });
      j++;
    } else if (i < x.length && (j >= y.length || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ kind: '-', word: x[i++] });
    else ops.push({ kind: '+', word: y[j++] });
  }
  const keep = ops.map((op, n) => op.kind !== '=' || ops.slice(Math.max(0, n - context), n + context + 1).some((o) => o.kind !== '='));
  const parts: string[] = [];
  let skipped = false;
  for (let n = 0; n < ops.length; n++) {
    if (!keep[n]) {
      if (!skipped) parts.push('...');
      skipped = true;
      continue;
    }
    skipped = false;
    const run: string[] = [];
    const kind = ops[n].kind;
    while (n < ops.length && keep[n] && ops[n].kind === kind) run.push(ops[n++].word);
    n--;
    parts.push(kind === '=' ? run.join(' ') : kind === '-' ? `[-${run.join(' ')}-]` : `{+${run.join(' ')}+}`);
  }
  return parts.join(' ');
}

type Entry = Record<string, unknown>;

/** Every entry of a warscroll with the list it is in, matched by name (reactions and abilities). */
export function warscrollEntries(w: Record<string, unknown>): { list: 'reactions' | 'abilities'; index: number; key: string; entry: Entry }[] {
  return (['reactions', 'abilities'] as const).flatMap((list) =>
    ((w[list] as Entry[] | undefined) ?? []).map((entry, index) => ({ list, index, key: canonText(String(entry.name ?? '')), entry })),
  );
}

/** Trigger and rules text together, so splitting the trigger off differently is not a text change. */
export const fullText = (e: Entry | undefined) => [e?.trigger, e?.rulesText].filter((x) => typeof x === 'string' && x).join(' ');

export function diffWarscroll(oldW: Record<string, unknown> | null, newW: Warscroll): string[] {
  if (!oldW) return ['(no current warscroll.json)'];
  const out: string[] = [];
  const show = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v ?? null));
  const change = (path: string, x: unknown, y: unknown) => {
    if ((x ?? null) === (y ?? null) || show(x) === show(y)) return;
    if (typeof x === 'string' && typeof y === 'string' && (x.length > 60 || y.length > 60)) out.push(`${path}: ${wordDiff(x, y)}`);
    else out.push(`${path}: ${show(x)} -> ${show(y)}`);
  };
  change('name', oldW.name, newW.name);
  change('version', oldW.version, newW.version);
  change('inspire', oldW.inspire, newW.inspire);
  change('generalRules', oldW.generalRules, newW.generalRules);
  const before = warscrollEntries(oldW);
  const after = warscrollEntries(newW as unknown as Record<string, unknown>);
  for (const x of before) if (!after.some((y) => y.key === x.key)) out.push(`"${x.entry.name}": not in the new read (was ${x.list}[${x.index}])`);
  for (const y of after) {
    const x = before.find((e) => e.key === y.key);
    const name = String(y.entry.name);
    if (!x) {
      out.push(`"${name}": new entry in ${y.list}[${y.index}]: ${show(fullText(y.entry))}`);
      continue;
    }
    if (x.list !== y.list) out.push(`"${name}": moved from ${x.list} to ${y.list}`);
    else if (x.index !== y.index) out.push(`"${name}": moved from ${x.list}[${x.index}] to [${y.index}]`);
    change(`"${name}" name`, x.entry.name, y.entry.name);
    change(`"${name}" type`, x.entry.type, y.entry.type);
    change(`"${name}" flavorText`, x.entry.flavorText, y.entry.flavorText);
    change(`"${name}" text`, fullText(x.entry), fullText(y.entry));
  }
  return out;
}

// ---------- the report ----------

/** A warband's results while it is being read (live objects). */
export interface WarbandResult {
  slug: string;
  name: string;
  opLegal: boolean;
  catalog: Catalog | null;
  catalogFlags: string[];
  warscroll: WarscrollReading | null;
  warscrollDiff: string[];
  polishNotes: string[];
  readings: FighterReading[];
  failedFighters: { index: number; error: string }[];
  crossChecks: string[];
  fighterDiff: string[];
  /** AI reads made for this warband (excludes repair requests). */
  reads: number;
  /** Fighter cards this warband should have read (all of them, or the ones --fighters named). */
  expectedFighters: number;
  error?: string;
}

/**
 * A finished warband as saved in <run>/<slug>/result.json: everything the report needs, so a
 * run that stops part way (or is resumed) can still report every warband it finished.
 */
export interface WarbandRecord {
  slug: string;
  name: string;
  opLegal: boolean;
  /** Every expected fighter was read (and the warscroll, when there is one). Resumed runs skip complete warbands. */
  complete: boolean;
  error: string | null;
  reads: number;
  keywords: KeywordIcon[];
  catalogFlags: string[];
  warscroll: { reads: number; flags: WarscrollReading['flags'] } | null;
  warscrollDiff: string[];
  polishNotes: string[];
  fighters: Fighter[];
  flags: { index: number; name: string; flag: Flag }[];
  failedFighters: { index: number; error: string }[];
  crossChecks: string[];
  fighterDiff: string[];
  stats: { values: number; unanimous: number; majority: number; flagged: number };
}

export function regionStats(readings: FighterReading[]): WarbandRecord['stats'] {
  const all: FieldOutcome[] = readings.flatMap((r) => r.regions.flatMap((g) => g.vote.outcomes()));
  return {
    values: all.length,
    unanimous: all.filter((o) => o.status === 'unanimous').length,
    majority: all.filter((o) => o.status === 'majority').length,
    flagged: all.filter((o) => o.status === 'flagged').length,
  };
}

export function toRecord(r: WarbandResult, warscrollExpected: boolean): WarbandRecord {
  const readings = [...r.readings].sort((a, b) => a.fighter.index - b.fighter.index);
  return {
    slug: r.slug,
    name: r.name,
    opLegal: r.opLegal,
    complete: !r.error && r.failedFighters.length === 0 && readings.length >= r.expectedFighters && (!warscrollExpected || r.warscroll !== null),
    error: r.error ?? null,
    reads: r.reads,
    keywords: r.catalog?.keywords ?? [],
    catalogFlags: r.catalogFlags,
    warscroll: r.warscroll ? { reads: r.warscroll.vote.reads, flags: r.warscroll.flags } : null,
    warscrollDiff: r.warscrollDiff,
    polishNotes: r.polishNotes,
    fighters: readings.map((x) => x.fighter),
    flags: readings.flatMap((x) => x.flags.map((flag) => ({ index: x.fighter.index, name: x.fighter.name, flag }))),
    failedFighters: r.failedFighters,
    crossChecks: r.crossChecks,
    fighterDiff: r.fighterDiff,
    stats: regionStats(readings),
  };
}

export interface RunSummary {
  runId: string;
  model: string;
  provider: string;
  settings: string;
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  seconds: number;
  /** How many times the run was started (1, plus one per --resume). */
  sessions?: number;
}

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function cropLinks(slug: string, index: number, side: string, region: string): string {
  if (side === 'card') return `[uninspired](${slug}/crops/${index}-uninspired-card.png), [inspired](${slug}/crops/${index}-inspired-card.png)`;
  return `[crop](${slug}/crops/${index}-${side}-${region}.png), [card](${slug}/crops/${index}-${side}-card.png)`;
}

function fighterLine(f: Fighter): string {
  const side = (s: Fighter['uninspired']) =>
    `M${s.move} S${s.save.dice}${s.save.symbol === 'shield' ? 'sh' : 'dg'} H${s.health} B${s.bounty}; ${s.runemarks.join(', ') || 'none'}; ${s.weapons.map(fmtWeapon).join(' / ')}`;
  return `| ${f.index} | ${md(f.name)} | ${md(side(f.uninspired))} | ${md(side(f.inspired))} | ${f.cardRulesText ? md(f.cardRulesText) : ''} |`;
}

export function renderReport(summary: RunSummary, records: WarbandRecord[], notes: string[] = []): string {
  const minutes = `${Math.floor(summary.seconds / 60)}m ${String(Math.round(summary.seconds % 60)).padStart(2, '0')}s`;
  const lines: string[] = [
    `# Fighter card and warscroll rebuild: ${summary.runId}`,
    '',
    `- Model: ${summary.model}, provider: ${summary.provider}`,
    `- Voting: ${summary.settings}`,
    `- AI calls: ${summary.calls} (${summary.failedCalls} failed and retried), ${summary.inputTokens.toLocaleString('en')} input / ${summary.outputTokens.toLocaleString('en')} output tokens, about $${summary.costUsd.toFixed(2)}`,
    `- Time: ${minutes}${summary.sessions && summary.sessions > 1 ? ` over ${summary.sessions} sessions (resumed)` : ''}`,
    ...notes.map((n) => `- **${n}**`),
    '',
    'Nothing in `warbands/` was changed. Every value below was voted on; "majority" values were accepted with at least 80% of the votes, "review" items need a person to look at the card.',
    '',
    '| Warband | Fighters | Values | Unanimous | Majority | Needs review | Cross-check notes | Changes vs current fighters.json | Warscroll changes |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of records) {
    const review = r.flags.filter((f) => f.flag.level === 'review').length + (r.warscroll?.flags.filter((f) => f.level === 'review' && !/reads: $/.test(f.message)).length ?? 0);
    const fighters = `${r.fighters.length}${r.complete ? '' : ' (incomplete)'}`;
    lines.push(`| [${md(r.name)}](#${r.slug}) | ${fighters} | ${r.stats.values} | ${r.stats.unanimous} | ${r.stats.majority} | ${review} | ${r.crossChecks.length} | ${r.fighterDiff.length} | ${r.warscrollDiff.length} |`);
  }

  for (const r of records) {
    lines.push('', `<a id="${r.slug}"></a>`, `## ${r.name}`, '');
    if (r.error) lines.push(`**Failed:** ${r.error}`, '');
    lines.push(`AI reads: ${r.reads}`, '');

    lines.push('### Runemark catalog', '', `![fighter runemarks](${r.slug}/runemarks/fighter-runemarks.png)`, '', `![weapon runemarks](${r.slug}/runemarks/weapon-runemarks.png)`, '');
    if (r.keywords.length) {
      lines.push('Keywords the warscroll prints with an icon:', '', '| Keyword | Id | Kind | Votes | Status |', '|---|---|---|---|---|');
      for (const k of r.keywords) lines.push(`| ${md(k.keyword)} | ${k.id} | ${k.kind} | ${k.votes} | ${k.status} |`);
      lines.push('');
    } else if (!r.opLegal) {
      lines.push('Vaulted warband: no warscroll, so only the core runemarks and the warband runemark are known.', '');
    }
    for (const f of r.catalogFlags) lines.push(`- ${md(f)}`);
    if (r.catalogFlags.length) lines.push('');

    if (r.warscroll) {
      lines.push('### Warscroll', '');
      const wf = r.warscroll.flags.filter((f) => !/reads: $/.test(f.message));
      if (wf.length) {
        lines.push('| Level | Field | Votes |', '|---|---|---|');
        for (const f of wf) lines.push(`| ${f.level} | ${f.field} | ${md(f.message)} |`);
        lines.push('');
      } else lines.push(`Every field unanimous over ${r.warscroll.reads} reads.`, '');
      lines.push(`Changes vs current warscroll.json (${r.warscrollDiff.length}):`, '');
      lines.push('```', ...(r.warscrollDiff.length ? r.warscrollDiff : ['(none)']), '```', '');
      if (r.polishNotes.length) {
        lines.push('Polish file (warscroll.pl.json):', '');
        for (const n of r.polishNotes) lines.push(`- ${md(n)}`);
        lines.push('');
      }
    }

    if (r.fighters.length || r.failedFighters.length) {
      lines.push('### Fighters', '', '| # | Name | Uninspired | Inspired | Card rules text |', '|---|---|---|---|---|');
      for (const f of r.fighters) lines.push(fighterLine(f));
      lines.push('');
      for (const f of r.failedFighters) lines.push(`- **Fighter ${f.index} failed:** ${md(f.error)}`);

      lines.push('', `### Values that were not unanimous (${r.flags.length})`, '');
      if (r.flags.length) {
        lines.push('| Fighter | Side | Region | Field | Level | Votes / note | Images |', '|---|---|---|---|---|---|---|');
        const order = (f: Flag) => (f.level === 'review' ? 0 : 1);
        for (const { flag: f, index, name } of [...r.flags].sort((a, b) => order(a.flag) - order(b.flag) || a.index - b.index)) {
          lines.push(`| ${index} ${md(name)} | ${f.side} | ${f.region} | ${f.field} | ${f.level} | ${md(f.message)} | ${cropLinks(r.slug, index, f.side, f.region)} |`);
        }
      } else lines.push('Every value was unanimous and confirmed by the checker.');

      lines.push('', `### Cross-checks (${r.crossChecks.length})`, '');
      for (const c of r.crossChecks) lines.push(`- ${md(c)}`);
      if (!r.crossChecks.length) lines.push('All passed.');

      lines.push('', `### Changes vs current fighters.json (${r.fighterDiff.length})`, '', '```', ...(r.fighterDiff.length ? r.fighterDiff : ['(none)']), '```');
    }
  }
  return `${lines.join('\n')}\n`;
}
