import sharp from 'sharp';
import { askJson, png, text, type ReadContext } from './ai-read';
import type { Catalog } from './catalog';
import { RegionVote, canonText, voteRegion, type FieldOutcome, type FieldVote, type VoteSettings } from './votes';

/**
 * Reads a warscroll card (warband or Grand Alliance) by voting, like the fighter cards: the whole
 * text is read several times and each field (inspire, each reaction's and ability's name, type,
 * trigger, flavour and rules text) is voted on separately. Inline icons are written as
 * {icon:<id>} with ids from the warband's runemark catalog, so a Grot is {icon:grot} and not
 * the nearest core runemark.
 */

export interface WarscrollEntry {
  name: string;
  type: string;
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

const SCHEMA = `{
  "name": "<warband name as printed in the title>",
  "version": "<version number if printed, or null>",
  "inspire": "<the full Inspire condition text>",
  "generalRules": "<a rule printed on its own that is not part of any one entry, such as a line above several entries, or null>",
  "reactions": [ <entry>, ... ],
  "abilities": [ <entry>, ... ]
}
where each <entry> is:
{ "name": "<name>", "type": "passive" | "action" | "reaction", "trigger": "<the opening sentence that says when to use it, or null>", "flavorText": "<italic flavour text, or null>", "rulesText": "<the rules text after the trigger>" }`;

const RULES = `- Copy all wording exactly as printed, word for word.
- The card has a narrow left column (the Inspire box, then usually a few grey boxes) and a wide panel on the right. "reactions" are the boxes in the left column below Inspire, top to bottom; "abilities" are the entries in the right panel, top to bottom. Decide only by where an entry is printed, not by what kind of ability it is.
- "trigger": when an entry's rules text opens with a sentence that says when to use it (for example "Use this immediately after ...", "Use this in a Power step.", "You can use this in the last Power step of a battle round."), put that sentence in "trigger" and the rest in "rulesText". Otherwise "trigger" is null and all of it is "rulesText".
- "type": "action" if the text says it is used in a Power step, "reaction" if the text says you can use it after something happens (for example "Use this immediately after ..."), and "passive" otherwise, including rules that apply on their own when something happens.
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
- Symbols in headings are not part of the text: leave out the symbol before the word "Inspire" and the Surge symbol before an entry's name.`;
}

const PROMPTS = [
  (name: string, catalog: Catalog) => `Image 1 is the warscroll card of "${name}" from Warhammer Underworlds. Extract all of its text as JSON with this shape:
${SCHEMA}

Rules:
${RULES}
${iconRules(catalog, 2)}

Return ONLY valid JSON, no markdown code fences or explanation.`,
  (name: string, catalog: Catalog) => `Transcribe the Warhammer Underworlds warscroll in image 1 ("${name}") into JSON. Read it slowly, box by box, and copy every word exactly.
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
      add(`${at}.type`, clean(item.type), when);
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
  const vote = new RegionVote(`${meta.name} warscroll`, settings);
  let shown = -1;
  const timer = setInterval(() => {
    if (vote.reads !== shown) progress(`${(shown = vote.reads)} reads`);
  }, 1000);
  try {
    await voteRegion(vote, async (n) => {
      const wording = n % PROMPTS.length;
      const reply = await askJson<Reply>(ctx, [png(enlarged), png(sheet), text(PROMPTS[wording](meta.name, catalog))], 8000);
      return { variant: `warscroll/${'ab'[wording]}`, fields: fields(reply) };
    });
  } finally {
    clearInterval(timer);
  }

  const get = (key: string) => vote.outcome(key).value as string | null;
  const list = (name: 'reactions' | 'abilities'): WarscrollEntry[] => {
    const count = Number(vote.outcome(`${name}.count`).canon) || 0;
    return Array.from({ length: count }, (_, i) => {
      const at = `${name}[${i}]`;
      const trigger = get(`${at}.trigger`);
      return {
        name: get(`${at}.name`) ?? '',
        type: get(`${at}.type`) ?? 'passive',
        ...(trigger ? { trigger } : {}),
        flavorText: get(`${at}.flavorText`),
        rulesText: get(`${at}.rulesText`) ?? '',
      };
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

  const flags: WarscrollReading['flags'] = [];
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
