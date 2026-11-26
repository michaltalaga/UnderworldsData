import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { AiClient, DEFAULT_MODEL, runJobs, takeAiOptions } from './ai';
import { jobNote } from './ai/jobs';
import type { ReadContext } from './lib/ai-read';
import { CARD_REGION_NAMES } from './lib/card-image';
import {
  CARD_LEGEND,
  answerIds,
  buildCatalog,
  fighterRunemarks,
  renderCatalogSheets,
  renderLegend,
  saveCatalog,
  weaponRunemarks,
  type Catalog,
  type CatalogSheets,
} from './lib/catalog';
import { GA_DIR, GA_KEYS, ROOT, isFile, loadWarbands, readJsonIfExists, warbandFile, type WarbandMeta } from './lib/data';
import { loadSide, readFighter, type FighterReading, type References } from './lib/fighter-reader';
import { SIDES, fightersFileText, type FightersFile } from './lib/fighters';
import { Limiter } from './lib/limit';
import { crossChecks, diffFighters, diffWarscroll, renderReport, type RunSummary, type WarbandResult } from './lib/rebuild-report';
import { DEFAULT_VOTE_SETTINGS, type RegionVote, type VoteSettings } from './lib/votes';
import { readWarscroll, remapPolish, translateMissing, type Warscroll } from './lib/warscroll-reader';

/**
 * Fighter stats (fighters.json) from the fighter card images, read by consensus voting.
 *
 *   npm run extract:fighters                          fighters.json for warbands that have none
 *   npm run extract:fighters -- --rebuild <slug>...   read again into extraction/<run>/, changing nothing
 *   npm run extract:fighters -- --rebuild --all       the same for every warband and the GA warscrolls
 *   npm run extract:fighters -- --apply extraction/<run> [slug...]
 *                                                     copy a reviewed run into warbands/
 *
 * Options: --reads N (first reads per region, default 5), --max-reads N (default 15),
 * --fighters 1,8 (only these card numbers, for testing), --no-warscroll, --no-fighters, --ga, plus the
 * usual --provider api|cli and --jobs N.
 *
 * Each warband first gets a runemark catalog (core runemarks, its own runemark, and the keyword
 * icons its warscroll prints), then its warscroll is read again with those icons (--rebuild
 * only), then every fighter card is read region by region with voting and checked. A report
 * with every value that was not unanimous, the cross-checks and the changes against the
 * current files goes to extraction/<run>/report.md.
 */

const EXTRACTION_DIR = join(ROOT, 'extraction');

// ---------- arguments ----------

/**
 * Pulls a flag out of the arguments. In PowerShell npm drops the `--` of `npm run x -- --flag`
 * and keeps the flag as its own config, so it arrives as npm_config_<flag> instead.
 */
function takeFlag(args: string[], name: string): boolean {
  const at = args.indexOf(`--${name}`);
  if (at >= 0) {
    args.splice(at, 1);
    return true;
  }
  return process.env[`npm_config_${name.replace(/-/g, '_')}`] === 'true';
}

function takeValue(args: string[], name: string): string | undefined {
  const at = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (at >= 0) {
    const [arg] = args.splice(at, 1);
    return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args.splice(at, 1)[0];
  }
  const npm = process.env[`npm_config_${name.replace(/-/g, '_')}`];
  return npm && npm !== 'true' ? npm : undefined;
}

function positiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a whole number of at least 1, got "${value}"`);
  return n;
}

// ---------- output helpers ----------

function write(path: string, data: string | Buffer): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, data);
}

const json = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;

function votesJson(regions: { label: string; vote: RegionVote }[]) {
  return regions.map(({ label, vote }) => ({
    region: label,
    reads: vote.reads,
    failedReads: vote.failures,
    fields: vote.outcomes().map((o) => ({
      field: o.key,
      status: o.status,
      value: o.value,
      votes: o.tallies.map((t) => ({ answer: t.canon, count: t.count, example: t.value, reads: t.reads.map((r) => `${r.read}:${r.variant}`) })),
    })),
  }));
}

/** The current Polish file with icons carried over, and anything that changed translated again. */
async function polishFor(ctx: ReadContext, oldEn: Record<string, unknown>, newEn: Warscroll, pl: Record<string, unknown>) {
  const remapped = remapPolish(oldEn, newEn, pl);
  const done = await translateMissing(ctx, newEn, remapped.pl);
  const notes = [...remapped.notes];
  if (done.translated.length) notes.push(`translated again: ${done.translated.join(', ')}`);
  return { pl: done.pl, notes };
}

const regionCount = (votes: { vote: RegionVote }[]) => votes.reduce((sum, v) => sum + v.vote.reads + v.vote.failures.length, 0);

// ---------- apply ----------

function apply(runArg: string, slugs: string[]): void {
  const runDir = existsSync(runArg) ? runArg : join(EXTRACTION_DIR, runArg);
  if (!existsSync(runDir)) throw new Error(`no run folder at ${runArg}`);
  const dirs = readdirSync(runDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const chosen = slugs.length ? dirs.filter((d) => slugs.includes(d)) : dirs;
  const unknown = slugs.filter((s) => !dirs.includes(s));
  if (unknown.length) throw new Error(`not in this run: ${unknown.join(', ')}`);
  console.log(`\n  Applying ${relative(ROOT, runDir)} to warbands/\n`);
  for (const slug of chosen) {
    const from = join(runDir, slug);
    const copied: string[] = [];
    const copy = (file: string, to = file) => {
      if (isFile(join(from, file))) {
        cpSync(join(from, file), slug === '_ga' ? join(GA_DIR, to) : warbandFile(slug, to));
        copied.push(to);
      }
    };
    if (slug === '_ga') {
      for (const file of readdirSync(from).filter((f) => f.endsWith('.json'))) copy(file);
    } else {
      copy('fighters.json');
      copy('warscroll.json');
      copy('warscroll.pl.json');
      if (existsSync(join(from, 'runemarks'))) {
        cpSync(join(from, 'runemarks'), warbandFile(slug, 'runemarks'), { recursive: true });
        copied.push('runemarks/');
      }
    }
    console.log(`  ${slug}: ${copied.join(', ') || 'nothing to copy'}`);
  }
  console.log('\n  Done. Polish notes in the report list warscroll.pl.json fields that need `npm run translate` again.');
}

// ---------- main ----------

async function main() {
  const { provider, jobs, args } = takeAiOptions(process.argv.slice(2));
  const applyRun = takeValue(args, 'apply');
  if (applyRun) return apply(applyRun, args);

  const rebuild = takeFlag(args, 'rebuild');
  const all = takeFlag(args, 'all');
  const noWarscroll = takeFlag(args, 'no-warscroll');
  const noFighters = rebuild && takeFlag(args, 'no-fighters');
  const withGa = takeFlag(args, 'ga') || (rebuild && all);
  const initialReads = positiveInt(takeValue(args, 'reads'), 'reads', DEFAULT_VOTE_SETTINGS.initialReads);
  const maxReads = Math.max(initialReads, positiveInt(takeValue(args, 'max-reads'), 'max-reads', DEFAULT_VOTE_SETTINGS.maxReads));
  const onlyFighters = takeValue(args, 'fighters')?.split(',').map(Number);
  const settings: VoteSettings = { ...DEFAULT_VOTE_SETTINGS, initialReads, maxReads };
  const smallSettings: VoteSettings = { ...settings, initialReads: Math.min(3, initialReads), maxReads: Math.min(7, maxReads) };

  const warbands = loadWarbands();
  const wanted = args.map((a) => a.toLowerCase());
  const named = warbands.filter((wb) => wanted.includes(wb.slug) || wanted.includes(wb.name.toLowerCase()));
  const unknownNames = wanted.filter((w) => !warbands.some((wb) => wb.slug === w || wb.name.toLowerCase() === w));
  if (unknownNames.length) throw new Error(`unknown warband(s): ${unknownNames.join(', ')}`);
  if (rebuild && !all && named.length === 0 && !withGa) throw new Error('--rebuild needs warband slugs, or --all');

  const selected = rebuild ? (all ? warbands : named) : warbands.filter((wb) => !isFile(warbandFile(wb.slug, 'fighters.json')) && (!wanted.length || named.includes(wb)));
  const cardFiles = (wb: WarbandMeta) =>
    Array.from({ length: wb.fighters }, (_, i) => i + 1).filter((n) => isFile(warbandFile(wb.slug, `fighters/${n}.png`)) && isFile(warbandFile(wb.slug, `fighters/${n}-inspired.png`)));
  const ready = selected.filter((wb) => cardFiles(wb).length === wb.fighters);
  const noCards = selected.filter((wb) => !ready.includes(wb));

  console.log(`\n  Fighter Card Extraction (${rebuild ? 'rebuild into a new folder' : 'missing fighters.json only'})`);
  console.log(`  ==========================================\n`);
  noCards.forEach((wb) => console.log(`  ${wb.name}: SKIP (fighter cards not downloaded; run npm run download:fighters)`));
  if (ready.length === 0 && !withGa) {
    console.log('  Nothing to extract.');
    return;
  }

  const runId = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..*/, '');
  const runDir = join(EXTRACTION_DIR, runId);
  mkdirSync(runDir, { recursive: true });
  const started = Date.now();
  const ai = await AiClient.create({ provider });
  const ctx: ReadContext = { ai, limiter: new Limiter(jobs) };
  console.log(`  Model: ${DEFAULT_MODEL} | Reads per region: ${initialReads}, up to ${maxReads} when they disagree | Output: ${relative(ROOT, runDir)}`);

  const results = new Map<string, WarbandResult>();
  const catalogs = new Map<string, { catalog: Catalog; sheets: CatalogSheets }>();
  const blank = (wb: WarbandMeta): WarbandResult => ({
    slug: wb.slug,
    name: wb.name,
    opLegal: wb.opLegal,
    catalog: null,
    catalogFlags: [],
    warscroll: null,
    warscrollDiff: [],
    polishNotes: [],
    readings: [],
    failedFighters: [],
    crossChecks: [],
    fighterDiff: [],
    reads: 0,
  });

  // 1. Runemark catalog per warband, and (rebuild only) its warscroll read again with it.
  console.log(`\n  Step 1: runemark catalogs${rebuild && !noWarscroll ? ' and warscrolls' : ''}`);
  await runJobs(ready, jobs, (wb) => wb.name, async (wb) => {
    const result = blank(wb);
    results.set(wb.slug, result);
    const icon = isFile(warbandFile(wb.slug, 'icon.png')) ? readFileSync(warbandFile(wb.slug, 'icon.png')) : null;
    const warscrollImage = wb.opLegal && isFile(warbandFile(wb.slug, 'warscroll.png')) ? readFileSync(warbandFile(wb.slug, 'warscroll.png')) : null;
    jobNote('reading the warscroll icons');
    const catalog = await buildCatalog(ctx, wb, { icon, warscroll: warscrollImage }, smallSettings);
    const sheets = await renderCatalogSheets(catalog, wb.name);
    catalogs.set(wb.slug, { catalog, sheets });
    result.catalog = catalog;
    result.catalogFlags = catalog.flags;
    result.reads += catalog.reads;
    await saveCatalog(rebuild ? join(runDir, wb.slug, 'runemarks') : warbandFile(wb.slug, 'runemarks'), catalog, sheets);
    const found = catalog.keywords.map((k) => `${k.keyword}=${k.id}`).join(', ');

    if (!rebuild || noWarscroll || !warscrollImage) return `catalog: ${catalog.entries.length} icons${found ? ` (${found})` : ''}`;
    const existing = readJsonIfExists<Record<string, unknown>>(warbandFile(wb.slug, 'warscroll.json'));
    const reading = await readWarscroll(ctx, { id: wb.slug, name: wb.name, grandAlliance: wb.grandAlliance }, warscrollImage, catalog, sheets.all, existing, smallSettings, (n) => jobNote(`warscroll: ${n}`));
    result.warscroll = reading;
    result.reads += reading.vote.reads + reading.vote.failures.length;
    result.warscrollDiff = diffWarscroll(existing, reading.warscroll);
    write(join(runDir, wb.slug, 'warscroll.json'), json(reading.warscroll));
    write(join(runDir, wb.slug, 'warscroll-votes.json'), json(votesJson([{ label: 'warscroll', vote: reading.vote }])));
    const pl = readJsonIfExists<Record<string, unknown>>(warbandFile(wb.slug, 'warscroll.pl.json'));
    if (existing && pl) {
      jobNote('Polish file');
      const polish = await polishFor(ctx, existing, reading.warscroll, pl);
      result.polishNotes = polish.notes;
      write(join(runDir, wb.slug, 'warscroll.pl.json'), json(polish.pl));
    }
    return `catalog: ${catalog.entries.length} icons${found ? ` (${found})` : ''}; warscroll: ${reading.flags.length} flag(s), ${result.warscrollDiff.length} change(s)`;
  });

  // Grand Alliance warscrolls (played by vaulted warbands) only use core icons.
  const gaResults: WarbandResult[] = [];
  if (rebuild && withGa && !noWarscroll) {
    console.log('\n  Grand Alliance warscrolls');
    await runJobs(GA_KEYS.filter((k) => isFile(join(GA_DIR, `${k}.png`))), jobs, (k) => k, async (key) => {
      const [alliance, variant] = key.split('-');
      const grandAlliance = alliance[0].toUpperCase() + alliance.slice(1);
      const meta = { slug: key, name: `Grand Alliance ${grandAlliance} (${variant})`, fighters: 0, opLegal: true, grandAlliance };
      const result = blank(meta);
      gaResults.push(result);
      const image = readFileSync(join(GA_DIR, `${key}.png`));
      const catalog = await buildCatalog(ctx, meta, { icon: null, warscroll: image }, smallSettings);
      const sheets = await renderCatalogSheets(catalog, meta.name);
      result.catalog = catalog;
      result.catalogFlags = catalog.flags;
      const existing = readJsonIfExists<Record<string, unknown>>(join(GA_DIR, `${key}.json`));
      const reading = await readWarscroll(ctx, { id: key, name: meta.name, grandAlliance }, image, catalog, sheets.all, existing, smallSettings, (n) => jobNote(n));
      result.warscroll = reading;
      result.reads = reading.vote.reads + reading.vote.failures.length;
      result.warscrollDiff = diffWarscroll(existing, reading.warscroll);
      write(join(runDir, '_ga', `${key}.json`), json(reading.warscroll));
      const pl = readJsonIfExists<Record<string, unknown>>(join(GA_DIR, `${key}.pl.json`));
      if (existing && pl) {
        const polish = await polishFor(ctx, existing, reading.warscroll, pl);
        result.polishNotes = polish.notes;
        write(join(runDir, '_ga', `${key}.pl.json`), json(polish.pl));
      }
      return `${reading.flags.length} flag(s), ${result.warscrollDiff.length} change(s)`;
    });
  }

  // 2. Every fighter card, region by region.
  const withCatalog = ready.filter((wb) => catalogs.has(wb.slug));
  const references = new Map<string, References>();
  const saveLegend = await renderLegend('Save symbols', CARD_LEGEND.save);
  const weaponLegend = await renderLegend('Weapon bar icons', CARD_LEGEND.weapon);
  for (const wb of withCatalog) {
    const { catalog, sheets } = catalogs.get(wb.slug)!;
    references.set(wb.slug, {
      warbandName: wb.name,
      warbandSlug: wb.slug,
      fighterSheet: sheets.fighter,
      weaponSheet: sheets.weapon,
      saveLegend,
      weaponLegend,
      warscroll: wb.opLegal && isFile(warbandFile(wb.slug, 'warscroll.png')) ? readFileSync(warbandFile(wb.slug, 'warscroll.png')) : null,
      fighterIds: answerIds(fighterRunemarks(catalog), wb),
      weaponIds: answerIds(weaponRunemarks(catalog), wb),
    });
  }
  const tasks = noFighters ? [] : withCatalog.flatMap((wb) => cardFiles(wb).filter((n) => !onlyFighters || onlyFighters.includes(n)).map((index) => ({ wb, index })));
  console.log(`\n  Step 2: fighter cards (${CARD_REGION_NAMES.length} regions x 2 sides, ${initialReads} reads each, then a checker)`);
  // Each fighter sends many reads at once, so fewer fighters run side by side than --jobs.
  const fighterJobs = Math.max(1, Math.ceil(jobs / 4));
  await runJobs(tasks, fighterJobs, ({ wb, index }) => `${wb.name}, fighter ${index}/${wb.fighters}`, async ({ wb, index }) => {
    const result = results.get(wb.slug)!;
    try {
      const uninspired = readFileSync(warbandFile(wb.slug, `fighters/${index}.png`));
      const inspired = readFileSync(warbandFile(wb.slug, `fighters/${index}-inspired.png`));
      const card = { index, uninspired: await loadSide(uninspired), inspired: await loadSide(inspired) };
      const cropDir = join(runDir, wb.slug, 'crops');
      for (const side of SIDES) {
        write(join(cropDir, `${index}-${side}-card.png`), card[side].card);
        for (const region of CARD_REGION_NAMES) write(join(cropDir, `${index}-${side}-${region}.png`), card[side].crops[region]);
      }
      const reading = await readFighter(ctx, card, references.get(wb.slug)!, settings, jobNote);
      result.readings.push(reading);
      result.reads += regionCount(reading.regions) + 1;
      const review = reading.flags.filter((f) => f.level === 'review').length;
      return `${reading.fighter.name}${review ? ` (${review} to review)` : ''}`;
    } catch (err) {
      result.failedFighters.push({ index, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  });

  // 3. Assemble, cross-check, compare with the current files, write.
  for (const wb of withCatalog) {
    const result = results.get(wb.slug)!;
    const readings = result.readings.sort((a, b) => a.fighter.index - b.fighter.index);
    if (readings.length === 0) continue;
    const file: FightersFile = { warband: wb.slug, fighters: readings.map((r) => r.fighter) };
    const currentFile = readJsonIfExists<FightersFile>(warbandFile(wb.slug, 'fighters.json'));
    // With --fighters only those cards are compared.
    const current = currentFile && onlyFighters ? { ...currentFile, fighters: currentFile.fighters.filter((f) => onlyFighters.includes(f.index)) } : currentFile;
    result.crossChecks = crossChecks(wb, readings, result.catalog!, cardFiles(wb).length);
    result.fighterDiff = diffFighters(current, file);
    const complete = readings.length === wb.fighters;
    write(join(runDir, wb.slug, 'fighters.json'), fightersFileText(file));
    write(
      join(runDir, wb.slug, 'fighter-votes.json'),
      json(readings.flatMap((r: FighterReading) => [
        ...votesJson(r.regions.map((g) => ({ label: `${r.fighter.index} ${r.fighter.name} / ${g.side} / ${g.region}`, vote: g.vote }))),
        { region: `${r.fighter.index} ${r.fighter.name} / checker`, checks: r.checks },
      ])),
    );
    if (!rebuild && complete) writeFileSync(warbandFile(wb.slug, 'fighters.json'), fightersFileText(file));
  }

  const usage = ai.usage();
  const summary: RunSummary = {
    runId,
    model: DEFAULT_MODEL,
    provider: ai.providerLabel,
    settings: `${initialReads} reads per region (3 for warscrolls and rules text), up to ${maxReads} (7) when they disagree, majority needs ${Math.round(settings.threshold * 100)}% of the maximum`,
    calls: ai.stats.calls,
    failedCalls: ai.stats.failed,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    seconds: (Date.now() - started) / 1000,
  };
  const ordered = [...ready.map((wb) => results.get(wb.slug)!).filter(Boolean), ...gaResults];
  write(join(runDir, 'report.md'), renderReport(summary, ordered));
  write(join(runDir, 'summary.json'), json(summary));

  const incomplete = noFighters ? [] : ready.filter((wb) => (results.get(wb.slug)?.readings.length ?? 0) < (onlyFighters ? 1 : wb.fighters));
  console.log(`\n  Done in ${Math.round(summary.seconds)}s: ${summary.calls} AI calls, about $${summary.costUsd.toFixed(2)}.`);
  console.log(`  Report: ${relative(ROOT, join(runDir, 'report.md'))}`);
  if (!rebuild) console.log(`  fighters.json written for ${ready.length - incomplete.length} warband(s).`);
  else console.log(`  Nothing in warbands/ was changed. After review: npm run extract:fighters -- --apply ${runId}`);
  if (incomplete.length) {
    console.log(`  Not complete: ${incomplete.map((wb) => wb.name).join(', ')}. Run again to retry.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
