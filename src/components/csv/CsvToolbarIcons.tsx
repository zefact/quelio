/**
 * CSVエディタのツールバーに並べる絵。
 *
 * どれも 24 の枠に線だけで描いてあるので、
 * 色は置いた場所の文字色をそのまま継ぐ
 */

/** 保存 (フロッピー) */
export function SaveIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 5.5A1.5 1.5 0 015.5 4h10L20 8.5v10a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 18.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M8 4v5h7V4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M7.5 20v-6h9v6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 別名で保存 (フロッピーと＋) */
export function SaveAsIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2 6.5A1.5 1.5 0 013.5 5h9L15 7.5v10a1.5 1.5 0 01-1.5 1.5h-10A1.5 1.5 0 012 17.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M5.5 5v3.5h5V5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M5 19v-4.5h7V19"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M19.5 5.25v5.5M16.75 8h5.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 検索・置換 (虫めがね) */
export function FindIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="10.5" cy="10.5" r="6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M15 15l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** 比較 (左右に並べた紙) */
export function CompareIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="4"
        width="7.5"
        height="16"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <rect
        x="13.5"
        y="4"
        width="7.5"
        height="16"
        rx="1.2"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M6 9h1.5M6 12h1.5M16.5 9H18M16.5 12H18"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 左右に分ける (縦線で仕切った枠) */
export function SplitIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="4.5"
        width="18"
        height="15"
        rx="1.6"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path d="M12 4.5v15" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/** 同期スクロール (2つを結ぶ鎖) */
export function SyncIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9.5 14.5l5-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M13 6.5l1.5-1.5a3.5 3.5 0 015 5L18 11.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M11 17.5L9.5 19a3.5 3.5 0 01-5-5L6 12.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Excelで書き出す (表に×印… ではなく、右下に小さな緑の印) */
export function ExcelIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="1.6"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M3 9h18M9 9v11"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M12.5 12.5l5 5M17.5 12.5l-5 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
