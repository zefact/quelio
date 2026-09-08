/**
 * 絞り込みのメニューで使う絵。
 *
 * 並べ替えの向きは、線の長さで「小さい順・大きい順」を表す
 * (下向きの矢印は「上から下へこの順に並ぶ」という意味)
 */

/** 小さい順 (上へ行くほど短い) */
export function SortAscIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 4v15M2.6 15.6L6 19l3.4-3.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13 6.5h3M13 12h6M13 17.5h9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 大きい順 (上へ行くほど長い) */
export function SortDescIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 4v15M2.6 15.6L6 19l3.4-3.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13 6.5h9M13 12h6M13 17.5h3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
