import sharp from 'sharp';
import type { ContentPart } from '../ai';
import { askJson, isInt, png, slugify, text, type ReadContext } from './ai-read';
import { CARD_REGION_NAMES, cropCardRegion, type CardRegion } from './card-image';
import { WARBAND_ANSWER } from './catalog';
import { SIDES, type Characteristic, type Fighter, type FighterSide, type Side, type Weapon } from './fighters';
import { DEFAULT_VOTE_SETTINGS, RegionVote, canonText, voteRegion, type FieldOutcome, type FieldVote, type VoteSettings } from './votes';

/**
 * Reads one fighter card (both sides) by voting: every region of each side (name, stats,
 * runemarks, weapons) is read several times with varied input (an enlarged crop, the whole
 * card, or both) and varied wording, and each value is decided by votes/votes.ts. A separate
 * checker call then confirms the final values against the card, and a "no" sends that region
 * back for more reads.
 */

export interface SideImages {
  card: Buffer;
  /** The whole card enlarged to 900 px wide, which is what the model is shown. */
  cardLarge: Buffer;
  crops: Record<CardRegion, Buffer>;
}

export interface FighterCard {
  index: number;
  uninspired: SideImages;
  inspired: SideImages;
}

export interface References {
  warbandName: string;
  warbandSlug: string;
  fighterSheet: Buffer;
  weaponSheet: Buffer;
  saveLegend: Buffer;
  weaponLegend: Buffer;
  warscroll: Buffer | null;
  /** Every answer accepted for a fighter runemark (its id, slugified names) and the id it stands for. */
  fighterIds: Map<string, string>;
  weaponIds: Map<string, string>;
  /** The warband's own keyword runemarks, which can stand in place of a characteristic; null when the warscroll has none. */
  keywordSheet: Buffer | null;
}

export interface Flag {
  /** "warning": a value that was not unanimous but was accepted; "review": a person needs to look. */
  level: 'warning' | 'review';
  side: Side | 'card';
  region: CardRegion | 'rules';
  field: string;
  message: string;
}

export interface FighterReading {
  fighter: Fighter;
  names: Record<Side, string>;
  regions: { side: Side | 'card'; region: CardRegion | 'rules'; vote: RegionVote }[];
  flags: Flag[];
  checks: { statement: string; ok: boolean; cardShows: string | null; region: string }[];
}

export async function loadSide(card: Buffer): Promise<SideImages> {
  const crops = {} as Record<CardRegion, Buffer>;
  for (const region of CARD_REGION_NAMES) crops[region] = await cropCardRegion(card, region);
  // At 514 px the runemark circles are small; 900 px is about the largest the model takes in full.
  const cardLarge = await sharp(card).resize({ width: 900, kernel: 'lanczos3' }).png().toBuffer();
  return { card, cardLarge, crops };
}

// ---------- prompts ----------

const PART: Record<CardRegion, string> = {
  name: 'name banner at the top',
  stats: 'characteristics down the left edge',
  runemarks: 'runemark circles down the right edge',
  weapons: 'weapon bars at the bottom',
};

type InputKind = 'crop' | 'card' | 'both';
const VARIANTS: { input: InputKind; wording: number }[] = [
  { input: 'crop', wording: 0 },
  { input: 'crop', wording: 1 },
  { input: 'card', wording: 0 },
  { input: 'both', wording: 2 },
  { input: 'card', wording: 1 },
];

function cardImages(side: SideImages, region: CardRegion, input: InputKind): { parts: ContentPart[]; intro: string } {
  const where = PART[region];
  if (input === 'crop') {
    return { parts: [png(side.crops[region])], intro: `Image 1 is an enlarged crop of the ${where} of a Warhammer Underworlds fighter card.` };
  }
  if (input === 'card') {
    return { parts: [png(side.cardLarge)], intro: `Image 1 is a Warhammer Underworlds fighter card. Look at the ${where}.` };
  }
  return {
    parts: [png(side.crops[region]), png(side.cardLarge)],
    intro: `Image 1 is an enlarged crop of the ${where} of a Warhammer Underworlds fighter card, and image 2 is the whole card it was cut from.`,
  };
}

const JSON_ONLY = 'Return ONLY valid JSON, no markdown code fences or explanation.';

/** Small capitals show case only by letter height, so every wording says how to read them. */
const SMALL_CAPS =
  'The banner is printed in small capitals: a full-height capital letter is a capital, a smaller capital-shaped letter is lowercase. This also holds after a hyphen ("Fjul-Grimnir" has a full-height G, "Mean-eye" a small e).';

function namePrompt(intro: string, wording: number): string {
  const ask = [
    `What is the fighter's name in the banner at the top? ${SMALL_CAPS} Keep hyphens and apostrophes exactly as printed. Leave out any symbol printed before the name, and ignore the names in other languages printed below the banner.`,
    `Read the English name printed in the top banner, letter by letter, with exactly the printed punctuation. ${SMALL_CAPS} Do not include the small star-like Inspired symbol some cards print before the name, and do not use the Chinese, Japanese or other translated names.`,
    `Transcribe the fighter's name from the dark banner across the top, spelled exactly as printed, with any hyphens and apostrophes. ${SMALL_CAPS} Translations of the name in other languages and any emblem before the name are not part of it.`,
  ][wording];
  return `${intro}\n${ask}\nReturn JSON: {"name": "<name>"}\n${JSON_ONLY}`;
}

/** What to do when a runemark is printed where a number should be. */
function inPlaceOfNumber(sheetNo: number | null): string {
  return sheetNo
    ? `If a runemark is printed in place of a number, give that runemark's id from image ${sheetNo} as a string instead of the number.`
    : 'If a runemark is printed in place of a number, give a short name for it as a string instead of the number.';
}

function statsPrompt(intro: string, wording: number, legendNo: number, keywordSheetNo: number | null): string {
  const shape = `{"move": <whole number>, "save": {"symbol": "shield" | "dodge", "dice": <whole number>}, "health": <whole number>, "bounty": <whole number>}`;
  const ask = [
    `Down the left edge of the card are four characteristics, top to bottom:
1. Move: the number in the blue-grey hexagon.
2. Save: the green shield-shaped badge. It holds a symbol and a number. The number is the number of Save dice. The symbol is either "shield" or "dodge"; image ${legendNo} shows both symbols.
3. Health: the number in the red circle.
4. Bounty: the number in the bronze coin.
Read each one.`,
    `Give the four characteristics down the left side of the card, top to bottom: Move (hexagon), Save (green shield-shaped badge), Health (red circle) and Bounty (coin). For Save, give the number of dice and which symbol is on the badge, "shield" or "dodge": compare it with image ${legendNo}.`,
    `Look at each badge on the left edge on its own, from the top: the hexagon is Move, the green shield-shaped badge is Save (a symbol plus the number of Save dice), the red circle is Health and the coin is Bounty. Image ${legendNo} shows the two possible Save symbols, "shield" and "dodge"; say which one the badge shows.`,
  ][wording];
  return `${intro}\n${ask}\n${inPlaceOfNumber(keywordSheetNo)}\nReturn JSON: ${shape}\n${JSON_ONLY}`;
}

function runemarksPrompt(intro: string, wording: number, sheetNo: number, warscrollNo: number | null): string {
  const shape = `{"count": <number of circles>, "circles": [{"position": 1, "id": "<id from the sheet, or unknown>", "description": "<what the symbol looks like>"}]}`;
  const refs =
    `Image ${sheetNo} is a reference sheet of the runemarks this warband's fighters can have, each labelled with its id in bold.` +
    (warscrollNo ? ` Image ${warscrollNo} is the warband's warscroll, which prints its own keywords with their icons, like "Grot (icon)".` : '');
  const ask = [
    `The round badges in a column along the right edge of the card are the fighter's runemarks: pale symbols on dark circles (the warband's own runemark can be coloured).
Step 1: count the badges in that column. Count only the round runemark badges along the right edge: not shapes in the fighter's artwork, not the name banner, and not the small round emblem in the bottom-right corner of the card.
Step 2: for each badge, top to bottom, find the runemark on the reference sheet with the same shape and give its id. Colours and shading differ between the sheet and the card, so compare shapes. If no runemark on the sheet has the same shape, give "unknown". Describe each symbol in a few words too.`,
    `List the round runemark badges in the column on the right edge of the card, from top to bottom (ignore the fighter's artwork and the small emblem in the bottom-right corner). For each badge, first describe the symbol in a few words, then give the id of the runemark on the reference sheet whose shape is the same, or "unknown" if none is. Finally give how many badges there are.`,
    `How many round runemark badges are in the right-hand column of the card? Count them carefully (artwork and the bottom-right emblem do not count). Then identify each one, top to bottom: describe its symbol, and match the shape against the reference sheet (ignore colour). Use the sheet id, or "unknown" if nothing on the sheet has that shape.`,
  ][wording];
  return `${intro}\n${refs}\n${ask}\nReturn JSON: ${shape}\n${JSON_ONLY}`;
}

function weaponsPrompt(intro: string, wording: number, legendNo: number, sheetNo: number, keywordSheetNo: number | null): string {
  const shape = `{"weapons": [{"reach": "melee" | "ranged", "range": <whole number>, "symbol": "hammer" | "swords", "dice": <whole number>, "damage": <whole number>, "runemarks": [{"id": "<id or unknown>", "critical": <true or false>, "description": "<what it looks like>"}]}]}`;
  const refs = `Image ${legendNo} shows the weapon bar icons, and image ${sheetNo} the weapon runemarks this warband's weapons can have, each labelled with its id in bold.`;
  const parts = `- "reach": the icon just left of the bar, "melee" or "ranged" (see image ${legendNo})
- "range": the number after the hexagon symbol
- "symbol": the attack dice symbol on the small white square, "hammer" or "swords" (see image ${legendNo})
- "dice": the number right after that symbol (Attack dice)
- "damage": the number after the star-burst symbol
- "runemarks": the small icons in hexagons just right of the bar, left to right (often there are none). Give each one's id from image ${sheetNo}, or "unknown" with a description. The Critical marker (a spiky star with "!") is not a runemark on its own: it makes the icon right after it critical, so give that icon "critical": true and leave the marker out of the list.`;
  const ask = [
    `Each weapon is a dark bar near the bottom of the card; a fighter has one, two or three. For each bar, top to bottom, read:\n${parts}\nIgnore the round emblem in the bottom-right corner of the card.`,
    `Read the weapon profile bars at the bottom of the card, top to bottom (the round emblem in the bottom-right corner is not part of them). In each bar:\n${parts}`,
    `How many weapon bars are at the bottom of the card? Read each of them separately, one value at a time:\n${parts}\nThe round emblem in the bottom-right corner of the card is not a weapon runemark.`,
  ][wording];
  return `${intro}\n${refs}\n${ask}\n${inPlaceOfNumber(keywordSheetNo)}\nReturn JSON: ${shape}\n${JSON_ONLY}`;
}

// ---------- reading one region ----------

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function nameFields(reply: { name?: unknown }): FieldVote[] {
  const name = str(reply.name).replace(/\s+/g, ' ');
  if (!name) throw new Error('name is missing');
  return [{ key: 'name', canon: canonText(name), value: name }];
}

/** A characteristic from a reply: a whole number, or the catalog id of the runemark printed in its place ("unknown" if no id matches). */
function characteristic(value: unknown, ids: Map<string, string>, field: string): Characteristic {
  if (isInt(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  if (typeof value === 'string' && value.trim()) return resolveId(value.trim(), ids) ?? 'unknown';
  throw new Error(`${field} is not a whole number or a runemark`);
}

function statsFields(reply: { move?: unknown; save?: { symbol?: unknown; dice?: unknown }; health?: unknown; bounty?: unknown }, ids: Map<string, string>): FieldVote[] {
  const move = characteristic(reply.move, ids, 'move');
  const health = characteristic(reply.health, ids, 'health');
  const bounty = characteristic(reply.bounty, ids, 'bounty');
  const dice = characteristic(reply.save?.dice, ids, 'save dice');
  const symbol = reply.save?.symbol;
  if (symbol !== 'shield' && symbol !== 'dodge') throw new Error('save symbol is not shield or dodge');
  return [
    { key: 'move', canon: String(move), value: move },
    { key: 'save.symbol', canon: symbol, value: symbol },
    { key: 'save.dice', canon: String(dice), value: dice },
    { key: 'health', canon: String(health), value: health },
    { key: 'bounty', canon: String(bounty), value: bounty },
  ];
}

export interface ReadRunemark {
  id: string;
  description: string;
}

/** The catalog id for an answer, allowing for case, punctuation and the names the sheet shows. */
function resolveId(answer: string, ids: Map<string, string>): string | null {
  return ids.get(answer) ?? ids.get(slugify(answer)) ?? null;
}

function runemarkFields(reply: { count?: unknown; circles?: unknown }, ids: Map<string, string>): FieldVote[] {
  if (!isInt(reply.count) || !Array.isArray(reply.circles)) throw new Error('count or circles is missing');
  if (reply.circles.length !== reply.count) throw new Error(`counted ${reply.count} circles but listed ${reply.circles.length}`);
  const marks: ReadRunemark[] = reply.circles.map((c: { id?: unknown; description?: unknown }) => {
    const answer = str(c?.id);
    const description = str(c?.description);
    const id = resolveId(answer, ids);
    return id ? { id, description } : { id: 'unknown', description: answer && answer.toLowerCase() !== 'unknown' ? `${description} (answered "${answer}")` : description };
  });
  return [{ key: 'runemarks', canon: marks.map((m) => m.id).sort().join(','), value: marks }];
}

interface ReadAbility {
  id: string;
  critical: boolean;
  description: string;
}

function weaponFields(reply: { weapons?: unknown }, ids: Map<string, string>, numberIds: Map<string, string>): FieldVote[] {
  if (!Array.isArray(reply.weapons) || reply.weapons.length === 0) throw new Error('weapons is empty');
  const count = String(reply.weapons.length);
  const fields: FieldVote[] = [{ key: 'weapons.count', canon: count, value: reply.weapons.length }];
  reply.weapons.forEach((w: Record<string, unknown>, i: number) => {
    const at = `weapons[${i}]`;
    const when = { key: 'weapons.count', canon: count };
    if (w.reach !== 'melee' && w.reach !== 'ranged') throw new Error(`${at}.reach is invalid`);
    if (w.symbol !== 'hammer' && w.symbol !== 'swords') throw new Error(`${at}.symbol is invalid`);
    const range = characteristic(w.range, numberIds, `${at}.range`);
    const dice = characteristic(w.dice, numberIds, `${at}.dice`);
    const damage = characteristic(w.damage, numberIds, `${at}.damage`);
    if (!Array.isArray(w.runemarks)) throw new Error(`${at}.runemarks is missing`);
    const abilities: ReadAbility[] = [];
    let critNext = false;
    for (const r of w.runemarks as Record<string, unknown>[]) {
      const answer = str(r?.id);
      const id = resolveId(answer, ids);
      if (id === 'crit' || slugify(answer) === 'critical') {
        critNext = true;
        continue;
      }
      const description = str(r?.description);
      abilities.push({
        id: id ?? 'unknown',
        critical: r?.critical === true || critNext,
        description: id || !answer || answer.toLowerCase() === 'unknown' ? description : `${description} (answered "${answer}")`,
      });
      critNext = false;
    }
    const abilityCanon = abilities.map((a) => `${a.critical ? 'critical ' : ''}${a.id}`).join(',') || 'none';
    fields.push(
      { key: `${at}.reach`, canon: w.reach, value: w.reach, when },
      { key: `${at}.range`, canon: String(range), value: range, when },
      { key: `${at}.symbol`, canon: w.symbol, value: w.symbol, when },
      { key: `${at}.dice`, canon: String(dice), value: dice, when },
      { key: `${at}.damage`, canon: String(damage), value: damage, when },
      { key: `${at}.abilities`, canon: abilityCanon, value: abilities, when },
    );
  });
  return fields;
}

/** Runemark ids a characteristic can be (fighter and weapon runemarks together). */
const numberIds = (refs: References) => new Map([...refs.weaponIds, ...refs.fighterIds]);

function readRegion(ctx: ReadContext, side: SideImages, region: CardRegion, refs: References) {
  return async (n: number): Promise<{ variant: string; fields: FieldVote[] }> => {
    const v = VARIANTS[n % VARIANTS.length];
    const { parts, intro } = cardImages(side, region, v.input);
    const variant = `${v.input}/${'abc'[v.wording]}`;
    const next = parts.length + 1;
    switch (region) {
      case 'name': {
        const reply = await askJson<{ name?: unknown }>(ctx, [...parts, text(namePrompt(intro, v.wording))]);
        return { variant, fields: nameFields(reply) };
      }
      case 'stats': {
        const keyword = refs.keywordSheet ? [png(refs.keywordSheet)] : [];
        const prompt = statsPrompt(intro, v.wording, next, refs.keywordSheet ? next + 1 : null);
        const reply = await askJson<Parameters<typeof statsFields>[0]>(ctx, [...parts, png(refs.saveLegend), ...keyword, text(prompt)]);
        return { variant, fields: statsFields(reply, numberIds(refs)) };
      }
      case 'runemarks': {
        const extra = [png(refs.fighterSheet), ...(refs.warscroll ? [png(refs.warscroll)] : [])];
        const prompt = runemarksPrompt(intro, v.wording, next, refs.warscroll ? next + 1 : null);
        const reply = await askJson<{ count?: unknown; circles?: unknown }>(ctx, [...parts, ...extra, text(prompt)]);
        return { variant, fields: runemarkFields(reply, refs.fighterIds) };
      }
      case 'weapons': {
        const keyword = refs.keywordSheet ? [png(refs.keywordSheet)] : [];
        const prompt = weaponsPrompt(intro, v.wording, next, next + 1, refs.keywordSheet ? next + 2 : null);
        const reply = await askJson<{ weapons?: unknown }>(ctx, [...parts, png(refs.weaponLegend), png(refs.weaponSheet), ...keyword, text(prompt)]);
        return { variant, fields: weaponFields(reply, refs.weaponIds, numberIds(refs)) };
      }
    }
  };
}

const RULES_PROMPTS = [
  `Images 1 and 2 are the two sides of one Warhammer Underworlds fighter card. Apart from the fighter's name (and the same name in other languages), the characteristics on the left, the runemark circles on the right and the weapon bars at the bottom, does either side print any rules text, that is a sentence of game rules? Most cards do not. If there is none, return {"rulesText": null}. If there is, return it exactly as printed, writing inline icons as {icon:<id>} with ids from image 3: {"rulesText": "<text>"}.`,
  `Images 1 and 2 show both sides of a fighter card from Warhammer Underworlds. Is there a printed rules sentence anywhere on them, other than names, translated names, characteristics, runemarks and weapon profiles? Answer {"rulesText": null} when there is no rules text (the usual case), or {"rulesText": "<the text exactly as printed>"} with inline icons written as {icon:<id>} using the ids in image 3.`,
];

function readRules(ctx: ReadContext, card: FighterCard, refs: References) {
  return async (n: number): Promise<{ variant: string; fields: FieldVote[] }> => {
    const wording = n % RULES_PROMPTS.length;
    const reply = await askJson<{ rulesText?: unknown }>(ctx, [
      png(card.uninspired.cardLarge),
      png(card.inspired.cardLarge),
      png(refs.fighterSheet),
      text(`${RULES_PROMPTS[wording]}\n${JSON_ONLY}`),
    ]);
    const rules = typeof reply.rulesText === 'string' && reply.rulesText.trim() ? reply.rulesText.trim() : null;
    return { variant: `cards/${'ab'[wording]}`, fields: [{ key: 'rulesText', canon: canonText(rules), value: rules }] };
  };
}

// ---------- assembling the result ----------

type RegionKey = `${Side}/${CardRegion}` | 'card/rules';

function value<T>(vote: RegionVote, key: string): T {
  return vote.outcome(key).value as T;
}

function assembleSide(votes: Map<RegionKey, RegionVote>, side: Side): { name: string; side: FighterSide } {
  const name = votes.get(`${side}/name`)!;
  const stats = votes.get(`${side}/stats`)!;
  const runemarks = votes.get(`${side}/runemarks`)!;
  const weapons = votes.get(`${side}/weapons`)!;
  const count = Number(weapons.outcome('weapons.count').canon) || 0;
  const list: Weapon[] = Array.from({ length: count }, (_, i) => ({
    name: null,
    reach: value(weapons, `weapons[${i}].reach`),
    range: value(weapons, `weapons[${i}].range`),
    symbol: value(weapons, `weapons[${i}].symbol`),
    dice: value(weapons, `weapons[${i}].dice`),
    damage: value(weapons, `weapons[${i}].damage`),
    abilities: (value<ReadAbility[]>(weapons, `weapons[${i}].abilities`) ?? []).map((a) => ({ name: a.id, critical: a.critical })),
  }));
  return {
    name: value(name, 'name'),
    side: {
      move: value(stats, 'move'),
      save: { symbol: value(stats, 'save.symbol'), dice: value(stats, 'save.dice') },
      health: value(stats, 'health'),
      bounty: value(stats, 'bounty'),
      runemarks: (value<ReadRunemark[]>(runemarks, 'runemarks') ?? []).map((r) => r.id),
      weapons: list,
    },
  };
}

interface Assembled {
  fighter: Fighter;
  /** The name as read on each side (the fighter keeps the uninspired one). */
  names: Record<Side, string>;
}

function assemble(index: number, votes: Map<RegionKey, RegionVote>): Assembled {
  const u = assembleSide(votes, 'uninspired');
  const i = assembleSide(votes, 'inspired');
  return {
    fighter: { index, name: u.name, uninspired: u.side, inspired: i.side, cardRulesText: value(votes.get('card/rules')!, 'rulesText') },
    names: { uninspired: u.name, inspired: i.name },
  };
}

// ---------- checker ----------

interface Statement {
  text: string;
  region: RegionKey;
  /** The values this statement states, to see whether a re-read changed them. */
  canon: string;
}

const SYMBOL_NAME = { shield: 'Shield', dodge: 'Dodge', hammer: 'Hammer', swords: 'Swords' } as const;

function statements({ fighter: f, names }: Assembled, warbandSlug: string): Statement[] {
  const out: Statement[] = [];
  for (const side of SIDES) {
    const s = f[side];
    const name = names[side];
    const label = side === 'uninspired' ? 'Uninspired side (silver frame)' : 'Inspired side (gold frame)';
    out.push({ text: `${label}: the name in the banner is "${name}".`, region: `${side}/name`, canon: canonText(name) });
    out.push({
      text: `${label}: Move ${s.move}, Save ${s.save.dice} dice with the ${SYMBOL_NAME[s.save.symbol]} symbol, Health ${s.health}, Bounty ${s.bounty}.`,
      region: `${side}/stats`,
      canon: JSON.stringify([s.move, s.save, s.health, s.bounty]),
    });
    out.push({
      text: `${label}: ${s.runemarks.length} runemark circle(s) on the right edge, top to bottom: ${s.runemarks.map((r) => (r === warbandSlug ? WARBAND_ANSWER : r)).join(', ') || 'none'} (ids from the fighter runemark sheet).`,
      region: `${side}/runemarks`,
      canon: s.runemarks.slice().sort().join(','),
    });
    s.weapons.forEach((w, i) => {
      const abilities = w.abilities.map((a) => `${a.critical ? 'critical ' : ''}${a.name}`).join(', ') || 'none';
      out.push({
        text: `${label}: weapon bar ${i + 1} of ${s.weapons.length}: ${w.reach === 'melee' ? 'Melee' : 'Ranged'}, Range ${w.range}, ${SYMBOL_NAME[w.symbol]} symbol with ${w.dice} Attack dice, Damage ${w.damage}, weapon runemarks: ${abilities}.`,
        region: `${side}/weapons`,
        canon: JSON.stringify(s.weapons),
      });
    });
  }
  out.push({
    text: f.cardRulesText ? `The card prints this rules text: "${f.cardRulesText}".` : 'Neither side prints any rules text (only names, characteristics, runemarks and weapons).',
    region: 'card/rules',
    canon: canonText(f.cardRulesText),
  });
  return out;
}

const CHECK_PROMPT = (list: string) => `Images 1 and 2 are the uninspired and inspired sides of one Warhammer Underworlds fighter card. Images 3 to 8 are enlarged crops of each side (characteristics, runemark circles and weapon bars; first the uninspired side, then the inspired side). Image 9 is the sheet of fighter runemarks and image 10 the sheet of weapon runemarks, each labelled with the id used below.

Check each statement against the card. Answer "ok": true only if the card shows exactly what the statement says; if any number, symbol, runemark or count in it is wrong, answer false and say what the card shows instead. Judge each statement on its own.

${list}

Return JSON: {"checks": [{"n": 1, "ok": true, "cardShows": null}]}
${JSON_ONLY}`;

async function check(ctx: ReadContext, card: FighterCard, refs: References, list: Statement[]) {
  const crops = SIDES.flatMap((side) => (['stats', 'runemarks', 'weapons'] as const).map((r) => png(card[side].crops[r])));
  const reply = await askJson<{ checks?: { n?: unknown; ok?: unknown; cardShows?: unknown }[] }>(ctx, [
    png(card.uninspired.cardLarge),
    png(card.inspired.cardLarge),
    ...crops,
    png(refs.fighterSheet),
    png(refs.weaponSheet),
    text(CHECK_PROMPT(list.map((s, i) => `${i + 1}. ${s.text}`).join('\n'))),
  ]);
  if (!Array.isArray(reply.checks)) throw new Error('checks is missing');
  return list.map((s, i) => {
    const c = reply.checks!.find((x) => x?.n === i + 1);
    return { statement: s.text, region: s.region, ok: c?.ok !== false, cardShows: typeof c?.cardShows === 'string' ? c.cardShows : null, answered: Boolean(c) };
  });
}

// ---------- flags ----------

function describe(o: FieldOutcome): string {
  const shown = (t: FieldOutcome['tallies'][number]) => {
    if (Array.isArray(t.value)) {
      // Say what an "unknown" runemark looked like to the model (from the first read that gave it).
      const unknowns = (t.value as { id?: string; description?: string }[]).filter((m) => m.id === 'unknown').map((m) => m.description || '?');
      return `${t.canon || 'none'}${unknowns.length ? ` (unknown: ${unknowns.join('; ')})` : ''}`;
    }
    return typeof t.value === 'string' ? JSON.stringify(t.value) : t.canon;
  };
  return o.tallies.map((t) => `${shown(t)} x${t.count}`).join(', ');
}

function voteFlags(side: Side | 'card', region: CardRegion | 'rules', vote: RegionVote): Flag[] {
  const flags: Flag[] = [];
  // Fields with no votes belong to weapons only some reads saw: not part of the result.
  for (const o of vote.outcomes().filter((x) => x.votes > 0)) {
    if (o.status === 'unanimous') continue;
    flags.push({
      level: o.status === 'flagged' ? 'review' : 'warning',
      side,
      region,
      field: o.key,
      message: `${o.status === 'flagged' ? 'no clear majority' : 'majority'} after ${vote.reads} reads: ${describe(o)}`,
    });
  }
  for (const key of ['runemarks', ...vote.keys().filter((k) => k.endsWith('.abilities'))]) {
    const o = vote.keys().includes(key) ? vote.outcome(key) : null;
    const unknowns = ((o?.value as { id: string; description: string }[] | undefined) ?? []).filter((m) => m.id === 'unknown');
    if (unknowns.length) {
      flags.push({ level: 'review', side, region, field: key, message: `unknown runemark: ${unknowns.map((u) => u.description || '(no description)').join('; ')}` });
    }
  }
  return flags;
}

// ---------- the whole fighter ----------

export async function readFighter(
  ctx: ReadContext,
  card: FighterCard,
  refs: References,
  settings: VoteSettings = DEFAULT_VOTE_SETTINGS,
  progress: (note: string) => void = () => {},
): Promise<FighterReading> {
  const votes = new Map<RegionKey, RegionVote>();
  const reads: Promise<unknown>[] = [];
  for (const side of SIDES) {
    for (const region of CARD_REGION_NAMES) {
      const vote = new RegionVote(`fighter ${card.index} ${side} ${region}`, settings);
      votes.set(`${side}/${region}`, vote);
      reads.push(voteRegion(vote, readRegion(ctx, card[side], region, refs)));
    }
  }
  const rulesSettings = { ...settings, initialReads: Math.min(3, settings.initialReads), maxReads: Math.min(7, settings.maxReads) };
  const rules = new RegionVote(`fighter ${card.index} rules text`, rulesSettings);
  votes.set('card/rules', rules);
  reads.push(voteRegion(rules, readRules(ctx, card, refs)));
  const total = () => [...votes.values()].reduce((sum, v) => sum + v.reads, 0);
  let shown = -1;
  const timer = setInterval(() => {
    if (total() !== shown) progress(`${(shown = total())} reads`);
  }, 1000);
  try {
    await Promise.all(reads);
  } finally {
    clearInterval(timer);
  }

  let assembled = assemble(card.index, votes);
  const flags: Flag[] = [];
  const before = statements(assembled, refs.warbandSlug);
  progress(`${total()} reads, checking`);
  const checks = await check(ctx, card, refs, before);

  // A "no" sends its region back for more reads (once), unless it already had all of them.
  const rejected = [...new Set(checks.filter((c) => !c.ok).map((c) => c.region as RegionKey))];
  if (rejected.length) {
    progress(`${total()} reads, re-reading ${rejected.join(', ')}`);
    await Promise.all(
      rejected.map((key) => {
        const vote = votes.get(key)!;
        const [side, region] = key.split('/') as [Side | 'card', CardRegion | 'rules'];
        const read = side === 'card' ? readRules(ctx, card, refs) : readRegion(ctx, card[side as Side], region as CardRegion, refs);
        return voteRegion(vote, read, { extraReads: settings.initialReads });
      }),
    );
    assembled = assemble(card.index, votes);
    const after = statements(assembled, refs.warbandSlug);
    for (const c of checks.filter((x) => !x.ok)) {
      const old = before.find((s) => s.text === c.statement)!;
      const now = after.filter((s) => s.region === old.region);
      const [side, region] = c.region.split('/') as [Side | 'card', CardRegion | 'rules'];
      const changed = !now.some((s) => s.canon === old.canon);
      const shows = c.cardShows ? ` (card shows: ${c.cardShows})` : '';
      flags.push({
        level: 'review',
        side,
        region,
        field: 'checker',
        message: changed
          ? `checker said no to "${c.statement}"${shows}; after more reads the value changed: ${now.map((s) => s.text).join(' ')}`
          : `checker said no to "${c.statement}"${shows}; more reads kept the value`,
      });
    }
  }

  for (const [key, vote] of votes) {
    const [side, region] = key.split('/') as [Side | 'card', CardRegion | 'rules'];
    flags.push(...voteFlags(side, region, vote));
  }
  return {
    fighter: assembled.fighter,
    names: assembled.names,
    regions: [...votes].map(([key, vote]) => {
      const [side, region] = key.split('/') as [Side | 'card', CardRegion | 'rules'];
      return { side, region, vote };
    }),
    flags,
    checks: checks.map(({ statement, ok, cardShows, region }) => ({ statement, ok, cardShows, region })),
  };
}
