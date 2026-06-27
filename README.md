# Underworlds Warscrolls

A React web app for viewing and translating Warhammer Underworlds warscroll cards and rival decks. Supports English and Polish with a print-friendly layout.

## Prerequisites

- Node.js
- `ANTHROPIC_API_KEY` environment variable (required for `extract`, `translate`, `rivals:translate`)

## Development

```bash
npm install
npm run dev       # Start dev server on http://localhost:5173
npm run build     # TypeScript check + production build
npm run preview   # Preview the production build locally
```

## Data Pipeline Scripts

These scripts handle downloading, extracting, translating, and syncing game data. Run them with `npm run <script>`.

### `npm run status`

Shows completion status of the entire data pipeline. Reports which warbands are missing images, extracted data, or translations, and which rival decks are missing data or translations. No API key required.

### `npm run download`

Downloads warscroll card PNG images from underworldsdb.com. Downloads both generic Grand Alliance warscroll variants (8 images into `warbands/_ga/`) and OP-legal warband images into each warband's directory. Skips already-downloaded images. Processes in batches of 10.

### `npm run download:icons`

Downloads icon PNGs from underworldsdb.com: warband icons into each `warbands/<slug>/icon.png`, rival deck icons into each `rivals/<slug>/icon.png`, and the faction / Grand Alliance icons (`chaos`, `death`, `destruction`, `order`, `universal`) into `warbands/_ga/<faction>-icon.png`. Skips already-downloaded files.

### `npm run extract`

Extracts structured game data from warscroll card PNGs using Claude's vision API (Sonnet 4.6). Processes GA warscrolls in `_ga/` first, then OP-legal warbands. Outputs JSON with fields like name, grand alliance, abilities, reactions, and inspire conditions. Processes in batches (default 5, configurable via CLI argument).

### `npm run translate`

Translates English warscroll JSON files to Polish using the Claude API. Processes GA warscrolls in `_ga/` first, then OP-legal warbands. Preserves game icon tokens (`{icon:name}`). Skips already-translated files.

### `npm run rivals:sync`

Scrapes rival deck data from underworldsdb.com. Parses deck metadata (name, faction, plot, cards) from HTML and writes `rivals/index.json` plus individual `deck.json` files per rival deck. Supports filtering by deck slug/name via CLI argument.

### `npm run rivals:translate`

Translates rival deck `deck.json` files to Polish using the Claude API. Outputs `deck.pl.json` for each deck. Supports filtering by deck slug/name via CLI argument.

## Project Structure

```
warbands/           Warband data (60+ warbands)
  index.json        Master warband metadata
  _ga/              Shared Grand Alliance warscrolls (2 per alliance)
    chaos-1.json    GA Chaos variant 1
    chaos-2.json    GA Chaos variant 2
    ...             (+ .pl.json translations and .png images)
  _ga/              ... (+ `<faction>-icon.png` Grand Alliance / Universal icons)
  <warband>/        OP-legal warband data
    warscroll.png   Card image
    icon.png        Warband icon
    warscroll.json  Extracted English data (incl. `playstyle` pairings blurb)
    warscroll.pl.json  Polish translation (incl. `playstyle`)
rivals/             Rival deck data (13 decks)
  index.json        Master rival deck metadata
  <deck>/
    deck.json       English deck data (incl. `strategyTagline` + `strategy`)
    deck.pl.json    Polish translation (incl. `strategyTagline` + `strategy`)
    icon.png        Rival deck icon
warband-rivals-pairings.json     Warband × deck rating matrix (stars + per-pairing notes, EN)
warband-rivals-pairings.pl.json  Polish per-pairing notes
warband-rivals-pairings.md       Human-readable pairings reference
scripts/            Data pipeline scripts (TypeScript)
src/
  components/       React UI components
  data/             Pairings join layer (pairings.ts)
  types/            TypeScript interfaces
  i18n/             UI label translations
  styles/           CSS
  assets/icons/     Game icon SVGs
```

## Warband ↔ Rivals deck pairings

The **Pairings** tab rates every OP-legal warband against all 12 universal Rivals decks. The data is split to match the per-entity convention:

- Each warband's **playstyle** blurb lives in its `warscroll.json` (`playstyle`); each deck's **strategy** summary + tagline live in its `deck.json` (`strategyTagline`, `strategy`) — both translated in the paired `.pl.json` files.
- The star ratings (0–3) and per-pairing **notes** — an inherently warband×deck relation — live in `warband-rivals-pairings.json`, with Polish notes in `warband-rivals-pairings.pl.json`.

Each warband page lists its decks ranked by fit (with links), each deck page lists its best-matched warbands, and the Pairings tab shows the full matrix — all bilingual.
