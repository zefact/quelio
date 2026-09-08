/**
 * 検索・置換バーの絵。
 *
 * バー本体の作りを読みやすくするため、形の定義だけをここに分けている。
 * 大きさは置いた場所に合わせるので、どれも 24 の升目で描く
 */

/** 置換の欄を開く矢印 (開いているあいだは横倒しにして下向きにする) */
export function MoreIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 5l7 7-7 7"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 前を検索 */
export function UpIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 19V5M6 11l6-6 6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 次を検索 */
export function DownIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 5v14M6 13l6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 選んだ範囲の中だけを探す (破線の枠に、選んだ所を塗って表す) */
export function ScopeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="4"
        y="4"
        width="16"
        height="16"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeDasharray="3 2.4"
      />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1" fill="currentColor" />
    </svg>
  );
}

/** 閉じる */
export function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** この1つを置換 (1つのセルへ入れる形) */
export function ReplaceOneIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3v7.4M8.6 7.2L12 10.6l3.4-3.4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="6.5"
        y="14"
        width="11"
        height="6.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

/** すべて置換 (複数のセルへ入れる形) */
export function ReplaceAllIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 2v6M8.6 4.8L12 8.2l3.4-3.4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="3.5"
        y="11.5"
        width="17"
        height="4.6"
        rx="1.3"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <rect
        x="3.5"
        y="17.6"
        width="17"
        height="4.6"
        rx="1.3"
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </svg>
  );
}
