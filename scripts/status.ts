import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

interface WarbandMeta {
  slug: string;
  name: string;
  grandAlliance: string;
}

const WARBANDS_DIR = join(import.meta.dirname, '..', 'warbands');

function main() {
  const index: WarbandMeta[] = JSON.parse(
    readFileSync(join(WARBANDS_DIR, 'index.json'), 'utf8'),
  );

  const missingImage: string[] = [];
  const missingExtract: string[] = [];
  const missingTranslate: string[] = [];

  for (const wb of index) {
    const wbDir = join(WARBANDS_DIR, wb.slug);
    const hasDir = existsSync(wbDir) && statSync(wbDir).isDirectory();
    const hasImage = hasDir && existsSync(join(wbDir, 'warscroll.png'));
    const hasEN = hasDir && existsSync(join(wbDir, 'warscroll.json'));
    const hasPL = hasDir && existsSync(join(wbDir, 'warscroll.pl.json'));

    if (!hasImage) missingImage.push(wb.name);
    if (!hasEN) missingExtract.push(wb.name);
    if (!hasPL) missingTranslate.push(wb.name);
  }

  const total = index.length;

  console.log(`\n  Warscroll Status Report`);
  console.log(`  ======================\n`);
  console.log(`  Total warbands:  ${total}`);
  console.log(`  Images:          ${total - missingImage.length}/${total}`);
  console.log(`  Extracted (EN):  ${total - missingExtract.length}/${total}`);
  console.log(`  Translated (PL): ${total - missingTranslate.length}/${total}`);

  if (missingImage.length > 0) {
    console.log(`\n  Missing images (run: npm run download):`);
    missingImage.forEach((n) => console.log(`    - ${n}`));
  }

  if (missingExtract.length > 0) {
    console.log(`\n  Missing extraction (run: npm run extract):`);
    missingExtract.forEach((n) => console.log(`    - ${n}`));
  }

  if (missingTranslate.length > 0) {
    console.log(`\n  Missing translation (run: npm run translate):`);
    missingTranslate.forEach((n) => console.log(`    - ${n}`));
  }

  if (missingImage.length === 0 && missingExtract.length === 0 && missingTranslate.length === 0) {
    console.log(`\n  Everything is complete!`);
  }

  console.log('');
}

main();
