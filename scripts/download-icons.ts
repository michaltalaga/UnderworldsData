import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

interface WarbandMeta {
  slug: string;
  name: string;
  grandAlliance: string;
}

interface RivalDeckMeta {
  slug: string;
  name: string;
  iconUrl: string | null;
}

const ROOT = join(import.meta.dirname, '..');
const WARBANDS_DIR = join(ROOT, 'warbands');
const GA_DIR = join(WARBANDS_DIR, '_ga');
const RIVALS_DIR = join(ROOT, 'rivals');
const IMG_BASE = 'https://www.underworldsdb.com/img';

// Faction icons (Grand Alliances + Universal) — same /img/<faction>-icon.png pattern.
const FACTIONS = ['chaos', 'death', 'destruction', 'order', 'universal'];

async function downloadImage(url: string, dest: string): Promise<'ok' | 'skip' | 'fail'> {
  if (existsSync(dest)) return 'skip';
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`  HTTP ${res.status} for ${url}`);
      return 'fail';
    }
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return 'ok';
  } catch (err) {
    console.error(`  Error downloading ${url}:`, err);
    return 'fail';
  }
}

async function run(label: string, items: { url: string; dest: string; dir: string; name: string }[]) {
  let ok = 0, skip = 0, fail = 0;
  console.log(`\n  ${label}\n  ${'='.repeat(label.length)}\n`);
  for (const it of items) {
    mkdirSync(it.dir, { recursive: true });
    process.stdout.write(`  ${it.name} ... `);
    const r = await downloadImage(it.url, it.dest);
    console.log(r.toUpperCase());
    if (r === 'ok') ok++; else if (r === 'skip') skip++; else fail++;
  }
  console.log(`\n  ${label} done. Downloaded: ${ok} | Skipped: ${skip} | Failed: ${fail}`);
  return fail;
}

async function main() {
  const warbands: WarbandMeta[] = JSON.parse(readFileSync(join(WARBANDS_DIR, 'index.json'), 'utf8'));
  const decks: RivalDeckMeta[] = JSON.parse(readFileSync(join(RIVALS_DIR, 'index.json'), 'utf8'));

  let fails = 0;

  // Grand Alliance / faction icons
  mkdirSync(GA_DIR, { recursive: true });
  fails += await run(
    'Faction Icons',
    FACTIONS.map((f) => ({
      url: `${IMG_BASE}/${f}-icon.png`,
      dest: join(GA_DIR, `${f}-icon.png`),
      dir: GA_DIR,
      name: f,
    })),
  );

  // Warband icons
  fails += await run(
    'Warband Icons',
    warbands.map((wb) => ({
      url: `${IMG_BASE}/${wb.slug}-icon.png`,
      dest: join(WARBANDS_DIR, wb.slug, 'icon.png'),
      dir: join(WARBANDS_DIR, wb.slug),
      name: wb.name,
    })),
  );

  // Rival deck icons (URLs already in index.json)
  fails += await run(
    'Rival Deck Icons',
    decks
      .filter((d) => d.iconUrl)
      .map((d) => ({
        url: d.iconUrl as string,
        dest: join(RIVALS_DIR, d.slug, 'icon.png'),
        dir: join(RIVALS_DIR, d.slug),
        name: d.name,
      })),
  );

  console.log(`\nAll icon downloads complete. Total failures: ${fails}`);
  if (fails > 0) process.exitCode = 1;
}

main();
