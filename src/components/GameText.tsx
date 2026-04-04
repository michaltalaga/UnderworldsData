function renderIconTokens(text: string) {
  const parts = text.split(/(\{icon:[^}]+\})/g);
  return parts.map((part, index) => {
    const match = part.match(/^\{icon:(.+)\}$/);
    if (match) {
      return (
        <span key={index} className="icon-token">
          {match[1]}
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
