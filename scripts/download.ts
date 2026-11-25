import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

interface WarbandMeta {
  slug: string;
  name: string;
  fighters: number;
  opLegal: boolean;
  grandAlliance: string;
}

const WARBANDS_DIR = join(import.meta.dirname, '..', 'warbands');
const GA_DIR = join(WARBANDS_DIR, '_ga');
const INDEX_PATH = join(WARBANDS_DIR, 'index.json');
const WARBANDS_URL = 'https://www.underworldsdb.com/warbands.php';
const BASE_URL = 'https://www.underworldsdb.com/cards/fighters';
const ALLIANCES = ['Chaos', 'Death', 'Destruction', 'Order'];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const META_FIELDS = ['name', 'fighters', 'opLegal', 'grandAlliance'] as const;

const ENTITIES: Record<string, string> = { amp: '&', apos: "'", quot: '"', rsquo: "'", lsquo: "'", lt: '<', gt: '>' };

function decodeHtml(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return ENTITIES[lower] ?? match;
  });
}

function getAttribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'));
  return match ? decodeHtml(match[1]) : null;
}

function isPng(path: string): boolean {
  return existsSync(path) && readFileSync(path).subarray(0, 4).equals(PNG_MAGIC);
}

async function downloadImage(url: string, dest: string): Promise<boolean> {
  try {
    // Missing images may answer with a redirect to an HTML page — never follow it.
    const res = await fetch(url, { redirect: 'manual' });
    if (res.status !== 200) {
      console.error(`  HTTP ${res.status} for ${url}`);
      return false;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.subarray(0, 4).equals(PNG_MAGIC)) {
      console.error(`  Not a PNG: ${url}`);
      return false;
    }
    writeFileSync(dest, buffer);
    return true;
  } catch (err) {
    console.error(`  Error downloading ${url}:`, err);
    return false;
  }
}

/** Reads the warband list (the radio buttons in the warband picker) from underworldsdb.com. */
async function fetchSiteWarbands(): Promise<WarbandMeta[]> {
  const res = await fetch(WARBANDS_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${WARBANDS_URL}`);
  const html = await res.text();

  const warbands: WarbandMeta[] = [];
  for (const [tag] of html.matchAll(/<input\b[^>]*\bname="warband"[^>]*>/gi)) {
    const slug = getAttribute(tag, 'value');
    const name = getAttribute(tag, 'data-warband');
    const fighters = Number(getAttribute(tag, 'data-fighters'));
    // "Yes" when OP-legal; vaulted warbands carry their own name here instead.
    const opLegal = getAttribute(tag, 'data-warbandOPLegal');
    const grandAlliance = getAttribute(tag, 'data-warbandGA');
    if (!slug || !name || !grandAlliance || opLegal === null || !Number.isInteger(fighters)) {
      throw new Error(`Unexpected warband markup on ${WARBANDS_URL}: ${tag}`);
    }
    warbands.push({ slug, name, fighters, opLegal: opLegal === 'Yes', grandAlliance });
  }

  if (warbands.length === 0) {
    throw new Error(`No warbands found on ${WARBANDS_URL} — the page layout may have changed.`);
  }
  return warbands;
}

/** Brings warbands/index.json in line with the site so new or re-rated warbands are never missed. */
async function syncWarbandIndex(): Promise<WarbandMeta[]> {
  console.log(`\n  Warband Index Sync`);
  console.log(`  ==================\n`);

  const raw = readFileSync(INDEX_PATH, 'utf8');
  const local: WarbandMeta[] = JSON.parse(raw);
  const localBySlug = new Map(local.map((wb) => [wb.slug, wb]));
  const site = await fetchSiteWarbands();
  const siteSlugs = new Set(site.map((wb) => wb.slug));

  let added = 0;
  let updated = 0;
  const merged = site.map((wb) => {
    const existing = localBySlug.get(wb.slug);
    if (!existing) {
      added++;
      console.log(`  + ${wb.name} (${wb.opLegal ? 'OP-legal' : 'not OP-legal'})`);
      return wb;
    }
    const changes = META_FIELDS.filter((field) => existing[field] !== wb[field]).map(
      (field) => `${field} ${JSON.stringify(existing[field])} -> ${JSON.stringify(wb[field])}`,
    );
    if (changes.length > 0) {
      updated++;
      console.log(`  ~ ${wb.name}: ${changes.join(', ')}`);
    }
    return { ...existing, ...wb };
  });

  // Keep warbands the site no longer lists, so their downloaded data isn't orphaned.
  for (const wb of local) {
    if (siteSlugs.has(wb.slug)) continue;
    console.log(`  ! ${wb.name} is no longer listed on the site (kept in index)`);
    merged.push(wb);
  }

  const serialized = JSON.stringify(merged, null, 2);
  if (serialized !== raw) writeFileSync(INDEX_PATH, serialized);

  const opCount = site.filter((wb) => wb.opLegal).length;
  console.log(
    `  Site: ${site.length} warbands (${opCount} OP-legal) | Added: ${added} | Updated: ${updated}`,
  );
  return merged;
}

async function downloadGaWarscrolls(): Promise<number> {
  mkdirSync(GA_DIR, { recursive: true });
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  console.log(`\n  GA Warscroll Downloads`);
  console.log(`  =====================\n`);

  for (const alliance of ALLIANCES) {
    for (const variant of [1, 2]) {
      const key = `${alliance.toLowerCase()}-${variant}`;
      const dest = join(GA_DIR, `${key}.png`);
      if (isPng(dest)) {
        skipped++;
        continue;
      }
      const url = `${BASE_URL}/${alliance}-0${variant}.png?v=1.14`;
      process.stdout.write(`  ${key} ... `);
      const ok = await downloadImage(url, dest);
      if (ok) {
        console.log('OK');
        downloaded++;
      } else {
        console.log('FAILED');
        failed++;
      }
    }
  }

  console.log(`\n  GA done. Downloaded: ${downloaded} | Skipped: ${skipped} | Failed: ${failed}`);
  return failed;
}

async function main() {
  const index = await syncWarbandIndex();

  const gaFailed = await downloadGaWarscrolls();

  // Only OP-legal warbands have their own warscroll; the rest use the GA ones above.
  const opWarbands = index.filter((wb) => wb.opLegal);
  const pending = opWarbands.filter((wb) => !isPng(join(WARBANDS_DIR, wb.slug, 'warscroll.png')));

  console.log(`\n  Warband Downloads`);
  console.log(`  =================\n`);
  console.log(
    `  OP warbands: ${opWarbands.length} | Already downloaded: ${opWarbands.length - pending.length} | To download: ${pending.length}`,
  );

  let downloaded = 0;
  let failed = 0;
  if (pending.length > 0) console.log('');
  for (const wb of pending) {
    const wbDir = join(WARBANDS_DIR, wb.slug);
    mkdirSync(wbDir, { recursive: true });
    const url = `${BASE_URL}/${wb.slug}-0.png?v=1.14`;

    process.stdout.write(`  ${wb.name} ... `);
    const ok = await downloadImage(url, join(wbDir, 'warscroll.png'));
    if (ok) {
      console.log('OK');
      downloaded++;
    } else {
      console.log('FAILED');
      failed++;
    }
  }

  if (pending.length === 0) {
    console.log('  All warscroll images already downloaded.');
  } else {
    console.log(`\n  Done. Downloaded: ${downloaded} | Failed: ${failed}`);
  }

  if (gaFailed + failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
