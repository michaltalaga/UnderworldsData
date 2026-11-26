import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { AiClient, runJobs, takeAiOptions } from './ai';
import { jobNote } from './ai/jobs';
import type { ReadContext } from './lib/ai-read';
import { buildCatalog, renderCatalogSheets, saveCatalog } from './lib/catalog';
import { Limiter } from './lib/limit';
import type { VoteSettings } from './lib/votes';
import { readWarscroll } from './lib/warscroll-reader';

interface WarbandMeta {
  slug: string;
  name: string;
  fighters: number;
  opLegal: boolean;
  grandAlliance: string;
}

const WARBANDS_DIR = join(import.meta.dirname, '..', 'warbands');
const GA_DIR = join(WARBANDS_DIR, '_ga');
const BASE_URL = 'https://www.underworldsdb.com/cards/fighters';
const ALLIANCES = ['Chaos', 'Death', 'Destruction', 'Order'];

// Warscrolls are read by voting, with icons taken from the warband's runemark catalog (see
// scripts/lib/warscroll-reader.ts): 3 reads, up to 7 when they disagree.
const SETTINGS: VoteSettings = { initialReads: 3, maxReads: 7, threshold: 0.8 };

async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Builds the runemark catalog for a warscroll (saved to catalogDir when given) and reads the
 * warscroll with it. Values the reads could not agree on are printed for checking.
 */
async function readWithCatalog(
  ctx: ReadContext,
  meta: { slug: string; name: string; grandAlliance: string },
  image: Buffer,
  icon: Buffer | null,
  catalogDir: string | null,
): Promise<Record<string, unknown>> {
  jobNote('reading the icons');
  const catalog = await buildCatalog(ctx, meta, { icon, warscroll: image }, SETTINGS);
  const sheets = await renderCatalogSheets(catalog, meta.name);
  if (catalogDir) saveCatalog(catalogDir, catalog, sheets);
  const reading = await readWarscroll(ctx, { id: meta.slug, name: meta.name, grandAlliance: meta.grandAlliance }, image, catalog, sheets.all, null, SETTINGS, (n) => jobNote(`text: ${n}`));
  for (const flag of [...catalog.flags, ...reading.flags.filter((f) => f.level === 'review').map((f) => `${f.field}: ${f.message}`)]) {
    console.log(`  ! ${meta.name}: ${flag}`);
  }
  return reading.warscroll;
}

async function extractGaWarscrolls(ctx: ReadContext, jobs: number) {
  mkdirSync(GA_DIR, { recursive: true });

  const pending: { key: string; alliance: string; variant: number }[] = [];
  let alreadyDone = 0;

  for (const alliance of ALLIANCES) {
    for (const variant of [1, 2]) {
      const key = `${alliance.toLowerCase()}-${variant}`;
      if (existsSync(join(GA_DIR, `${key}.json`))) {
        alreadyDone++;
      } else {
        pending.push({ key, alliance, variant });
      }
    }
  }

  console.log(`\n  GA Warscroll Extraction`);
  console.log(`  ======================\n`);
  console.log(`  Total: 8 | Extracted: ${alreadyDone} | Remaining: ${pending.length}`);

  if (pending.length === 0) {
    console.log('  All GA warscrolls extracted!');
    return;
  }

  const { ok, failed } = await runJobs(pending, jobs, (p) => p.key, async ({ key, alliance, variant }) => {
    const localImage = join(GA_DIR, `${key}.png`);
    let imageData: Buffer | null = null;

    if (existsSync(localImage)) {
      imageData = readFileSync(localImage);
    } else {
      const url = `${BASE_URL}/${alliance}-0${variant}.png?v=1.14`;
      imageData = await downloadImage(url);
      if (imageData) {
        writeFileSync(localImage, imageData);
      }
    }

    if (!imageData || imageData.length < 1000) throw new Error('no image or too small');

    const meta = { slug: key, name: `Grand Alliance ${alliance} (${variant})`, grandAlliance: alliance };
    const data = await readWithCatalog(ctx, meta, imageData, null, null);
    writeFileSync(join(GA_DIR, `${key}.json`), `${JSON.stringify(data, null, 2)}
`);
  });

  console.log(`\n  GA done. Success: ${ok} | Failed: ${failed}`);
}

async function main() {
  const { provider, jobs, args } = takeAiOptions(process.argv.slice(2));
  const batchSize = parseInt(args[0] || '5', 10);

  const ai = await AiClient.create({ provider });
  const ctx: ReadContext = { ai, limiter: new Limiter(jobs) };

  // Extract GA warscrolls first
  await extractGaWarscrolls(ctx, jobs);

  const index: WarbandMeta[] = JSON.parse(
    readFileSync(join(WARBANDS_DIR, 'index.json'), 'utf8'),
  );

  // Only OP-legal warbands need per-warband extraction
  const opWarbands = index.filter((wb) => wb.opLegal);

  const pending = opWarbands.filter((wb) => {
    const wbDir = join(WARBANDS_DIR, wb.slug);
    return !existsSync(join(wbDir, 'warscroll.json'));
  });

  const extracted = opWarbands.length - pending.length;
  console.log(`\n  Warband Extraction`);
  console.log(`  ==================\n`);
  console.log(`  OP warbands: ${opWarbands.length} | Extracted: ${extracted} | Remaining: ${pending.length}`);

  if (pending.length === 0) {
    console.log('  All warscrolls have been extracted!');
    return;
  }

  const batch = pending.slice(0, batchSize);
  console.log(`  Processing batch of ${batch.length}...\n`);

  const { ok, failed } = await runJobs(batch, jobs, (meta) => meta.name, async (meta) => {
    const wbDir = join(WARBANDS_DIR, meta.slug);
    mkdirSync(wbDir, { recursive: true });

    const localImage = join(wbDir, 'warscroll.png');
    let imageData: Buffer | null = null;

    if (existsSync(localImage)) {
      imageData = readFileSync(localImage);
    } else {
      const url = `${BASE_URL}/${meta.slug}-0.png?v=1.14`;
      imageData = await downloadImage(url);
      if (imageData) {
        writeFileSync(localImage, imageData);
      }
    }

    if (!imageData || imageData.length < 1000) throw new Error('no image or too small');

    const iconPath = join(wbDir, 'icon.png');
    const icon = existsSync(iconPath) ? readFileSync(iconPath) : null;
    const data = await readWithCatalog(ctx, meta, imageData, icon, join(wbDir, 'runemarks'));
    writeFileSync(join(wbDir, 'warscroll.json'), `${JSON.stringify(data, null, 2)}
`);
  });

  const remaining = pending.length - batch.length;
  console.log(`\n  Batch done. Success: ${ok} | Failed: ${failed} | Still remaining: ${remaining}`);
  if (remaining > 0) {
    console.log('  Run this script again to process the next batch.');
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
