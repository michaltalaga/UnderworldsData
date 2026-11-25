# Underworlds Warscrolls

A React web app for viewing and translating Warhammer Underworlds warscroll cards and rival decks. Supports English and Polish with a print-friendly layout.

## Prerequisites

- Node.js
- For `extract`, `translate` and `rivals:translate`, one usable [AI provider](#ai-providers): an `ANTHROPIC_API_KEY`, or the Claude CLI (`claude`) logged in with `claude auth login`

## Development

```bash
npm install
npm run dev       # Start dev server on http://localhost:5173
npm run build     # TypeScript check + production build
npm run preview   # Preview the production build locally
```

## Data Pipeline Scripts

These scripts handle downloading, extracting, translating, and syncing game data. Run them with `npm run <script>`.

### `npm run sync`

Brings all data up to date in one go. It always runs `download` and `rivals:sync` first, since only they can find new warbands or decks on underworldsdb.com. After that it runs each of `download:icons`, `download:fighters`, `extract`, `extract:fighters`, `translate`, `rivals:translate` and `pairings` only when `status` reports a gap that script fills, re-checking before every step. It ends with the full status report and exits with an error if any step failed or a gap remains. `--provider api|cli` is passed on to the AI steps, and `--dry-run` shows the gaps and the steps that would run without running them.

In PowerShell, `npm.ps1` drops the `--` in `npm run sync -- --dry-run`, so npm reads the flag as its own option. The scripts read `--dry-run` and `--provider` back from npm's config in that case, so the same commands work in PowerShell, cmd and bash.

### AI providers

`extract`, `extract:fighters`, `translate`, `rivals:translate` and `pairings` call Claude (Sonnet 4.6) through a provider layer in `scripts/ai/`. Providers are tried in this order, and the first usable one is used:

1. **Anthropic API** (`api`): the Anthropic SDK with `ANTHROPIC_API_KEY`. Usable when the key is set and a free models-list call accepts it. API usage is billed to the key's Console account.
2. **Claude CLI** (`cli`): runs `claude -p` with no tools, no CLAUDE.md or plugins, and no saved session; images are sent inline, so the CLI never opens files. Usable when `claude` is on PATH and `claude auth status` reports a login. It runs without `ANTHROPIC_API_KEY`, so it uses the CLI's own login (for example a Claude subscription).

If the provider in use stops working during a run (key rejected, credit balance too low, rate limited, service down, CLI logged out or at its usage limit), the card being processed is retried on the next provider, which handles the rest of the run. If no provider is left, the script stops with an error.

To skip detection and use one provider only, pass `--provider api|cli` or set `AI_PROVIDER`, for example `npm run extract -- --provider cli 10`. `CLAUDE_CLI_PATH` overrides the `claude` command, and `CLAUDE_CLI_TIMEOUT_MS` the per-call timeout (default 10 minutes).

### `npm run status`

Shows completion status of the entire data pipeline, with the script that fills each gap:

- **Grand Alliance warscrolls:** images, extracted JSON, Polish translations, faction icons.
- **Warbands:** icons, fighter card images, fighter stats (`fighters.json`) and playstyle (EN and PL) for every warband, vaulted ones included. Warscroll image, extracted warscroll and its Polish translation for OP-legal warbands only, since vaulted warbands use their Grand Alliance's warscrolls.
- **Rival decks:** synced `deck.json`, icons, Polish translation, strategy tagline and summary (EN and PL).
- **Pairings:** every warband (OP-legal and vaulted) rated against every universal deck, a note on every 3-star rating, and a Polish version of every note.

Needs no AI provider.

### `npm run download`

Downloads warscroll card PNG images from underworldsdb.com. First syncs `warbands/index.json` with the site's [warband list](https://www.underworldsdb.com/warbands.php): new warbands are added, and changed names, fighter counts, Grand Alliances or OP-legal flags are updated. Warbands the site no longer lists stay in the index. Then downloads both generic Grand Alliance warscroll variants (8 images into `warbands/_ga/`) and every missing OP-legal warband image into that warband's directory. Vaulted (non-OP-legal) warbands have no warscroll card of their own on underworldsdb.com; the site and the app show their Grand Alliance's two cards instead. Images that already exist as valid PNGs are skipped. Finishes by checking that every warband in the index has its warscroll, and exits with an error if any download fails or any warband is still missing one.

### `npm run download:icons`

Downloads icon PNGs from underworldsdb.com: warband icons into each `warbands/<slug>/icon.png`, rival deck icons into each `rivals/<slug>/icon.png`, and the faction / Grand Alliance icons (`chaos`, `death`, `destruction`, `order`, `universal`) into `warbands/_ga/<faction>-icon.png`. Skips already-downloaded files.

### `npm run download:fighters`

Downloads both sides of every fighter card (`<n>.png` and `<n>-inspired.png`) into `warbands/<slug>/fighters/` for every warband in the index, vaulted ones included (underworldsdb.com has 2024-layout fighter cards for all of them). Warbands whose cards are all present are skipped. Writes a `download-report.json` per warband and updates `warbands/fighters-download-summary.json`.

### `npm run extract`

Extracts structured game data from warscroll card PNGs using Claude's vision (Sonnet 4.6) through the first usable [AI provider](#ai-providers). Processes GA warscrolls in `_ga/` first, then OP-legal warbands. Outputs JSON with fields like name, grand alliance, abilities, reactions, and inspire conditions. Processes in batches (default 5, configurable via CLI argument).

### `npm run extract:fighters`

Extracts fighter stats into `warbands/<slug>/fighters.json` for every warband (vaulted ones included) whose fighter card images are downloaded but that have no `fighters.json` yet. Sends both sides of each fighter card to Claude (one call per fighter) and checks the reply against the schema of the existing files: Move, Save, Health, Bounty, runemarks and weapons (with abilities) per side. A warband's file is written only when every fighter extracted cleanly. An optional argument limits it to one warband (slug or name).

### `npm run translate`

Translates English warscroll JSON files to Polish using Claude through the first usable [AI provider](#ai-providers). Processes GA warscrolls in `_ga/` first, then OP-legal warbands. Preserves game icon tokens (`{icon:name}`). Skips already-translated files.

### `npm run rivals:sync`

Scrapes rival deck data from underworldsdb.com. Parses deck metadata (name, faction, plot, cards) from HTML and writes `rivals/index.json` plus individual `deck.json` files per rival deck. Fields in an existing `deck.json` that the scraper does not produce (`strategyTagline`, `strategy`) are kept. Supports filtering by deck slug/name via CLI argument.

### `npm run rivals:translate`

Translates rival deck `deck.json` files to Polish using Claude through the first usable [AI provider](#ai-providers). Outputs `deck.pl.json` for each deck. Supports filtering by deck slug/name via CLI argument.

### `npm run pairings`

Fills every gap in the warband × Rivals deck pairings, in this order, using the existing hand-written entries as style and calibration examples:

1. Deck `strategyTagline` and `strategy` in `deck.json` for decks that lack them.
2. Warband `playstyle` for warbands that lack one, from the warscroll and `fighters.json`. OP-legal warbands keep it in `warscroll.json`. Vaulted warbands have no warscroll of their own, so theirs is written from their fighter stats and their Grand Alliance's two warscrolls into `playstyle.json`.
3. Star ratings in `warband-rivals-pairings.json` for every warband (OP-legal and vaulted) not yet rated against every universal deck, with a note on each 3-star rating. New decks are appended to `meta.deckOrder`, and the counts in `meta.description` are updated.
4. Polish versions of all three: deck strategy in `deck.pl.json`, playstyle in `warscroll.pl.json` (OP-legal) or `playstyle.pl.json` (vaulted), and notes in `warband-rivals-pairings.pl.json`. `deck.pl.json` and `warscroll.pl.json` are only filled in once they exist; `rivals:translate` / `translate` create those.

`warband-rivals-pairings.md` is a hand-written reference and is not updated.

## Project Structure

```
warbands/           Warband data (60+ warbands)
  index.json        Master warband metadata
  _ga/              Shared Grand Alliance warscrolls (2 per alliance)
    chaos-1.json    GA Chaos variant 1
    chaos-2.json    GA Chaos variant 2
    ...             (+ .pl.json translations and .png images)
  _ga/              ... (+ `<faction>-icon.png` Grand Alliance / Universal icons)
  <warband>/        Warband data (vaulted warbands: icon and fighters only)
    warscroll.png   Card image (OP-legal only)
    icon.png        Warband icon
    fighters/       Fighter card images (<n>.png, <n>-inspired.png)
    fighters.json   Extracted fighter stats
    warscroll.json  Extracted English data (incl. `playstyle` pairings blurb)
    warscroll.pl.json  Polish translation (incl. `playstyle`)
    playstyle.json  Vaulted warbands only: `playstyle` pairings blurb (+ playstyle.pl.json)
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
  ai/               AI provider layer (Anthropic API, Claude CLI, fallback client)
  lib/              Shared data paths/loaders and the status checks used by status and sync
src/
  components/       React UI components
  data/             Pairings join layer (pairings.ts)
  types/            TypeScript interfaces
  i18n/             UI label translations
  styles/           CSS
  assets/icons/     Game icon SVGs
```

## Warband ↔ Rivals deck pairings

The **Pairings** tab rates every warband against all 12 universal Rivals decks. Vaulted (not OP-legal) warbands are included and marked "Vaulted" in the matrix and on deck pages. The data is split to match the per-entity convention:

- Each warband's **playstyle** blurb lives in its `warscroll.json` (`playstyle`), or in `playstyle.json` for vaulted warbands, which have no warscroll of their own; each deck's **strategy** summary + tagline live in its `deck.json` (`strategyTagline`, `strategy`) — both translated in the paired `.pl.json` files.
- The star ratings (0–3) and per-pairing **notes** — an inherently warband×deck relation — live in `warband-rivals-pairings.json`, with Polish notes in `warband-rivals-pairings.pl.json`.

Each warband page lists its decks ranked by fit (with links), each deck page lists its best-matched warbands, and the Pairings tab shows the full matrix — all bilingual.
