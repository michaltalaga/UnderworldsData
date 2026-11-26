import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, join, relative, sep } from 'path';
import { AiClient, DEFAULT_MODEL, NoProviderLeftError, runJobs, takeAiOptions, type ProviderId } from './ai';
import { jobNote } from './ai/jobs';
import { positiveInt, takeFlag, takeValue } from './lib/args';
import type { ReadContext } from './lib/ai-read';
import { CARD_REGION_NAMES } from './lib/card-image';
import {
  CARD_LEGEND,
  answerIds,
  buildCatalog,
  fighterRunemarks,
  renderCatalogSheets,
  refreshPictures,
  renderLegend,
  renderSheet,
  saveCatalog,
  weaponRunemarks,
} from './lib/catalog';
import { GA_DIR, GA_KEYS, ROOT, isFile, loadWarbands, readJsonIfExists, warbandFile, type WarbandMeta } from './lib/data';
import { loadSide, readFighter, type FighterReading, type References } from './lib/fighter-reader';
import { SIDES, fightersFileText, type FightersFile } from './lib/fighters';
import { Limiter } from './lib/limit';
import { crossChecks, diffFighters, diffWarscroll, renderReport, toRecord, type RunSummary, type WarbandRecord, type WarbandResult } from './lib/rebuild-report';
import { renderHtmlReport } from './lib/html-report';
import { DEFAULT_VOTE_SETTINGS, type RegionVote, type VoteSettings } from './lib/votes';
import { readWarscroll, remapPolish, translateMissing, type Warscroll } from './lib/warscroll-reader';

/**
 * Fighter stats (fighters.json) from the fighter card images, read by consensus voting.
 *
 *   npm run extract:fighters                          fighters.json for warbands that have none
 *   npm run extract:fighters -- --rebuild <slug>...   read again into extraction/<run>/, changing nothing
 *   npm run extract:fighters -- --rebuild --all       the same for every warband and the GA warscrolls
 *   npm run extract:fighters -- --resume <run>         continue a run that stopped (usage limit, Ctrl+C)
 *   npm run extract:fighters -- --resume <run> --redo a,b   read finished warbands of a run again
 *   npm run extract:fighters -- --pictures <run>       cut a run's warscroll keyword pictures again
 *   npm run extract:fighters -- --report <run>         write a run's review page (report.html) again
 *   npm run extract:fighters -- --apply extraction/<run> [slug...]
 *                                                     copy a reviewed run into warbands/
 *
 * Options: --resume <run> (continue a run that stopped), --reads N (first reads per region, default 5), --max-reads N (default 15),
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
      for (const file of readdirSync(from).filter((f) => f.endsWith('.json') && f !== 'result.json')) copy(file);
    } else {
      copy('fighters.json');
      copy('warscroll.json');
      copy('warscroll.pl.json');
      if (existsSync(join(from, 'runemarks'))) {
        // Replaced as a whole, so the catalog and its pictures always come from the same run, except
        // icons/: the app's SVGs, which npm run icons draws and a run does not make.
        const target = warbandFile(slug, 'runemarks');
        for (const entry of existsSync(target) ? readdirSync(target) : []) if (entry !== 'icons') rmSync(join(target, entry), { recursive: true, force: true });
        const runIcons = join(from, 'runemarks', 'icons');
        cpSync(join(from, 'runemarks'), target, { recursive: true, filter: (src) => src !== runIcons && !src.startsWith(runIcons + sep) });
        // Runs made before keywords/<id>-icon.png kept the cut-outs in icons/<id>.png, next to a copy of icon.png.
        for (const file of existsSync(runIcons) ? readdirSync(runIcons).filter((f) => f.endsWith('.png') && f !== `${slug}.png`) : []) {
          mkdirSync(join(target, 'keywords'), { recursive: true });
          cpSync(join(runIcons, file), join(target, 'keywords', file.replace(/\.png$/, '-icon.png')));
        }
        copied.push('runemarks/');
      }
    }
    console.log(`  ${slug}: ${copied.join(', ') || 'nothing to copy'}`);
  }
  console.log('\n  Done.');
}

// ---------- pictures ----------

/**
 * --pictures <run>: cuts the warscroll keyword pictures of a finished run again (see
 * refreshPictures) and updates its records and report. Ids and texts stay as they are.
 */
async function refreshRunPictures(runArg: string, provider: ProviderId | undefined, jobs: number): Promise<void> {
  const runDir = existsSync(runArg) ? runArg : join(EXTRACTION_DIR, runArg);
  const summary = readJsonIfExists<RunSummary & { selection?: string[]; ga?: boolean }>(join(runDir, 'summary.json'));
  if (!summary) throw new Error(`no run with a summary.json at ${runArg}`);
  const warbands = loadWarbands();
  // Runs made before the summary listed its warbands: the warband folders in the run.
  const selection = summary.selection ?? readdirSync(runDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const targets = [
    ...warbands
      .filter((wb) => selection.includes(wb.slug) && isFile(warbandFile(wb.slug, 'warscroll.png')))
      .map((wb) => ({ slug: wb.slug, name: wb.name, image: warbandFile(wb.slug, 'warscroll.png') })),
    ...GA_KEYS.map((k) => ({ slug: `_ga/${k}`, name: `Grand Alliance ${k}`, image: join(GA_DIR, `${k}.png`) })),
  ].filter((t) => {
    const saved = readJsonIfExists<{ runemarks: { source: string }[] }>(join(runDir, t.slug, 'runemarks', 'runemarks.json'));
    return saved?.runemarks.some((r) => r.source === 'warscroll') && isFile(t.image);
  });

  console.log(`\n  Warscroll keyword pictures for ${relative(ROOT, runDir)}: ${targets.length} catalog(s) with keywords\n`);
  const started = Date.now();
  const ai = await AiClient.create({ provider });
  const ctx: ReadContext = { ai, limiter: new Limiter(jobs) };
  await runJobs(targets, jobs, (t) => t.name, async (t) => {
    const catalog = await refreshPictures(ctx, join(runDir, t.slug, 'runemarks'), readFileSync(t.image), { slug: t.slug.replace(/^_ga\//, ''), name: t.name });
    const record = readJsonIfExists<WarbandRecord>(join(runDir, t.slug, 'result.json'));
    if (record) write(join(runDir, t.slug, 'result.json'), json({ ...record, catalogFlags: catalog.flags }));
    const icons = catalog.entries.filter((e) => e.source === 'warscroll');
    return `cut out alone: ${icons.filter((e) => e.cutOut).map((e) => e.id).join(', ') || 'none'}${icons.some((e) => !e.cutOut) ? `; not: ${icons.filter((e) => !e.cutOut).map((e) => e.id).join(', ')}` : ''}`;
  });

  const usage = ai.usage();
  const updated = {
    ...summary,
    calls: summary.calls + ai.stats.calls,
    failedCalls: summary.failedCalls + ai.stats.failed,
    inputTokens: summary.inputTokens + usage.inputTokens,
    outputTokens: summary.outputTokens + usage.outputTokens,
    costUsd: summary.costUsd + usage.costUsd,
    seconds: summary.seconds + (Date.now() - started) / 1000,
  };
  const order = [...warbands.map((wb) => wb.slug), ...GA_KEYS.map((k) => `_ga/${k}`)];
  const records = order.map((slug) => readJsonIfExists<WarbandRecord>(join(runDir, slug, 'result.json'))).filter((r): r is WarbandRecord => r !== null);
  write(join(runDir, 'report.md'), renderReport(updated, records));
  write(join(runDir, 'summary.json'), json(updated));
  write(join(runDir, 'report.html'), renderHtmlReport(runDir));
  console.log(`\n  Done: ${ai.stats.calls} AI calls, about $${usage.costUsd.toFixed(2)}. Report updated: ${relative(ROOT, join(runDir, 'report.md'))}`);
}

// ---------- main ----------

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function main() {
  const { provider, jobs, args } = takeAiOptions(process.argv.slice(2));
  const applyRun = takeValue(args, 'apply');
  if (applyRun) return apply(applyRun, args);
  const picturesRun = takeValue(args, 'pictures');
  if (picturesRun) return refreshRunPictures(picturesRun, provider, jobs);
  const reportRun = takeValue(args, 'report');
  if (reportRun) {
    const runDir = existsSync(reportRun) ? reportRun : join(EXTRACTION_DIR, reportRun);
    write(join(runDir, 'report.html'), renderHtmlReport(runDir));
    console.log(`  Review page: ${relative(ROOT, join(runDir, 'report.html'))}`);
    return;
  }

  const resume = takeValue(args, 'resume');
  // With --resume: warbands (or _ga/<key>) to read again even though they finished.
  const redo = new Set(takeValue(args, 'redo')?.split(',').map((s) => s.trim()).filter(Boolean) ?? []);
  if (redo.size && !resume) throw new Error('--redo only works with --resume <run>');
  const rebuild = takeFlag(args, 'rebuild') || Boolean(resume);
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
  if (rebuild && !resume && !all && named.length === 0 && !withGa) throw new Error('--rebuild needs warband slugs, or --all');

  const runId = resume ? basename(resume) : new Date().toISOString().replace(/[:T]/g, '-').replace(/\..*/, '');
  const runDir = join(EXTRACTION_DIR, runId);
  if (resume && !existsSync(runDir)) throw new Error(`no run folder ${relative(ROOT, runDir)} to resume`);
  const previous = resume ? readJsonIfExists<RunSummary & { selection?: string[]; ga?: boolean }>(join(runDir, 'summary.json')) : null;

  // A resumed run reads the same warbands as the run it continues.
  const resumedSelection = previous?.selection ? warbands.filter((wb) => previous.selection!.includes(wb.slug)) : null;
  const selected = resumedSelection ?? (rebuild ? (all ? warbands : named) : warbands.filter((wb) => !isFile(warbandFile(wb.slug, 'fighters.json')) && (!wanted.length || named.includes(wb))));
  const gaWanted = resume ? Boolean(previous?.ga) : withGa;
  const cardFiles = (wb: WarbandMeta) =>
    Array.from({ length: wb.fighters }, (_, i) => i + 1).filter((n) => isFile(warbandFile(wb.slug, `fighters/${n}.png`)) && isFile(warbandFile(wb.slug, `fighters/${n}-inspired.png`)));
  const ready = selected.filter((wb) => cardFiles(wb).length === wb.fighters);
  const noCards = selected.filter((wb) => !ready.includes(wb));
  const gaKeys = rebuild && gaWanted && !noWarscroll ? GA_KEYS.filter((k) => isFile(join(GA_DIR, `${k}.png`))) : [];

  const recordFile = (slug: string) => join(runDir, slug, 'result.json');
  const isDone = (slug: string) => !redo.has(slug) && readJsonIfExists<WarbandRecord>(recordFile(slug))?.complete === true;
  const todo = ready.filter((wb) => !isDone(wb.slug));
  const gaTodo = gaKeys.filter((k) => !isDone(`_ga/${k}`));

  console.log(`\n  Fighter Card Extraction (${rebuild ? 'rebuild into a review folder' : 'missing fighters.json only'})`);
  console.log(`  ==========================================\n`);
  noCards.forEach((wb) => console.log(`  ${wb.name}: SKIP (fighter cards not downloaded; run npm run download:fighters)`));
  if (resume) console.log(`  Resuming ${runId}: ${ready.length - todo.length} of ${ready.length} warbands and ${gaKeys.length - gaTodo.length} of ${gaKeys.length} GA warscrolls already done`);
  if (todo.length === 0 && gaTodo.length === 0 && !resume) {
    console.log('  Nothing to extract.');
    return;
  }

  mkdirSync(runDir, { recursive: true });
  const started = Date.now();
  const ai = await AiClient.create({ provider });
  const ctx: ReadContext = { ai, limiter: new Limiter(jobs) };
  console.log(`  Model: ${DEFAULT_MODEL} | Reads per region: ${initialReads}, up to ${maxReads} when they disagree | Output: ${relative(ROOT, runDir)}`);

  const saveLegend = await renderLegend('Save symbols', CARD_LEGEND.save);
  const weaponLegend = await renderLegend('Weapon bar icons', CARD_LEGEND.weapon);
  const blank = (wb: { slug: string; name: string; opLegal: boolean }): WarbandResult => ({
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
    expectedFighters: 0,
  });

  /** Everything for one warband, saved as soon as it is done: catalog, warscroll (rebuild), fighters. */
  const readWarband = async (wb: WarbandMeta): Promise<string> => {
    const result = blank(wb);
    const outDir = join(runDir, wb.slug);
    const warscrollImage = wb.opLegal && isFile(warbandFile(wb.slug, 'warscroll.png')) ? readFileSync(warbandFile(wb.slug, 'warscroll.png')) : null;
    const wantWarscroll = rebuild && !noWarscroll && warscrollImage !== null;
    const summary: string[] = [];
    try {
      jobNote('runemark catalog');
      const icon = isFile(warbandFile(wb.slug, 'icon.png')) ? readFileSync(warbandFile(wb.slug, 'icon.png')) : null;
      const catalog = await buildCatalog(ctx, wb, { icon, warscroll: warscrollImage }, smallSettings);
      const sheets = await renderCatalogSheets(catalog, wb.name);
      result.catalog = catalog;
      result.catalogFlags = catalog.flags;
      result.reads += catalog.reads;
      saveCatalog(rebuild ? join(outDir, 'runemarks') : warbandFile(wb.slug, 'runemarks'), catalog, sheets);
      const found = catalog.keywords.map((k) => `${k.keyword}=${k.id}`).join(', ');
      summary.push(`catalog ${catalog.entries.length} icons${found ? ` (${found})` : ''}`);

      if (wantWarscroll) {
        const existing = readJsonIfExists<Record<string, unknown>>(warbandFile(wb.slug, 'warscroll.json'));
        const reading = await readWarscroll(ctx, { id: wb.slug, name: wb.name, grandAlliance: wb.grandAlliance }, warscrollImage!, catalog, sheets.all, existing, smallSettings, (n) => jobNote(`warscroll: ${n}`));
        result.reads += reading.vote.reads + reading.vote.failures.length;
        result.warscrollDiff = diffWarscroll(existing, reading.warscroll);
        write(join(outDir, 'warscroll.json'), json(reading.warscroll));
        write(join(outDir, 'warscroll-votes.json'), json(votesJson([{ label: 'warscroll', vote: reading.vote }])));
        const pl = readJsonIfExists<Record<string, unknown>>(warbandFile(wb.slug, 'warscroll.pl.json'));
        if (existing && pl) {
          jobNote('Polish file');
          const polish = await polishFor(ctx, existing, reading.warscroll, pl);
          result.polishNotes = polish.notes;
          write(join(outDir, 'warscroll.pl.json'), json(polish.pl));
        }
        result.warscroll = reading;
        summary.push(`warscroll ${reading.flags.length} flag(s), ${result.warscrollDiff.length} change(s)`);
      }

      if (!noFighters) {
        const refs: References = {
          warbandName: wb.name,
          warbandSlug: wb.slug,
          fighterSheet: sheets.fighter,
          weaponSheet: sheets.weapon,
          saveLegend,
          weaponLegend,
          warscroll: warscrollImage,
          fighterIds: answerIds(fighterRunemarks(catalog), wb),
          weaponIds: answerIds(weaponRunemarks(catalog), wb),
          keywordSheet: catalog.entries.some((e) => e.source === 'warscroll')
            ? await renderSheet(`${wb.name}: the warband's own runemarks (a runemark can stand in place of a number)`, catalog.entries.filter((e) => e.source === 'warscroll'))
            : null,
        };
        const indexes = cardFiles(wb).filter((n) => !onlyFighters || onlyFighters.includes(n));
        result.expectedFighters = indexes.length;
        let finished = 0;
        jobNote(`fighters 0/${indexes.length} done`);
        const outcomes = await Promise.allSettled(
          indexes.map(async (index) => {
            const card = {
              index,
              uninspired: await loadSide(readFileSync(warbandFile(wb.slug, `fighters/${index}.png`))),
              inspired: await loadSide(readFileSync(warbandFile(wb.slug, `fighters/${index}-inspired.png`))),
            };
            for (const side of SIDES) {
              write(join(outDir, 'crops', `${index}-${side}-card.png`), card[side].card);
              for (const region of CARD_REGION_NAMES) write(join(outDir, 'crops', `${index}-${side}-${region}.png`), card[side].crops[region]);
            }
            const reading = await readFighter(ctx, card, refs, settings, () => {});
            jobNote(`fighters ${++finished}/${indexes.length} done (last: ${reading.fighter.name})`);
            return reading;
          }),
        );
        // Out of AI providers (for example at a usage limit): stop the run; this warband is redone on --resume.
        const stop = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected' && o.reason instanceof NoProviderLeftError);
        if (stop) throw stop.reason;
        outcomes.forEach((o, i) => {
          if (o.status === 'fulfilled') result.readings.push(o.value);
          else result.failedFighters.push({ index: indexes[i], error: errorText(o.reason) });
        });
        result.readings.sort((a, b) => a.fighter.index - b.fighter.index);
        result.reads += result.readings.reduce((sum, r) => sum + regionCount(r.regions) + 1, 0);

        if (result.readings.length) {
          const file: FightersFile = { warband: wb.slug, fighters: result.readings.map((r) => r.fighter) };
          const currentFile = readJsonIfExists<FightersFile>(warbandFile(wb.slug, 'fighters.json'));
          // With --fighters only those cards are compared.
          const current = currentFile && onlyFighters ? { ...currentFile, fighters: currentFile.fighters.filter((f) => onlyFighters.includes(f.index)) } : currentFile;
          result.crossChecks = crossChecks(wb, result.readings, catalog, cardFiles(wb).length);
          result.fighterDiff = diffFighters(current, file);
          write(join(outDir, 'fighters.json'), fightersFileText(file));
          write(
            join(outDir, 'fighter-votes.json'),
            json(result.readings.flatMap((r: FighterReading) => [
              ...votesJson(r.regions.map((g) => ({ label: `${r.fighter.index} ${r.fighter.name} / ${g.side} / ${g.region}`, vote: g.vote }))),
              { region: `${r.fighter.index} ${r.fighter.name} / checker`, checks: r.checks },
            ])),
          );
          if (!rebuild && result.failedFighters.length === 0 && result.readings.length === wb.fighters) {
            writeFileSync(warbandFile(wb.slug, 'fighters.json'), fightersFileText(file));
          }
        }
        const review = result.readings.flatMap((r) => r.flags).filter((f) => f.level === 'review').length;
        summary.push(`${result.readings.length}/${indexes.length} fighters${review ? `, ${review} to review` : ''}${result.failedFighters.length ? `, ${result.failedFighters.length} FAILED` : ''}`);
      }
    } catch (err) {
      if (err instanceof NoProviderLeftError) throw err;
      result.error = errorText(err);
    }
    write(recordFile(wb.slug), json(toRecord(result, wantWarscroll)));
    if (result.error) throw new Error(result.error);
    if (result.failedFighters.length) throw new Error(summary.join('; '));
    return summary.join('; ');
  };

  /** A Grand Alliance warscroll (played by vaulted warbands); only core icons. */
  const readGa = async (key: string): Promise<string> => {
    const [alliance, variant] = key.split('-');
    const grandAlliance = alliance[0].toUpperCase() + alliance.slice(1);
    const meta = { slug: `_ga/${key}`, name: `Grand Alliance ${grandAlliance} (${variant})`, opLegal: true };
    const result = blank(meta);
    try {
      const image = readFileSync(join(GA_DIR, `${key}.png`));
      const catalog = await buildCatalog(ctx, { slug: key, name: meta.name }, { icon: null, warscroll: image }, smallSettings);
      const sheets = await renderCatalogSheets(catalog, meta.name);
      saveCatalog(join(runDir, '_ga', key, 'runemarks'), catalog, sheets);
      result.catalog = catalog;
      result.catalogFlags = catalog.flags;
      result.reads += catalog.reads;
      const existing = readJsonIfExists<Record<string, unknown>>(join(GA_DIR, `${key}.json`));
      const reading = await readWarscroll(ctx, { id: key, name: meta.name, grandAlliance }, image, catalog, sheets.all, existing, smallSettings, (n) => jobNote(n));
      result.reads += reading.vote.reads + reading.vote.failures.length;
      result.warscrollDiff = diffWarscroll(existing, reading.warscroll);
      write(join(runDir, '_ga', `${key}.json`), json(reading.warscroll));
      const pl = readJsonIfExists<Record<string, unknown>>(join(GA_DIR, `${key}.pl.json`));
      if (existing && pl) {
        const polish = await polishFor(ctx, existing, reading.warscroll, pl);
        result.polishNotes = polish.notes;
        write(join(runDir, '_ga', `${key}.pl.json`), json(polish.pl));
      }
      result.warscroll = reading;
    } catch (err) {
      if (err instanceof NoProviderLeftError) throw err;
      result.error = errorText(err);
    }
    write(recordFile(meta.slug), json(toRecord(result, true)));
    if (result.error) throw new Error(result.error);
    return `${result.warscroll!.flags.length} flag(s), ${result.warscrollDiff.length} change(s)`;
  };

  const notes: string[] = [];
  try {
    if (todo.length) {
      // A warband sends many reads at once, so fewer warbands run side by side than --jobs.
      console.log(`\n  Warbands: runemark catalog${rebuild && !noWarscroll ? ', warscroll' : ''}${noFighters ? '' : ', fighter cards'}`);
      await runJobs(todo, Math.max(2, Math.ceil(jobs / 6)), (wb) => wb.name, readWarband);
    }
    if (gaTodo.length) {
      console.log('\n  Grand Alliance warscrolls');
      await runJobs(gaTodo, jobs, (k) => k, readGa);
    }
  } catch (err) {
    notes.push(`The run stopped early: ${errorText(err)}. Continue it with: npm run extract:fighters -- --resume ${runId} --jobs ${jobs}`);
    process.exitCode = 1;
  } finally {
    // The report always covers every warband finished so far, this session or an earlier one.
    const usage = ai.usage();
    const summary: RunSummary & { selection: string[]; ga: boolean } = {
      runId,
      model: DEFAULT_MODEL,
      provider: ai.providerLabel,
      settings: `${initialReads} reads per region (3 for warscrolls and rules text), up to ${maxReads} (7) when they disagree, majority needs ${Math.round(settings.threshold * 100)}% of the maximum`,
      calls: (previous?.calls ?? 0) + ai.stats.calls,
      failedCalls: (previous?.failedCalls ?? 0) + ai.stats.failed,
      inputTokens: (previous?.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
      costUsd: (previous?.costUsd ?? 0) + usage.costUsd,
      seconds: (previous?.seconds ?? 0) + (Date.now() - started) / 1000,
      sessions: (previous?.sessions ?? 1) + (previous ? 1 : 0),
      selection: selected.map((wb) => wb.slug),
      ga: gaWanted,
    };
    const records = [...ready.map((wb) => wb.slug), ...gaKeys.map((k) => `_ga/${k}`)]
      .map((slug) => readJsonIfExists<WarbandRecord>(recordFile(slug)))
      .filter((r): r is WarbandRecord => r !== null);
    const unfinished = [...ready.map((wb) => wb.name), ...gaKeys].length - records.filter((r) => r.complete).length;
    if (unfinished > 0 && !notes.length) notes.push(`${unfinished} warband(s) or GA warscroll(s) are not complete; npm run extract:fighters -- --resume ${runId} reads them again`);
    write(join(runDir, 'report.md'), renderReport(summary, records, notes));
    write(join(runDir, 'summary.json'), json(summary));
    write(join(runDir, 'report.html'), renderHtmlReport(runDir));

    console.log(`\n  ${notes.length ? 'Stopped' : 'Done'} after ${Math.round(summary.seconds)}s in all: ${summary.calls} AI calls, about $${summary.costUsd.toFixed(2)}.`);
    console.log(`  Review page: ${relative(ROOT, join(runDir, 'report.html'))} (everything in full: report.md)`);
    notes.forEach((n) => console.log(`  ${n}`));
    if (!rebuild) console.log(`  fighters.json written for ${records.filter((r) => r.complete && r.fighters.length).length} warband(s).`);
    else if (!notes.length) console.log(`  Nothing in warbands/ was changed. After review: npm run extract:fighters -- --apply ${runId}`);
    if (unfinished > 0) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
