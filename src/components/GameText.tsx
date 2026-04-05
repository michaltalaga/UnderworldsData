const ICON_MAP: Record<string, string> = {
  // dice faces
  crit: '/assets/crit.png',
  fury: '/assets/swords.png',
  sword: '/assets/swords.png',
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
  grievous: '/assets/grevious.png',
  stagger: '/assets/stagger.png',
  damage: '/assets/damage.png',
  // weapon stats
  hex: '/assets/range.png',
  // roles
  leader: '/assets/leader.png',
  // movement
  fly: '/assets/fly.png',
};

function renderIconTokens(text: string) {
  const parts = text.split(/(\{icon:[^}]+\})/g);
  return parts.map((part, index) => {
    const match = part.match(/^\{icon:(.+)\}$/);
    if (match) {
      const name = match[1];
      const src = ICON_MAP[name];
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

export function renderText(text: string) {
  if (!text) return null;

  return text.split('\n').map((line, index) => (
    <span key={index}>
      {index > 0 && <br />}
      {renderIconTokens(line)}
    </span>
  ));
}
