interface Props {
  stars: number;
  max?: number;
  /** When true, render only filled stars (a muted dot for zero) — compact for tables/lists. */
  compact?: boolean;
  /** When true, the rating is purely visual (its parent control/text already carries the label). */
  decorative?: boolean;
  className?: string;
  title?: string;
}

export function StarRating({ stars, max = 3, compact = false, decorative = false, className, title }: Props) {
  const cls = `star-rating${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`;
  const labelProps = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img', 'aria-label': `${stars} of ${max}` };

  const glyphs = compact
    ? stars > 0
      ? Array.from({ length: stars }, (_, i) => (
          <span key={i} className="star filled" aria-hidden="true">★</span>
        ))
      : <span className="star empty-dot" aria-hidden="true">·</span>
    : Array.from({ length: max }, (_, i) => (
        <span key={i} className={i < stars ? 'star filled' : 'star'} aria-hidden="true">
          {i < stars ? '★' : '☆'}
        </span>
      ));

  return (
    <span className={cls} title={title} {...labelProps}>
      {glyphs}
    </span>
  );
}
