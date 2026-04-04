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
const BASE_URL = 'https://www.underworldsdb.com/cards/fighters';

async function downloadImage(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`  HTTP ${res.status} for ${url}`);
      return false;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buffer);
    return true;
  } catch (err) {
    console.error(`  Error downloading ${url}:`, err);
    return false;
  }
}

async function main() {
  const index: WarbandMeta[] = JSON.parse(
    readFileSync(join(WARBANDS_DIR, 'index.json'), 'utf8')
  );

  const batchSize = parseInt(process.argv[2] || '10', 10);
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  const pending: WarbandMeta[] = [];
  for (const wb of index) {
    const wbDir = join(WARBANDS_DIR, wb.slug);
    mkdirSync(wbDir, { recursive: true });
    const dest = join(wbDir, 'warscroll.png');
    if (existsSync(dest)) {
      skipped++;
      continue;
    }
    pending.push(wb);
  }

  console.log(`Total: ${index.length} | Already downloaded: ${skipped} | To download: ${pending.length}`);

  if (pending.length === 0) {
    console.log('All warscroll images already downloaded.');
    return;
  }

  const batch = pending.slice(0, batchSize);
  console.log(`Processing batch of ${batch.length}...\n`);

  for (const wb of batch) {
    const dest = join(WARBANDS_DIR, wb.slug, 'warscroll.png');
    const url = wb.opLegal
      ? `${BASE_URL}/${wb.slug}-0.png?v=1.14`
      : `${BASE_URL}/${wb.grandAlliance}-01.png?v=1.14`;

    process.stdout.write(`  ${wb.name} ... `);
    const ok = await downloadImage(url, dest);
    if (ok) {
      console.log('OK');
      downloaded++;
    } else {
      console.log('FAILED');
      failed++;
    }
  }

  console.log(`\nDone. Downloaded: ${downloaded} | Failed: ${failed} | Remaining: ${pending.length - batch.length}`);
}

main();
