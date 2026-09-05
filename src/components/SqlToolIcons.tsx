/**
 * SQLエディタのシート列の右に並べる絵。
 *
 * どれも 24 の枠に線だけで描いてあるので、
 * 色は置いた場所の文字色をそのまま継ぐ
 */

/** 整形 (字下げの付いた行) */
export function FormatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 5h16M8 10h12M8 15h9M4 20h16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 関数リファレンス (開いた本) */
export function FunctionsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 6.5C10.5 5.2 8.4 4.5 5 4.5v13c3.4 0 5.5.7 7 2 1.5-1.3 3.6-2 7-2v-13c-3.4 0-5.5.7-7 2z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M12 6.5v13" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * ▾ の代わりに使う印。
 *
 * 文字の ▾ は、環境によって別のフォントで描かれて
 * 高さが変わり、隣のボタンとずれることがある
 */
export function CaretIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M2.5 4.5L6 8l3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
