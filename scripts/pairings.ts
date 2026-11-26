import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative } from 'path';
import { AiClient, DEFAULT_MODEL, NoProviderLeftError, runJobs, takeAiOptions, type ProviderId } from './ai';
import { jobNote } from './ai/jobs';
import { completeJson } from './ai/json';
import { positiveInt, takeFlag, takeValue } from './lib/args';
import type { Characteristic, FighterSide, FightersFile } from './lib/fighters';
import {
  changeSummary,
  renderPairingsReport,
  type PairingRecord,
  type PairingSnapshot,
  type PairingsRunSummary,
} from './lib/pairings-report';
import {
  PAIRINGS_FILE,
  PAIRINGS_PL_FILE,
  ROOT,
  deckFile,
  gaWarscrollFiles,
  isFile,
  loadDeckIndex,
  loadPairableDecks,
  loadWarbands,
  playstyleFile,
  readJson,
  readJsonIfExists,
  readPlaystyle,
  warbandFile,
  writeJson,
  writePlaystyle,
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
 *   2. warband playstyle in warbands/<slug>/warscroll.json (OP-legal) or playstyle.json (vaulted)
 *   3. star ratings (+ notes for 3-star fits) in warband-rivals-pairings.json
 *   4. Polish versions of all three
 * Every warband is covered, vaulted ones included: they are judged on their fighters and
 * their Grand Alliance's two warscrolls. Generated text is calibrated against the existing
 * hand-written entries.
 *
 *   npm run pairings                                 fill the gaps above
 *   npm run pairings -- --rebuild <slug>...          write 2-4 again for these warbands into
 *                                                    extraction/pairings/<run>/, changing nothing
 *   npm run pairings -- --rebuild --all              the same for every warband
 *   npm run pairings -- --resume <run>               continue a rebuild run that stopped
 *   npm run pairings -- --report <run>               write a run's review page (report.html) again
 *   npm run pairings -- --apply <run> [slug...]      put a reviewed run into the data files
 */

interface Warscroll {
  name: string;
  inspire?: string;
  generalRules?: string | null;
  reactions?: unknown[];
  abilities?: unknown[];
  playstyle?: string;
}

const shortDeckName = (deck: { name: string }) => deck.name.replace(/ Rivals Deck$/, '');

let ok = 0;
let failed = 0;
/** How many AI requests run at once (--jobs). */
let jobs = 1;

/** Runs one phase's items, up to `jobs` at a time, and adds up the results. */
async function runPhase<T>(items: T[], label: (item: T) => string, run: (item: T) => Promise<void>): Promise<void> {
  const result = await runJobs(items, jobs, label, run);
  ok += result.ok;
  failed += result.failed;
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

/** A characteristic in words: the number, or the runemark printed in its place. */
const statText = (v: Characteristic) => (typeof v === 'number' ? String(v) : `[${v} runemark]`);

/** One side of a fighter card; the warband's own runemark (on every fighter) is left out. */
function describeSide(side: FighterSide, slug: string): string {
  const weapons = side.weapons
    .map((w) => {
      const abilities = w.abilities.map((a) => `${a.critical ? 'critical ' : ''}${a.name}`).join('/');
      return `${w.reach} range ${statText(w.range)}, ${statText(w.dice)} dice (${w.symbol}), ${statText(w.damage)} damage${abilities ? ` (${abilities})` : ''}`;
    })
    .join('; ');
  const runemarks = side.runemarks.filter((r) => r !== slug);
  return `Move ${statText(side.move)}, Save ${statText(side.save.dice)} ${side.save.symbol}, Health ${statText(side.health)}, Bounty ${statText(side.bounty)}, runemarks [${runemarks.join(', ')}], weapons: ${weapons}`;
}

function describeFighters(slug: string): string {
  const data = readJsonIfExists<FightersFile>(warbandFile(slug, 'fighters.json'));
  if (!data) return 'not available';
  return data.fighters
    .map((f) => {
      const uninspired = describeSide(f.uninspired, slug);
      const inspired = describeSide(f.inspired, slug);
      return [
        `${f.name}: ${uninspired}`,
        `  inspired: ${inspired === uninspired ? 'no change' : inspired}`,
        ...(f.cardRulesText ? [`  card rules: ${f.cardRulesText}`] : []),
      ].join('\n');
    })
    .join('\n');
}

/** How to read the fighter stats and warscroll rules in the prompts. */
const DATA_LEGEND = `How to read the data:
- Fighter stats: runemark ids such as grot or squig are the warband's keyword runemarks, which the warscroll rules write as {icon:<id>}; the warband's own runemark, on every fighter, is left out. A characteristic written as [<id> runemark] is printed on the card as that runemark instead of a number, and the warscroll rules say what it stands for.
- Warscroll rules (JSON): "inspire" says when a fighter is Inspired. "generalRules", when present, is a rule printed apart from the entries, for example a limit on how often the abilities can be used, or an Uninspire box. "leftColumn" holds the boxes printed under Inspire and "abilities" the entries of the right-hand panel; each entry's "type" (passive, reaction or action) and "trigger" say when it is used. {icon:<id>} stands for a runemark.`;

function warscrollRules(warscroll: Warscroll): string {
  const { inspire, generalRules, reactions, abilities } = warscroll;
  const entry = (e: unknown) => Object.fromEntries(Object.entries(e as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined));
  return JSON.stringify({ inspire, generalRules: generalRules || undefined, leftColumn: (reactions ?? []).map(entry), abilities: (abilities ?? []).map(entry) });
}

/**
 * The warscroll rules a warband plays with, for the prompts: its own warscroll, or for a
 * vaulted warband both of its Grand Alliance's warscrolls. Null when they are not extracted yet.
 */
function rulesFor(wb: WarbandMeta): string | null {
  if (wb.opLegal) {
    const warscroll = readJsonIfExists<Warscroll>(warbandFile(wb.slug, 'warscroll.json'));
    return warscroll ? warscrollRules(warscroll) : null;
  }
  const variants = gaWarscrollFiles(wb).map((path) => readJsonIfExists<Warscroll>(path));
  if (variants.some((v) => !v)) return null;
  return (
    `This is a vaulted (not OP-legal) warband with no warscroll of its own: it plays with one of the two generic ` +
    `${wb.grandAlliance} Grand Alliance warscrolls, chosen when the warband is picked, so judge it mainly on its fighters. ` +
    variants.map((v, i) => `Variant ${i + 1}: ${warscrollRules(v!)}`).join(' ')
  );
}

async function generatePlaystyle(ai: AiClient, wb: WarbandMeta, rules: string, examples: { wb: WarbandMeta; playstyle: string }[]) {
  const prompt = `You are writing a playstyle summary of a Warhammer Underworlds (Embergard) warband for a warband-to-Rivals-deck compatibility guide.

Existing summaries, for style and length:
${examples.map((e) => `- ${e.wb.name} (${e.wb.fighters} fighters, ${e.wb.grandAlliance}): ${e.playstyle}`).join('\n')}

Warband to summarise:
Name: ${wb.name}
Grand Alliance: ${wb.grandAlliance}
Fighters: ${wb.fighters}
Fighter stats (uninspired side, then inspired side):
${describeFighters(wb.slug)}
Warscroll rules: ${rules}

${DATA_LEGEND}

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
  playstyle: string,
  rules: string,
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
      const otherPlaystyle = (other && readPlaystyle(other, 'en')) ?? '';
      const own = pairings.ratings.filter((r) => r.warband === slug);
      const stars = own.map((r) => `${codeBySlug.get(r.deck) ?? r.deck}:${r.stars}`).join(' ');
      const notes = own.filter((r) => r.note).map((r) => `${codeBySlug.get(r.deck) ?? r.deck}: ${r.note}`).join(' | ');
      const vaulted = other && !other.opLegal ? ', vaulted' : '';
      return `${other?.name ?? slug} (${other?.fighters ?? '?'} fighters${vaulted}): ${otherPlaystyle}\n  ratings: ${stars}\n  3-star notes: ${notes || 'none'}`;
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
Playstyle: ${playstyle}
Fighter stats (uninspired side, then inspired side):
${describeFighters(wb.slug)}
Warscroll rules: ${rules}

${DATA_LEGEND}

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

/**
 * Several independent rating votes for the same warband, combined per deck: the median stars
 * (the lower of the two middle ones for an even number of votes), and the 3-star note of the
 * first vote that gave 3 stars. Every vote rates every deck (generateRatings checks that).
 */
function combineVotes(ballots: Rating[][], decks: RivalDeck[]): (Rating & { votes: number[] })[] {
  return decks.map((deck) => {
    const own = ballots.map((ballot) => ballot.find((r) => r.deck === deck.slug)!);
    const stars = own.map((r) => r.stars);
    const median = [...stars].sort((a, b) => a - b)[Math.floor((stars.length - 1) / 2)];
    const note = median === 3 ? own.find((r) => r.stars === 3)?.note : undefined;
    return { warband: own[0].warband, deck: deck.slug, stars: median, ...(note ? { note } : {}), votes: stars };
  });
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

// ---------- shared data ----------

interface Data {
  warbands: WarbandMeta[];
  warbandsBySlug: Map<string, WarbandMeta>;
  op: WarbandMeta[];
  allDecks: RivalDeckMeta[];
  pairings: PairingsFile;
  pairingsPl: PairingsPlFile;
}

function loadData(): Data {
  const warbands = loadWarbands();
  return {
    warbands,
    warbandsBySlug: new Map(warbands.map((wb) => [wb.slug, wb])),
    op: warbands.filter((wb) => wb.opLegal),
    allDecks: loadDeckIndex(),
    pairings: readJson<PairingsFile>(PAIRINGS_FILE),
    pairingsPl: readJson<PairingsPlFile>(PAIRINGS_PL_FILE),
  };
}

const loadDeck = (d: RivalDeckMeta) => readJsonIfExists<RivalDeck>(deckFile(d.slug, 'deck.json'));

/** The decks warbands are rated for: universal decks that have a strategy summary. */
function decksToRate(data: Data): RivalDeck[] {
  const pairable = new Set(loadPairableDecks().map((d) => d.slug));
  return data.allDecks.filter((d) => pairable.has(d.slug)).map(loadDeck).filter((d): d is RivalDeck => Boolean(d?.strategy));
}

/** meta.deckOrder with any new deck appended. */
const deckOrderFor = (data: Data, decks: RivalDeck[]) => [
  ...data.pairings.meta.deckOrder,
  ...decks.map((d) => d.slug).filter((slug) => !data.pairings.meta.deckOrder.includes(slug)),
];

/** Playstyles of OP-legal warbands with different fighter counts, for style and length (never the warband being written). */
function playstyleExamples(data: Data, exclude?: string): { wb: WarbandMeta; playstyle: string }[] {
  return data.op
    .filter((wb) => wb.slug !== exclude)
    .map((wb) => ({ wb, playstyle: readPlaystyle(wb, 'en') }))
    .filter((e): e is { wb: WarbandMeta; playstyle: string } => Boolean(e.playstyle))
    .filter((e, i, all) => all.findIndex((x) => x.wb.fighters === e.wb.fighters) === i)
    .slice(0, 4);
}

/** One playstyle, one note and one deck tagline with their Polish versions, for the translation prompt. */
function polishExamples(data: Data): { en: string; pl: string }[] {
  const { op, pairings, pairingsPl, allDecks } = data;
  const examples: { en: string; pl: string }[] = [];
  const wb = op.find((w) => readPlaystyle(w, 'en') && readPlaystyle(w, 'pl'));
  if (wb) examples.push({ en: readPlaystyle(wb, 'en')!, pl: readPlaystyle(wb, 'pl')! });
  const plNote = pairingsPl.ratings[0];
  const enNote = plNote && pairings.ratings.find((r) => r.warband === plNote.warband && r.deck === plNote.deck)?.note;
  if (enNote) examples.push({ en: enNote, pl: plNote.note });
  const deck = allDecks.map(loadDeck).find((d) => d?.strategyTagline && readJsonIfExists<RivalDeck>(deckFile(d.slug, 'deck.pl.json'))?.strategyTagline);
  if (deck) examples.push({ en: deck.strategyTagline!, pl: readJson<RivalDeck>(deckFile(deck.slug, 'deck.pl.json')).strategyTagline! });
  return examples;
}

/** Writes warband-rivals-pairings.json in its usual order, with the counts in meta.description brought up to date. */
function savePairings(data: Data, deckOrder: string[]): void {
  const { pairings, warbands, warbandsBySlug } = data;
  pairings.meta.deckOrder = deckOrder;
  pairings.ratings = sortRatings(pairings.ratings, warbands, deckOrder);
  const rated = [...new Set(pairings.ratings.map((r) => r.warband))].map((slug) => warbandsBySlug.get(slug));
  const ratedOp = rated.filter((wb) => wb?.opLegal !== false).length;
  const ratedVaulted = rated.length - ratedOp;
  pairings.meta.description = pairings.meta.description
    .replace(
      /all \d+ OP-legal warbands( and \d+ vaulted warbands)?/,
      `all ${ratedOp} OP-legal warbands${ratedVaulted ? ` and ${ratedVaulted} vaulted warbands` : ''}`,
    )
    .replace(/all \d+ universal Rivals decks/, `all ${deckOrder.length} universal Rivals decks`);
  writeJson(PAIRINGS_FILE, pairings);
}

/** Writes warband-rivals-pairings.pl.json in the order of the English ratings. */
function savePairingsPl(data: Data): void {
  const enOrder = new Map(data.pairings.ratings.map((r, i) => [`${r.warband}|${r.deck}`, i]));
  const at = (r: { warband: string; deck: string }) => enOrder.get(`${r.warband}|${r.deck}`) ?? Infinity;
  data.pairingsPl.ratings.sort((a, b) => at(a) - at(b));
  writeJson(PAIRINGS_PL_FILE, data.pairingsPl);
}

// ---------- fill (no flags) ----------

async function fill(data: Data, provider: ProviderId | undefined) {
  const { warbands, warbandsBySlug, allDecks, pairings, pairingsPl } = data;

  // Created on first use (nothing may need AI), once even when parallel jobs ask at the same time.
  let aiClient: Promise<AiClient> | null = null;
  const getAi = () => (aiClient ??= AiClient.create({ provider }));

  // 1. Deck strategies
  console.log('\n  Deck strategies (EN)');
  const strategyExamples = allDecks.map(loadDeck).filter((d): d is RivalDeck => Boolean(d?.strategyTagline && d.strategy)).slice(0, 3);
  const decksNeedingStrategy = allDecks.map(loadDeck).filter((d): d is RivalDeck => Boolean(d && !(d.strategyTagline && d.strategy)));
  if (decksNeedingStrategy.length === 0) console.log('  none missing');
  await runPhase(decksNeedingStrategy, shortDeckName, async (deck) => {
    const strategy = await generateDeckStrategy(await getAi(), deck, strategyExamples);
    writeJson(deckFile(deck.slug, 'deck.json'), { ...deck, ...strategy });
  });

  // 2. Warband playstyles (vaulted warbands also need their fighter stats: that is most of what they have)
  console.log('\n  Warband playstyles (EN)');
  const examples = playstyleExamples(data);
  // An OP-legal warband's playstyle goes into its warscroll.json, so that has to be extracted first.
  const needPlaystyle = warbands.filter((wb) => !readPlaystyle(wb, 'en') && (!wb.opLegal || isFile(playstyleFile(wb, 'en'))));
  if (needPlaystyle.length === 0) console.log('  none missing');
  const playstyleJobs: { wb: WarbandMeta; rules: string }[] = [];
  for (const wb of needPlaystyle) {
    const rules = rulesFor(wb);
    const missing = !rules ? 'Grand Alliance warscrolls not extracted (run npm run extract)'
      : !wb.opLegal && !isFile(warbandFile(wb.slug, 'fighters.json')) ? 'no fighter stats (run npm run extract:fighters)'
      : null;
    if (missing) {
      console.log(`  ${wb.name} ... SKIP (${missing})`);
      failed++;
    } else {
      playstyleJobs.push({ wb, rules: rules! });
    }
  }
  await runPhase(playstyleJobs, ({ wb }) => wb.name, async ({ wb, rules }) => {
    writePlaystyle(wb, 'en', await generatePlaystyle(await getAi(), wb, rules, examples));
  });

  // 3. Ratings
  console.log('\n  Ratings');
  const decks = decksToRate(data);
  const deckOrder = deckOrderFor(data, decks);
  let ratingsChanged = deckOrder.length !== pairings.meta.deckOrder.length;
  const ratingJobs: { wb: WarbandMeta; playstyle: string; rules: string; unrated: RivalDeck[]; needNote: RivalDeck[] }[] = [];
  let anyRatingWork = false;
  for (const wb of warbands) {
    const playstyle = readPlaystyle(wb, 'en');
    const rules = rulesFor(wb);
    const own = pairings.ratings.filter((r) => r.warband === wb.slug);
    const unrated = decks.filter((d) => !own.some((r) => r.deck === d.slug));
    const needNote = decks.filter((d) => own.some((r) => r.deck === d.slug && r.stars === 3 && !r.note));
    if (unrated.length === 0 && needNote.length === 0) continue;
    anyRatingWork = true;
    if (!playstyle || !rules) {
      console.log(`  ${wb.name} ... SKIP (no playstyle yet)`);
      failed++;
      continue;
    }
    ratingJobs.push({ wb, playstyle, rules, unrated, needNote });
  }
  if (!anyRatingWork) console.log('  none missing');
  try {
    // Parallel jobs calibrate against the ratings that existed when the phase started.
    await runPhase(
      ratingJobs,
      ({ wb, unrated, needNote }) => `${wb.name} (${unrated.length} decks to rate${needNote.length ? `, ${needNote.length} notes` : ''})`,
      async ({ wb, playstyle, rules, unrated, needNote }) => {
        const results = await generateRatings(await getAi(), wb, playstyle, rules, pairings, decks, unrated, needNote, warbandsBySlug);
        for (const result of results) {
          const existing = pairings.ratings.find((r) => r.warband === result.warband && r.deck === result.deck);
          if (existing) existing.note = result.note;
          else pairings.ratings.push(result);
        }
        ratingsChanged = true;
      },
    );
  } finally {
    // Saved even when the run stops on a provider failure, so finished ratings are kept.
    if (ratingsChanged) savePairings(data, deckOrder);
  }

  // 4. Polish
  console.log('\n  Polish translations');
  const plExamples = polishExamples(data);
  const deckJobs: { meta: RivalDeckMeta; en: RivalDeck; pl: Record<string, unknown> }[] = [];
  for (const meta of allDecks) {
    const en = loadDeck(meta);
    const pl = readJsonIfExists<Record<string, unknown>>(deckFile(meta.slug, 'deck.pl.json'));
    if (!en?.strategyTagline || !en.strategy || !pl || (pl.strategyTagline && pl.strategy)) continue;
    deckJobs.push({ meta, en, pl });
  }
  await runPhase(deckJobs, ({ meta }) => `${shortDeckName(meta)} strategy`, async ({ meta, en, pl }) => {
    const translated = await translateFields(await getAi(), { strategyTagline: en.strategyTagline!, strategy: en.strategy! }, plExamples);
    writeJson(deckFile(meta.slug, 'deck.pl.json'), { ...pl, ...translated });
  });

  const plNoteKeys = new Set(pairingsPl.ratings.map((r) => `${r.warband}|${r.deck}`));
  const warbandJobs: { wb: WarbandMeta; fields: Record<string, string> }[] = [];
  for (const wb of warbands) {
    const enPlaystyle = readPlaystyle(wb, 'en');
    // An OP-legal warband's Polish playstyle goes into warscroll.pl.json, which `translate` creates;
    // a vaulted warband's playstyle.pl.json is created here.
    const plFileReady = !wb.opLegal || isFile(playstyleFile(wb, 'pl'));
    const fields: Record<string, string> = {};
    if (enPlaystyle && plFileReady && !readPlaystyle(wb, 'pl')) fields.playstyle = enPlaystyle;
    for (const r of pairings.ratings.filter((r) => r.warband === wb.slug && r.note && !plNoteKeys.has(`${r.warband}|${r.deck}`))) {
      fields[`note:${r.deck}`] = r.note!;
    }
    if (Object.keys(fields).length > 0) warbandJobs.push({ wb, fields });
  }
  if (deckJobs.length + warbandJobs.length === 0) console.log('  none missing');
  // The whole Polish notes file is rewritten after each warband, so it is always complete on disk.
  await runPhase(warbandJobs, ({ wb, fields }) => `${wb.name} (${Object.keys(fields).join(', ')})`, async ({ wb, fields }) => {
    const translated = await translateFields(await getAi(), fields, plExamples);
    if (translated.playstyle) writePlaystyle(wb, 'pl', translated.playstyle);
    const notes = Object.entries(translated).filter(([key]) => key.startsWith('note:'));
    if (notes.length) {
      for (const [key, note] of notes) pairingsPl.ratings.push({ warband: wb.slug, deck: key.slice('note:'.length), note });
      savePairingsPl(data);
    }
  });

  console.log(`\n  Done. Success: ${ok} | Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

// ---------- rebuild (--rebuild, --resume) ----------

/** Rebuild runs: one folder per run, next to the extract:fighters runs (gitignored). */
const RUNS_DIR = join(ROOT, 'extraction', 'pairings');
const runPath = (run: string) => (existsSync(run) ? run : join(RUNS_DIR, run));
const recordPath = (runDir: string, slug: string) => join(runDir, slug, 'result.json');
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const byDeckOrder = <T extends { deck: string }>(items: T[], deckOrder: string[]) =>
  [...items].sort((a, b) => (deckOrder.indexOf(a.deck) + 1 || Infinity) - (deckOrder.indexOf(b.deck) + 1 || Infinity));

/** A warband's playstyle and ratings as they are in the data files now, with the Polish texts. */
function snapshot(data: Data, wb: WarbandMeta): PairingSnapshot {
  const plNotes = new Map(data.pairingsPl.ratings.filter((r) => r.warband === wb.slug).map((r) => [r.deck, r.note]));
  const ratings = data.pairings.ratings
    .filter((r) => r.warband === wb.slug)
    .map((r) => ({ deck: r.deck, stars: r.stars, note: r.note ?? null, notePl: plNotes.get(r.deck) ?? null }));
  return {
    playstyle: readPlaystyle(wb, 'en') ?? null,
    playstylePl: readPlaystyle(wb, 'pl') ?? null,
    ratings: byDeckOrder(ratings, data.pairings.meta.deckOrder),
  };
}

/** The finished and unfinished warbands of a run, in index order. */
function loadRecords(data: Data, runDir: string): PairingRecord[] {
  return data.warbands
    .map((wb) => readJsonIfExists<PairingRecord>(recordPath(runDir, wb.slug)))
    .filter((r): r is PairingRecord => r !== null);
}

function writeReport(data: Data, runDir: string): string {
  const summary = readJsonIfExists<PairingsRunSummary>(join(runDir, 'summary.json'));
  const path = join(runDir, 'report.html');
  writeText(path, renderPairingsReport(summary, loadRecords(data, runDir), data.allDecks));
  return path;
}

/**
 * Writes the playstyle, every deck rating with its 3-star notes, and their Polish versions again
 * for each selected warband, from its current fighters.json and warscroll, without showing the
 * model the current text. Results go to extraction/pairings/<run>/<slug>/result.json as each
 * warband finishes; the data files are not touched (see apply).
 */
async function rebuild(data: Data, provider: ProviderId | undefined, options: { named: WarbandMeta[]; all: boolean; resume?: string; votes: number }) {
  const decks = decksToRate(data);
  const noStrategy = loadPairableDecks().filter((d) => !decks.some((x) => x.slug === d.slug));
  if (noStrategy.length) throw new Error(`no strategy yet for ${noStrategy.map(shortDeckName).join(', ')}: run npm run pairings first`);
  const deckOrder = deckOrderFor(data, decks);

  const runId = options.resume ? basename(options.resume) : new Date().toISOString().replace(/[:T]/g, '-').replace(/\..*/, '');
  const runDir = join(RUNS_DIR, runId);
  if (options.resume && !existsSync(runDir)) throw new Error(`no run folder ${relative(ROOT, runDir)} to resume`);
  const previous = options.resume ? readJsonIfExists<PairingsRunSummary>(join(runDir, 'summary.json')) : null;
  const selected = previous ? data.warbands.filter((wb) => previous.selection.includes(wb.slug)) : options.all ? data.warbands : options.named;
  if (selected.length === 0) throw new Error('--rebuild needs warband slugs, or --all');
  const todo = selected.filter((wb) => !readJsonIfExists<PairingRecord>(recordPath(runDir, wb.slug))?.complete);
  // A resumed run votes like the run it continues.
  const votes = previous?.votes ?? options.votes;

  console.log(`\n  Playstyles and pairings: rebuild into a review folder`);
  console.log(`  ==========================================\n`);
  if (previous) console.log(`  Resuming ${runId}: ${selected.length - todo.length} of ${selected.length} warbands already done`);
  mkdirSync(runDir, { recursive: true });
  const started = Date.now();
  const ai = await AiClient.create({ provider });
  console.log(`  Model: ${DEFAULT_MODEL} | ${selected.length} warband(s), ${decks.length} decks each, ${votes} rating vote(s) | Output: ${relative(ROOT, runDir)}`);
  const plExamples = polishExamples(data);

  const notes: string[] = [];
  try {
    console.log('\n  Warbands: playstyle, ratings and notes, Polish');
    const result = await runJobs(todo, jobs, (wb) => wb.name, async (wb) => {
      const record: PairingRecord = { slug: wb.slug, name: wb.name, opLegal: wb.opLegal, fighters: wb.fighters, complete: false, old: snapshot(data, wb), new: null };
      try {
        const rules = rulesFor(wb);
        if (!rules) throw new Error('Grand Alliance warscrolls not extracted (run npm run extract)');
        if (!isFile(warbandFile(wb.slug, 'fighters.json'))) throw new Error('no fighter stats (run npm run extract:fighters)');
        jobNote('playstyle');
        const playstyle = await generatePlaystyle(ai, wb, rules, playstyleExamples(data, wb.slug));
        jobNote(`ratings, ${votes} vote(s)`);
        // Calibrated on the other warbands only, so the current ratings do not anchor the new ones.
        const others = { ...data.pairings, ratings: data.pairings.ratings.filter((r) => r.warband !== wb.slug) };
        const ballots = await Promise.all(
          Array.from({ length: votes }, () => generateRatings(ai, wb, playstyle, rules, others, decks, decks, [], data.warbandsBySlug)),
        );
        const ratings = combineVotes(ballots, decks);
        jobNote('Polish');
        const fields: Record<string, string> = { playstyle };
        for (const r of ratings) if (r.note) fields[`note:${r.deck}`] = r.note;
        const pl = await translateFields(ai, fields, plExamples);
        const entries = ratings.map((r) => ({ deck: r.deck, stars: r.stars, votes: r.votes, note: r.note ?? null, notePl: r.note ? pl[`note:${r.deck}`] : null }));
        record.new = { playstyle, playstylePl: pl.playstyle, ratings: byDeckOrder(entries, deckOrder) };
        record.complete = true;
      } catch (err) {
        // Out of AI providers (for example at a usage limit): stop the run; this warband is redone on --resume.
        if (err instanceof NoProviderLeftError) throw err;
        record.error = errorText(err);
      }
      writeText(recordPath(runDir, wb.slug), `${JSON.stringify(record, null, 2)}\n`);
      if (record.error) throw new Error(record.error);
      const c = changeSummary(record);
      return `${c.changed} of ${c.total} ratings change, 3-star fits ${c.oldTop} -> ${c.newTop}${votes > 1 ? `, votes split on ${c.split}` : ''}`;
    });
    if (result.failed) notes.push(`${result.failed} warband(s) failed; npm run pairings -- --resume ${runId} tries them again`);
  } catch (err) {
    notes.push(`The run stopped early: ${errorText(err)}. Continue it with: npm run pairings -- --resume ${runId}`);
  } finally {
    const usage = ai.usage();
    const summary: PairingsRunSummary = {
      runId,
      model: DEFAULT_MODEL,
      provider: ai.providerLabel,
      calls: (previous?.calls ?? 0) + ai.stats.calls,
      failedCalls: (previous?.failedCalls ?? 0) + ai.stats.failed,
      inputTokens: (previous?.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
      costUsd: (previous?.costUsd ?? 0) + usage.costUsd,
      seconds: (previous?.seconds ?? 0) + (Date.now() - started) / 1000,
      sessions: (previous?.sessions ?? 0) + 1,
      selection: selected.map((wb) => wb.slug),
      votes,
    };
    writeText(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    const report = writeReport(data, runDir);
    console.log(`\n  ${notes.length ? 'Stopped' : 'Done'} after ${Math.round(summary.seconds)}s in all: ${summary.calls} AI calls, about $${summary.costUsd.toFixed(2)}.`);
    console.log(`  Review page: ${relative(ROOT, report)}`);
    notes.forEach((n) => console.log(`  ${n}`));
    if (notes.length) process.exitCode = 1;
    else console.log(`  Nothing in the data files was changed. After review: npm run pairings -- --apply ${runId}`);
  }
}

// ---------- apply (--apply) ----------

/** Puts a reviewed run's playstyles, ratings and notes (both languages) into the data files. */
function apply(data: Data, runArg: string, slugs: string[]): void {
  const runDir = runPath(runArg);
  if (!existsSync(runDir)) throw new Error(`no run folder at ${runArg}`);
  const records = loadRecords(data, runDir);
  const unknown = slugs.filter((s) => !records.some((r) => r.slug === s));
  if (unknown.length) throw new Error(`not in this run: ${unknown.join(', ')}`);
  const chosen = records.filter((r) => !slugs.length || slugs.includes(r.slug));

  console.log(`\n  Applying ${relative(ROOT, runDir)}\n`);
  for (const record of chosen) {
    const wb = data.warbandsBySlug.get(record.slug)!;
    if (!record.complete || !record.new?.playstyle) {
      console.log(`  ${wb.name}: SKIP (not done in this run${record.error ? `: ${record.error}` : ''})`);
      process.exitCode = 1;
      continue;
    }
    const changedSince = JSON.stringify(snapshot(data, wb)) !== JSON.stringify(record.old);
    writePlaystyle(wb, 'en', record.new.playstyle);
    // An OP-legal warband's warscroll.pl.json is made by `translate`; it is not created here.
    const plWritten = Boolean(record.new.playstylePl && (!wb.opLegal || isFile(playstyleFile(wb, 'pl'))));
    if (plWritten) writePlaystyle(wb, 'pl', record.new.playstylePl!);
    data.pairings.ratings = [
      ...data.pairings.ratings.filter((r) => r.warband !== wb.slug),
      ...record.new.ratings.map((e): Rating => ({ warband: wb.slug, deck: e.deck, stars: e.stars, ...(e.note ? { note: e.note } : {}) })),
    ];
    data.pairingsPl.ratings = [
      ...data.pairingsPl.ratings.filter((r) => r.warband !== wb.slug),
      ...record.new.ratings.filter((e) => e.notePl).map((e) => ({ warband: wb.slug, deck: e.deck, note: e.notePl! })),
    ];
    const c = changeSummary(record);
    console.log(
      `  ${wb.name}: playstyle${plWritten ? ' (EN, PL)' : ' (EN)'}, ${c.total} ratings (${c.changed} changed)` +
        (changedSince ? ' - note: its entries had changed since the run, and are replaced' : ''),
    );
  }
  savePairings(data, deckOrderFor(data, decksToRate(data)));
  savePairingsPl(data);
  console.log('\n  Done.');
}

// ---------- main ----------

async function main() {
  const options = takeAiOptions(process.argv.slice(2));
  const { provider, args } = options;
  jobs = options.jobs;
  const data = loadData();

  const applyRun = takeValue(args, 'apply');
  if (applyRun) return apply(data, applyRun, args);
  const reportRun = takeValue(args, 'report');
  if (reportRun) {
    console.log(`  Review page: ${relative(ROOT, writeReport(data, runPath(reportRun)))}`);
    return;
  }
  const resume = takeValue(args, 'resume');
  const rebuildWanted = takeFlag(args, 'rebuild') || Boolean(resume);
  const all = takeFlag(args, 'all');
  const votes = positiveInt(takeValue(args, 'votes'), 'votes', 3);
  const wanted = args.map((a) => a.toLowerCase());
  const unknownNames = wanted.filter((w) => !data.warbands.some((wb) => wb.slug === w || wb.name.toLowerCase() === w));
  if (unknownNames.length) throw new Error(`unknown warband(s) or option(s): ${unknownNames.join(', ')}`);
  if (!rebuildWanted) {
    if (wanted.length || all) throw new Error('warband names and --all only work with --rebuild');
    return fill(data, provider);
  }
  const named = data.warbands.filter((wb) => wanted.includes(wb.slug) || wanted.includes(wb.name.toLowerCase()));
  return rebuild(data, provider, { named, all, resume, votes });
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
