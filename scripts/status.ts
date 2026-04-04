import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

interface WarbandMeta {
  slug: string;
  name: string;
  grandAlliance: string;
}

const WARBANDS_DIR = join(import.meta.dirname, '..', 'warbands');
const RIVALS_DIR = join(import.meta.dirname, '..', 'rivals');

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
