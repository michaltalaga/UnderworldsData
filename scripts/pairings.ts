import { AiClient, NoProviderLeftError, takeProviderOption } from './ai';
import { completeJson } from './ai/json';
import {
  PAIRINGS_FILE,
  PAIRINGS_PL_FILE,
  deckFile,
  loadDeckIndex,
  loadPairableDecks,
  loadWarbands,
  readJson,
  readJsonIfExists,
  warbandFile,
  writeJson,
  type PairingsFile,
  type PairingsPlFile,
  type Rating,
  type RivalDeck,
  type RivalDeckMeta,
  type WarbandMeta,
} from './lib/data';

/**
 * Fills every gap in the pairings feature:
 *   1. deck strategy (strategyTagline + strategy) in rivals/<deck>/deck.json
 *   2. warband playstyle in warbands/<slug>/warscroll.json
 *   3. star ratings (+ notes for 3-star fits) in warband-rivals-pairings.json
 *   4. Polish versions of all three, where the Polish file already exists
 * Generated text is calibrated against the existing hand-written entries.
 */

interface Warscroll {
  name: string;
  inspire?: string;
  reactions?: unknown[];
  abilities?: unknown[];
  playstyle?: string;
}

interface FightersFile {
  fighters: {
    name: string;
    uninspired: {
      move: number;
      save: { symbol: string; dice: number };
      health: number;
      bounty: number;
      runemarks: string[];
      weapons: { reach: string; range: number; dice: number; damage: number; abilities: { name: string; critical: boolean }[] }[];
    };
  }[];
}

const shortDeckName = (deck: { name: string }) => deck.name.replace(/ Rivals Deck$/, '');

let ok = 0;
let failed = 0;

async function step(label: string, run: () => Promise<void>): Promise<void> {
  process.stdout.write(`  ${label} ... `);
  try {
    await run();
    console.log('OK');
    ok++;
  } catch (err) {
    if (err instanceof NoProviderLeftError) throw err;
    console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is missing from the reply`);
  return value.trim();
}

// ---------- 1. Deck strategy ----------

async function generateDeckStrategy(ai: AiClient, deck: RivalDeck, examples: RivalDeck[]) {
  const cards = deck.cards.map((c) => ({ name: c.name, type: c.type, text: c.text }));
  const prompt = `You are writing a short strategy summary of a Warhammer Underworlds (Embergard) Rivals deck for a warband-to-deck compatibility guide.

Existing summaries, for style and length:
${examples.map((e) => `- ${shortDeckName(e)}\n  strategyTagline: ${e.strategyTagline}\n  strategy: ${e.strategy}`).join('\n')}

Deck to summarise:
Name: ${shortDeckName(deck)}
Plot: ${deck.plot ?? 'none'}
Cards: ${JSON.stringify(cards)}

Return JSON: {"strategyTagline": "<3-7 word identity of the deck>", "strategy": "<3-4 sentences: what the objectives score Glory for, what the Plot does if there is one, and which kind of warband the deck rewards and punishes>"}
Return ONLY valid JSON, no markdown code fences or explanation.`;
  const reply = await completeJson<{ strategyTagline?: string; strategy?: string }>(ai, { prompt, maxTokens: 1500 });
  return { strategyTagline: requireText(reply.strategyTagline, 'strategyTagline'), strategy: requireText(reply.strategy, 'strategy') };
}

// ---------- 2. Warband playstyle ----------

function describeFighters(slug: string): string {
  const data = readJsonIfExists<FightersFile>(warbandFile(slug, 'fighters.json'));
  if (!data) return 'not available';
  return data.fighters
    .map((f) => {
      const s = f.uninspired;
      const weapons = s.weapons
        .map((w) => {
          const abilities = w.abilities.map((a) => `${a.critical ? 'critical ' : ''}${a.name}`).join('/');
          return `${w.reach} range ${w.range} ${w.dice} dice ${w.damage} dmg${abilities ? ` (${abilities})` : ''}`;
        })
        .join('; ');
      return `${f.name}: Move ${s.move}, Save ${s.save.dice} ${s.save.symbol}, Health ${s.health}, Bounty ${s.bounty}, runemarks [${s.runemarks.join(', ')}], weapons: ${weapons}`;
    })
    .join('\n');
}

function warscrollRules(warscroll: Warscroll): string {
  const { inspire, reactions, abilities } = warscroll;
  return JSON.stringify({ inspire, reactions, abilities });
}

async function generatePlaystyle(ai: AiClient, wb: WarbandMeta, warscroll: Warscroll, examples: { wb: WarbandMeta; playstyle: string }[]) {
  const prompt = `You are writing a playstyle summary of a Warhammer Underworlds (Embergard) warband for a warband-to-Rivals-deck compatibility guide.

Existing summaries, for style and length:
${examples.map((e) => `- ${e.wb.name} (${e.wb.fighters} fighters, ${e.wb.grandAlliance}): ${e.playstyle}`).join('\n')}

Warband to summarise:
Name: ${wb.name}
Grand Alliance: ${wb.grandAlliance}
Fighters: ${wb.fighters}
Fighter stats (uninspired side):
${describeFighters(wb.slug)}
Warscroll rules: ${warscrollRules(warscroll)}

Write 3-4 sentences (60-90 words) covering model count, durability and mobility, the signature mechanics, and how the warband wins games. Do not mention specific Rivals decks or ratings.
Return JSON: {"playstyle": "<text>"}
Return ONLY valid JSON, no markdown code fences or explanation.`;
  const reply = await completeJson<{ playstyle?: string }>(ai, { prompt, maxTokens: 1000 });
  return requireText(reply.playstyle, 'playstyle');
}

// ---------- 3. Ratings ----------

async function generateRatings(
  ai: AiClient,
  wb: WarbandMeta,
  warscroll: Warscroll,
  pairings: PairingsFile,
  decks: RivalDeck[],
  unrated: RivalDeck[],
  needNote: RivalDeck[],
  warbandsBySlug: Map<string, WarbandMeta>,
): Promise<Rating[]> {
  const scale = pairings.meta.ratingScale.map((s) => `${s.stars} - ${s.label}: ${s.description}`).join('\n');
  const deckLines = decks
    .map((d) => `- ${d.slug} (${d.code}) ${shortDeckName(d)}: ${d.strategyTagline}. ${d.strategy} Plot: ${d.plot ?? 'none'}`)
    .join('\n');
  const codeBySlug = new Map(decks.map((d) => [d.slug, d.code]));

  const calibration = [...new Set(pairings.ratings.map((r) => r.warband))]
    .map((slug) => {
      const other = warbandsBySlug.get(slug);
      const playstyle = readJsonIfExists<Warscroll>(warbandFile(slug, 'warscroll.json'))?.playstyle ?? '';
      const own = pairings.ratings.filter((r) => r.warband === slug);
      const stars = own.map((r) => `${codeBySlug.get(r.deck) ?? r.deck}:${r.stars}`).join(' ');
      const notes = own.filter((r) => r.note).map((r) => `${codeBySlug.get(r.deck) ?? r.deck}: ${r.note}`).join(' | ');
      return `${other?.name ?? slug} (${other?.fighters ?? '?'} fighters): ${playstyle}\n  ratings: ${stars}\n  3-star notes: ${notes || 'none'}`;
    })
    .join('\n');

  const prompt = `You are rating how well a Warhammer Underworlds (Embergard) warband fits universal Rivals decks, for a warband-to-deck compatibility guide.

Rating scale:
${scale}

Method: ${pairings.meta.method}

Rivals decks:
${deckLines}

Existing ratings for other warbands. Keep the new ratings consistent with them (most warbands have only a few 3-star fits):
${calibration}

Warband to rate:
Name: ${wb.name}
Grand Alliance: ${wb.grandAlliance}
Fighters: ${wb.fighters}
Playstyle: ${warscroll.playstyle}
Fighter stats (uninspired side):
${describeFighters(wb.slug)}
Warscroll rules: ${warscrollRules(warscroll)}

Rate the warband for these decks: ${unrated.map((d) => d.slug).join(', ') || 'none'}.
${needNote.length ? `The warband is already rated 3 stars for these decks; return them with "stars": 3 and a note: ${needNote.map((d) => d.slug).join(', ')}.\n` : ''}
Return JSON: {"ratings": [{"deck": "<deck slug>", "stars": <0-3>, "note": "<only when stars is 3>"}]} with one entry per listed deck.
Each note is one sentence of at most 25 words with no trailing period, saying why the warband's mechanics power that deck's win condition, in the style of the existing 3-star notes.
Return ONLY valid JSON, no markdown code fences or explanation.`;

  const reply = await completeJson<{ ratings?: { deck?: string; stars?: number; note?: string }[] }>(ai, { prompt, maxTokens: 3000 });
  if (!Array.isArray(reply.ratings)) throw new Error('ratings array is missing from the reply');

  const bySlug = new Map(reply.ratings.map((r) => [r.deck, r]));
  const results: Rating[] = [];
  for (const deck of unrated) {
    const r = bySlug.get(deck.slug);
    if (!r || !Number.isInteger(r.stars) || r.stars! < 0 || r.stars! > 3) throw new Error(`no valid rating for ${deck.slug}`);
    const rating: Rating = { warband: wb.slug, deck: deck.slug, stars: r.stars! };
    if (rating.stars === 3) rating.note = requireText(r.note, `note for ${deck.slug}`).replace(/\.$/, '');
    results.push(rating);
  }
  for (const deck of needNote) {
    const r = bySlug.get(deck.slug);
    results.push({ warband: wb.slug, deck: deck.slug, stars: 3, note: requireText(r?.note, `note for ${deck.slug}`).replace(/\.$/, '') });
  }
  return results;
}

/** Ratings ordered like the original file: warbands in index order, decks in deckOrder. */
function sortRatings(ratings: Rating[], warbands: WarbandMeta[], deckOrder: string[]): Rating[] {
  const wbIndex = new Map(warbands.map((wb, i) => [wb.slug, i]));
  const deckIndex = new Map(deckOrder.map((slug, i) => [slug, i]));
  const pos = (map: Map<string, number>, key: string) => map.get(key) ?? Number.MAX_SAFE_INTEGER;
  return [...ratings].sort(
    (a, b) => pos(wbIndex, a.warband) - pos(wbIndex, b.warband) || pos(deckIndex, a.deck) - pos(deckIndex, b.deck),
  );
}

// ---------- 4. Polish ----------

async function translateFields(
  ai: AiClient,
  fields: Record<string, string>,
  examples: { en: string; pl: string }[],
): Promise<Record<string, string>> {
  const prompt = `You are translating text for a Warhammer Underworlds guide from English to Polish.

Translate every string value of the JSON object below. Keep the keys unchanged and return an object with exactly the same keys.

Rules:
- Keep game keywords that Polish players commonly use in English in their English form (for example Flanked, Surrounded, Grievous, Inspire, Charge, Guard, warband, Rivals, Plot, Glory), and translate the descriptive text around them.
- Preserve {icon:name} tokens exactly as they are.
- Keep the same tone and length as the English text.

Existing translations, for style:
${examples.map((e) => `EN: ${e.en}\nPL: ${e.pl}`).join('\n\n')}

JSON to translate:
${JSON.stringify(fields, null, 2)}

Return ONLY valid JSON, no markdown code fences or explanation.`;
  const reply = await completeJson<Record<string, unknown>>(ai, { prompt, maxTokens: 4000 });
  return Object.fromEntries(Object.keys(fields).map((key) => [key, requireText(reply[key], key)]));
}

// ---------- main ----------

async function main() {
  const { provider } = takeProviderOption(process.argv.slice(2));

  const warbands = loadWarbands();
  const warbandsBySlug = new Map(warbands.map((wb) => [wb.slug, wb]));
  const op = warbands.filter((wb) => wb.opLegal);
  const allDecks = loadDeckIndex();
  const pairableSlugs = new Set(loadPairableDecks().map((d) => d.slug));
  const loadDeck = (d: RivalDeckMeta) => readJsonIfExists<RivalDeck>(deckFile(d.slug, 'deck.json'));
  const pairings = readJson<PairingsFile>(PAIRINGS_FILE);
  const pairingsPl = readJson<PairingsPlFile>(PAIRINGS_PL_FILE);

  let ai: AiClient | null = null;
  const getAi = async () => (ai ??= await AiClient.create({ provider }));

  // 1. Deck strategies
  console.log('\n  Deck strategies (EN)');
  const strategyExamples = allDecks.map(loadDeck).filter((d): d is RivalDeck => Boolean(d?.strategyTagline && d.strategy)).slice(0, 3);
  const decksNeedingStrategy = allDecks.map(loadDeck).filter((d): d is RivalDeck => Boolean(d && !(d.strategyTagline && d.strategy)));
  if (decksNeedingStrategy.length === 0) console.log('  none missing');
  for (const deck of decksNeedingStrategy) {
    await step(shortDeckName(deck), async () => {
      const strategy = await generateDeckStrategy(await getAi(), deck, strategyExamples);
      writeJson(deckFile(deck.slug, 'deck.json'), { ...deck, ...strategy });
    });
  }

  // 2. Warband playstyles
  console.log('\n  Warband playstyles (EN)');
  const playstyleExamples = op
    .map((wb) => ({ wb, playstyle: readJsonIfExists<Warscroll>(warbandFile(wb.slug, 'warscroll.json'))?.playstyle }))
    .filter((e): e is { wb: WarbandMeta; playstyle: string } => Boolean(e.playstyle))
    .filter((e, i, all) => all.findIndex((x) => x.wb.fighters === e.wb.fighters) === i)
    .slice(0, 4);
  const needPlaystyle = op.filter((wb) => {
    const ws = readJsonIfExists<Warscroll>(warbandFile(wb.slug, 'warscroll.json'));
    return ws && !ws.playstyle;
  });
  if (needPlaystyle.length === 0) console.log('  none missing');
  for (const wb of needPlaystyle) {
    await step(wb.name, async () => {
      const path = warbandFile(wb.slug, 'warscroll.json');
      const warscroll = readJson<Warscroll>(path);
      warscroll.playstyle = await generatePlaystyle(await getAi(), wb, warscroll, playstyleExamples);
      writeJson(path, warscroll);
    });
  }

  // 3. Ratings
  console.log('\n  Ratings');
  const decks = allDecks.filter((d) => pairableSlugs.has(d.slug)).map(loadDeck).filter((d): d is RivalDeck => Boolean(d?.strategy));
  const deckOrder = [...pairings.meta.deckOrder, ...decks.map((d) => d.slug).filter((slug) => !pairings.meta.deckOrder.includes(slug))];
  let ratingsChanged = deckOrder.length !== pairings.meta.deckOrder.length;
  let anyRatingWork = false;
  for (const wb of op) {
    const warscroll = readJsonIfExists<Warscroll>(warbandFile(wb.slug, 'warscroll.json'));
    const own = pairings.ratings.filter((r) => r.warband === wb.slug);
    const unrated = decks.filter((d) => !own.some((r) => r.deck === d.slug));
    const needNote = decks.filter((d) => own.some((r) => r.deck === d.slug && r.stars === 3 && !r.note));
    if (unrated.length === 0 && needNote.length === 0) continue;
    anyRatingWork = true;
    if (!warscroll?.playstyle) {
      console.log(`  ${wb.name} ... SKIP (no playstyle yet)`);
      failed++;
      continue;
    }
    await step(`${wb.name} (${unrated.length} decks to rate${needNote.length ? `, ${needNote.length} notes` : ''})`, async () => {
      const results = await generateRatings(await getAi(), wb, warscroll, pairings, decks, unrated, needNote, warbandsBySlug);
      for (const result of results) {
        const existing = pairings.ratings.find((r) => r.warband === result.warband && r.deck === result.deck);
        if (existing) existing.note = result.note;
        else pairings.ratings.push(result);
      }
      ratingsChanged = true;
    });
  }
  if (!anyRatingWork) console.log('  none missing');
  if (ratingsChanged) {
    pairings.meta.deckOrder = deckOrder;
    pairings.ratings = sortRatings(pairings.ratings, warbands, deckOrder);
    const ratedWarbands = new Set(pairings.ratings.map((r) => r.warband)).size;
    pairings.meta.description = pairings.meta.description
      .replace(/all \d+ OP-legal warbands/, `all ${ratedWarbands} OP-legal warbands`)
      .replace(/all \d+ universal Rivals decks/, `all ${deckOrder.length} universal Rivals decks`);
    writeJson(PAIRINGS_FILE, pairings);
  }

  // 4. Polish
  console.log('\n  Polish translations');
  const plExamples = (() => {
    const examples: { en: string; pl: string }[] = [];
    const wb = op.find((w) => readJsonIfExists<Warscroll>(warbandFile(w.slug, 'warscroll.pl.json'))?.playstyle);
    if (wb) {
      examples.push({
        en: readJson<Warscroll>(warbandFile(wb.slug, 'warscroll.json')).playstyle!,
        pl: readJson<Warscroll>(warbandFile(wb.slug, 'warscroll.pl.json')).playstyle!,
      });
    }
    const plNote = pairingsPl.ratings[0];
    const enNote = plNote && pairings.ratings.find((r) => r.warband === plNote.warband && r.deck === plNote.deck)?.note;
    if (enNote) examples.push({ en: enNote, pl: plNote.note });
    const deck = allDecks.map(loadDeck).find((d) => d?.strategyTagline && readJsonIfExists<RivalDeck>(deckFile(d.slug, 'deck.pl.json'))?.strategyTagline);
    if (deck) examples.push({ en: deck.strategyTagline!, pl: readJson<RivalDeck>(deckFile(deck.slug, 'deck.pl.json')).strategyTagline! });
    return examples;
  })();
  let anyPolishWork = false;

  for (const meta of allDecks) {
    const en = loadDeck(meta);
    const plPath = deckFile(meta.slug, 'deck.pl.json');
    const pl = readJsonIfExists<Record<string, unknown>>(plPath);
    if (!en?.strategyTagline || !en.strategy || !pl || (pl.strategyTagline && pl.strategy)) continue;
    anyPolishWork = true;
    await step(`${shortDeckName(meta)} strategy`, async () => {
      const translated = await translateFields(await getAi(), { strategyTagline: en.strategyTagline!, strategy: en.strategy! }, plExamples);
      writeJson(plPath, { ...pl, ...translated });
    });
  }

  const plNoteKeys = new Set(pairingsPl.ratings.map((r) => `${r.warband}|${r.deck}`));
  for (const wb of op) {
    const en = readJsonIfExists<Warscroll>(warbandFile(wb.slug, 'warscroll.json'));
    const plPath = warbandFile(wb.slug, 'warscroll.pl.json');
    const pl = readJsonIfExists<Warscroll>(plPath);
    const fields: Record<string, string> = {};
    if (en?.playstyle && pl && !pl.playstyle) fields.playstyle = en.playstyle;
    for (const r of pairings.ratings.filter((r) => r.warband === wb.slug && r.note && !plNoteKeys.has(`${r.warband}|${r.deck}`))) {
      fields[`note:${r.deck}`] = r.note!;
    }
    if (Object.keys(fields).length === 0) continue;
    anyPolishWork = true;
    await step(`${wb.name} (${Object.keys(fields).join(', ')})`, async () => {
      const translated = await translateFields(await getAi(), fields, plExamples);
      if (translated.playstyle && pl) writeJson(plPath, { ...pl, playstyle: translated.playstyle });
      const notes = Object.entries(translated).filter(([key]) => key.startsWith('note:'));
      if (notes.length) {
        for (const [key, note] of notes) pairingsPl.ratings.push({ warband: wb.slug, deck: key.slice('note:'.length), note });
        const enOrder = new Map(pairings.ratings.map((r, i) => [`${r.warband}|${r.deck}`, i]));
        pairingsPl.ratings.sort(
          (a, b) => (enOrder.get(`${a.warband}|${a.deck}`) ?? Infinity) - (enOrder.get(`${b.warband}|${b.deck}`) ?? Infinity),
        );
        writeJson(PAIRINGS_PL_FILE, pairingsPl);
      }
    });
  }
  if (!anyPolishWork) console.log('  none missing');

  console.log(`\n  Done. Success: ${ok} | Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
