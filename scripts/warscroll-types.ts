import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { AiClient, DEFAULT_MODEL, runJobs, takeAiOptions } from './ai';
import { jobNote } from './ai/jobs';
import type { ReadContext } from './lib/ai-read';
import { takeFlag, takeValue } from './lib/args';
import { GA_DIR, GA_KEYS, ROOT, isFile, loadWarbands, readJson, warbandFile } from './lib/data';
import { Limiter } from './lib/limit';
import { DEFAULT_VOTE_SETTINGS } from './lib/votes';
import { entryType, readEntryTypes, wordingMismatch, type EntryType, type TypeTarget } from './lib/warscroll-reader';

/**
 * The type of every warscroll entry, read again from the symbol printed before its name (Surge:
 * reaction, Core ability: action, none: passive, or action when it is used in a Power step; see
 * entryType in lib/warscroll-reader.ts). Nothing else is read, and nothing else is written.
 *
 *   npm run warscroll:types -- --all                 every warband warscroll and the 8 GA ones
 *   npm run warscroll:types -- <slug|ga-key>...       only these (for example zarbags-gitz order-1)
 *   npm run warscroll:types -- --apply <run>          write the settled changes of a run
 *   npm run warscroll:types -- --report <run>         write a run's report again
 *
 * A run goes to extraction/types-<time>/: one JSON per warscroll with every entry's votes, and
 * report.md with every change (the type before the run -> the type read, with the vote counts)
 * and every flag. What is kept is the symbol each entry's reads settled on; --apply and --report
 * turn it into a type with the rule as it is now, from the entry's text as it is now, so a change
 * to the rule needs no new reads. --apply changes only the `type` of entries whose symbol was
 * settled and whose type differs; unresolved entries keep their type. The Polish files carry no
 * types (the app shows the English file's type in either language), so they only need the same
 * entries in the same order, which --apply checks. Options: --reads N, --max-reads N,
 * --provider api|cli, --jobs N.
 */

const EXTRACTION_DIR = join(ROOT, 'extraction');

interface Target {
  id: string;
  name: string;
  json: string;
  pl: string;
  image: string;
}

interface EntryRecord {
  list: 'reactions' | 'abilities';
  index: number;
  name: string;
  /** The type in warscroll.json when the run read it. */
  current: EntryType | null;
  /** The type the settled symbol gives (see retype). */
  read: EntryType | null;
  /** The symbol the reads settled on, or null. */
  icon: string | null;
  status: string;
  votes: string;
  reads: number;
  seen: string[];
  flags: { level: string; message: string }[];
}

interface TypesRecord {
  id: string;
  name: string;
  file: string;
  reads: number;
  failedReads: string[];
  entries: EntryRecord[];
  error?: string;
}

const json = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;

function targets(): Target[] {
  const warbands = loadWarbands()
    .filter((wb) => isFile(warbandFile(wb.slug, 'warscroll.json')) && isFile(warbandFile(wb.slug, 'warscroll.png')))
    .map((wb) => ({ id: wb.slug, name: wb.name, json: warbandFile(wb.slug, 'warscroll.json'), pl: warbandFile(wb.slug, 'warscroll.pl.json'), image: warbandFile(wb.slug, 'warscroll.png') }));
  const ga = GA_KEYS.filter((k) => isFile(join(GA_DIR, `${k}.json`)) && isFile(join(GA_DIR, `${k}.png`))).map((k) => ({
    id: k,
    name: String(readJson<{ name: string }>(join(GA_DIR, `${k}.json`)).name),
    json: join(GA_DIR, `${k}.json`),
    pl: join(GA_DIR, `${k}.pl.json`),
    image: join(GA_DIR, `${k}.png`),
  }));
  return [...warbands, ...ga];
}

type Entry = { name: string; type?: string; trigger?: string | null; rulesText: string };
type WarscrollFile = { reactions: Entry[]; abilities: Entry[] } & Record<string, unknown>;

const asType = (value: unknown): EntryType | null => (value === 'passive' || value === 'action' || value === 'reaction' ? value : null);

const WORDING = 'but its wording reads as';

/**
 * A run's record with each type worked out again from its settled symbol and the entry's text in
 * `data` (entryType as it is now), and the wording warnings checked again; the vote flags stay.
 */
function retype(record: TypesRecord, data: WarscrollFile): TypesRecord {
  return {
    ...record,
    entries: record.entries.map((e) => {
      const entry = data[e.list][e.index];
      if (!entry || entry.name !== e.name) throw new Error(`${record.id}: ${e.list}[${e.index}] is no longer "${e.name}"; read it again`);
      const read = e.icon ? entryType(e.icon, entry) : null;
      const mismatch = read ? wordingMismatch(entry, read, e.icon!) : null;
      const flags = [...e.flags.filter((f) => !f.message.includes(WORDING)), ...(mismatch ? [{ level: 'warning', message: mismatch }] : [])];
      return { ...e, read, flags };
    }),
  };
}

// ---------- report ----------

function renderReport(meta: Record<string, unknown>, records: TypesRecord[]): string {
  const entries = records.flatMap((r) => r.entries.map((e) => ({ r, e })));
  const changes = entries.filter(({ e }) => e.read && e.read !== e.current);
  const unresolved = entries.filter(({ e }) => !e.read);
  const flagged = entries.filter(({ e }) => e.flags.length);
  const powerStep = entries.filter(({ e }) => e.icon === 'none' && e.read === 'action');
  const row = ({ r, e }: { r: TypesRecord; e: EntryRecord }) =>
    `| ${r.name} | ${e.name} | ${e.list === 'reactions' ? 'left' : 'right'} | ${e.current ?? '-'} | **${e.read ?? 'unresolved'}** (${e.icon ?? '?'}) | ${e.votes} of ${e.reads} | ${e.seen.slice(0, 2).join('; ')} |`;
  const header = '| Warscroll | Entry | Column | Current | Read (symbol) | Votes | What the reads saw before the name |\n|---|---|---|---|---|---|---|';
  const lines = [
    `# Warscroll entry types read from the heading symbols`,
    '',
    `Run ${meta.runId}: ${records.length} warscrolls, ${entries.length} entries. Model ${meta.model} via ${meta.provider}; ${meta.settings}. ${meta.calls} AI calls, about $${Number(meta.costUsd).toFixed(2)}, ${Math.round(Number(meta.seconds))} s.`,
    '',
    `- Settled: ${entries.length - unresolved.length} (${entries.filter(({ e }) => e.status === 'unanimous').length} unanimous, ${entries.filter(({ e }) => e.status === 'majority').length} by majority); unresolved: ${unresolved.length}`,
    `- Changes against the files as they were when the run read them: ${changes.length}`,
    `- Entries with a flag: ${flagged.length}`,
    `- Types read: ${(['reaction', 'action', 'passive'] as const).map((t) => `${t} ${entries.filter(({ e }) => e.read === t).length}`).join(', ')}; ${powerStep.length} of the actions have no symbol and are used in a Power step`,
    ...records.filter((r) => r.error).map((r) => `- FAILED ${r.name}: ${r.error}`),
    '',
    `## Changes (${changes.length})`,
    '',
    header,
    ...changes.map(row),
    '',
    `## Unresolved (${unresolved.length})`,
    '',
    unresolved.length ? header : 'None.',
    ...unresolved.map(row),
    '',
    `## Flags (${flagged.length} entries)`,
    '',
    ...flagged.flatMap(({ r, e }) => e.flags.map((f) => `- ${r.name} / ${e.name}: ${f.level}: ${f.message}`)),
    '',
    `## Every entry`,
    '',
    header,
    ...entries.map(row),
    '',
  ];
  return lines.join('\n');
}

// ---------- apply ----------

const runFolder = (runArg: string) => {
  const runDir = existsSync(runArg) ? runArg : join(EXTRACTION_DIR, runArg);
  if (!existsSync(join(runDir, 'summary.json'))) throw new Error(`no types run at ${runArg}`);
  return runDir;
};

/** A run's records, each worked out again against the warscroll file it read. */
function runRecords(runDir: string): { record: TypesRecord; target: Target }[] {
  const byId = new Map(targets().map((t) => [t.id, t]));
  return readdirSync(join(runDir, 'warscrolls'))
    .filter((f) => f.endsWith('.json'))
    .map((file) => {
      const record = readJson<TypesRecord>(join(runDir, 'warscrolls', file));
      const target = byId.get(record.id);
      if (!target) throw new Error(`${record.id}: no such warscroll`);
      return { record: retype(record, readJson<WarscrollFile>(target.json)), target };
    });
}

/** --report <run>: report.md again, with the rule as it is now. */
function report(runArg: string): void {
  const runDir = runFolder(runArg);
  const order = targets().map((t) => t.id);
  const records = runRecords(runDir).map((r) => r.record).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  writeFileSync(join(runDir, 'report.md'), renderReport(readJson<Record<string, unknown>>(join(runDir, 'summary.json')), records));
  console.log(`  Report: ${relative(ROOT, join(runDir, 'report.md'))}`);
}

function apply(runArg: string): void {
  const runDir = runFolder(runArg);
  console.log(`\n  Applying the entry types of ${relative(ROOT, runDir)}\n`);
  let changed = 0;
  for (const { record, target } of runRecords(runDir)) {
    const text = readFileSync(target.json, 'utf8');
    const data = JSON.parse(text) as WarscrollFile;
    if (json(data) !== text) throw new Error(`${relative(ROOT, target.json)} is not formatted as the scripts write it; nothing written`);
    const notes: string[] = [];
    for (const e of record.entries) {
      const entry = data[e.list][e.index];
      if (!e.read) {
        notes.push(`"${e.name}" unresolved, kept ${entry.type ?? 'no type'}`);
        continue;
      }
      if (entry.type === e.read) continue;
      notes.push(`"${e.name}" ${entry.type ?? 'none'} -> ${e.read}`);
      // The type stays right after the name, where the files keep it.
      const rebuilt: Entry = {} as Entry;
      for (const [k, v] of Object.entries(entry)) {
        if (k === 'type') continue;
        (rebuilt as Record<string, unknown>)[k] = v;
        if (k === 'name') rebuilt.type = e.read;
      }
      data[e.list][e.index] = rebuilt;
      changed++;
    }
    const pl = isFile(target.pl) ? readJson<{ reactions?: unknown[]; abilities?: unknown[] } & Record<string, unknown>>(target.pl) : null;
    if (pl) {
      const lengths = (['reactions', 'abilities'] as const).map((l) => `${(pl[l] ?? []).length}/${data[l].length}`);
      if ((pl.reactions ?? []).length !== data.reactions.length || (pl.abilities ?? []).length !== data.abilities.length) {
        notes.push(`Polish file has other entries (reactions, abilities: ${lengths.join(', ')})`);
      }
      if (JSON.stringify(pl).includes('"type"')) notes.push('Polish file has types: update them by hand');
    }
    if (notes.some((n) => n.includes('->'))) writeFileSync(target.json, json(data));
    if (notes.length) console.log(`  ${record.name}: ${notes.join('; ')}`);
  }
  console.log(`\n  ${changed} type(s) changed. Nothing else was written.`);
}

// ---------- read ----------

async function main() {
  const { provider, jobs, args } = takeAiOptions(process.argv.slice(2));
  const applyRun = takeValue(args, 'apply');
  if (applyRun) return apply(applyRun);
  const reportRun = takeValue(args, 'report');
  if (reportRun) return report(reportRun);
  const all = takeFlag(args, 'all');
  const initialReads = Number(takeValue(args, 'reads') ?? DEFAULT_VOTE_SETTINGS.initialReads);
  const maxReads = Math.max(initialReads, Number(takeValue(args, 'max-reads') ?? DEFAULT_VOTE_SETTINGS.maxReads));
  const settings = { ...DEFAULT_VOTE_SETTINGS, initialReads, maxReads };
  const available = targets();
  const unknown = args.filter((a) => !available.some((t) => t.id === a));
  if (unknown.length) throw new Error(`unknown warscroll(s): ${unknown.join(', ')}`);
  const chosen = all ? available : available.filter((t) => args.includes(t.id));
  if (!chosen.length) throw new Error('name warscrolls (warband slugs or GA keys such as order-1), or --all');

  const runId = `types-${new Date().toISOString().replace(/[:T]/g, '-').replace(/\..*/, '')}`;
  const runDir = join(EXTRACTION_DIR, runId);
  mkdirSync(join(runDir, 'warscrolls'), { recursive: true });
  console.log(`\n  Warscroll entry types from the heading symbols: ${chosen.length} warscroll(s) -> ${relative(ROOT, runDir)}`);
  const started = Date.now();
  const ai = await AiClient.create({ provider });
  const ctx: ReadContext = { ai, limiter: new Limiter(jobs) };
  const records: TypesRecord[] = [];

  await runJobs(chosen, Math.max(2, Math.ceil(jobs / settings.initialReads)), (t) => t.name, async (t) => {
    const data = readJson<WarscrollFile>(t.json);
    const list: TypeTarget[] = (['reactions', 'abilities'] as const).flatMap((l) =>
      data[l].map((e, index) => ({ list: l, index, name: e.name, trigger: e.trigger ?? null, rulesText: e.rulesText })),
    );
    const record: TypesRecord = { id: t.id, name: t.name, file: relative(ROOT, t.json), reads: 0, failedReads: [], entries: [] };
    try {
      const { readings, vote } = await readEntryTypes(ctx, t.name, readFileSync(t.image), list, settings, (n) => jobNote(n));
      record.reads = vote.reads;
      record.failedReads = vote.failures;
      record.entries = readings.map((r) => {
        const top = r.outcome.tallies[0];
        return {
          list: r.target.list,
          index: r.target.index,
          name: r.target.name,
          current: asType(data[r.target.list][r.target.index].type),
          read: r.type,
          icon: r.type ? (top?.canon ?? null) : null,
          status: r.type ? r.outcome.status : 'unresolved',
          votes: r.outcome.tallies.map((x) => `${x.canon} ${x.count}`).join(', '),
          reads: vote.reads,
          seen: r.seen,
          flags: r.flags.map((f) => ({ level: f.level, message: f.message })),
        };
      });
    } catch (err) {
      record.error = err instanceof Error ? err.message : String(err);
    }
    writeFileSync(join(runDir, 'warscrolls', `${t.id}.json`), json(record));
    records.push(record);
    if (record.error) throw new Error(record.error);
    const changes = record.entries.filter((e) => e.read && e.read !== e.current);
    const open = record.entries.filter((e) => !e.read).length;
    return `${record.reads} reads; ${changes.length ? changes.map((e) => `${e.name} ${e.current}->${e.read}`).join(', ') : 'no change'}${open ? `; ${open} UNRESOLVED` : ''}`;
  });

  const usage = ai.usage();
  const meta = {
    runId,
    model: DEFAULT_MODEL,
    provider: ai.providerLabel,
    settings: `${settings.initialReads} reads per warscroll (the whole card and the enlarged columns in turn, two wordings), up to ${settings.maxReads} when they disagree, a majority needs ${Math.ceil(settings.threshold * settings.maxReads)}`,
    calls: ai.stats.calls,
    costUsd: usage.costUsd,
    seconds: (Date.now() - started) / 1000,
  };
  const order = chosen.map((t) => t.id);
  records.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  writeFileSync(join(runDir, 'summary.json'), json(meta));
  writeFileSync(join(runDir, 'report.md'), renderReport(meta, records));
  console.log(`\n  Done: ${meta.calls} AI calls, about $${meta.costUsd.toFixed(2)}. Report: ${relative(ROOT, join(runDir, 'report.md'))}`);
  console.log(`  Nothing in warbands/ was changed. After review: npm run warscroll:types -- --apply ${runId}`);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
