import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import sharp, { type OverlayOptions } from 'sharp';
import { askJson, png, slugify, text, type ReadContext } from './ai-read';
import { cropFraction } from './card-image';
import { ROOT } from './data';
import { DEFAULT_VOTE_SETTINGS, RegionVote, voteRegion, type FieldOutcome, type FieldVote, type VoteSettings } from './votes';

/**
 * The runemarks a warband's cards and warscroll can show, each with an image, so the model
 * labels what it sees from a fixed list instead of guessing a name. Built from three sources:
 *
 * - core: the runemarks and symbols of the core rules (public/assets, drawn from the rules PDF)
 * - warband: the warband's own runemark (warbands/<slug>/icon.png, the same art as on the cards)
 * - warscroll: keywords the warscroll prints with an inline icon, like "Grot" or "Volley",
 *   read from warscroll.png and cut out of it with the keyword next to the icon
 *
 * Vaulted warbands have no warscroll, so their catalog has only the first two; any other
 * circle on their cards comes out as "unknown" with a description, for a person to name.
 */

export type RunemarkKind = 'fighter' | 'weapon' | 'symbol';

/** What the model answers for the warband's own runemark: a long slug invites misspellings. */
export const WARBAND_ANSWER = 'warband';

export interface RunemarkEntry {
  id: string;
  label: string;
  kind: RunemarkKind;
  source: 'core' | 'warband' | 'warscroll';
  /** The image shown on the reference sheet. */
  image: Buffer;
  /** For warscroll entries: the keyword printed next to the icon. */
  keyword?: string;
  /** For warscroll entries: the icon alone (no keyword or brackets), for the app; only when a check confirmed it. */
  appIcon?: Buffer;
}

export interface KeywordIcon {
  keyword: string;
  id: string;
  kind: RunemarkKind;
  status: FieldOutcome['status'];
  votes: string;
}

export interface Catalog {
  warband: string;
  entries: RunemarkEntry[];
  /** Keywords the warscroll prints with an icon, and the catalog id of that icon. */
  keywords: KeywordIcon[];
  /** The warscroll's icon reads, kept for the report. */
  iconVotes: FieldOutcome[];
  /** AI calls the catalog took. */
  reads: number;
  flags: string[];
}

const ASSETS = join(ROOT, 'public', 'assets');

interface CoreIcon {
  id: string;
  label: string;
  kind: RunemarkKind;
  file: string;
}

/** Fighter runemarks of the core rules (index of runemarks, core rules page 18; Minion on page 5). */
const CORE_FIGHTER: CoreIcon[] = [
  { id: 'leader', label: 'Leader (crown)', kind: 'fighter', file: 'leader.png' },
  { id: 'minion', label: 'Minion', kind: 'fighter', file: 'minion.png' },
  { id: 'fly', label: 'Fly', kind: 'fighter', file: 'fly.png' },
];

/** Weapon ability runemarks of the core rules (page 11), and the Critical marker that can precede one. */
const CORE_WEAPON: CoreIcon[] = [
  { id: 'crit', label: 'Critical marker (makes the next runemark critical)', kind: 'weapon', file: 'crit.png' },
  { id: 'cleave', label: 'Cleave', kind: 'weapon', file: 'cleave.png' },
  { id: 'ensnare', label: 'Ensnare', kind: 'weapon', file: 'ensnare.png' },
  { id: 'brutal', label: 'Brutal', kind: 'weapon', file: 'brutal.png' },
  { id: 'grievous', label: 'Grievous', kind: 'weapon', file: 'grevious.png' },
  { id: 'stagger', label: 'Stagger', kind: 'weapon', file: 'stagger.png' },
  { id: 'grapple', label: 'Grapple', kind: 'weapon', file: 'grapple.png' },
];

/** Dice and other symbols that warscroll text prints inline. */
const CORE_SYMBOLS: CoreIcon[] = [
  { id: 'hammer', label: 'Hammer (attack dice symbol)', kind: 'symbol', file: 'hammer.png' },
  { id: 'swords', label: 'Swords (attack dice symbol)', kind: 'symbol', file: 'swords.png' },
  { id: 'shield', label: 'Shield (save dice symbol)', kind: 'symbol', file: 'shield.png' },
  { id: 'dodge', label: 'Dodge (save dice symbol)', kind: 'symbol', file: 'dodge.png' },
  { id: 'crit', label: 'Critical (dice symbol)', kind: 'symbol', file: 'crit.png' },
  { id: 'flanked', label: 'Flanked', kind: 'symbol', file: 'flanked.png' },
  { id: 'surrounded', label: 'Surrounded', kind: 'symbol', file: 'surrounded.png' },
  { id: 'hex', label: 'Range (hexagon)', kind: 'symbol', file: 'range.png' },
  { id: 'damage', label: 'Damage (star)', kind: 'symbol', file: 'damage.png' },
  { id: 'surge', label: 'Surge', kind: 'symbol', file: 'surge.png' },
  { id: 'core-ability', label: 'Core ability', kind: 'symbol', file: 'core-ability.png' },
  { id: 'inspired', label: 'Inspired (skull in a spiked ring)', kind: 'symbol', file: 'inspired.png' },
];

/** Card legends that are not runemarks: the save badge symbols and the weapon bar icons. */
export const CARD_LEGEND = {
  save: [
    { id: 'shield', label: 'Shield', file: 'shield.png' },
    { id: 'dodge', label: 'Dodge', file: 'dodge.png' },
  ],
  weapon: [
    { id: 'melee', label: 'Melee weapon (left of the bar)', file: 'melee.png' },
    { id: 'ranged', label: 'Ranged weapon (left of the bar)', file: 'ranged.png' },
    { id: 'hammer', label: 'Hammer (attack dice symbol)', file: 'hammer.png' },
    { id: 'swords', label: 'Swords (attack dice symbol)', file: 'swords.png' },
  ],
};

export const CORE_IDS = new Set([...CORE_FIGHTER, ...CORE_WEAPON, ...CORE_SYMBOLS].map((c) => c.id));

/**
 * Warscroll keywords that name a core rules symbol: they always use the core id, even when the
 * reads did not match the printed icon to the core one (a Critical symbol is crit, not a new
 * "critical" runemark).
 */
const CORE_KEYWORDS: Record<string, string> = {
  ...Object.fromEntries([...CORE_IDS].map((id) => [id, id])),
  critical: 'crit',
  range: 'hex',
  inspire: 'inspired',
  'core-abilities': 'core-ability',
  flying: 'fly',
  leaders: 'leader',
  minions: 'minion',
};

const asset = (file: string) => readFileSync(join(ASSETS, file));

function coreEntry(icon: CoreIcon): RunemarkEntry {
  return { id: icon.id, label: icon.label, kind: icon.kind, source: 'core', image: asset(icon.file) };
}

// ---------- reference sheets ----------

const TILE_W = 250;
const TILE_H = 250;
const ICON_BOX = 170;
const COLUMNS = 4;

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/** Black glyph on transparent (the core assets) as a light glyph on a dark circle or hexagon, like on the cards. */
async function cardStyle(glyph: Buffer, shape: 'circle' | 'hex' | 'plain'): Promise<Buffer> {
  const size = ICON_BOX;
  if (shape === 'plain') {
    return sharp(glyph).resize(size - 40, size - 40, { fit: 'contain', background: '#0000' }).extend({ top: 20, bottom: 20, left: 20, right: 20, background: '#0000' }).png().toBuffer();
  }
  const light = await sharp(glyph)
    .resize(Math.round(size * 0.55), Math.round(size * 0.55), { fit: 'contain', background: '#0000' })
    .negate({ alpha: false })
    .png()
    .toBuffer();
  const r = size / 2 - 4;
  const shapeSvg =
    shape === 'circle'
      ? `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="#2b2d30" stroke="#9aa0a6" stroke-width="4"/>`
      : `<polygon points="${Array.from({ length: 6 }, (_, i) => {
          const a = (Math.PI / 3) * i;
          return `${size / 2 + r * Math.cos(a)},${size / 2 + r * Math.sin(a)}`;
        }).join(' ')}" fill="#2b2d30" stroke="#9aa0a6" stroke-width="4"/>`;
  const base = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${shapeSvg}</svg>`);
  return sharp(base).composite([{ input: light, gravity: 'center' }]).png().toBuffer();
}

async function tileImage(entry: RunemarkEntry): Promise<Buffer> {
  if (entry.source === 'core') return cardStyle(entry.image, entry.kind === 'fighter' ? 'circle' : entry.kind === 'weapon' ? 'hex' : 'plain');
  return sharp(entry.image)
    .resize(TILE_W - 20, ICON_BOX, { fit: 'contain', background: '#ffffff' })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
}

/** One labelled image with every entry: the id to answer with in bold, what it is below. */
export async function renderSheet(title: string, entries: RunemarkEntry[]): Promise<Buffer> {
  const rows = Math.ceil(entries.length / COLUMNS);
  const width = COLUMNS * TILE_W;
  const height = 60 + rows * TILE_H;
  const composites: OverlayOptions[] = [];
  let labels = '';
  for (const [i, entry] of entries.entries()) {
    const x = (i % COLUMNS) * TILE_W;
    const y = 60 + Math.floor(i / COLUMNS) * TILE_H;
    const image = await tileImage(entry);
    const { width: w = 0, height: h = 0 } = await sharp(image).metadata();
    composites.push({ input: image, left: x + Math.round((TILE_W - w) / 2), top: y + 8 + Math.round((ICON_BOX - h) / 2) });
    const sub = entry.label.length > 34 ? `${entry.label.slice(0, 33)}...` : entry.label;
    labels +=
      `<rect x="${x + 2}" y="${y + 2}" width="${TILE_W - 4}" height="${TILE_H - 4}" fill="none" stroke="#c8c8c8" stroke-width="2"/>` +
      `<text x="${x + TILE_W / 2}" y="${y + ICON_BOX + 42}" font-family="Arial, sans-serif" font-size="24" font-weight="bold" text-anchor="middle" fill="#000">${escapeXml(entry.source === 'warband' ? WARBAND_ANSWER : entry.id)}</text>` +
      `<text x="${x + TILE_W / 2}" y="${y + ICON_BOX + 68}" font-family="Arial, sans-serif" font-size="15" text-anchor="middle" fill="#444">${escapeXml(sub)}</text>`;
  }
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#ffffff"/>` +
      `<text x="16" y="40" font-family="Arial, sans-serif" font-size="28" font-weight="bold" fill="#000">${escapeXml(title)}</text>${labels}</svg>`,
  );
  return sharp(svg).composite(composites).png().toBuffer();
}

/** Small labelled legend (save symbols, weapon bar icons) for the stats and weapons reads. */
export async function renderLegend(title: string, items: { id: string; label: string; file: string }[]): Promise<Buffer> {
  return renderSheet(
    title,
    items.map((i) => ({ id: i.id, label: i.label, kind: 'symbol', source: 'core', image: asset(i.file) })),
  );
}

// ---------- warscroll keyword icons ----------

interface IconReply {
  icons?: { keyword?: unknown; kind?: unknown; core?: unknown; description?: unknown; at?: unknown }[];
}

const ICON_PROMPTS = [
  (name: string) => `This is the warscroll card of the Warhammer Underworlds warband "${name}" (first image). Its rules text prints small inline icons (runemarks or symbols), usually in brackets right after the word they stand for, for example "a friendly Grot (icon)" or "Volley (icon)".

List every distinct word that the warscroll prints together with an inline icon inside its rules text. Ignore the two large round emblems in the top corners, and the symbols in headings (the symbol before the word "Inspire", the Surge symbol before an ability's name): they are not inline icons. For each one give:
- "keyword": the word the icon stands for, singular, capitalised as printed (for example "Grot", "Squig", "Volley", "Leader")
- "kind": "fighter" if it is a kind of fighter (a fighter runemark), "weapon" if it is a weapon runemark or weapon ability, "symbol" if it is a dice symbol or other game symbol (for example a shield, dodge, critical or hexagon range symbol)
- "core": the id of the icon on the reference sheet (second image) if the inline icon is the same symbol as that one, otherwise null. Compare shapes carefully: many warbands have their own icons that only look a little like a core one.
- "description": a few words describing the icon's shape
- "at": the centre of the icon in one place where it is printed, as [x, y] fractions of the warscroll image (0 to 1, from the top-left corner)

Return JSON: {"icons": [{"keyword": "...", "kind": "...", "core": null, "description": "...", "at": [0.42, 0.31]}]}
Return ONLY valid JSON, no markdown code fences or explanation.`,
  (name: string) => `First image: the warscroll of the "${name}" warband from Warhammer Underworlds. Second image: a reference sheet of core rules icons, each labelled with its id.

Go through the warscroll text paragraph by paragraph and find each small icon printed inside the sentences (not the big emblems in the top corners, and not symbols in headings, such as the one before "Inspire" or the Surge symbol before an ability's name). Each icon stands for the word just before it, often written as "Word (icon)". Collect each different word once and report:
- "keyword": that word, singular, as printed
- "kind": "fighter" (a fighter keyword), "weapon" (a weapon runemark or weapon ability) or "symbol" (a dice face or other game symbol)
- "core": the reference sheet id whose icon is the same shape, or null if no icon on the sheet is the same (do not pick a merely similar one)
- "description": the icon's shape in a few words
- "at": [x, y], the centre of the icon in one place where it is printed, as fractions of the warscroll image measured from its top-left corner

Return JSON: {"icons": [{"keyword": "...", "kind": "...", "core": null, "description": "...", "at": [0.5, 0.5]}]}
Return ONLY valid JSON, no markdown code fences or explanation.`,
];

function parsePoint(at: unknown): [number, number] | null {
  if (!Array.isArray(at) || at.length !== 2 || at.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;
  const [x, y] = at as number[];
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? [x, y] : null;
}

/**
 * Reads which keywords the warscroll prints with an icon, voting over several reads, and cuts
 * each warband-specific one out of the warscroll (keyword and icon together) for the sheet.
 */
async function readWarscrollIcons(
  ctx: ReadContext,
  name: string,
  warscroll: Buffer,
  coreSheet: Buffer,
  settings: VoteSettings,
): Promise<{ keywords: KeywordIcon[]; entries: RunemarkEntry[]; outcomes: FieldOutcome[]; flags: string[]; reads: number }> {
  const region = new RegionVote(`${name} warscroll icons`, settings, { canon: 'false', value: false });
  // Each read may point at a different place the keyword is printed, so the points are kept as separate places to try, not averaged.
  const points = new Map<string, [number, number][]>();
  const descriptions = new Map<string, string[]>();
  const enlarged = await sharp(warscroll).resize({ width: 1600 }).png().toBuffer();

  await voteRegion(region, async (n) => {
    const prompt = ICON_PROMPTS[n % ICON_PROMPTS.length](name);
    const reply = await askJson<IconReply>(ctx, [png(enlarged), png(coreSheet), text(prompt)]);
    if (!Array.isArray(reply.icons)) throw new Error('icons is missing');
    const fields: FieldVote[] = [];
    for (const icon of reply.icons) {
      if (typeof icon.keyword !== 'string' || !icon.keyword.trim()) continue;
      const kw = slugify(icon.keyword);
      if (!kw || fields.some((f) => f.key === `has:${kw}`)) continue;
      const kind = ['fighter', 'weapon', 'symbol'].includes(icon.kind as string) ? (icon.kind as string) : 'symbol';
      const core = typeof icon.core === 'string' && CORE_IDS.has(icon.core) ? icon.core : 'none';
      fields.push({ key: `has:${kw}`, canon: 'true', value: icon.keyword.trim() });
      fields.push({ key: `kind:${kw}`, canon: kind, value: kind, when: { key: `has:${kw}`, canon: 'true' } });
      fields.push({ key: `core:${kw}`, canon: core, value: core, when: { key: `has:${kw}`, canon: 'true' } });
      const point = parsePoint(icon.at);
      if (point) {
        const list = points.get(kw) ?? [];
        addPoint(list, point);
        points.set(kw, list);
      }
      if (typeof icon.description === 'string') descriptions.set(kw, [...(descriptions.get(kw) ?? []), icon.description]);
    }
    return { variant: `icons-${n % ICON_PROMPTS.length}`, fields };
  });

  const outcomes = region.outcomes();
  const keywords: KeywordIcon[] = [];
  const entries: RunemarkEntry[] = [];
  const flags: string[] = [];
  for (const has of outcomes.filter((o) => o.key.startsWith('has:') && o.canon === 'true')) {
    const kw = has.key.slice(4);
    const kind = region.outcome(`kind:${kw}`);
    const core = region.outcome(`core:${kw}`);
    const worst = [has, kind, core].find((o) => o.status === 'flagged') ?? [has, kind, core].find((o) => o.status === 'majority') ?? has;
    const keyword = String(has.tallies[0].value);
    const id = CORE_KEYWORDS[kw] ?? (core.canon !== 'none' ? core.canon : kw);
    const votes = `${has.tallies[0].count}/${has.votes}`;
    keywords.push({ keyword, id, kind: kind.canon as RunemarkKind, status: worst.status, votes });
    if (worst.status === 'flagged') {
      flags.push(`warscroll icon "${keyword}": reads disagree (present ${votes}, kind ${describeTallies(kind)}, core ${describeTallies(core)})`);
    }
    if (CORE_IDS.has(id)) continue;
    const places = points.get(kw) ?? [];
    const description = descriptions.get(kw)?.[0];
    let image: Buffer;
    let appIcon: Buffer | undefined;
    if (places.length) {
      const cropped = await cropKeyword(ctx, warscroll, keyword, description, places);
      image = cropped.image;
      appIcon = cropped.icon;
      flags.push(...cropped.flags);
    } else {
      // Still a valid answer, just without a picture on the sheet.
      flags.push(`warscroll icon "${keyword}": no read gave its position, so the sheet shows its name only`);
      image = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="230" height="120"><rect width="100%" height="100%" fill="#fff"/><text x="115" y="70" font-family="Arial, sans-serif" font-size="22" text-anchor="middle">${escapeXml(keyword)} (no picture)</text></svg>`)).png().toBuffer();
    }
    entries.push({ id, label: `${keyword} (warscroll)${description ? `: ${description}` : ''}`, kind: kind.canon as RunemarkKind, source: 'warscroll', image, keyword, appIcon });
  }
  return { keywords, entries, outcomes, flags, reads: region.reads + region.failures.length };
}

type Box = { left: number; top: number; width: number; height: number };

/** A window around a point, as fractions, kept inside the image. */
function around([x, y]: [number, number], left: number, right: number, up: number, down: number): Box {
  const l = Math.max(0, x - left);
  const t = Math.max(0, y - up);
  return { left: l, top: t, width: Math.min(1, x + right) - l, height: Math.min(1, y + down) - t };
}

function parseBox(box: unknown): Box | null {
  if (!Array.isArray(box) || box.length !== 4 || box.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;
  const [left, top, width, height] = box as number[];
  if (left < 0 || top < 0 || width <= 0 || height <= 0 || left + width > 1.02 || top + height > 1.02) return null;
  return { left, top, width, height };
}

/** Close points (within about 2% of the warscroll) count as the same place. */
function addPoint(list: [number, number][], point: [number, number]): void {
  if (!list.some(([x, y]) => Math.abs(x - point[0]) < 0.02 && Math.abs(y - point[1]) < 0.02)) list.push(point);
}

/** The places the model says an icon is printed, for refreshing pictures without reading the catalog again. */
export async function locateIcon(ctx: ReadContext, warscroll: Buffer, keyword: string, description: string | undefined): Promise<[number, number][]> {
  const enlarged = await sharp(warscroll).resize({ width: 1600 }).png().toBuffer();
  const reply = await askJson<{ at?: unknown }>(ctx, [
    png(enlarged),
    text(`This is a Warhammer Underworlds warscroll. Its text prints a small icon that stands for "${keyword}"${description ? ` (${description})` : ''}, usually right after the word, like "${keyword} (icon)", and sometimes on its own inside a sentence, like "has the (icon) runemark". List every place in the text where that icon is printed, as the [x, y] centre of the icon in fractions of the image, measured from its top-left corner. Places where the word is printed right before the icon come first.
Return JSON: {"at": [[0.42, 0.31], [0.6, 0.72]]}
Return ONLY valid JSON, no markdown code fences or explanation.`),
  ]);
  const points: [number, number][] = [];
  if (Array.isArray(reply.at)) for (const p of reply.at) {
    const point = parsePoint(p);
    if (point) addPoint(points, point);
  }
  return points;
}

interface Attempt {
  zoomed: Buffer;
  phrase?: Buffer;
  icon?: Buffer;
}

/**
 * One place: a generous area around the model's rough point is cut and enlarged, and the model
 * places the icon again inside it (its centre, and the box around the icon alone). The sheet
 * picture is a fixed window around the centre, wider to the left where the keyword is, so the
 * icon is never cut in half; the app picture is the icon's box. A last call checks both, and
 * only pictures that pass are returned.
 */
async function cropAt(ctx: ReadContext, warscroll: Buffer, keyword: string, description: string | undefined, point: [number, number]): Promise<Attempt> {
  const area = around(point, 0.1, 0.1, 0.07, 0.07);
  const zoomed = await cropFraction(warscroll, area, 4);
  const reply = await askJson<{ found?: unknown; at?: unknown; box?: unknown }>(ctx, [
    png(zoomed),
    text(`This is an enlarged part of a Warhammer Underworlds warscroll. Find the small icon that stands for "${keyword}"${description ? ` (${description})` : ''}. It is usually printed right after the word, like "${keyword} (icon)", but it can also stand on its own inside a sentence, like "has the (icon) runemark". Give the centre of that icon as [x, y], and the tight box around the icon alone (not any word, not the brackets) as [left, top, width, height], both as fractions of this image measured from its top-left corner. Return {"found": false} if it is not in this image.
Return JSON: {"found": true, "at": [0.5, 0.5], "box": [0.45, 0.42, 0.1, 0.16]}
Return ONLY valid JSON, no markdown code fences or explanation.`),
  ]);
  const inner = reply.found === false ? null : parsePoint(reply.at);
  if (!inner) return { zoomed };
  const centre: [number, number] = [area.left + inner[0] * area.width, area.top + inner[1] * area.height];
  const phrase = await cropFraction(warscroll, around(centre, 0.1, 0.03, 0.028, 0.028), 3);
  const box = parseBox(reply.box);
  const icon = box ? await cropFraction(zoomed, box, 1, 0.012) : null;
  const check = await askJson<{ phrase?: unknown; icon?: unknown }>(ctx, [
    png(phrase),
    ...(icon ? [png(icon)] : []),
    text(`Image 1 should show the word "${keyword}" followed by a small icon, with the whole icon visible (not cut off at any edge).${
      icon ? ` Image 2 should show that icon alone: the whole icon, not cut off, with no letters and no brackets in it.` : ''
    } Answer for each image whether it does.
Return JSON: {"phrase": true, "icon": true}
Return ONLY valid JSON.`),
  ]);
  return { zoomed, phrase: check.phrase === true ? phrase : undefined, icon: icon && check.icon === true ? icon : undefined };
}

/**
 * Cuts "keyword (icon)" out of the warscroll for the reference sheet, and the icon alone for the
 * app, trying the places the reads pointed at one by one (at most 4) until both pictures pass
 * their check. The model's points can land on any place the icon is printed, including one
 * where the keyword is not next to it ("has the (icon) runemark"), which is why one place is
 * not enough. Without a sheet picture that passes, the sheet shows a wider part of the
 * warscroll; without an app picture, the app shows the keyword as text.
 */
async function cropKeyword(
  ctx: ReadContext,
  warscroll: Buffer,
  keyword: string,
  description: string | undefined,
  points: [number, number][],
): Promise<{ image: Buffer; icon?: Buffer; flags: string[] }> {
  let phrase: Buffer | undefined;
  let icon: Buffer | undefined;
  // Wider pictures for the sheet when no tight one passes: preferably of a place where the icon was confirmed.
  let iconArea: Buffer | undefined;
  let firstArea: Buffer | undefined;
  let tried = 0;
  const errors: string[] = [];
  for (const point of points.slice(0, 4)) {
    tried++;
    try {
      const attempt = await cropAt(ctx, warscroll, keyword, description, point);
      firstArea ??= attempt.zoomed;
      if (attempt.icon) iconArea ??= attempt.zoomed;
      phrase ??= attempt.phrase;
      icon ??= attempt.icon;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    if (phrase && icon) break;
  }
  const where = `${tried} place${tried === 1 ? '' : 's'} tried${errors.length ? `; errors: ${errors.join('; ')}` : ''}`;
  const flags: string[] = [];
  if (!icon) flags.push(`warscroll icon "${keyword}": no picture of the icon alone passed its check (${where}), so the app shows the keyword as text`);
  if (!phrase) flags.push(`warscroll icon "${keyword}": no picture of the keyword with its icon passed its check (${where}), so the sheet shows a wider part of the warscroll`);
  const image = phrase ?? iconArea ?? firstArea ?? (await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="230" height="120"><rect width="100%" height="100%" fill="#fff"/><text x="115" y="70" font-family="Arial, sans-serif" font-size="22" text-anchor="middle">${escapeXml(keyword)} (no picture)</text></svg>`)).png().toBuffer());
  return { image, icon, flags };
}

export function describeTallies(outcome: FieldOutcome): string {
  return outcome.tallies.map((t) => `${t.canon} x${t.count}`).join(', ');
}

/** The core fighter, weapon and symbol entries (no warband ones). */
export function coreEntries(): RunemarkEntry[] {
  return [...CORE_FIGHTER, ...CORE_WEAPON, ...CORE_SYMBOLS.filter((s) => s.id !== 'crit')].map(coreEntry);
}

export async function buildCatalog(
  ctx: ReadContext,
  wb: { slug: string; name: string },
  sources: { icon: Buffer | null; warscroll: Buffer | null },
  settings: VoteSettings = { ...DEFAULT_VOTE_SETTINGS, initialReads: 3, maxReads: 7 },
): Promise<Catalog> {
  const core = coreEntries();
  const entries: RunemarkEntry[] = [];
  if (sources.icon) {
    entries.push({ id: wb.slug, label: `own runemark of ${wb.name}`, kind: 'fighter', source: 'warband', image: sources.icon });
  }
  entries.push(...core);
  const catalog: Catalog = { warband: wb.slug, entries, keywords: [], iconVotes: [], flags: [], reads: 0 };
  if (!sources.warscroll) return catalog;

  const coreSheet = await renderSheet('Core rules icons (id in bold)', core);
  const found = await readWarscrollIcons(ctx, wb.name, sources.warscroll, coreSheet, settings);
  catalog.keywords = found.keywords;
  catalog.iconVotes = found.outcomes;
  catalog.reads = found.reads + found.entries.length * 2;
  catalog.flags.push(...found.flags);
  for (const entry of found.entries) {
    if (entries.some((e) => e.id === entry.id)) {
      catalog.flags.push(`warscroll keyword "${entry.keyword}" has the same id as another runemark (${entry.id}); kept the first`);
      continue;
    }
    entries.push(entry);
  }
  return catalog;
}

export const fighterRunemarks = (c: Catalog) => c.entries.filter((e) => e.kind === 'fighter');

/**
 * Answers accepted for each entry: its id, and the names a model may write instead (the
 * keyword, the warband's name, the slug without "the-"), all slugified, mapped to the id.
 */
export function answerIds(entries: RunemarkEntry[], warband: { slug: string; name: string }): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    const names = [e.id, e.keyword ?? ''];
    if (e.source === 'warband') names.push(WARBAND_ANSWER, warband.name, warband.slug.replace(/^the-/, ''));
    for (const n of names) if (n && !map.has(slugify(n))) map.set(slugify(n), e.id);
  }
  return map;
}
export const weaponRunemarks = (c: Catalog) => c.entries.filter((e) => e.kind === 'weapon');
export const symbols = (c: Catalog) => c.entries.filter((e) => e.kind === 'symbol' || e.id === 'crit');

export interface CatalogSheets {
  fighter: Buffer;
  weapon: Buffer;
  all: Buffer;
}

export async function renderCatalogSheets(c: Catalog, name: string): Promise<CatalogSheets> {
  return {
    fighter: await renderSheet(`${name}: fighter runemarks (answer with the id in bold)`, fighterRunemarks(c)),
    weapon: await renderSheet(`${name}: weapon runemarks (answer with the id in bold)`, weaponRunemarks(c)),
    all: await renderSheet(`${name}: icons (use the id in bold)`, c.entries),
  };
}

/**
 * Cuts the pictures of a saved catalog's warscroll keywords again (dir is a runemarks/ folder),
 * without reading the catalog again: ids, keywords and votes stay as they are. The model lists
 * every place each icon is printed, and cropKeyword tries them in turn. Rewrites the folder.
 */
export async function refreshPictures(ctx: ReadContext, dir: string, warscroll: Buffer, warband: { slug: string; name: string }): Promise<Catalog> {
  const saved = JSON.parse(readFileSync(join(dir, 'runemarks.json'), 'utf8')) as ReturnType<typeof catalogJson>;
  const core = coreEntries();
  // Picture flags are replaced; flags about the votes are kept.
  const flags = saved.flags.filter((f) => !/^warscroll icon "[^"]*": .*(picture|app shows|sheet shows|placing it failed)/.test(f));
  const entries: RunemarkEntry[] = [];
  for (const r of saved.runemarks) {
    if (r.source === 'core') {
      const entry = core.find((e) => e.id === r.id && e.kind === r.kind) ?? core.find((e) => e.id === r.id);
      if (entry) entries.push(entry);
    } else if (r.source === 'warband') {
      entries.push({ id: r.id, label: r.label, kind: r.kind, source: 'warband', image: readFileSync(join(dir, 'icons', `${r.id}.png`)) });
    } else {
      const keyword = r.keyword ?? r.id;
      const description = r.label.includes(': ') ? r.label.slice(r.label.indexOf(': ') + 2) : undefined;
      const places = await locateIcon(ctx, warscroll, keyword, description);
      const cropped = await cropKeyword(ctx, warscroll, keyword, description, places);
      flags.push(...cropped.flags);
      entries.push({ id: r.id, label: r.label, kind: r.kind, source: 'warscroll', image: cropped.image, keyword, appIcon: cropped.icon });
    }
  }
  const catalog: Catalog = { warband: warband.slug, entries, keywords: saved.keywords, iconVotes: [], flags, reads: 0 };
  rmSync(dir, { recursive: true, force: true });
  saveCatalog(dir, catalog, await renderCatalogSheets(catalog, warband.name));
  return catalog;
}

/** Writes runemarks.json, the warband's own icons (icons/<id>.png) and the reference sheets into dir. */
export function saveCatalog(dir: string, catalog: Catalog, sheets: CatalogSheets): void {
  mkdirSync(join(dir, 'icons'), { recursive: true });
  writeFileSync(join(dir, 'runemarks.json'), `${JSON.stringify(catalogJson(catalog), null, 2)}
`);
  // icons/ is what the app shows for {icon:<id>}: the warband's own icon, and keyword icons that were cut out cleanly.
  // keywords/ keeps the "keyword (icon)" pictures from the sheet, for reference.
  for (const e of catalog.entries) {
    if (e.source === 'warband') writeFileSync(join(dir, 'icons', `${e.id}.png`), e.image);
    if (e.source !== 'warscroll') continue;
    mkdirSync(join(dir, 'keywords'), { recursive: true });
    writeFileSync(join(dir, 'keywords', `${e.id}.png`), e.image);
    if (e.appIcon) writeFileSync(join(dir, 'icons', `${e.id}.png`), e.appIcon);
  }
  writeFileSync(join(dir, 'fighter-runemarks.png'), sheets.fighter);
  writeFileSync(join(dir, 'weapon-runemarks.png'), sheets.weapon);
  writeFileSync(join(dir, 'all-icons.png'), sheets.all);
}

/** The catalog as JSON for the output folder (images are saved next to it as icons/<id>.png). */
export function catalogJson(c: Catalog) {
  return {
    warband: c.warband,
    runemarks: c.entries.map((e) => ({
      id: e.id,
      label: e.label,
      kind: e.kind,
      source: e.source,
      keyword: e.keyword ?? null,
      sheetPicture: e.source === 'warscroll' ? `keywords/${e.id}.png` : e.source === 'warband' ? `icons/${e.id}.png` : null,
      appIcon: e.source === 'warband' || e.appIcon ? `icons/${e.id}.png` : null,
    })),
    keywords: c.keywords,
    flags: c.flags,
  };
}
