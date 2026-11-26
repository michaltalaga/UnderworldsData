/**
 * npm run icons: writes every game icon and runemark as an SVG.
 *
 * - Core icons go to public/assets/<name>.svg, a warband's keyword runemarks (Grot, Volley...) to
 *   warbands/<slug>/runemarks/icons/<id>.svg. Both have the same 100x100 viewBox, with the glyph's
 *   bounding box fitted to 92x92 and centred, and use currentColor.
 *   - Vector icons are the official PDFs' own paths, copied as they are (VECTOR below).
 *   - The tokens and the card-type symbols exist only as small pictures in the core rules, so they
 *     are traced with Potrace from the picture, oriented as it is printed and enlarged first (TRACED).
 *   - Keyword runemarks no PDF draws are traced from the runemark circles of the fighter cards,
 *     averaged over every card that shows them (CARD), or from the icon npm run extract cut out of
 *     the warscroll, runemarks/keywords/<id>-icon.png (SCAN). runemarks.json's appIcon is brought up
 *     to date: the SVG when there is one.
 * - Faction runemarks (warbands/<slug>/icon.png, warbands/_ga/<faction>-icon.png) go next to the
 *   picture as icon.svg / <faction>-icon.svg: the glyph traced from the picture over the coloured
 *   disc and dark rim it sits on, in the picture's colours, with the disc filling the viewBox.
 *
 * Each SVG is rendered back and compared with its source (the PDF render, or the traced picture):
 * the overlap is printed, with contact sheets in extraction/icons/ (contact-sheet.png for the
 * one-colour icons, factions.png). The PDFs are downloaded to extraction/icons (not committed).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { join, relative } from 'path';
import * as mupdf from 'mupdf';
import sharp, { type OverlayOptions } from 'sharp';
import { GA_DIR, ROOT, WARBANDS_DIR } from './lib/data';

// esm-potrace-wasm's Node code calls require() and reads __dirname, which an ES module lacks.
const globals = globalThis as Record<string, unknown>;
globals.require ??= createRequire(import.meta.url);
globals.__dirname ??= ROOT;
const { potrace, init: potraceReady } = await import('esm-potrace-wasm');

const PDFS = {
  core: 'https://assets.warhammer-community.com/eng_15-10_warhammer_underworlds_core_rules_digital-nrmwa4mnix-ifmubc4bq2.pdf',
  // Grand Alliance warband rules (September 2025): Surge drawn as a vector
  ga: 'https://assets.warhammer-community.com/eng_15-10_warhammer_underworlds_warband_rules_grand_alliance-rqodkzuvx4-o1fnn4bc33.pdf',
  // Rules updates (February 2026): reprints many warband abilities with their keyword runemarks
  update: 'https://assets.warhammer-community.com/eng_11-02_whuw_core&key_rules_update-e1aisy8hzv-rohzrxwyn0.pdf',
  // Digital warband rules of Cyreni's Razors (Spanish; runemarks are the same in every language): Thrall
  cyreni: 'https://assets.warhammer-community.com/spa_whuw_cyrenis_razors-fwpxamtbpl-ajrden1f3d.pdf',
  // Digital warband rules of Ironsoul's Condemnors (Chinese): Shield Aetheric
  ironsouls: 'https://assets.warhammer-community.com/whuw_warband_ironsouls_condemnors_download_chi_11-oznwmpqmyo.pdf',
};
type Pdf = keyof typeof PDFS;
type Box = [number, number, number, number];

/**
 * Glyphs drawn as paths: the page and the box (PDF points, top-left origin) that holds the glyph.
 * With `warband`, a keyword runemark of that warband rather than a core icon.
 */
const VECTOR: { name: string; warband?: string; pdf: Pdf; page: number; box: Box }[] = [
  // core rules p18, index of runemarks and symbols
  { name: 'core-ability', pdf: 'core', page: 18, box: [147.9, 668, 153.7, 677] },
  { name: 'melee', pdf: 'core', page: 18, box: [150.9, 688.2, 157.6, 695] },
  { name: 'ranged', pdf: 'core', page: 18, box: [156.8, 697.6, 164.8, 705] },
  { name: 'range', pdf: 'core', page: 18, box: [127.7, 709.3, 135.1, 716] },
  { name: 'damage', pdf: 'core', page: 18, box: [220.8, 667.8, 228.8, 676] },
  { name: 'crit', pdf: 'core', page: 18, box: [218.7, 677.6, 227.3, 686.5] },
  { name: 'swords', pdf: 'core', page: 18, box: [216.7, 688.8, 224.9, 696.5] },
  { name: 'hammer', pdf: 'core', page: 18, box: [223.6, 698.1, 230.4, 706.8] },
  { name: 'shield', pdf: 'core', page: 18, box: [214.3, 708.5, 220, 717] },
  { name: 'dodge', pdf: 'core', page: 18, box: [298.7, 667.7, 306.3, 675.9] },
  { name: 'flanked', pdf: 'core', page: 18, box: [305.8, 678, 311.5, 686.5] },
  { name: 'surrounded', pdf: 'core', page: 18, box: [320, 688, 328.5, 696.5] },
  { name: 'fly', pdf: 'core', page: 18, box: [287.3, 698, 293.7, 706] },
  { name: 'leader', pdf: 'core', page: 18, box: [300.9, 709.2, 309.7, 715] },
  { name: 'underdog', pdf: 'core', page: 18, box: [399.1, 667.5, 404.7, 676.7] },
  { name: 'cleave', pdf: 'core', page: 18, box: [386.4, 679.1, 392.8, 685.5] },
  { name: 'ensnare', pdf: 'core', page: 18, box: [391.9, 688.8, 398.3, 695.4] },
  { name: 'brutal', pdf: 'core', page: 18, box: [385.2, 698.8, 391.9, 705.5] },
  { name: 'grievous', pdf: 'core', page: 18, box: [395.8, 708.3, 401.8, 715.9] },
  { name: 'grapple', pdf: 'core', page: 18, box: [477.7, 678.3, 483.3, 686] },
  { name: 'inspired', pdf: 'core', page: 18, box: [478.1, 687.6, 487.1, 696.5] },
  // the p18 Stagger is part picture; p11 (weapon abilities) draws it whole
  { name: 'stagger', pdf: 'core', page: 11, box: [348.1, 576.1, 355.5, 585] },
  { name: 'minion', pdf: 'core', page: 5, box: [373.7, 667.3, 379.6, 674.8] },
  { name: 'starting-hex', pdf: 'core', page: 15, box: [122.7, 308, 130.8, 316] },
  // the core rules print Surge only as a 19x17 picture
  { name: 'surge', pdf: 'ga', page: 1, box: [102.05, 327.98, 110.19, 335.03] },
  // warband keyword runemarks, printed next to the keyword in the reprinted abilities
  { name: 'conductive', warband: 'the-exiled-dead', pdf: 'update', page: 7, box: [121.3, 620.7, 128, 628] },
  { name: 'loonknight', warband: 'grinkraks-looncourt', pdf: 'update', page: 9, box: [215.3, 323, 220.6, 331.6] },
  { name: 'agent-azyrite', warband: 'hexbanes-hunters', pdf: 'update', page: 10, box: [222, 652.6, 229.6, 661.1] },
  { name: 'saurus', warband: 'jaws-of-itzl', pdf: 'update', page: 11, box: [76.9, 636.3, 84.3, 643.3] },
  { name: 'gnoblar', warband: 'hrothgorns-mantrappers', pdf: 'update', page: 11, box: [123.2, 322.5, 130.3, 329.4] },
  { name: 'slashing', warband: 'kamandoras-blades', pdf: 'update', page: 13, box: [82.9, 708.3, 88.6, 714] },
  { name: 'snarlfangs-jaws', warband: 'rippas-snarlfangs', pdf: 'update', page: 16, box: [108.5, 656, 114.7, 662.8] },
  { name: 'chef', warband: 'the-skinnerkin', pdf: 'update', page: 17, box: [226.4, 603.1, 233.3, 608.1] },
  { name: 'fillet', warband: 'the-skinnerkin', pdf: 'update', page: 17, box: [131.6, 657.2, 137.3, 665.8] },
  { name: 'grave-guard', warband: 'sons-of-velmorn', pdf: 'update', page: 18, box: [98.7, 438.3, 104.7, 445.4] },
  { name: 'bile-blade', warband: 'the-wurmspat', pdf: 'update', page: 20, box: [88.8, 433.4, 95.4, 436.7] },
  { name: 'grot', warband: 'zarbags-gitz', pdf: 'update', page: 22, box: [361.1, 316.6, 369.1, 322.2] },
  { name: 'squig', warband: 'zarbags-gitz', pdf: 'update', page: 22, box: [231.6, 353.2, 239.5, 360.7] },
  { name: 'volley', warband: 'zarbags-gitz', pdf: 'update', page: 22, box: [215.3, 472.8, 223.3, 478.8] },
  { name: 'schemer', warband: 'spiteclaws-swarm', pdf: 'update', page: 26, box: [114.5, 754.2, 120, 761] },
  { name: 'destined', warband: 'zondaras-gravebreakers', pdf: 'update', page: 27, box: [230.33, 534.97, 237, 541.79] },
  { name: 'thrall', warband: 'cyrenis-razors', pdf: 'cyreni', page: 1, box: [245.1, 532.2, 248.6, 539.6] },
  { name: 'shield-aetheric', warband: 'ironsouls-condemners', pdf: 'ironsouls', page: 1, box: [308.9, 611.5, 313.5, 618.9] },
];

/**
 * Glyphs printed only as pictures (core rules p9 tokens, p13 card types): the picture of that
 * pixel size under `at` (a point on the page), and which of its pixels are the glyph: light ones,
 * or light and red ones (Charge's red arrow).
 */
type Ink = 'light' | 'light-or-red' | 'dark';
const TRACED: { name: string; pdf: Pdf; page: number; at: [number, number]; size: [number, number]; ink: Ink }[] = [
  { name: 'move', pdf: 'core', page: 9, at: [272, 270], size: [93, 93], ink: 'light' },
  { name: 'charge', pdf: 'core', page: 9, at: [271, 473], size: [90, 90], ink: 'light-or-red' },
  { name: 'guard', pdf: 'core', page: 9, at: [270, 574], size: [91, 92], ink: 'light' },
  { name: 'ploy', pdf: 'core', page: 13, at: [281, 508], size: [60, 64], ink: 'light' },
  { name: 'upgrade', pdf: 'core', page: 13, at: [281, 647], size: [60, 69], ink: 'light' },
];

/**
 * Runemarks no PDF draws: traced from the fighter cards that fighters.json says show them (a
 * light glyph in a dark runemark circle, or in a weapon ability hexagon), averaged.
 */
const CARD: { name: string; warband: string }[] = [
  { name: 'assassin', warband: 'skittershanks-clawpack' },
  { name: 'bulwark', warband: 'sons-of-velmorn' },
  { name: 'chaos-duardin', warband: 'blood-of-the-bull' },
  { name: 'idoneth', warband: 'elathains-soulraid' },
  { name: 'mortis-reaper', warband: 'thanateks-tithe' },
  { name: 'retainer', warband: 'thanateks-tithe' },
  { name: 'skink', warband: 'the-starblood-stalkers' },
  { name: 'swashbuckle', warband: 'blackpowders-buccaneers' },
];

/** Keywords printed only in warscroll text: traced from the icon npm run extract cut out of the warscroll (runemarks/keywords/<id>-icon.png, dark on paper). */
const SCAN: { name: string; warband: string }[] = [
  { name: 'asterism', warband: 'the-starblood-stalkers' },
  { name: 'gardener', warband: 'grandfathers-gardeners' },
];

const SIZE = 100; // viewBox
const GLYPH = 92; // the bounding box's longer side; the rest is padding
const UPSCALE = 8; // pictures are enlarged this much before tracing
const CHECK_PX = 800; // the size the SVGs are rendered at to measure them
const CACHE = join(ROOT, 'extraction', 'icons');
const OUT = join(ROOT, 'public', 'assets');
const keywordFile = (warband: string, name: string) => join(WARBANDS_DIR, warband, 'runemarks', 'icons', `${name}.svg`);

// ---------- PDFs ----------

const docs = new Map<Pdf, mupdf.Document>();
async function openPdf(key: Pdf): Promise<mupdf.Document> {
  const cached = docs.get(key);
  if (cached) return cached;
  const file = join(CACHE, `${key}.pdf`);
  if (!existsSync(file)) {
    console.log(`  downloading ${PDFS[key]}`);
    const res = await fetch(PDFS[key]);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${PDFS[key]}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const doc = mupdf.Document.openDocument(readFileSync(file), 'application/pdf');
  docs.set(key, doc);
  return doc;
}

/**
 * mupdf.js 1.3 wraps the objects it lends a custom Device in wrappers that free them when garbage
 * collected; the page frees them too, and the second free breaks the WASM heap. Let go of them.
 */
function borrowed(args: unknown[]) {
  for (const a of args) {
    const registry = (a as { constructor?: { _finalizer?: FinalizationRegistry<number> } } | null)?.constructor?._finalizer;
    if (registry && typeof (a as { pointer?: unknown }).pointer === 'number') registry.unregister(a as object);
  }
}

type Matrix = [number, number, number, number, number, number];
const apply = (m: Matrix, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

interface Op {
  /** SVG path data in page coordinates. */
  d: string;
  /** Control-point bounds, widened by half the stroke. */
  box: Box;
  evenOdd: boolean;
  stroke?: { width: number; cap: number; join: number; miter: number };
  /** Paper-coloured paint (white): it knocks out what was drawn under it. */
  paper: boolean;
}

/** How light a colour is, 0 (ink) to 1 (paper); a one-component spot colour is a tint of ink. */
function lightness(colorspace: mupdf.ColorSpace, color: number[]): number {
  const name = colorspace.getName();
  if (/gray/i.test(name) && color.length === 1) return color[0];
  if (/rgb/i.test(name) && color.length === 3) return 0.3 * color[0] + 0.59 * color[1] + 0.11 * color[2];
  if (/cmyk/i.test(name) && color.length === 4) return Math.max(0, 1 - (0.3 * color[0] + 0.59 * color[1] + 0.11 * color[2] + color[3]));
  return color.length === 1 ? 1 - color[0] : 0;
}

function pathOp(path: mupdf.Path, ctm: Matrix): { d: string; box: Box } {
  let d = '';
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  const pt = (x: number, y: number) => {
    const [px, py] = apply(ctm, x, y);
    box[0] = Math.min(box[0], px);
    box[1] = Math.min(box[1], py);
    box[2] = Math.max(box[2], px);
    box[3] = Math.max(box[3], py);
    return `${px} ${py}`;
  };
  path.walk({
    moveTo: (x, y) => (d += `M${pt(x, y)}`),
    lineTo: (x, y) => (d += `L${pt(x, y)}`),
    curveTo: (x1, y1, x2, y2, x3, y3) => (d += `C${pt(x1, y1)} ${pt(x2, y2)} ${pt(x3, y3)}`),
    closePath: () => (d += 'Z'),
  });
  return { d, box };
}

/** The paths a page paints inside box, in painting order. */
function opsIn(page: mupdf.Page, box: Box): Op[] {
  const ops: Op[] = [];
  const inside = (b: Box) => b[0] >= box[0] - 0.3 && b[1] >= box[1] - 0.3 && b[2] <= box[2] + 0.3 && b[3] <= box[3] + 0.3;
  const device = new mupdf.Device({
    fillPath(path: mupdf.Path, evenOdd: boolean, ctm: Matrix, colorspace: mupdf.ColorSpace, color: number[]) {
      borrowed([path, colorspace]);
      const op = pathOp(path, ctm);
      if (inside(op.box)) ops.push({ ...op, evenOdd, paper: lightness(colorspace, color) > 0.5 });
    },
    strokePath(path: mupdf.Path, stroke: mupdf.StrokeState, ctm: Matrix, colorspace: mupdf.ColorSpace, color: number[]) {
      borrowed([path, stroke, colorspace]);
      const m = ctm;
      const width = stroke.getLineWidth() * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
      const op = pathOp(path, m);
      const box: Box = [op.box[0] - width / 2, op.box[1] - width / 2, op.box[2] + width / 2, op.box[3] + width / 2];
      if (inside(box)) {
        ops.push({ d: op.d, box, evenOdd: false, paper: lightness(colorspace, color) > 0.5, stroke: { width, cap: stroke.getLineCap(), join: stroke.getLineJoin(), miter: stroke.getMiterLimit() } });
      }
    },
  });
  page.run(device, mupdf.Matrix.identity);
  device.close();
  return ops;
}

/** The picture of the given pixel size drawn under point `at`, turned the way the page shows it. */
async function pictureAt(page: mupdf.Page, at: [number, number], size: [number, number]): Promise<Buffer> {
  let found: { png: Buffer; m: Matrix } | null = null;
  const device = new mupdf.Device({
    fillImage(image: mupdf.Image, ctm: Matrix) {
      borrowed([image]);
      const m = ctm;
      const [x0, y0] = apply(m, 0, 0);
      const [x1, y1] = apply(m, 1, 1);
      const under = at[0] >= Math.min(x0, x1) && at[0] <= Math.max(x0, x1) && at[1] >= Math.min(y0, y1) && at[1] <= Math.max(y0, y1);
      if (!under || image.getWidth() !== size[0] || image.getHeight() !== size[1]) return;
      if (Math.abs(m[1]) > 1e-6 || Math.abs(m[2]) > 1e-6) throw new Error('rotated picture');
      const pixmap = image.toPixmap();
      found = { png: Buffer.from(pixmap.asPNG()), m };
      pixmap.destroy();
    },
  });
  page.run(device, mupdf.Matrix.identity);
  device.close();
  if (!found) throw new Error(`no ${size.join('x')} picture at ${at}`);
  const { png, m } = found as { png: Buffer; m: Matrix };
  // Pixel row 0 is drawn at unit y 0, so a negative scale prints the picture upside down.
  let img = sharp(png).removeAlpha();
  if (m[3] < 0) img = img.flip();
  if (m[0] < 0) img = img.flop();
  return img.png().toBuffer();
}

// ---------- SVG ----------

type Affine = { scale: number; dx: number; dy: number; flipY?: number };
const fmt = (v: number) => String(Math.round(v * 100) / 100).replace(/^-0$/, '0');

/** Transforms path data (M L H V C S Q T Z, absolute or relative) by x*s+dx, y*s+dy (y mirrored when flipY is set). */
function transformPath(d: string, t: Affine): string {
  const sy = t.flipY !== undefined ? -t.scale : t.scale;
  const dy = t.flipY !== undefined ? t.flipY * t.scale + t.dy : t.dy;
  const tokens = d.match(/[MLHVCSQTZmlhvcsqtz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  let out = '';
  let cmd = '';
  let i = 0;
  const num = () => +tokens[i++];
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) {
      cmd = tokens[i++];
      out += cmd;
      if (cmd === 'Z' || cmd === 'z') continue;
    } else out += ' ';
    const rel = cmd === cmd.toLowerCase();
    const X = (x: number) => fmt(x * t.scale + (rel ? 0 : t.dx));
    const Y = (y: number) => fmt(y * sy + (rel ? 0 : dy));
    switch (cmd.toUpperCase()) {
      case 'H': out += X(num()); break;
      case 'V': out += Y(num()); break;
      default: {
        const pairs = { M: 1, L: 1, T: 1, C: 3, S: 2, Q: 2 }[cmd.toUpperCase()] ?? 0;
        if (!pairs) throw new Error(`path command ${cmd}`);
        const parts: string[] = [];
        for (let p = 0; p < pairs; p++) parts.push(`${X(num())} ${Y(num())}`);
        out += parts.join(' ');
        if (cmd === 'M') cmd = 'L';
        if (cmd === 'm') cmd = 'l';
      }
    }
  }
  return out;
}

const CAP = ['butt', 'round', 'square', 'round'];
const JOIN = ['miter', 'round', 'bevel', 'miter'];

/** One op as an SVG element, painted with `paint`. */
function element(op: Op, t: Affine, paint: string): string {
  const d = transformPath(op.d, t);
  if (op.stroke) {
    const s = op.stroke;
    return `<path fill="none" stroke="${paint}" stroke-width="${fmt(s.width * t.scale)}" stroke-linecap="${CAP[s.cap] ?? 'butt'}" stroke-linejoin="${JOIN[s.join] ?? 'miter'}" stroke-miterlimit="${fmt(s.miter)}" d="${d}"/>`;
  }
  return `<path${paint === 'currentColor' ? '' : ` fill="${paint}"`}${op.evenOdd ? ' fill-rule="evenodd"' : ''} d="${d}"/>`;
}

/** The ops as SVG body in painting order: paper-coloured paint masks out the ink drawn before it, within area (x, y, w, h). */
function svgBody(name: string, ops: Op[], t: Affine, area: Box = [0, 0, SIZE, SIZE]): string {
  let body = '';
  let masks = 0;
  for (const op of ops) {
    if (!op.paper) body += element(op, t, 'currentColor');
    else if (body) {
      const id = `${name}-knockout-${++masks}`;
      body = `<mask id="${id}"><rect${area[0] || area[1] ? ` x="${area[0]}" y="${area[1]}"` : ''} width="${area[2]}" height="${area[3]}" fill="#fff"/>${element(op, t, '#000')}</mask><g mask="url(#${id})">${body}</g>`;
    }
  }
  return body;
}

const svgDoc = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" fill="currentColor">${body}</svg>\n`;

/** The painted bounds of svg markup drawn in `view` (x, y, w, h), measured on a render. */
async function paintedBox(body: string, view: Box): Promise<Box> {
  const [x, y, w, h] = view;
  const px = 2400;
  const scale = px / Math.max(w, h);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w * scale)}" height="${Math.ceil(h * scale)}" viewBox="${x} ${y} ${w} ${h}" fill="#000">${body}</svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let row = 0; row < info.height; row++) {
    for (let col = 0; col < info.width; col++) {
      if (data[(row * info.width + col) * 4 + 3] < 128) continue;
      x0 = Math.min(x0, col);
      y0 = Math.min(y0, row);
      x1 = Math.max(x1, col + 1);
      y1 = Math.max(y1, row + 1);
    }
  }
  if (x0 === Infinity) throw new Error('nothing painted');
  return [x + x0 / scale, y + y0 / scale, x + x1 / scale, y + y1 / scale];
}

/** The transform that fits box into the 92x92 square in the middle of the viewBox. */
function fit(box: Box): Affine {
  const scale = GLYPH / Math.max(box[2] - box[0], box[3] - box[1]);
  return { scale, dx: SIZE / 2 - ((box[0] + box[2]) / 2) * scale, dy: SIZE / 2 - ((box[1] + box[3]) / 2) * scale };
}

// ---------- tracing ----------

/** Otsu's threshold of a 0-255 histogram. */
function otsu(values: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of values) hist[v]++;
  const total = values.length;
  const sum = hist.reduce((s, h, i) => s + h * i, 0);
  let [sumB, weightB, best, threshold] = [0, 0, -1, 128];
  for (let i = 0; i < 256; i++) {
    weightB += hist[i];
    if (!weightB || weightB === total) continue;
    sumB += hist[i] * i;
    const mB = sumB / weightB;
    const mF = (sum - sumB) / (total - weightB);
    const between = weightB * (total - weightB) * (mB - mF) ** 2;
    if (between > best) [best, threshold] = [between, i];
  }
  return threshold;
}

interface Bitmap {
  /** Black glyph (0) on white (255), 1 channel. */
  bitmap: Buffer;
  width: number;
  height: number;
}

/** A 0-255 glyph score (high = glyph), enlarged UPSCALE times and split at `threshold`. */
async function enlarge(score: Uint8Array, width: number, height: number, threshold: number): Promise<Bitmap> {
  const big = await sharp(Buffer.from(score), { raw: { width, height, channels: 1 } })
    .resize(width * UPSCALE, height * UPSCALE, { kernel: 'lanczos3' })
    .extractChannel(0)
    .raw()
    .toBuffer();
  const bitmap = Buffer.alloc(big.length);
  for (let i = 0; i < bitmap.length; i++) bitmap[i] = big[i] > threshold ? 0 : 255;
  return { bitmap, width: width * UPSCALE, height: height * UPSCALE };
}

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** The glyph pixels of a picture, enlarged and smoothed. */
async function glyphBitmap(png: Buffer, ink: Ink): Promise<Bitmap> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const score = new Uint8Array(info.width * info.height);
  for (let i = 0; i < score.length; i++) {
    const [r, g, b] = [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
    const light = luma(r, g, b);
    score[i] = Math.min(255, ink === 'dark' ? 255 - light : ink === 'light-or-red' ? Math.max(light, 1.5 * (r - Math.max(g, b))) : light);
  }
  return enlarge(score, info.width, info.height, otsu(score));
}

/** Potrace's outline of a black-on-white bitmap, as path data in bitmap pixels. */
async function trace(bitmap: Buffer, width: number, height: number): Promise<string> {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < bitmap.length; i++) rgba.set([bitmap[i], bitmap[i], bitmap[i], 255], i * 4);
  await potraceReady();
  const svg = await potrace({ data: rgba, width, height } as unknown as ImageData, {
    extractcolors: false,
    turdsize: (UPSCALE * 1.5) ** 2,
    alphamax: 1,
    opticurve: 1,
    opttolerance: 0.2,
  });
  // Potrace draws in tenths of a pixel with y up: <g transform="translate(0,H) scale(0.1,-0.1)">
  const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  if (!paths.length) throw new Error('nothing traced');
  return transformPath(paths.join(''), { scale: 0.1, dx: 0, dy: 0, flipY: height * 10 });
}

// ---------- checking ----------

/** Share of glyph pixels the two masks agree on: |A and B| / |A or B|. */
function overlap(a: Uint8Array, b: Uint8Array): number {
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) both++;
    if (a[i] || b[i]) either++;
  }
  return either ? both / either : 1;
}

/** Ink mask (1 = glyph) of svg markup rendered `scale` pixels per user unit, width x height pixels. */
async function svgMask(svg: string, scale: number, width: number, height: number): Promise<Uint8Array> {
  const { data, info } = await sharp(Buffer.from(svg), { density: 72 * scale }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height) throw new Error(`rendered ${info.width}x${info.height}, expected ${width}x${height}`);
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  return mask;
}

/**
 * The page rendered so that the SVG's viewBox lands on CHECK_PX x CHECK_PX: dark pixels within
 * the glyph's box (viewBox units, plus half a unit) are ink, so neighbouring text does not count.
 */
function pdfMask(page: mupdf.Page, t: Affine, glyph: Box): { mask: Uint8Array; png: Buffer } {
  const k = CHECK_PX / SIZE;
  const s = t.scale * k;
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, CHECK_PX, CHECK_PX], false);
  pixmap.clear(255);
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
  page.run(device, [s, 0, 0, s, t.dx * k, t.dy * k]);
  device.close();
  const pixels = new Uint8Array(pixmap.getPixels()); // a view into WASM memory: copy it before anything else allocates
  const png = Buffer.from(pixmap.asPNG());
  pixmap.destroy();
  const [x0, y0, x1, y1] = [(glyph[0] - 0.5) * k, (glyph[1] - 0.5) * k, (glyph[2] + 0.5) * k, (glyph[3] + 0.5) * k];
  const mask = new Uint8Array(CHECK_PX * CHECK_PX);
  for (let y = 0; y < CHECK_PX; y++) {
    for (let x = 0; x < CHECK_PX; x++) {
      const i = y * CHECK_PX + x;
      const light = 0.299 * pixels[i * 3] + 0.587 * pixels[i * 3 + 1] + 0.114 * pixels[i * 3 + 2];
      mask[i] = x >= x0 && x < x1 && y >= y0 && y < y1 && light < 128 ? 1 : 0;
    }
  }
  return { mask, png };
}

/** box mapped by t. */
const mapBox = (box: Box, t: Affine): Box => [box[0] * t.scale + t.dx, box[1] * t.scale + t.dy, box[2] * t.scale + t.dx, box[3] * t.scale + t.dy];

interface Built {
  name: string;
  /** Where the SVG goes. */
  file: string;
  svg: string;
  /** What the SVG was measured against, for the contact sheet. */
  source: Buffer;
  score: number;
  how: string;
}

const iconFile = (name: string, warband?: string) => (warband ? keywordFile(warband, name) : join(OUT, `${name}.svg`));

async function buildVector(icon: (typeof VECTOR)[number]): Promise<Built> {
  const page = (await openPdf(icon.pdf)).loadPage(icon.page - 1);
  const ops = opsIn(page, icon.box);
  if (!ops.length) throw new Error(`${icon.name}: no paths in the box`);
  const [x0, y0, x1, y1] = icon.box;
  const view: Box = [x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2];
  const painted = await paintedBox(svgBody(icon.name, ops, { scale: 1, dx: 0, dy: 0 }, view), view);
  const t = fit(painted);
  const svg = svgDoc(svgBody(icon.name, ops, t));
  const ref = pdfMask(page, t, mapBox(painted, t));
  const score = overlap(ref.mask, await svgMask(svg, CHECK_PX / SIZE, CHECK_PX, CHECK_PX));
  return { name: icon.name, file: iconFile(icon.name, icon.warband), svg, source: ref.png, score, how: `vector, ${icon.pdf} p${icon.page}` };
}

/** Traces a glyph bitmap into a fitted one-colour SVG, measured against the bitmap. */
async function fromBitmap(name: string, file: string, { bitmap, width, height }: Bitmap, source: Buffer, how: string): Promise<Built> {
  const d = await trace(bitmap, width, height);
  const t = fit(await paintedBox(`<path d="${d}"/>`, [0, 0, width, height]));
  const svg = svgDoc(`<path d="${transformPath(d, t)}"/>`);
  // Measured in the bitmap's own pixels: the viewBox placed where it falls on the bitmap.
  const [bx, by, bw] = [-t.dx / t.scale, -t.dy / t.scale, SIZE / t.scale];
  const placed = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><svg x="${bx}" y="${by}" width="${bw}" height="${bw}" viewBox="0 0 ${SIZE} ${SIZE}">${svg.replace(/^<svg[^>]*>|<\/svg>\n$/g, '')}</svg></svg>`;
  const reference = new Uint8Array(width * height);
  for (let i = 0; i < reference.length; i++) reference[i] = bitmap[i] < 128 ? 1 : 0;
  const score = overlap(reference, await svgMask(placed, 1, width, height));
  return { name, file, svg, source, score, how };
}

async function buildTraced(icon: (typeof TRACED)[number]): Promise<Built> {
  const page = (await openPdf(icon.pdf)).loadPage(icon.page - 1);
  const picture = await pictureAt(page, icon.at, icon.size);
  return fromBitmap(icon.name, iconFile(icon.name), await glyphBitmap(picture, icon.ink), picture, `traced, ${icon.pdf} p${icon.page} ${icon.size.join('x')} picture`);
}

async function buildScan(icon: (typeof SCAN)[number]): Promise<Built> {
  const source = join(WARBANDS_DIR, icon.warband, 'runemarks', 'keywords', `${icon.name}-icon.png`);
  const picture = readFileSync(source);
  const { width, height } = await sharp(picture).metadata();
  return fromBitmap(icon.name, keywordFile(icon.warband, icon.name), await glyphBitmap(picture, 'dark'), picture, `traced, warscroll cut-out ${width}x${height}`);
}

// ---------- fighter card runemarks ----------

/**
 * Where a 514x718 fighter card prints its runemarks: the circles down the right side (the first
 * one's centre and radius, and the step to the next), and the weapon ability hexagons at the right
 * end of each weapon bar (the first one's centre, the step to the next ability, and to the next
 * weapon's bar). `inset` keeps the glyph's mask off the rim.
 */
const CARD_LAYOUT = {
  width: 514,
  circle: { x: 464, y: 123, step: 68, r: 27, inset: 4 },
  hexagon: { x: 400, y: 625, step: 40, weapon: 60, r: 17, inset: 2 },
};

interface CardSide {
  runemarks?: string[];
  weapons?: { abilities?: { name: string; critical?: boolean }[] }[];
}

interface FightersFile {
  fighters: { index: number; uninspired?: CardSide; inspired?: CardSide }[];
}

/** Where to look for a runemark on a card (514 px wide), for findCircle. */
interface CardSpot {
  file: string;
  x: number;
  y: number;
  r: number;
  inset: number;
}

/** The fighter cards that show runemark `name`, in a runemark circle or a weapon ability hexagon, and where. */
function cardSamples(warband: string, name: string): CardSpot[] {
  const { fighters } = JSON.parse(readFileSync(join(WARBANDS_DIR, warband, 'fighters.json'), 'utf8')) as FightersFile;
  const { circle, hexagon } = CARD_LAYOUT;
  const samples: CardSpot[] = [];
  for (const fighter of fighters) {
    for (const [side, suffix] of [['uninspired', ''], ['inspired', '-inspired']] as const) {
      const file = join(WARBANDS_DIR, warband, 'fighters', `${fighter.index}${suffix}.png`);
      if (!existsSync(file)) continue;
      const slot = fighter[side]?.runemarks?.indexOf(name) ?? -1;
      if (slot >= 0) samples.push({ file, x: circle.x, y: circle.y + circle.step * slot, r: circle.r, inset: circle.inset });
      for (const [w, weapon] of (fighter[side]?.weapons ?? []).entries()) {
        // A Critical marker takes a hexagon of its own, before the runemark it makes critical.
        let k = 0;
        for (const ability of weapon.abilities ?? []) {
          if (ability.critical) k++;
          if (ability.name === name) samples.push({ file, x: hexagon.x + hexagon.step * k, y: hexagon.y + hexagon.weapon * w, r: hexagon.r, inset: hexagon.inset });
          k++;
        }
      }
    }
  }
  return samples;
}

function ringMean(light: Uint8Array, width: number, cx: number, cy: number, r: number): number {
  let sum = 0;
  for (let k = 0; k < 64; k++) {
    const a = (k / 64) * 2 * Math.PI;
    sum += light[Math.round(cy + r * Math.sin(a)) * width + Math.round(cx + r * Math.cos(a))];
  }
  return sum / 64;
}

/** The dark circle near (gx, gy) of about radius gr: where the ring just outside it is lightest against the ring just inside. */
function findCircle(light: Uint8Array, width: number, gx: number, gy: number, gr: number): { cx: number; cy: number; r: number } {
  let best = { cx: gx, cy: gy, r: gr, score: -Infinity };
  for (let cy = gy - 8; cy <= gy + 8; cy++) {
    for (let cx = gx - 8; cx <= gx + 8; cx++) {
      for (let r = gr - 4; r <= gr + 4; r++) {
        const score = ringMean(light, width, cx, cy, r + 2) - ringMean(light, width, cx, cy, r - 3);
        if (score > best.score) best = { cx, cy, r, score };
      }
    }
  }
  return best;
}

/**
 * The light glyph inside each sample's runemark circle or hexagon, enlarged to one size, aligned
 * with the first and averaged, so the noise of a single print evens out; split by Otsu's threshold.
 */
async function cardGlyph(samples: CardSpot[]): Promise<{ bitmap: Bitmap; picture: Buffer }> {
  const crops: Uint8Array[] = [];
  let picture: Buffer | null = null;
  let side = 0;
  for (const sample of samples) {
    const { data, info } = await sharp(sample.file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const k = info.width / CARD_LAYOUT.width;
    const light = new Uint8Array(info.width * info.height);
    for (let i = 0; i < light.length; i++) light[i] = luma(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]);
    const c = findCircle(light, info.width, Math.round(sample.x * k), Math.round(sample.y * k), Math.round(sample.r * k));
    const half = c.r + 2;
    const n = 2 * half + 1;
    side ||= n * UPSCALE;
    // Inside the circle (or the hexagon's inscribed circle), off the rim: the picture's lightness.
    // Outside: the disc's typical (median) lightness, so the only split left is disc against glyph.
    const within = (x: number, y: number) => Math.hypot(x - half, y - half) <= c.r - sample.inset * k;
    const inside: number[] = [];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (within(x, y)) inside.push(light[(c.cy - half + y) * info.width + c.cx - half + x]);
    const disc = median(inside);
    const score = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) score[y * n + x] = within(x, y) ? light[(c.cy - half + y) * info.width + c.cx - half + x] : disc;
    picture ??= await sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } }).extract({ left: c.cx - half, top: c.cy - half, width: n, height: n }).png().toBuffer();
    crops.push(new Uint8Array(await sharp(Buffer.from(score), { raw: { width: n, height: n, channels: 1 } }).resize(side, side, { kernel: 'lanczos3' }).extractChannel(0).raw().toBuffer()));
  }
  if (!crops.length || !picture) throw new Error('no fighter card shows it');
  const sum = new Float64Array(side * side);
  const [reference] = crops;
  for (const crop of crops) {
    let best = { dx: 0, dy: 0, match: -Infinity };
    for (let dy = -UPSCALE; dy <= UPSCALE; dy++) {
      for (let dx = -UPSCALE; dx <= UPSCALE; dx++) {
        let match = 0;
        for (let y = UPSCALE; y < side - UPSCALE; y += 3) for (let x = UPSCALE; x < side - UPSCALE; x += 3) match += reference[y * side + x] * crop[(y + dy) * side + x + dx];
        if (match > best.match) best = { dx, dy, match };
      }
    }
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const [sx, sy] = [x + best.dx, y + best.dy];
        if (sx >= 0 && sy >= 0 && sx < side && sy < side) sum[y * side + x] += crop[sy * side + sx];
      }
    }
  }
  const average = new Uint8Array(side * side);
  for (let i = 0; i < average.length; i++) average[i] = Math.round(sum[i] / crops.length);
  const threshold = otsu(average);
  const bitmap = Buffer.alloc(side * side);
  for (let i = 0; i < bitmap.length; i++) bitmap[i] = average[i] > threshold ? 0 : 255;
  return { bitmap: { bitmap, width: side, height: side }, picture };
}

async function buildCard(icon: (typeof CARD)[number]): Promise<Built> {
  const samples = cardSamples(icon.warband, icon.name);
  const { bitmap, picture } = await cardGlyph(samples);
  return fromBitmap(icon.name, keywordFile(icon.warband, icon.name), bitmap, picture, `traced, ${samples.length} fighter card prints`);
}

// ---------- faction runemarks ----------

interface Faction extends Built {
  /** Mean difference of the rendered SVG from the picture over the disc, 0-255 per channel. */
  colour: number;
}

const hex = (rgb: number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * A faction runemark: a light glyph on a coloured, textured disc with a dark rim. The SVG keeps
 * the disc (filling the viewBox) and the rim in the picture's colours, the texture becoming a
 * radial gradient from the disc's middle to its edge, with the glyph traced on top.
 */
async function buildFaction(name: string, source: string, file: string): Promise<Faction> {
  const picture = readFileSync(source);
  const { data, info } = await sharp(picture).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  // The disc: the opaque pixels.
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 128) continue;
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
  }
  const [cx, cy, R] = [(x0 + x1 + 1) / 2, (y0 + y1 + 1) / 2, Math.max(x1 - x0 + 1, y1 - y0 + 1) / 2];
  const at = (x: number, y: number) => (Math.min(height - 1, Math.max(0, Math.floor(y))) * width + Math.min(width - 1, Math.max(0, Math.floor(x)))) * 4;
  // The rim: how far in from the edge the pixels stay near black, along 90 rays.
  const rims: number[] = [];
  for (let k = 0; k < 90; k++) {
    const a = (k / 90) * 2 * Math.PI;
    let t = 0.5;
    while (t < R * 0.3) {
      const i = at(cx + (R - t) * Math.cos(a), cy + (R - t) * Math.sin(a));
      if (Math.max(data[i], data[i + 1], data[i + 2]) > 60) break;
      t += 0.5;
    }
    rims.push(t);
  }
  const inner = R - median(rims);
  // The glyph: the whitest pixels inside the disc (the least saturated and lightest).
  const whiteness = new Uint8Array(width * height);
  const values: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) >= inner - 1) continue;
      const i = (y * width + x) * 4;
      whiteness[y * width + x] = Math.min(data[i], data[i + 1], data[i + 2]);
      values.push(whiteness[y * width + x]);
    }
  }
  const threshold = otsu(Uint8Array.from(values));
  const bitmap = await enlarge(whiteness, width, height, threshold);
  const d = await trace(bitmap.bitmap, bitmap.width, bitmap.height);
  // Colours: the glyph's bright middle, the disc around the middle and near the edge, the rim.
  const sums = { glyph: [0, 0, 0, 0], middle: [0, 0, 0, 0], edge: [0, 0, 0, 0], rim: [0, 0, 0, 0] };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue;
      const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const w = Math.min(data[i], data[i + 1], data[i + 2]);
      const part =
        dist > inner + 0.75 && dist < R - 0.75 ? sums.rim
        : dist >= inner - 1 ? null
        : w > threshold + 0.35 * (255 - threshold) ? sums.glyph
        : w > threshold * 0.85 ? null
        : dist < 0.5 * inner ? sums.middle
        : dist > 0.7 * inner ? sums.edge
        : null;
      if (part) [0, 1, 2].forEach((c) => (part[c] += data[i + c])), part[3]++;
    }
  }
  const colour = (s: number[], fallback: number[]) => hex(s[3] ? s.slice(0, 3).map((v) => v / s[3]) : fallback);
  const edge = colour(sums.edge, [80, 80, 80]);
  const s = SIZE / (2 * R);
  const t: Affine = { scale: s / UPSCALE, dx: SIZE / 2 - cx * s, dy: SIZE / 2 - cy * s };
  const glyph = transformPath(d, t);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<defs><radialGradient id="${name}-disc"><stop offset="0.35" stop-color="${colour(sums.middle, [80, 80, 80])}"/><stop offset="1" stop-color="${edge}"/></radialGradient></defs>` +
    `<circle cx="50" cy="50" r="50" fill="${colour(sums.rim, [20, 20, 20])}"/>` +
    `<circle cx="50" cy="50" r="${fmt((50 * inner) / R)}" fill="url(#${name}-disc)"/>` +
    `<path fill="${colour(sums.glyph, [230, 225, 215])}" d="${glyph}"/></svg>\n`;
  // The glyph, measured in the bitmap's pixels; the colours, over the disc in the picture's pixels.
  const placed = (w: number, h: number, k: number, body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><svg x="${(cx - R) * k}" y="${(cy - R) * k}" width="${2 * R * k}" height="${2 * R * k}" viewBox="0 0 ${SIZE} ${SIZE}">${body}</svg></svg>`;
  const reference = new Uint8Array(bitmap.width * bitmap.height);
  for (let i = 0; i < reference.length; i++) reference[i] = bitmap.bitmap[i] < 128 ? 1 : 0;
  const score = overlap(reference, await svgMask(placed(bitmap.width, bitmap.height, UPSCALE, `<path d="${glyph}"/>`), 1, bitmap.width, bitmap.height));
  const render = await sharp(Buffer.from(placed(width, height, 1, svg.replace(/^<svg[^>]*>|<\/svg>\n$/g, '')))).ensureAlpha().raw().toBuffer();
  let [diff, count] = [0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) >= R - 1) continue;
      const i = (y * width + x) * 4;
      diff += (Math.abs(data[i] - render[i]) + Math.abs(data[i + 1] - render[i + 1]) + Math.abs(data[i + 2] - render[i + 2])) / 3;
      count++;
    }
  }
  return { name, file, svg, source: picture, score, colour: diff / count, how: `traced, ${width}x${height} picture` };
}

/** Every faction runemark picture: the warbands' icon.png and the Grand Alliances' <faction>-icon.png. */
function factionSources(): { name: string; source: string; file: string }[] {
  const warbands = readdirSync(WARBANDS_DIR)
    .filter((slug) => !slug.startsWith('_') && existsSync(join(WARBANDS_DIR, slug, 'icon.png')))
    .map((slug) => ({ name: slug, source: join(WARBANDS_DIR, slug, 'icon.png'), file: join(WARBANDS_DIR, slug, 'icon.svg') }));
  const alliances = readdirSync(GA_DIR)
    .filter((f) => f.endsWith('-icon.png'))
    .map((f) => ({ name: f.replace('.png', ''), source: join(GA_DIR, f), file: join(GA_DIR, f.replace('.png', '.svg')) }));
  return [...warbands, ...alliances];
}

// ---------- contact sheets ----------

async function contactSheet(built: Built[]): Promise<Buffer> {
  const cell = 96;
  const tileW = cell * 3 + 40;
  const tileH = cell + 44;
  const cols = 4;
  const rows = Math.ceil(built.length / cols);
  const composites: OverlayOptions[] = [];
  let marks = '';
  for (const [i, b] of built.entries()) {
    const x = (i % cols) * tileW + 10;
    const y = Math.floor(i / cols) * tileH + 10;
    const source = await sharp(b.source).resize(cell, cell, { fit: 'contain', background: '#fff' }).flatten({ background: '#fff' }).png().toBuffer();
    const density = (72 * cell) / SIZE;
    const onLight = await sharp(Buffer.from(b.svg), { density }).png().toBuffer();
    const onDark = await sharp(Buffer.from(b.svg.replace(/currentColor/g, '#f2efe6')), { density }).png().toBuffer();
    composites.push({ input: source, left: x, top: y }, { input: onLight, left: x + cell + 10, top: y }, { input: onDark, left: x + 2 * cell + 20, top: y });
    const warband = relative(WARBANDS_DIR, b.file).startsWith('..') ? '' : relative(WARBANDS_DIR, b.file).split(/[\\/]/)[0];
    marks +=
      `<rect x="${x + cell + 10}" y="${y}" width="${cell}" height="${cell}" fill="#fff" stroke="#ccc"/>` +
      `<rect x="${x + 2 * cell + 20}" y="${y}" width="${cell}" height="${cell}" fill="#1a1a2e"/>` +
      `<text x="${x}" y="${y + cell + 18}" font-family="Arial" font-size="15" font-weight="bold" fill="${b.score < 0.98 ? '#c00' : '#000'}">${b.name}  ${(b.score * 100).toFixed(1)}%</text>` +
      `<text x="${x}" y="${y + cell + 34}" font-family="Arial" font-size="11" fill="#555">${warband ? `${warband}: ` : ''}${b.how}</text>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * tileW + 10}" height="${rows * tileH + 10}"><rect width="100%" height="100%" fill="#fff"/>${marks}</svg>`;
  return sharp(Buffer.from(svg)).composite(composites).png().toBuffer();
}

async function factionSheet(built: Faction[]): Promise<Buffer> {
  const cell = 110;
  const tileW = cell * 2 + 30;
  const tileH = cell + 44;
  const cols = 6;
  const rows = Math.ceil(built.length / cols);
  const composites: OverlayOptions[] = [];
  let marks = '';
  for (const [i, b] of built.entries()) {
    const x = (i % cols) * tileW + 10;
    const y = Math.floor(i / cols) * tileH + 10;
    const source = await sharp(b.source).resize(cell, cell, { fit: 'contain', background: '#fff' }).flatten({ background: '#fff' }).png().toBuffer();
    const svg = await sharp(Buffer.from(b.svg), { density: (72 * cell) / SIZE }).flatten({ background: '#fff' }).png().toBuffer();
    composites.push({ input: source, left: x, top: y }, { input: svg, left: x + cell + 10, top: y });
    marks +=
      `<text x="${x}" y="${y + cell + 18}" font-family="Arial" font-size="13" font-weight="bold" fill="${b.score < 0.98 ? '#c00' : '#000'}">${b.name.slice(0, 24)}</text>` +
      `<text x="${x}" y="${y + cell + 34}" font-family="Arial" font-size="11" fill="#555">glyph ${(b.score * 100).toFixed(1)}%, colour off by ${b.colour.toFixed(0)}</text>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * tileW + 10}" height="${rows * tileH + 10}"><rect width="100%" height="100%" fill="#fff"/>${marks}</svg>`;
  return sharp(Buffer.from(svg)).composite(composites).png().toBuffer();
}

// ---------- main ----------

const shown = (file: string) => relative(ROOT, file).replace(/\\/g, '/');

async function main() {
  mkdirSync(CACHE, { recursive: true });
  const built: Built[] = [];
  for (const icon of VECTOR) built.push(await buildVector(icon));
  for (const icon of TRACED) built.push(await buildTraced(icon));
  for (const icon of CARD) built.push(await buildCard(icon));
  for (const icon of SCAN) built.push(await buildScan(icon));
  built.sort((a, b) => shown(a.file).localeCompare(shown(b.file)));
  console.log('\n  icon               overlap  file, source');
  for (const b of built) {
    writeFileSync(b.file, b.svg);
    console.log(`  ${b.name.padEnd(18)} ${(b.score * 100).toFixed(1).padStart(6)}%  ${shown(b.file)}, ${b.how}${b.score < 0.98 ? '  <- under 98%' : ''}`);
  }
  writeFileSync(join(CACHE, 'contact-sheet.png'), await contactSheet(built));

  const factions: Faction[] = [];
  for (const f of factionSources()) factions.push(await buildFaction(f.name, f.source, f.file));
  console.log('\n  faction runemark                glyph  colour  file');
  for (const f of factions) {
    writeFileSync(f.file, f.svg);
    console.log(`  ${f.name.padEnd(30)} ${(f.score * 100).toFixed(1).padStart(6)}%  ${f.colour.toFixed(0).padStart(5)}  ${shown(f.file)}${f.score < 0.98 ? '  <- under 98%' : ''}`);
  }
  writeFileSync(join(CACHE, 'factions.png'), await factionSheet(factions));

  // The warscroll keywords of each catalog (runemarks.json): point appIcon at the SVG, and list those without one.
  const core = new Set(built.filter((b) => b.file.startsWith(OUT)).map((b) => b.name));
  const left: string[] = [];
  for (const slug of readdirSync(WARBANDS_DIR).filter((s) => !s.startsWith('_'))) {
    const file = join(WARBANDS_DIR, slug, 'runemarks', 'runemarks.json');
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const catalog = JSON.parse(text) as { runemarks: { id: string; source: string; appIcon?: string | null }[] };
    for (const r of catalog.runemarks.filter((r) => r.source === 'warscroll')) {
      const own = existsSync(keywordFile(slug, r.id));
      r.appIcon = own ? `icons/${r.id}.svg` : null;
      if (!own) left.push(`${slug}/${r.id}${core.has(r.id) ? ' (the core icon is used)' : ' (no SVG: add it to VECTOR, CARD or SCAN)'}`);
    }
    const updated = `${JSON.stringify(catalog, null, 2)}\n`;
    if (updated !== text) writeFileSync(file, updated);
  }
  if (left.length) console.log(`\n  warscroll keywords without their own SVG:\n${left.map((l) => `    ${l}`).join('\n')}`);
  console.log(`\n  ${built.length} icons and ${factions.length} faction runemarks; contact sheets: extraction/icons/contact-sheet.png, extraction/icons/factions.png`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
