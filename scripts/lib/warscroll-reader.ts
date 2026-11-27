import sharp from 'sharp';
import { askJson, png, text, type ReadContext } from './ai-read';
import { coreEntries, renderSheet, type Catalog } from './catalog';
import { RegionVote, canonText, voteRegion, type FieldOutcome, type FieldVote, type VoteSettings } from './votes';

/**
 * Reads a warscroll card (warband or Grand Alliance) by voting, like the fighter cards: the whole
 * text is read several times and each field (inspire, each reaction's and ability's name, type,
 * trigger, flavour and rules text) is voted on separately. Inline icons are written as
 * {icon:<id>} with ids from the warband's runemark catalog, so a Grot is {icon:grot} and not
 * the nearest core runemark.
 *
 * An entry's type comes from the symbol the card prints before its name (see entryType): Surge
 * is a reaction, Core ability an action, and an entry with no symbol is passive unless it is used
 * in a Power step. Otherwise the wording is only a cross-check that flags disagreements.
 */

export type EntryType = 'passive' | 'action' | 'reaction';

export interface WarscrollEntry {
  name: string;
  /** Left out when the reads could not settle it (the reading then has a review flag for it). */
  type?: EntryType;
  trigger?: string | null;
  flavorText: string | null;
  rulesText: string;
}

export interface Warscroll {
  id: string;
  name: string;
  version: string | null;
  grandAlliance: string;
  inspire: string;
  /** A rule printed outside any entry, such as a line above several of them (only present when there is one). */
  generalRules?: string;
  reactions: WarscrollEntry[];
  abilities: WarscrollEntry[];
  [key: string]: unknown;
}

export interface WarscrollReading {
  warscroll: Warscroll;
  vote: RegionVote;
  flags: { level: 'warning' | 'review'; field: string; message: string }[];
}

// ---------- entry types ----------

/**
 * The symbol printed in front of an entry's name, and the type it means. A closed set: the
 * Surge symbol (a hexagon with a lightning bolt, public/assets/surge.svg), the Core ability
 * symbol (a flaming skull, core-ability.svg), or no symbol at all. A warband's own runemark
 * printed there (the Starblood Stalkers' Asterism star) is none of them, so it counts as none.
 */
export const HEADING_ICONS: Record<string, EntryType> = { surge: 'reaction', 'core-ability': 'action', none: 'passive' };

/** Whether an entry's opening sentence (its trigger, or the first sentence of its text) uses it in a Power step. */
export function usedInPowerStep(entry: { trigger?: string | null; rulesText: string }): boolean {
  return /\bpower step\b/i.test(entry.trigger || entry.rulesText.split(/(?<=[.!?])\s/)[0]);
}

/**
 * An entry's type from the symbol before its name (a HEADING_ICONS key). Abilities used in a
 * Power step ("Use this in your Power step.") print no symbol, but they are actions, not passive
 * rules; the symbol still wins over the wording (Thanatek's Necromantic Pulse is used in a Power
 * step and prints Surge: a reaction).
 */
export function entryType(icon: string, entry: { trigger?: string | null; rulesText: string }): EntryType {
  return icon === 'none' && usedInPowerStep(entry) ? 'action' : HEADING_ICONS[icon];
}

/** A read's answer for the symbol before a name, as a HEADING_ICONS key, or null when it is not one of them. */
export function headingIcon(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value
    .trim()
    .toLowerCase()
    .replace(/^\{icon:(.*)\}$/, '$1')
    .replace(/[\s_]+/g, '-');
  return Object.hasOwn(HEADING_ICONS, id) ? id : null;
}

/** The two heading symbols as the catalog draws them, labelled with the answer for each. */
export async function headingIconSheet(catalog?: Catalog): Promise<Buffer> {
  const entries = (catalog?.entries ?? coreEntries()).filter((e) => e.source === 'core' && (e.id === 'surge' || e.id === 'core-ability'));
  return renderSheet('Symbols printed before an entry name (answer with the id in bold)', [
    { ...entries.find((e) => e.id === 'surge')!, label: 'Surge: hexagon, lightning bolt' },
    { ...entries.find((e) => e.id === 'core-ability')!, label: 'Core ability: flaming skull' },
  ]);
}

const HEADING_RULE = `Which symbol is printed right before the entry's name, in its heading line. There are only two such symbols, shown in the reference image of heading symbols: "surge" (a hexagon with a lightning bolt) and "core-ability" (a flaming skull). Answer "none" when nothing is printed before the name. Decide by the printed symbol alone, never by what the entry's text says: an entry used "immediately after" something can have no symbol, and one used in a Power step usually has none. The symbol before the word "Inspire" (a skull in a spiked ring) is not one of them.`;

/**
 * What an entry's wording alone suggests. Not used to decide anything: the type comes from the
 * printed symbol, and this only flags entries whose symbol and wording disagree, for a person to
 * check (a misread symbol, or a card worded unusually, like Da Bait's "Immediately after ..."
 * without "Use this", or Blackpowder's Swag abilities, whose trigger is in the line above them).
 */
export function typeFromWording(entry: { trigger?: string | null; rulesText: string }): EntryType {
  const opening = entry.trigger || entry.rulesText.split(/(?<=[.!?])\s/)[0];
  if (/\bimmediately\b/i.test(opening) || /\buse this\b[^.]*\bafter\b/i.test(opening)) return 'reaction';
  if (usedInPowerStep(entry)) return 'action';
  if (/\bto use this ability\b|\bas a core ability\b|\bcore abilit(y|ies)\b[^.]*\buse this\b/i.test(`${entry.trigger ?? ''} ${entry.rulesText}`)) return 'action';
  return 'passive';
}

const SCHEMA = `{
  "name": "<warband name as printed in the title>",
  "version": "<version number if printed, or null>",
  "inspire": "<the full Inspire condition text>",
  "generalRules": "<a rule printed on its own that is not part of any one entry, such as a line above several entries, or null>",
  "reactions": [ <entry>, ... ],
  "abilities": [ <entry>, ... ]
}
where each <entry> is:
{ "name": "<name>", "icon": "surge" | "core-ability" | "none", "trigger": "<the opening sentence that says when to use it, or null>", "flavorText": "<italic flavour text, or null>", "rulesText": "<the rules text after the trigger>" }`;

const RULES = `- Copy all wording exactly as printed, word for word.
- The card has a narrow left column (the Inspire box, then usually a few grey boxes) and a wide panel on the right. "reactions" are the boxes in the left column below Inspire, top to bottom; "abilities" are the entries in the right panel, top to bottom. Decide only by where an entry is printed, not by what kind of ability it is.
- "trigger": when an entry's rules text opens with a sentence that says when to use it (for example "Use this immediately after ...", "Use this in a Power step.", "You can use this in the last Power step of a battle round."), put that sentence in "trigger" and the rest in "rulesText". Otherwise "trigger" is null and all of it is "rulesText".
- "icon": ${HEADING_RULE}
- Inside a field, write \\n\\n where the card leaves a blank gap between paragraphs, and \\n where a new line starts without a gap.
- A box can hold several named paragraphs (for example "Sarrakkar Unleashed: ..." under the box's own title): they are part of that box's "rulesText", not entries of their own.
- "generalRules" is for a rule printed on its own outside any entry: a line above several entries (for example "You can use 1 of the following abilities once per battle round."), or a second coloured box next to Inspire (for example "Uninspire"), written as its title, a colon and its text. Do not copy it into the entries. Use null if there is none.
- Use only ASCII hyphens and straight quotes.`;

function iconRules(catalog: Catalog, sheetNo: number): string {
  const keywordLines = catalog.keywords.map((k) => `  "${k.keyword}" -> {icon:${k.id}}`).join('\n');
  return `- Write every small icon printed inside the text as {icon:<id>}, choosing the id from image ${sheetNo} (each icon is labelled with its id in bold).${
    keywordLines ? ` These words are printed with their own icon, so write the icon after them like this:\n${keywordLines}` : ''
  }
- Do not write an icon that is not printed, and never replace an icon with a similar-looking one: if an icon is on neither list, write {icon:unknown}.
- Symbols in headings are not part of the text: leave out the symbol before the word "Inspire", and the symbol before an entry's name (that one is the entry's "icon").`;
}

const PROMPTS = [
  (name: string, catalog: Catalog) => `Image 1 is the warscroll card of "${name}" from Warhammer Underworlds. Image 3 shows the two symbols an entry's heading can start with. Extract all of the card's text as JSON with this shape:
${SCHEMA}

Rules:
${RULES}
${iconRules(catalog, 2)}

Return ONLY valid JSON, no markdown code fences or explanation.`,
  (name: string, catalog: Catalog) => `Transcribe the Warhammer Underworlds warscroll in image 1 ("${name}") into JSON. Read it slowly, box by box, and copy every word exactly. Image 3 is the reference for heading symbols.
JSON shape:
${SCHEMA}

Rules:
${RULES}
${iconRules(catalog, 2)}

Return ONLY valid JSON, no markdown code fences or explanation.`,
];

const clean = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[ \t]+/g, ' ')
    .trim();
};

interface Reply {
  name?: unknown;
  version?: unknown;
  inspire?: unknown;
  generalRules?: unknown;
  reactions?: Record<string, unknown>[];
  abilities?: Record<string, unknown>[];
}

function fields(reply: Reply): FieldVote[] {
  const out: FieldVote[] = [];
  const add = (key: string, value: string | null, when?: FieldVote['when']) => out.push({ key, canon: canonText(value), value, when });
  add('name', clean(reply.name));
  add('version', reply.version === null || reply.version === undefined ? null : (clean(String(reply.version))?.replace(/^v\s*/i, '') ?? null));
  add('inspire', clean(reply.inspire));
  add('generalRules', clean(reply.generalRules));
  for (const list of ['reactions', 'abilities'] as const) {
    const items = reply[list];
    if (!Array.isArray(items)) throw new Error(`${list} is missing`);
    const count = String(items.length);
    out.push({ key: `${list}.count`, canon: count, value: items.length });
    const when = { key: `${list}.count`, canon: count };
    items.forEach((item, i) => {
      const at = `${list}[${i}]`;
      if (!clean(item.name) || !clean(item.rulesText)) throw new Error(`${at} has no name or rules text`);
      add(`${at}.name`, clean(item.name), when);
      // The symbol is voted on, and turned into a type once the text is settled (entryType); an
      // answer outside the closed set is a vote for null (unresolved).
      add(`${at}.icon`, headingIcon(item.icon), when);
      add(`${at}.trigger`, clean(item.trigger), when);
      add(`${at}.flavorText`, clean(item.flavorText), when);
      add(`${at}.rulesText`, clean(item.rulesText), when);
    });
  }
  return out;
}

export async function readWarscroll(
  ctx: ReadContext,
  meta: { id: string; name: string; grandAlliance: string },
  image: Buffer,
  catalog: Catalog,
  sheet: Buffer,
  existing: Record<string, unknown> | null,
  settings: VoteSettings,
  progress: (note: string) => void = () => {},
): Promise<WarscrollReading> {
  const enlarged = await sharp(image).resize({ width: 1600 }).png().toBuffer();
  const headings = await headingIconSheet(catalog);
  const vote = new RegionVote(`${meta.name} warscroll`, settings);
  let shown = -1;
  const timer = setInterval(() => {
    if (vote.reads !== shown) progress(`${(shown = vote.reads)} reads`);
  }, 1000);
  try {
    await voteRegion(vote, async (n) => {
      const wording = n % PROMPTS.length;
      const reply = await askJson<Reply>(ctx, [png(enlarged), png(sheet), png(headings), text(PROMPTS[wording](meta.name, catalog))], 8000);
      return { variant: `warscroll/${'ab'[wording]}`, fields: fields(reply) };
    });
  } finally {
    clearInterval(timer);
  }

  const get = (key: string) => vote.outcome(key).value as string | null;
  const flags: WarscrollReading['flags'] = [];
  const list = (name: 'reactions' | 'abilities'): WarscrollEntry[] => {
    const count = Number(vote.outcome(`${name}.count`).canon) || 0;
    return Array.from({ length: count }, (_, i) => {
      const at = `${name}[${i}]`;
      const trigger = get(`${at}.trigger`);
      const entry: WarscrollEntry = {
        name: get(`${at}.name`) ?? '',
        type: undefined,
        ...(trigger ? { trigger } : {}),
        flavorText: get(`${at}.flavorText`),
        rulesText: get(`${at}.rulesText`) ?? '',
      };
      const icon = headingIcon(get(`${at}.icon`));
      if (icon) entry.type = entryType(icon, entry);
      else {
        // Never a default: an entry whose symbol no majority of reads named is left without a type.
        delete entry.type;
        flags.push({ level: 'review', field: `${at}.icon`, message: `"${entry.name}": no read named the symbol before its name (surge, core-ability or none), so it has no type` });
      }
      flags.push(...wordingCheck(at, entry));
      return entry;
    });
  };

  // Same key order as the existing files; fields this script does not read (playstyle) are kept.
  const warscroll: Warscroll = {
    ...(existing ?? {}),
    id: meta.id,
    name: get('name') ?? meta.name,
    version: get('version'),
    grandAlliance: meta.grandAlliance,
    inspire: get('inspire') ?? '',
    reactions: list('reactions'),
    abilities: list('abilities'),
  };
  const generalRules = get('generalRules');
  const ordered: Warscroll = {
    id: warscroll.id,
    name: warscroll.name,
    version: warscroll.version,
    grandAlliance: warscroll.grandAlliance,
    inspire: warscroll.inspire,
    ...(generalRules ? { generalRules } : {}),
    reactions: warscroll.reactions,
    abilities: warscroll.abilities,
  };
  for (const [k, v] of Object.entries(warscroll)) if (!(k in ordered) && k !== 'generalRules') ordered[k] = v;

  // Fields with no votes belong to entries only some reads had (more reactions than the final count): not part of the result.
  for (const o of vote.outcomes().filter((x) => x.votes > 0)) {
    if (o.status !== 'unanimous') {
      flags.push({ level: o.status === 'flagged' ? 'review' : 'warning', field: o.key, message: `${o.status === 'flagged' ? 'no clear majority' : 'majority'} after ${vote.reads} reads: ${describeTexts(o)}` });
    }
    if (typeof o.value === 'string' && o.value.includes('{icon:unknown}')) {
      flags.push({ level: 'review', field: o.key, message: 'has an icon that is in no list ({icon:unknown})' });
    }
  }
  return { warscroll: ordered, vote, flags };
}

function describeTexts(o: FieldOutcome): string {
  return o.tallies.map((t) => `${typeof t.value === 'string' ? JSON.stringify(t.value) : t.canon} x${t.count}`).join(' | ');
}

/** A warning when an entry's symbol and its wording point at different types (see typeFromWording). */
function wordingCheck(at: string, entry: WarscrollEntry): WarscrollReading['flags'] {
  const message = entry.type ? wordingMismatch(entry, entry.type) : null;
  return message ? [{ level: 'warning', field: `${at}.icon`, message }] : [];
}

/** The warning for an entry whose type (from its symbol) and wording disagree, or null when they agree. */
export function wordingMismatch(entry: { name: string; trigger?: string | null; rulesText: string }, type: EntryType, icon?: string): string | null {
  const worded = typeFromWording(entry);
  return worded === type ? null : `"${entry.name}": the symbol before its name${icon ? ` (${icon})` : ''} makes it ${type}, but its wording reads as ${worded}; check the card`;
}

// ---------- types alone ----------

export interface TypeTarget {
  list: 'reactions' | 'abilities';
  index: number;
  name: string;
  /** The entry's text, for the wording cross-check. */
  trigger?: string | null;
  rulesText: string;
}

export interface TypeReading {
  target: TypeTarget;
  /** The type the symbol means, or null when the reads did not settle it. */
  type: EntryType | null;
  outcome: FieldOutcome;
  /** What the reads said is printed before the name, most common first. */
  seen: string[];
  flags: WarscrollReading['flags'];
}

/**
 * The two views a type read is given: the whole card, or its two columns cut out and enlarged,
 * so the small heading symbols are bigger (the left column holds Inspire and the boxes below it,
 * the right panel the other entries; the cuts overlap a little).
 */
async function typeViews(image: Buffer): Promise<{ whole: Buffer[]; columns: Buffer[] }> {
  const { width = 836, height = 593 } = await sharp(image).metadata();
  const cut = async (left: number, right: number, scale: number) =>
    sharp(image)
      .extract({ left: Math.round(left * width), top: Math.round(0.09 * height), width: Math.round((right - left) * width), height: height - Math.round(0.09 * height) })
      .resize({ width: Math.round((right - left) * width * scale), kernel: 'lanczos3' })
      .png()
      .toBuffer();
  return {
    whole: [await sharp(image).resize({ width: 1600 }).png().toBuffer()],
    columns: [await cut(0, 0.3, 2.6), await cut(0.26, 1, 2)],
  };
}

const TYPE_PROMPTS = [
  (name: string, images: string, entries: string) => `${images} Image ${'{legend}'} shows the only two symbols that can be printed before an entry's name on a Warhammer Underworlds warscroll card, each labelled with its id.

This is the warscroll of "${name}". For each entry listed below, look at its heading line and say which symbol is printed right before its name: "surge", "core-ability", or "none" when nothing is printed there.
${HEADING_RULE}

Entries (left column boxes below Inspire, then the right panel, each top to bottom):
${entries}

Return JSON with one item per entry, in the same order, the name as listed: {"entries": [{"name": "...", "printed": "<what you see right before the name, in a few words>", "icon": "surge" | "core-ability" | "none"}]}
Return ONLY valid JSON, no markdown code fences or explanation.`,
  (name: string, images: string, entries: string) => `${images} Image ${'{legend}'} is a reference: the Surge symbol ("surge", a hexagon with a lightning bolt) and the Core ability symbol ("core-ability", a flaming skull).

Look closely at the heading of each entry of the "${name}" warscroll listed below, at the very start of the line, just before the bold name. Is the Surge symbol printed there, the Core ability symbol, or nothing? Answer only from what is printed; ignore what the entry's text says. The skull in a spiked ring before "Inspire" is a different symbol and is never the answer.

Entries:
${entries}

Return JSON, one item per entry in this order: {"entries": [{"name": "<the name as listed>", "printed": "<a few words on what is printed before the name>", "icon": "surge" | "core-ability" | "none"}]}
Return ONLY valid JSON, no markdown code fences or explanation.`,
];

/**
 * Reads only the symbol before each entry's name (see HEADING_ICONS), by voting: the whole card
 * and the enlarged columns, each with two wordings, take turns. Entries are given by name, so
 * the reads cannot add or lose any. An entry is settled like any voted field; an entry no
 * majority settles keeps a null type and a review flag. Each settled type is also checked
 * against the entry's wording (a warning when they disagree).
 */
export async function readEntryTypes(
  ctx: ReadContext,
  name: string,
  image: Buffer,
  targets: TypeTarget[],
  settings: VoteSettings,
  progress: (note: string) => void = () => {},
): Promise<{ readings: TypeReading[]; vote: RegionVote }> {
  const legend = await headingIconSheet();
  const views = await typeViews(image);
  const listing = targets.map((t, i) => `${i + 1}. ${t.name} (${t.list === 'reactions' ? 'left column' : 'right panel'})`).join('\n');
  const vote = new RegionVote(`${name} entry types`, settings);
  const seen = new Map<string, Map<string, number>>();
  let shown = -1;
  const timer = setInterval(() => {
    if (vote.reads !== shown) progress(`${(shown = vote.reads)} reads`);
  }, 1000);
  try {
    await voteRegion(vote, async (n) => {
      const view = n % 2 === 0 ? 'whole' : 'columns';
      const wording = Math.floor(n / 2) % TYPE_PROMPTS.length;
      const pictures = views[view];
      const images =
        view === 'whole'
          ? 'Image 1 is a warscroll card.'
          : 'Image 1 is the left column of a warscroll card (the Inspire box and the boxes below it), enlarged; image 2 is its right panel, enlarged.';
      const prompt = TYPE_PROMPTS[wording](name, images, listing).replace('{legend}', String(pictures.length + 1));
      const reply = await askJson<{ entries?: { name?: unknown; printed?: unknown; icon?: unknown }[] }>(ctx, [...pictures.map(png), png(legend), text(prompt)], 3000);
      if (!Array.isArray(reply.entries)) throw new Error('entries is missing');
      const fields: FieldVote[] = [];
      targets.forEach((t, i) => {
        // Matched by name; by position only when the name is missing.
        const item = reply.entries!.find((e) => canonText(typeof e.name === 'string' ? e.name : null) === canonText(t.name)) ?? (reply.entries![i] && typeof reply.entries![i].name !== 'string' ? reply.entries![i] : undefined);
        if (!item) return;
        const icon = headingIcon(item.icon);
        const key = `${t.list}[${t.index}]`;
        fields.push({ key, canon: icon ?? 'unresolved', value: icon ?? (typeof item.icon === 'string' ? item.icon : null) });
        if (typeof item.printed === 'string' && item.printed.trim()) {
          const m = seen.get(key) ?? new Map<string, number>();
          const p = item.printed.trim().toLowerCase();
          m.set(p, (m.get(p) ?? 0) + 1);
          seen.set(key, m);
        }
      });
      return { variant: `types/${view}-${'ab'[wording]}`, fields };
    });
  } finally {
    clearInterval(timer);
  }

  const readings = targets.map((target): TypeReading => {
    const key = `${target.list}[${target.index}]`;
    const outcome = vote.outcome(key);
    const icon = outcome.votes > 0 ? headingIcon(outcome.canon) : null;
    const settled = icon !== null && outcome.status !== 'flagged';
    const type = settled ? entryType(icon, target) : null;
    const counts = outcome.tallies.map((t) => `${t.canon} ${t.count}`).join(', ');
    const flags: WarscrollReading['flags'] = [];
    if (!settled) {
      flags.push({ level: 'review', field: key, message: `"${target.name}": the reads did not settle the symbol before its name (${counts || 'no votes'} of ${vote.reads} reads), so its type is unresolved` });
    } else if (outcome.status === 'majority') {
      flags.push({ level: 'warning', field: key, message: `"${target.name}": ${icon} by majority (${counts})` });
    }
    const mismatch = type ? wordingMismatch(target, type, icon!) : null;
    if (mismatch) flags.push({ level: 'warning', field: key, message: mismatch });
    const forms = [...(seen.get(key) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]).map(([p, c]) => `${p} x${c}`);
    return { target, type, outcome, seen: forms, flags };
  });
  return { readings, vote };
}

// ---------- Polish file ----------

const TOKEN = /\{icon:[^}]+\}/g;
const tokens = (s: unknown) => (typeof s === 'string' ? s.match(TOKEN) ?? [] : []);
const withoutTokens = (s: unknown) => canonText(typeof s === 'string' ? s.replace(TOKEN, '') : null);

/**
 * Carries icon changes over to the Polish translation without translating again. Entries are
 * matched by their English name, so one that moved between reactions and abilities keeps its
 * translation. Where an English field kept its wording and its number of icons, the Polish
 * field's icons are replaced in order. Entries whose text changed or whose trigger is split
 * off differently lose their Polish text (the app then shows English) and are listed for
 * translating again.
 */
export function remapPolish(
  oldEn: Record<string, unknown>,
  newEn: Warscroll,
  pl: Record<string, unknown>,
): { pl: Record<string, unknown>; notes: string[] } {
  const notes: string[] = [];
  const out: Record<string, unknown> = { ...pl };
  const swapIcons = (path: string, oldText: unknown, newText: unknown, plText: unknown): string | undefined => {
    if (typeof plText !== 'string' || typeof newText !== 'string') return undefined;
    if (withoutTokens(oldText) !== withoutTokens(newText)) {
      notes.push(`${path}: English text changed, translate it again`);
      return undefined;
    }
    const before = tokens(oldText);
    const after = tokens(newText);
    if (before.join() === after.join()) return plText;
    if (after.length !== tokens(plText).length) {
      notes.push(`${path}: icons changed (${before.join(' ') || 'none'} -> ${after.join(' ') || 'none'}) but the Polish text has a different number of icons, translate it again`);
      return undefined;
    }
    let i = 0;
    return plText.replace(TOKEN, () => after[i++]);
  };

  out.inspire = swapIcons('inspire', oldEn.inspire, newEn.inspire, pl.inspire);
  if (out.inspire === undefined) delete out.inspire;

  const oldEntries = (['reactions', 'abilities'] as const).flatMap((list) =>
    ((oldEn[list] as Record<string, unknown>[] | undefined) ?? []).map((entry, i) => ({ entry, pl: ((pl[list] as Record<string, unknown>[] | undefined) ?? [])[i] ?? null })),
  );
  for (const list of ['reactions', 'abilities'] as const) {
    out[list] = newEn[list].map((entry) => {
      const name = entry.name;
      const match = oldEntries.find((o) => canonText(String(o.entry.name)) === canonText(name));
      if (!match?.pl) {
        notes.push(`"${name}": no Polish text for it yet, translate it again`);
        return null;
      }
      const hadTrigger = typeof match.entry.trigger === 'string' && Boolean(match.entry.trigger);
      const hasTrigger = typeof entry.trigger === 'string' && Boolean(entry.trigger);
      if (hadTrigger !== hasTrigger) {
        notes.push(`"${name}": its trigger sentence is now ${hasTrigger ? 'separate' : 'part of the rules text'}, translate it again`);
        return null;
      }
      const result: Record<string, unknown> = { ...match.pl };
      for (const key of ['trigger', 'flavorText', 'rulesText'] as const) {
        if (typeof match.pl[key] !== 'string') {
          // No Polish text for this field (for example no flavour text): fine if English has none either.
          if (typeof entry[key as keyof WarscrollEntry] === 'string' && entry[key as keyof WarscrollEntry]) {
            notes.push(`"${name}" ${key}: no Polish text for it yet, translate it again`);
            return null;
          }
          continue;
        }
        const swapped = swapIcons(`"${name}" ${key}`, match.entry[key], entry[key], match.pl[key]);
        if (swapped === undefined) return null;
        result[key] = swapped;
      }
      return result;
    });
  }
  if (newEn.generalRules && typeof pl.generalRules !== 'string') notes.push('generalRules: new field, needs translating');
  return { pl: out, notes: [...new Set(notes)] };
}

/**
 * Translates the parts of a remapped Polish file that remapPolish had to drop (changed or
 * moved entries, a new generalRules), in one request, with the rest of the Polish file as the
 * reference for terminology. Returns the completed file and what was translated.
 */
export async function translateMissing(
  ctx: ReadContext,
  en: Warscroll,
  pl: Record<string, unknown>,
): Promise<{ pl: Record<string, unknown>; translated: string[] }> {
  const wanted: Record<string, unknown> = {};
  if (typeof pl.inspire !== 'string') wanted.inspire = en.inspire;
  if (en.generalRules && typeof pl.generalRules !== 'string') wanted.generalRules = en.generalRules;
  const entries: { list: 'reactions' | 'abilities'; index: number }[] = [];
  for (const list of ['reactions', 'abilities'] as const) {
    const plList = (pl[list] as (Record<string, unknown> | null)[] | undefined) ?? [];
    en[list].forEach((entry, index) => {
      if (plList[index]) return;
      entries.push({ list, index });
      wanted[`${list}[${index}]`] = { name: entry.name, ...(entry.trigger ? { trigger: entry.trigger } : {}), flavorText: entry.flavorText, rulesText: entry.rulesText };
    });
  }
  const keys = Object.keys(wanted);
  if (keys.length === 0) return { pl, translated: [] };

  const reference = JSON.stringify({ inspire: pl.inspire, reactions: pl.reactions, abilities: pl.abilities });
  const reply = await askJson<Record<string, unknown>>(
    ctx,
    [
      text(`Translate these texts from a Warhammer Underworlds warscroll from English to Polish. Return a JSON object with the same keys and the same structure, every text translated.
- Use the same terminology and style as the existing Polish translation of this warscroll below.
- Keep {icon:name} tokens exactly as they are, and keep \\n line breaks.
- Keep game terms that the Polish community uses untranslated (for example "Inspire", "Power step", "Guard token") as the existing translation does.
- Keep null values as null.

Existing Polish translation of the rest of this warscroll:
${reference}

Texts to translate:
${JSON.stringify(wanted, null, 2)}

Return ONLY valid JSON, no markdown code fences or explanation.`),
    ],
    8000,
  );

  const out: Record<string, unknown> = { ...pl };
  const translated: string[] = [];
  if (typeof reply.inspire === 'string' && 'inspire' in wanted) {
    out.inspire = reply.inspire;
    translated.push('inspire');
  }
  if (typeof reply.generalRules === 'string' && 'generalRules' in wanted) {
    out.generalRules = reply.generalRules;
    translated.push('generalRules');
  }
  for (const list of ['reactions', 'abilities'] as const) out[list] = [...((pl[list] as unknown[] | undefined) ?? [])];
  for (const { list, index } of entries) {
    const value = reply[`${list}[${index}]`];
    if (value && typeof value === 'object') {
      (out[list] as unknown[])[index] = value;
      translated.push(`"${en[list][index].name}"`);
    }
  }
  return { pl: out, translated };
}
