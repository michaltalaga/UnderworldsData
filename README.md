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

Brings all data up to date in one go. It always runs `download` and `rivals:sync` first, since only they can find new warbands or decks on underworldsdb.com. After that it runs each of `download:icons`, `download:fighters`, `extract`, `extract:fighters`, `translate`, `rivals:translate` and `pairings` only when `status` reports a gap that script fills, re-checking before every step. It ends with the full status report and exits with an error if any step failed or a gap remains. `--provider api|cli` and `--jobs N` are passed on to the AI steps, and `--dry-run` shows the gaps and the steps that would run without running them. For example, `npm run sync -- --jobs 4` runs up to 4 AI requests at once in each AI step (default 1). The steps themselves still run one after another, since each builds on the one before. Each step prints its start time and how long it took, steps with nothing to do are listed as skipped, and the final status shows the total time.

In PowerShell, `npm.ps1` drops the `--` in `npm run sync -- --dry-run`, so npm reads the flag as its own option. The scripts read `--dry-run`, `--provider` and `--jobs` back from npm's config in that case, so the same commands work in PowerShell, cmd and bash.

### AI providers

`extract`, `extract:fighters`, `translate`, `rivals:translate` and `pairings` call Claude (Opus 5.5, `claude-opus-5-5`) through a provider layer in `scripts/ai/`. Providers are tried in this order, and the first usable one is used:

1. **Anthropic API** (`api`): the Anthropic SDK with `ANTHROPIC_API_KEY`. Usable when the key is set and a free models-list call accepts it. API usage is billed to the key's Console account. Opus 5.5 always thinks before it answers, and the thinking counts toward the reply's token limit, so every request gets 16,000 extra tokens for it and is streamed.
2. **Claude CLI** (`cli`): runs `claude -p` with no tools, no CLAUDE.md or plugins, and no saved session; images are sent inline, so the CLI never opens files. Usable when `claude` is on PATH and `claude auth status` reports a login. It runs without `ANTHROPIC_API_KEY`, so it uses the CLI's own login (for example a Claude subscription).

If the provider in use stops working during a run (key rejected, credit balance too low, rate limited, service down, CLI logged out or at its usage limit), the card being processed is retried on the next provider, which handles the rest of the run. If no provider is left, the script stops with an error.

To skip detection and use one provider only, pass `--provider api|cli` or set `AI_PROVIDER`, for example `npm run extract -- --provider cli 10`.

Every AI script also takes `--jobs N` (or `AI_JOBS`): how many AI requests it runs at once, default 1. While a script works, a status block at the bottom of the terminal shows what is in progress, refreshed every second. Its first line counts the items done, running and waiting. Below that, each running item has a line of its own with its elapsed time, plus a note when something is happening to it, such as a reply being repaired. Each finished item prints above the block as `[done/total] item ... OK - detail` or `... FAILED: why`, with the time it took. For `extract:fighters` the detail is the fighter's name. Names come from the card itself, since underworldsdb.com only numbers the card images, so they show once the card has been read. With more than one job the items finish in varying order. When the output goes to a file or pipe instead of a terminal, each item prints a `> item` line when it starts. When the provider in use fails, all running requests move to the next provider together. On the API, more jobs means more requests per minute; the client retries rate-limited (429) requests with backoff before counting them as a provider failure. In PowerShell, for a script with its own number argument (`extract`, `translate`), put `--jobs N` before that number (`npm run extract -- --jobs 4 10`) or write `--jobs=4`. `CLAUDE_CLI_PATH` overrides the `claude` command, and `CLAUDE_CLI_TIMEOUT_MS` the per-call timeout (default 10 minutes).

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

Extracts warscroll cards that have no `warscroll.json` yet, using Claude's vision through the first usable [AI provider](#ai-providers). Processes GA warscrolls in `_ga/` first, then OP-legal warbands. Outputs JSON with name, grand alliance, inspire condition, reactions and abilities. Each warscroll first gets a [runemark catalog](#runemark-catalog) (saved to `warbands/<slug>/runemarks/`). Its text is then read 3 times (up to 7 when the reads disagree) and voted on field by field, the same way as [fighter cards](#npm-run-extractfighters). Inline icons become `{icon:<id>}` tokens with ids from the catalog, so a Grot is `{icon:grot}` and not the nearest core runemark. `reactions` are the boxes in the card's left column under Inspire and `abilities` the entries in its right panel, decided by position only, so the app shows them where the card does; an opening "when to use it" sentence goes in `trigger` in both. A rule printed outside any entry (such as "You can use 1 of the following abilities once per battle round.") is kept as `generalRules`. Fields the reads could not agree on are printed. Processes in batches (default 5, configurable via CLI argument). To read existing warscrolls again, use `npm run extract:fighters -- --rebuild`.

### `npm run extract:fighters`

Reads the fighter cards into `warbands/<slug>/fighters.json`: Move, Save, Health, Bounty, runemarks and weapons (with their runemarks) for both sides, plus any rules text on the card. Every value is decided by voting over repeated reads, so a single misread does not end up in the data.

```
npm run extract:fighters                                            # warbands with no fighters.json yet (used by sync)
npm run extract:fighters -- --rebuild zarbags-gitz the-emberwatch   # read again into a new folder
npm run extract:fighters -- --rebuild --all                         # every warband and the 8 GA warscrolls
npm run extract:fighters -- --resume 2026-11-26-15-20-00            # continue a run that stopped
npm run extract:fighters -- --pictures 2026-11-26-15-20-00          # cut a run's keyword pictures again
npm run extract:fighters -- --apply 2026-11-26-15-20-00             # copy a reviewed run into warbands/
```

How a card is read:

1. **Regions.** Each side is cut into four regions with wide margins: the name banner, the characteristics on the left, the runemark circles on the right and the weapon bars at the bottom. Each is enlarged 3x, only so the model gets bigger pixels. Nothing is ever identified by comparing pixels.
2. **Voting.** Each region of each side is read 5 times, varying the input (the enlarged crop, the whole card enlarged to 900 px, or both) and the wording. Each value (Move, Save dice, a weapon's Damage, the list of runemarks, and so on) is voted on separately. A value is accepted when all reads agree. Otherwise the region is read again, up to 15 times, and the most common answer is accepted only with at least 80% of those 15 (12 votes). Below that it is marked for review. Rules text is read from both sides together, 3 times (up to 7).
A characteristic can also be a runemark printed in place of the number, such as Grandfather's Gardeners' Gardener runemark ("equal to the current space on your tracker"); it is then stored as the runemark id, for example `"damage": "gardener"`. For warbands whose warscroll has keyword runemarks, those reads also get a sheet of them.
3. **Runemarks.** The model first counts the circles, then labels each one from the warband's [runemark catalog](#runemark-catalog), shown as a labelled reference sheet, with the warscroll image as a second reference. A circle that matches nothing is `unknown`, with a description. Weapon runemarks work the same way, and the Critical marker makes the runemark after it critical.
4. **Checker.** A separate call gets both sides, the crops and the final values written out as numbered statements, and answers yes or no to each one. A "no" sends that region back for 5 more reads, and the value is marked for review either way.
5. **Cross-checks** (marked, never fixed): the name is the same on both sides; inspired characteristics and weapons are never lower than uninspired; runemarks differ between the sides; exactly one leader per warband; every fighter has the warband's own runemark; every runemark the warscroll names is on at least one fighter or weapon; the number of cards matches the warband's fighter count.

Without `--rebuild`, it handles warbands that have fighter cards but no `fighters.json`, and writes the file once every fighter is read. With `--rebuild <slug>...` (or `--all`), it also reads warbands that already have one, and their warscrolls (skip those with `--no-warscroll`, or the fighters with `--no-fighters`; `--ga` adds the GA warscrolls). Everything goes into `extraction/<run>/`, and `warbands/` is not touched:

- `report.md`: per warband, the catalog and its sheets, every value that was not unanimous with its vote counts and links to the crop images, the checker's answers, the cross-checks, and the changes against the current `fighters.json` and `warscroll.json` (long texts as word diffs). At the top: the number of AI calls, the tokens, the cost and the time taken.
- `<slug>/fighters.json`, `warscroll.json`, `warscroll.pl.json` (the current Polish file with its icon tokens changed to match; entries whose English text changed or that moved are translated again in one request, using the rest of the file for terminology, and listed in the report), `runemarks/`, the votes (`fighter-votes.json` and `warscroll-votes.json`, with which read gave which answer) and `crops/`.

Each warband is read from start to finish (catalog, warscroll, fighters) and saved in `extraction/<run>/<slug>/` as soon as it is done, two or more warbands at a time. If a run stops part way, for example because the AI provider hit its usage limit, the report still covers every finished warband, and `npm run extract:fighters -- --resume <run>` continues it: finished warbands are skipped, the rest are read (unfinished ones from the start), and the report and totals cover both sessions.

`--apply <run> [slug...]` copies a run's files into `warbands/`: every warband in the run, or only the ones named. A warband's `runemarks/` folder is replaced as a whole. Other options: `--reads N` and `--max-reads N` change the 5 and the 15, `--fighters 1,8` reads only those cards (for testing), and `--provider` and `--jobs` work as for every AI script. A fighter sends many reads at once, so `--jobs N` runs about N/4 fighters side by side with at most N requests in flight. One fighter takes about 55 calls, more when reads disagree.

#### Runemark catalog

The list of runemarks a warband's cards and warscroll can show, each with a picture, so the model picks from a fixed list instead of guessing names:

- **Core:** Leader, Minion and Fly; the weapon runemarks Cleave, Ensnare, Brutal, Grievous, Stagger and Grapple, and the Critical marker; and the dice and other symbols used in warscroll text. The pictures are in `public/assets/`, drawn from the core rules PDF.
- **The warband's own runemark:** `warbands/<slug>/icon.png`, the same art as on the cards. In the data its id is the warband slug; the sheet labels it `warband`, because models misspell long slugs (an early test read Ylthari's leaf right but wrote `ylthari-guardians`).
- **Warscroll keywords:** the words the warscroll prints with their own icon, such as Grot, Squig or Volley, read from `warscroll.png` 3 times (up to 7) and voted on. Every place a read pointed at is kept, because the icon can be printed more than once, sometimes without the keyword in front of it ("has the ◯ runemark"). For each place in turn, the model points again and boxes the icon alone in an enlarged cut-out, until both pictures pass. The sheet gets the keyword with its icon; the app gets the icon alone. A last call checks both pictures: a sheet picture that fails falls back to a wider cut-out, and an app icon that fails is left out, so the app shows the keyword as text. `--pictures <run>` cuts the keyword pictures of a finished run again without reading the catalog again (ids and texts stay the same): the model lists every place each icon is printed, and the same steps run for each place.

Vaulted warbands have no warscroll, so their catalog has only the first two, and other circles on their cards come out as `unknown` for a person to name. The catalog is saved as `runemarks/runemarks.json`, with the warband's own icons in `runemarks/icons/<id>.png` (the app shows these for `{icon:<id>}` tokens) and the reference sheets.

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
    runemarks/      Runemark catalog: runemarks.json, the warband's own icons (icons/<id>.png), reference sheets
    warscroll.json  Extracted English data (incl. `playstyle` pairings blurb)
    warscroll.pl.json  Polish translation (incl. `playstyle`)
    playstyle.json  Vaulted warbands only: `playstyle` pairings blurb (+ playstyle.pl.json)
extraction/         Runs of extract:fighters --rebuild (report.md, results, votes, crops); not committed
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
