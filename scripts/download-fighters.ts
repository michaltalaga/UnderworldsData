import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';

interface WarbandMeta {
  slug: string;
  name: string;
  fighters: number;
  opLegal: boolean;
  grandAlliance: string;
}

interface DownloadEntry {
  url: string;
  file: string;
  status: 'ok' | 'missing' | 'suspect-small' | 'error';
  bytes?: number;
}

const WARBANDS_DIR = join(import.meta.dirname, '..', 'warbands');
const BASE_URL = 'https://www.underworldsdb.com/cards/fighters';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const MIN_BYTES = 50_000;
const CONCURRENCY = 4;

async function downloadFighterImage(url: string, dest: string): Promise<DownloadEntry> {
  const entry: DownloadEntry = { url, file: dest, status: 'error' };
  try {
    // Missing images answer with a redirect, not a 404 — never follow it.
    const res = await fetch(url, { redirect: 'manual' });
    if (res.status !== 200) {
      entry.status = 'missing';
      return entry;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.subarray(0, 4).equals(PNG_MAGIC)) {
      entry.status = 'missing';
      return entry;
    }
    entry.bytes = buffer.length;
    if (buffer.length < MIN_BYTES) {
      entry.status = 'suspect-small';
      writeFileSync(dest, buffer);
      return entry;
    }
    writeFileSync(dest, buffer);
    entry.status = 'ok';
    return entry;
  } catch (err) {
    console.error(`  Error downloading ${url}:`, err);
    return entry;
  }
}

async function downloadWarband(wb: WarbandMeta): Promise<DownloadEntry[]> {
  const fightersDir = join(WARBANDS_DIR, wb.slug, 'fighters');
  mkdirSync(fightersDir, { recursive: true });
  const entries: DownloadEntry[] = [];
  for (let n = 1; n <= wb.fighters; n++) {
    for (const suffix of ['', '-inspired']) {
      const file = join(fightersDir, `${n}${suffix}.png`);
      const url = `${BASE_URL}/${wb.slug}-${n}${suffix}.png?v=1.14`;
      if (existsSync(file) && statSync(file).size >= MIN_BYTES) {
        entries.push({ url, file, status: 'ok', bytes: statSync(file).size });
        continue;
      }
      entries.push(await downloadFighterImage(url, file));
    }
  }
  writeFileSync(join(fightersDir, 'download-report.json'), JSON.stringify(entries, null, 2));
  return entries;
}

async function main() {
  const index: WarbandMeta[] = JSON.parse(readFileSync(join(WARBANDS_DIR, 'index.json'), 'utf8'));
  const opWarbands = index.filter((wb) => wb.opLegal);
  console.log(`Downloading fighter cards for ${opWarbands.length} OP-legal warbands (concurrency ${CONCURRENCY})\n`);

  const summary: Record<string, { ok: number; missing: number; suspect: number; expected: number }> = {};
  const queue = [...opWarbands];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (let wb = queue.shift(); wb; wb = queue.shift()) {
      const entries = await downloadWarband(wb);
      const ok = entries.filter((e) => e.status === 'ok').length;
      const missing = entries.filter((e) => e.status === 'missing' || e.status === 'error').length;
      const suspect = entries.filter((e) => e.status === 'suspect-small').length;
      summary[wb.slug] = { ok, missing, suspect, expected: wb.fighters * 2 };
      console.log(`  ${wb.slug}: ${ok}/${wb.fighters * 2} ok${missing ? ` | ${missing} missing` : ''}${suspect ? ` | ${suspect} suspect` : ''}`);
    }
  });
  await Promise.all(workers);

  writeFileSync(join(WARBANDS_DIR, 'fighters-download-summary.json'), JSON.stringify(summary, null, 2));
  const totalOk = Object.values(summary).reduce((s, v) => s + v.ok, 0);
  const totalExpected = Object.values(summary).reduce((s, v) => s + v.expected, 0);
  const incomplete = Object.entries(summary).filter(([, v]) => v.ok < v.expected);
  console.log(`\nDone. ${totalOk}/${totalExpected} images ok. Incomplete warbands: ${incomplete.length ? incomplete.map(([slug]) => slug).join(', ') : 'none'}`);
}

main();
