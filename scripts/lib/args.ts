/** Command-line flags shared by the pipeline scripts. */

/**
 * Pulls a flag out of the arguments. In PowerShell npm drops the `--` of `npm run x -- --flag`
 * and keeps the flag as its own config, so it arrives as npm_config_<flag> instead.
 */
export function takeFlag(args: string[], name: string): boolean {
  const at = args.indexOf(`--${name}`);
  if (at >= 0) {
    args.splice(at, 1);
    return true;
  }
  return process.env[`npm_config_${name.replace(/-/g, '_')}`] === 'true';
}

/** Pulls `--name value` (or `--name=value`) out of the arguments, with the same npm fallback as takeFlag. */
export function takeValue(args: string[], name: string): string | undefined {
  const at = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (at >= 0) {
    const [arg] = args.splice(at, 1);
    return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args.splice(at, 1)[0];
  }
  const npm = process.env[`npm_config_${name.replace(/-/g, '_')}`];
  return npm && npm !== 'true' ? npm : undefined;
}

export function positiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a whole number of at least 1, got "${value}"`);
  return n;
}
