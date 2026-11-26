/**
 * Consensus voting over repeated AI reads of the same thing.
 *
 * A region (say the stats column of one card side) is read several times, varying the input and
 * the wording. Each read is split into fields (move, save dice, ...), and each field is voted on
 * separately. A field is accepted when every read agrees. If they do not, more reads are made, up
 * to `maxReads`, and the most common answer is accepted only if it got at least `threshold` of
 * the votes the region could get. Otherwise the field is flagged for a person to check.
 */

export interface VoteSettings {
  /** Reads made before anything is decided. */
  initialReads: number;
  /** Most reads a region gets when its reads disagree. */
  maxReads: number;
  /** Share of `maxReads` the top answer needs when the reads disagree (0.8 = 12 of 15). */
  threshold: number;
}

export const DEFAULT_VOTE_SETTINGS: VoteSettings = { initialReads: 5, maxReads: 15, threshold: 0.8 };

/** One field's answer in one read. `canon` is the normalised form votes are counted on. */
export interface FieldVote {
  key: string;
  canon: string;
  value: unknown;
  /** Only count this vote when another field's winning answer is this one (for example a weapon's dice only among reads that saw the same number of weapons). */
  when?: { key: string; canon: string };
}

export type FieldStatus = 'unanimous' | 'majority' | 'flagged';

export interface Tally {
  canon: string;
  count: number;
  value: unknown;
  /** Which reads gave this answer (1-based), with the variant of each. */
  reads: { read: number; variant: string }[];
  /** How often each exact form of this answer came back; `value` is the most common one. */
  forms: Map<string, { value: unknown; count: number }>;
}

export interface FieldOutcome {
  key: string;
  status: FieldStatus;
  value: unknown;
  canon: string;
  votes: number;
  tallies: Tally[];
}

export interface Ballot {
  read: number;
  variant: string;
  fields: FieldVote[];
}

/** One region's reads so far, and the decisions they support. */
export class RegionVote {
  readonly ballots: Ballot[] = [];
  failures: string[] = [];

  constructor(
    readonly id: string,
    readonly settings: VoteSettings,
    /** Vote counted for a key a read does not mention (for "is X there" fields); unset means such reads abstain. */
    readonly absent?: { canon: string; value: unknown },
  ) {}

  get reads(): number {
    return this.ballots.length;
  }

  add(variant: string, fields: FieldVote[]): void {
    this.ballots.push({ read: this.ballots.length + this.failures.length + 1, variant, fields });
  }

  /** Every field key seen in any read, in first-seen order. */
  keys(): string[] {
    const keys: string[] = [];
    for (const b of this.ballots) for (const f of b.fields) if (!keys.includes(f.key)) keys.push(f.key);
    return keys;
  }

  tally(key: string): Tally[] {
    const winners = new Map<string, string>();
    const tallies = new Map<string, Tally>();
    for (const b of this.ballots) {
      const vote: FieldVote | undefined =
        b.fields.find((f) => f.key === key) ?? (this.absent ? { key, ...this.absent } : undefined);
      if (!vote) continue;
      if (vote.when) {
        const condition = winners.get(vote.when.key) ?? this.leader(vote.when.key)?.canon;
        winners.set(vote.when.key, condition ?? '');
        if (condition !== vote.when.canon) continue;
      }
      const t: Tally = tallies.get(vote.canon) ?? { canon: vote.canon, count: 0, value: vote.value, reads: [], forms: new Map() };
      t.count++;
      t.reads.push({ read: b.read, variant: b.variant });
      // Reads that agree can still differ in formatting (a line break, brackets): keep the most common form.
      const form = JSON.stringify(vote.value) ?? 'undefined';
      const f = t.forms.get(form) ?? { value: vote.value, count: 0 };
      f.count++;
      t.forms.set(form, f);
      if (f.count > (t.forms.get(JSON.stringify(t.value) ?? 'undefined')?.count ?? 0)) t.value = f.value;
      tallies.set(vote.canon, t);
    }
    return [...tallies.values()].sort((a, b) => b.count - a.count);
  }

  private leader(key: string): Tally | undefined {
    return this.tally(key)[0];
  }

  /** The decision for one field now, or 'pending' when more reads could still change it. */
  decide(key: string): FieldStatus | 'pending' {
    const tallies = this.tally(key);
    const votes = tallies.reduce((sum, t) => sum + t.count, 0);
    const top = tallies[0]?.count ?? 0;
    const { initialReads, maxReads, threshold } = this.settings;
    const need = Math.ceil(threshold * maxReads);
    const left = Math.max(0, maxReads - this.reads);
    if (top > 0 && top === votes && (this.reads >= initialReads || left === 0)) return 'unanimous';
    if (this.reads < initialReads) return 'pending';
    if (top >= need) return 'majority';
    if (top + left < need) return 'flagged';
    return 'pending';
  }

  pending(): string[] {
    return this.keys().filter((k) => this.decide(k) === 'pending');
  }

  /** How many more reads are worth making now (0 when every field is decided). */
  readsWanted(): number {
    if (this.reads < this.settings.initialReads) return this.settings.initialReads - this.reads;
    const pending = this.pending();
    if (pending.length === 0) return 0;
    const need = Math.ceil(this.settings.threshold * this.settings.maxReads);
    const shortest = Math.min(...pending.map((k) => need - (this.tally(k)[0]?.count ?? 0)));
    return Math.max(1, Math.min(this.settings.maxReads - this.reads, shortest));
  }

  outcome(key: string): FieldOutcome {
    const tallies = this.tally(key);
    const decision = this.decide(key);
    return {
      key,
      status: decision === 'pending' ? 'flagged' : decision,
      value: tallies[0]?.value,
      canon: tallies[0]?.canon ?? '',
      votes: tallies.reduce((sum, t) => sum + t.count, 0),
      tallies,
    };
  }

  outcomes(): FieldOutcome[] {
    return this.keys().map((k) => this.outcome(k));
  }
}

/**
 * Reads a region until every field is decided: `initialReads` reads first, then more while
 * some field is still undecided, at most `maxReads` in all. `read(n)` makes read number n
 * (0-based, used to pick the variant) and returns its fields; reads that fail are retried a
 * few times and then the region fails.
 */
export async function voteRegion(
  region: RegionVote,
  read: (n: number) => Promise<{ variant: string; fields: FieldVote[] }>,
  options: { extraReads?: number } = {},
): Promise<RegionVote> {
  const maxFailures = 4;
  let forced = options.extraReads ?? 0;
  for (;;) {
    const wanted = Math.max(region.readsWanted(), Math.min(forced, region.settings.maxReads - region.reads));
    if (wanted <= 0) return region;
    forced = Math.max(0, forced - wanted);
    const start = region.reads + region.failures.length;
    const results = await Promise.allSettled(Array.from({ length: wanted }, (_, i) => read(start + i)));
    for (const r of results) {
      if (r.status === 'fulfilled') region.add(r.value.variant, r.value.fields);
      else region.failures.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
    if (region.failures.length > maxFailures) {
      throw new Error(`${region.id}: too many failed reads (${region.failures.slice(-2).join('; ')})`);
    }
  }
}

/** Normalised text for comparing votes: case, spacing, quotes and dashes do not count. */
export function canonText(text: string | null | undefined): string {
  if (text === null || text === undefined) return 'null';
  return text
    .normalize('NFKC')
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    // "Grot ({icon:grot})" and "Grot {icon:grot}" are the same answer.
    .replace(/\(\s*(\{icon:[^}]+\})\s*\)/g, '$1')
    .trim()
    .toLowerCase();
}

export function canonValue(value: unknown): string {
  return JSON.stringify(value);
}
