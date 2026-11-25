import { join } from 'path';
import {
  FACTION_ICONS,
  GA_DIR,
  GA_KEYS,
  PAIRINGS_FILE,
  PAIRINGS_PL_FILE,
  deckFile,
  fighterCardFiles,
  isFile,
  loadDeckIndex,
  loadPairableDecks,
  loadWarbands,
  readJsonIfExists,
  warbandFile,
  type PairingsFile,
  type PairingsPlFile,
  type RivalDeck,
} from './data';

/** npm scripts that fill a gap. */
export type FixScript =
  | 'download'
  | 'download:icons'
  | 'download:fighters'
  | 'rivals:sync'
  | 'extract'
  | 'extract:fighters'
  | 'translate'
  | 'rivals:translate'
  | 'pairings';

export interface Check {
  label: string;
  total: number;
  missing: string[];
  fix: FixScript;
}

export interface Section {
  title: string;
  notes: string[];
  checks: Check[];
}

function check(label: string, fix: FixScript, items: { name: string; done: boolean }[]): Check {
  return { label, fix, total: items.length, missing: items.filter((i) => !i.done).map((i) => i.name) };
}

/** Everything the data pipeline should have produced, and what is still missing. */
export function collectStatus(): Section[] {
  const warbands = loadWarbands();
  const op = warbands.filter((wb) => wb.opLegal);
  const decks = loadDeckIndex();
  const pairableDecks = loadPairableDecks();
  const pairings = readJsonIfExists<PairingsFile>(PAIRINGS_FILE);
  const pairingsPl = readJsonIfExists<PairingsPlFile>(PAIRINGS_PL_FILE);

  const ga: Section = {
    title: 'Grand Alliance Warscrolls',
    notes: [],
    checks: [
      check('Images', 'download', GA_KEYS.map((k) => ({ name: k, done: isFile(join(GA_DIR, `${k}.png`)) }))),
      check('Extracted (EN)', 'extract', GA_KEYS.map((k) => ({ name: k, done: isFile(join(GA_DIR, `${k}.json`)) }))),
      check('Translated (PL)', 'translate', GA_KEYS.map((k) => ({ name: k, done: isFile(join(GA_DIR, `${k}.pl.json`)) }))),
      check('Faction icons', 'download:icons', FACTION_ICONS.map((f) => ({ name: f, done: isFile(join(GA_DIR, `${f}-icon.png`)) }))),
    ],
  };

  const en = new Map(op.map((wb) => [wb.slug, readJsonIfExists<{ playstyle?: string }>(warbandFile(wb.slug, 'warscroll.json'))]));
  const pl = new Map(op.map((wb) => [wb.slug, readJsonIfExists<{ playstyle?: string }>(warbandFile(wb.slug, 'warscroll.pl.json'))]));
  const fighterCardCount = (slug: string) => {
    const wb = op.find((w) => w.slug === slug)!;
    return fighterCardFiles(wb).filter(isFile).length;
  };

  const warbandSection: Section = {
    title: 'Warbands',
    notes: [`OP-legal: ${op.length}`, `Vaulted:  ${warbands.length - op.length} (use Grand Alliance warscrolls)`],
    checks: [
      check('Warscroll images', 'download', op.map((wb) => ({ name: wb.name, done: isFile(warbandFile(wb.slug, 'warscroll.png')) }))),
      check('Icons (all warbands)', 'download:icons', warbands.map((wb) => ({ name: wb.name, done: isFile(warbandFile(wb.slug, 'icon.png')) }))),
      check(
        'Fighter cards',
        'download:fighters',
        op.map((wb) => ({
          name: `${wb.name} (${fighterCardCount(wb.slug)}/${wb.fighters * 2} cards)`,
          done: fighterCardCount(wb.slug) === wb.fighters * 2,
        })),
      ),
      check(
        'Fighter stats',
        'extract:fighters',
        op.map((wb) => {
          const data = readJsonIfExists<{ fighters?: unknown[] }>(warbandFile(wb.slug, 'fighters.json'));
          return { name: wb.name, done: data?.fighters?.length === wb.fighters };
        }),
      ),
      check('Extracted (EN)', 'extract', op.map((wb) => ({ name: wb.name, done: en.get(wb.slug) !== null }))),
      check('Translated (PL)', 'translate', op.map((wb) => ({ name: wb.name, done: pl.get(wb.slug) !== null }))),
      check('Playstyle (EN)', 'pairings', op.map((wb) => ({ name: wb.name, done: Boolean(en.get(wb.slug)?.playstyle) }))),
      check('Playstyle (PL)', 'pairings', op.map((wb) => ({ name: wb.name, done: Boolean(pl.get(wb.slug)?.playstyle) }))),
    ],
  };

  const deckEn = new Map(decks.map((d) => [d.slug, readJsonIfExists<RivalDeck>(deckFile(d.slug, 'deck.json'))]));
  const deckPl = new Map(
    decks.map((d) => [d.slug, readJsonIfExists<{ strategyTagline?: string; strategy?: string }>(deckFile(d.slug, 'deck.pl.json'))]),
  );
  const deckSection: Section = {
    title: 'Rival Decks',
    notes: [`Decks: ${decks.length}`],
    checks: [
      check('Synced (EN)', 'rivals:sync', decks.map((d) => ({ name: d.name, done: deckEn.get(d.slug) !== null }))),
      check(
        'Icons',
        'download:icons',
        decks.filter((d) => d.iconUrl).map((d) => ({ name: d.name, done: isFile(deckFile(d.slug, 'icon.png')) })),
      ),
      check('Translated (PL)', 'rivals:translate', decks.map((d) => ({ name: d.name, done: deckPl.get(d.slug) !== null }))),
      check(
        'Strategy (EN)',
        'pairings',
        decks.map((d) => ({ name: d.name, done: Boolean(deckEn.get(d.slug)?.strategyTagline && deckEn.get(d.slug)?.strategy) })),
      ),
      check(
        'Strategy (PL)',
        'pairings',
        decks.map((d) => ({ name: d.name, done: Boolean(deckPl.get(d.slug)?.strategyTagline && deckPl.get(d.slug)?.strategy) })),
      ),
    ],
  };

  const ratings = pairings?.ratings ?? [];
  const rated = new Set(ratings.map((r) => `${r.warband}|${r.deck}`));
  const plNotes = new Set((pairingsPl?.ratings ?? []).map((r) => `${r.warband}|${r.deck}`));
  const warbandName = new Map(warbands.map((wb) => [wb.slug, wb.name]));
  const deckName = new Map(decks.map((d) => [d.slug, d.name.replace(/ Rivals Deck$/, '')]));
  const pairLabel = (r: { warband: string; deck: string }) =>
    `${warbandName.get(r.warband) ?? r.warband} x ${deckName.get(r.deck) ?? r.deck}`;
  const threeStar = ratings.filter((r) => r.stars === 3);
  const enNotes = ratings.filter((r) => r.note);

  const pairingsSection: Section = {
    title: 'Pairings (warband x Rivals deck)',
    notes: [`Matrix: ${op.length} OP-legal warbands x ${pairableDecks.length} universal decks`],
    checks: [
      check(
        'Rated warbands',
        'pairings',
        op.map((wb) => {
          const unrated = pairableDecks.filter((d) => !rated.has(`${wb.slug}|${d.slug}`)).length;
          return { name: `${wb.name} (${unrated} of ${pairableDecks.length} decks unrated)`, done: unrated === 0 };
        }),
      ),
      check('3-star notes (EN)', 'pairings', threeStar.map((r) => ({ name: pairLabel(r), done: Boolean(r.note) }))),
      check('Notes (PL)', 'pairings', enNotes.map((r) => ({ name: pairLabel(r), done: plNotes.has(`${r.warband}|${r.deck}`) }))),
    ],
  };

  return [ga, warbandSection, deckSection, pairingsSection];
}

/** The npm scripts that would fill at least one gap. */
export function scriptsWithGaps(sections: Section[]): Set<FixScript> {
  return new Set(sections.flatMap((s) => s.checks).filter((c) => c.missing.length > 0).map((c) => c.fix));
}

export function printStatus(sections: Section[]): void {
  for (const section of sections) {
    console.log(`\n  ${section.title}`);
    console.log(`  ${'='.repeat(section.title.length)}\n`);
    section.notes.forEach((note) => console.log(`  ${note}`));
    const width = Math.max(...section.checks.map((c) => c.label.length)) + 1;
    for (const c of section.checks) {
      const mark = c.missing.length === 0 ? ' ' : '!';
      console.log(`${mark} ${`${c.label}:`.padEnd(width + 1)} ${c.total - c.missing.length}/${c.total}`);
    }
    for (const c of section.checks.filter((c) => c.missing.length > 0)) {
      console.log(`\n  ${c.label} - missing (run: npm run ${c.fix}):`);
      c.missing.forEach((name) => console.log(`    - ${name}`));
    }
  }

  const gaps = scriptsWithGaps(sections);
  if (gaps.size === 0) {
    console.log('\n  Everything is complete!\n');
  } else {
    console.log(`\n  Gaps found. Run \`npm run sync\` to fill them all, or: ${[...gaps].map((s) => `npm run ${s}`).join(', ')}\n`);
  }
}
