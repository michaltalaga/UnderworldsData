import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

interface WarbandMeta {
  slug: string;
  name: string;
  opLegal: boolean;
  grandAlliance: string;
}

const WARBANDS_DIR = join(import.meta.dirname, '..', 'warbands');
const GA_DIR = join(WARBANDS_DIR, '_ga');
const RIVALS_DIR = join(import.meta.dirname, '..', 'rivals');
const ALLIANCES = ['Chaos', 'Death', 'Destruction', 'Order'];

function main() {
  const index: WarbandMeta[] = JSON.parse(
    readFileSync(join(WARBANDS_DIR, 'index.json'), 'utf8'),
  );

  // GA warscroll status
  const missingGaImage: string[] = [];
  const missingGaExtract: string[] = [];
  const missingGaTranslate: string[] = [];

  for (const alliance of ALLIANCES) {
    for (const variant of [1, 2]) {
      const key = `${alliance.toLowerCase()}-${variant}`;
      if (!existsSync(join(GA_DIR, `${key}.png`))) missingGaImage.push(key);
      if (!existsSync(join(GA_DIR, `${key}.json`))) missingGaExtract.push(key);
      if (!existsSync(join(GA_DIR, `${key}.pl.json`))) missingGaTranslate.push(key);
    }
  }

  console.log(`\n  GA Warscroll Status`);
  console.log(`  ===================\n`);
  console.log(`  Total:           8`);
  console.log(`  Images:          ${8 - missingGaImage.length}/8`);
  console.log(`  Extracted (EN):  ${8 - missingGaExtract.length}/8`);
  console.log(`  Translated (PL): ${8 - missingGaTranslate.length}/8`);

  if (missingGaImage.length > 0) {
    console.log(`\n  Missing GA images (run: npm run download):`);
    missingGaImage.forEach((n) => console.log(`    - ${n}`));
  }
  if (missingGaExtract.length > 0) {
    console.log(`\n  Missing GA extraction (run: npm run extract):`);
    missingGaExtract.forEach((n) => console.log(`    - ${n}`));
  }
  if (missingGaTranslate.length > 0) {
    console.log(`\n  Missing GA translation (run: npm run translate):`);
    missingGaTranslate.forEach((n) => console.log(`    - ${n}`));
  }

  // OP warband status
  const opWarbands = index.filter((wb) => wb.opLegal);
  const missingImage: string[] = [];
  const missingExtract: string[] = [];
  const missingTranslate: string[] = [];

  for (const wb of opWarbands) {
    const wbDir = join(WARBANDS_DIR, wb.slug);
    const hasDir = existsSync(wbDir) && statSync(wbDir).isDirectory();
    const hasImage = hasDir && existsSync(join(wbDir, 'warscroll.png'));
    const hasEN = hasDir && existsSync(join(wbDir, 'warscroll.json'));
    const hasPL = hasDir && existsSync(join(wbDir, 'warscroll.pl.json'));

    if (!hasImage) missingImage.push(wb.name);
    if (!hasEN) missingExtract.push(wb.name);
    if (!hasPL) missingTranslate.push(wb.name);
  }

  const total = opWarbands.length;

  console.log(`\n  Warscroll Status Report`);
  console.log(`  ======================\n`);
  console.log(`  OP warbands:     ${total}`);
  console.log(`  Non-OP warbands: ${index.length - total} (use GA warscrolls)`);
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

  const allComplete = missingImage.length === 0 && missingExtract.length === 0 && missingTranslate.length === 0
    && missingGaImage.length === 0 && missingGaExtract.length === 0 && missingGaTranslate.length === 0;
  if (allComplete) {
    console.log(`\n  Everything is complete!`);
  }

  if (existsSync(join(RIVALS_DIR, 'index.json'))) {
    const rivalIndex: { slug: string; name: string }[] = JSON.parse(
      readFileSync(join(RIVALS_DIR, 'index.json'), 'utf8'),
    );
    const missingRivalDecks = rivalIndex.filter((deck) => {
      const deckDir = join(RIVALS_DIR, deck.slug);
      return !(existsSync(deckDir) && statSync(deckDir).isDirectory() && existsSync(join(deckDir, 'deck.json')));
    });
    const missingRivalTranslations = rivalIndex.filter((deck) => {
      const deckDir = join(RIVALS_DIR, deck.slug);
      return !(existsSync(deckDir) && statSync(deckDir).isDirectory() && existsSync(join(deckDir, 'deck.pl.json')));
    });

    console.log(`\n  Rival Deck Status Report`);
    console.log(`  =======================\n`);
    console.log(`  Total rival decks: ${rivalIndex.length}`);
    console.log(`  Synced decks:      ${rivalIndex.length - missingRivalDecks.length}/${rivalIndex.length}`);
    console.log(`  Translated (PL):   ${rivalIndex.length - missingRivalTranslations.length}/${rivalIndex.length}`);

    if (missingRivalDecks.length > 0) {
      console.log(`\n  Missing rival decks (run: npm run rivals:sync):`);
      missingRivalDecks.forEach((deck) => console.log(`    - ${deck.name}`));
    }

    if (missingRivalTranslations.length > 0) {
      console.log(`\n  Missing rival translations (run: npm run rivals:translate):`);
      missingRivalTranslations.forEach((deck) => console.log(`    - ${deck.name}`));
    }
  }

  console.log('');
}

main();
