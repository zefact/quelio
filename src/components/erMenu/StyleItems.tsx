interface Props<T extends string> {
  options: readonly (readonly [T, string])[];
  value: T;
  onSelect: (value: T) => void;
}

/** 線種・枠線の選択肢 (チェック付きの項目を並べるだけ) */
export function StyleItems<T extends string>({
  options,
  value,
  onSelect,
}: Props<T>) {
  return (
    <>
      {options.map(([style, label]) => {
        const checked = value === style;
        return (
          <button
            key={style}
            className={"context-item" + (checked ? " checked" : "")}
            onClick={() => onSelect(style)}
          >
            {checked ? "✓ " : ""}
            {label}
          </button>
        );
      })}
    </>
  );
}
