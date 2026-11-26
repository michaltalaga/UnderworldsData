import { warbandIcon } from '../data/icons';

const ICON_MAP: Record<string, string> = {
  // dice faces
  crit: '/assets/crit.png',
  fury: '/assets/swords.png',
  sword: '/assets/swords.png',
  swords: '/assets/swords.png',
  hammer: '/assets/hammer.png',
  shield: '/assets/shield.png',
  block: '/assets/shield.png',
  dodge: '/assets/dodge.png',
  flanked: '/assets/flanked.png',
  'single-support': '/assets/flanked.png',
  surrounded: '/assets/surrounded.png',
  'double-support': '/assets/surrounded.png',
  // weapon keywords
  cleave: '/assets/cleave.png',
  ensnare: '/assets/ensnare.png',
  brutal: '/assets/brutal.png',
  grapple: '/assets/grapple.png',
  grievous: '/assets/grevious.png',
  stagger: '/assets/stagger.png',
  damage: '/assets/damage.png',
  // weapon stats
  hex: '/assets/range.png',
  // roles
  leader: '/assets/leader.png',
  minion: '/assets/minion.png',
  // movement
  fly: '/assets/fly.png',
  // ability kinds
  surge: '/assets/surge.png',
  'core-ability': '/assets/core-ability.png',
  inspired: '/assets/inspired.png',
};

// A warband's own runemarks (Grot, Squig, Volley...), cut from its warscroll by
// npm run extract:fighters into warbands/<slug>/runemarks/icons/<id>.png.
const warbandRunemarkModules = import.meta.glob('../../warbands/*/runemarks/icons/*.png', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

const warbandRunemarks = new Map<string, string>();
for (const [path, url] of Object.entries(warbandRunemarkModules)) {
  const parts = path.split('/');
  const slug = parts[parts.length - 4]; // .../warbands/<slug>/runemarks/icons/<id>.png
  warbandRunemarks.set(`${slug}/${parts[parts.length - 1].replace(/.png$/, '')}`, url);
}

/** The picture for {icon:name}: the warband's own runemark first, then the core icons. */
function iconSource(name: string, warband: string | undefined): string | undefined {
  if (warband) {
    const own = name === warband ? warbandIcon(warband) : warbandRunemarks.get(`${warband}/${name}`);
    if (own) return own;
  }
  return ICON_MAP[name];
}

function renderIconTokens(text: string, warband: string | undefined) {
  const parts = text.split(/(\{icon:[^}]+\})/g);
  return parts.map((part, index) => {
    const match = part.match(/^\{icon:(.+)\}$/);
    if (match) {
      const name = match[1];
      const src = iconSource(name, warband);
      if (src) {
        return (
          <img key={index} className="icon-img" src={src} alt={name} />
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
