import sharp from 'sharp';

/**
 * Parts of a fighter card (2024 Embergard layout), as fractions of the card's width and height
 * so they fit every scan size (most are 514x718, a few 744x1039). The boxes have wide margins:
 * the cards are photos, so everything shifts by a few pixels from card to card. Crops only give
 * the model bigger pixels to read; nothing is ever identified by comparing pixels.
 */
export const CARD_REGIONS = {
  /** Fighter name banner (the inspired side has the Inspired symbol before the name). */
  name: { left: 0, top: 0, width: 1, height: 0.135 },
  /** Move, Save, Health and Bounty, top to bottom down the left edge. */
  stats: { left: 0, top: 0.11, width: 0.24, height: 0.43 },
  /** Runemark circles down the right edge. */
  runemarks: { left: 0.77, top: 0.09, width: 0.23, height: 0.55 },
  /** Weapon bars at the bottom, with any weapon runemarks right of each bar. */
  weapons: { left: 0.1, top: 0.77, width: 0.9, height: 0.23 },
} as const;

export type CardRegion = keyof typeof CARD_REGIONS;
export const CARD_REGION_NAMES = Object.keys(CARD_REGIONS) as CardRegion[];

/** How much crops are enlarged. */
export const CROP_SCALE = 3;

/** Cuts one region out of a card image and enlarges it (PNG). */
export async function cropCardRegion(card: Buffer, region: CardRegion, scale = CROP_SCALE): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(card).metadata();
  const box = CARD_REGIONS[region];
  const left = Math.round(box.left * width);
  const top = Math.round(box.top * height);
  const extract = {
    left,
    top,
    width: Math.min(width - left, Math.round(box.width * width)),
    height: Math.min(height - top, Math.round(box.height * height)),
  };
  return sharp(card)
    .extract(extract)
    .resize(Math.round(extract.width * scale), Math.round(extract.height * scale), { kernel: 'lanczos3' })
    .png()
    .toBuffer();
}

/** Cuts a box given as fractions of the image (for example a box the model pointed at) and enlarges it. */
export async function cropFraction(
  image: Buffer,
  box: { left: number; top: number; width: number; height: number },
  scale = 1,
  pad = 0,
): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
  const left = clamp((box.left - pad) * width, width - 1);
  const top = clamp((box.top - pad) * height, height - 1);
  const right = clamp((box.left + box.width + pad) * width, width);
  const bottom = clamp((box.top + box.height + pad) * height, height);
  const extract = { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  return sharp(image)
    .extract(extract)
    .resize(Math.round(extract.width * scale), Math.round(extract.height * scale), { kernel: 'lanczos3' })
    .png()
    .toBuffer();
}

export async function imageSize(image: Buffer): Promise<{ width: number; height: number }> {
  const { width = 0, height = 0 } = await sharp(image).metadata();
  return { width, height };
}
