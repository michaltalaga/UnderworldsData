import { warbandIcon } from '../data/icons';

// The core icons: public/assets/<file>.svg, drawn from the rules PDFs by npm run icons.
const CORE_ICONS: Record<string, string> = {
  // dice faces
  crit: 'crit',
  fury: 'swords',
  sword: 'swords',
  swords: 'swords',
  hammer: 'hammer',
  shield: 'shield',
  block: 'shield',
  dodge: 'dodge',
  flanked: 'flanked',
  'single-support': 'flanked',
  surrounded: 'surrounded',
  'double-support': 'surrounded',
  // weapon keywords
  cleave: 'cleave',
  ensnare: 'ensnare',
  brutal: 'brutal',
  grapple: 'grapple',
  grievous: 'grievous',
  stagger: 'stagger',
  damage: 'damage',
  // weapon stats
  hex: 'range',
  range: 'range',
  melee: 'melee',
  ranged: 'ranged',
  // fighter runemarks
  leader: 'leader',
  minion: 'minion',
  fly: 'fly',
  flying: 'fly',
  underdog: 'underdog',
  // ability kinds
  surge: 'surge',
  'core-ability': 'core-ability',
  inspired: 'inspired',
  // tokens, card types, board
  move: 'move',
  charge: 'charge',
  guard: 'guard',
  ploy: 'ploy',
  upgrade: 'upgrade',
  'starting-hex': 'starting-hex',
};

// A warband's own keyword runemarks (Grot, Squig, Volley...): one-colour SVGs made by npm run icons
// in warbands/<slug>/runemarks/icons/<id>.svg.
const warbandRunemarkModules = import.meta.glob('../../warbands/*/runemarks/icons/*.svg', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

const warbandRunemarks = new Map<string, string>();
for (const [path, url] of Object.entries(warbandRunemarkModules)) {
  const parts = path.split('/');
  const slug = parts[parts.length - 4]; // .../warbands/<slug>/runemarks/icons/<id>.svg
  warbandRunemarks.set(`${slug}/${parts[parts.length - 1].replace(/\.svg$/, '')}`, url);
}

/**
 * The picture for {icon:name}: the warband's own runemark (its faction runemark, in colour, or a
 * keyword runemark) first, then the core icons. `mask` marks the one-colour ones.
 */
function iconSource(name: string, warband: string | undefined): { src: string; mask: boolean } | undefined {
  if (warband) {
    if (name === warband) {
      const faction = warbandIcon(warband);
      if (faction) return { src: faction, mask: false };
    }
    const own = warbandRunemarks.get(`${warband}/${name}`);
    if (own) return { src: own, mask: true };
  }
  const core = CORE_ICONS[name];
  return core ? { src: `/assets/${core}.svg`, mask: true } : undefined;
}

function renderIconTokens(text: string, warband: string | undefined) {
  const parts = text.split(/(\{icon:[^}]+\})/g);
  return parts.map((part, index) => {
    const match = part.match(/^\{icon:(.+)\}$/);
    if (match) {
      const name = match[1];
      const icon = iconSource(name, warband);
      if (icon?.mask) {
        // One-colour SVG used as a mask over the text colour, so it follows light and dark text.
        // Quoted: Vite inlines small SVGs as data: URLs.
        const mask = `url("${icon.src}")`;
        return (
          <span key={index} className="icon-img icon-svg" role="img" aria-label={name} style={{ maskImage: mask, WebkitMaskImage: mask }} />
        );
      }
      if (icon) {
        return (
          <img key={index} className="icon-img" src={icon.src} alt={name} />
        );
      }
      return (
        <span key={index} className="icon-token">
          {name}
        </span>
      );
    }

    return part;
  });
}

/** Text with {icon:name} tokens as pictures; `warband` (a slug) adds that warband's own runemarks. */
export function renderText(text: string, warband?: string) {
  if (!text) return null;

  return text.split('\n').map((line, index) => (
    <span key={index}>
      {index > 0 && <br />}
      {renderIconTokens(line, warband)}
    </span>
  ));
}
