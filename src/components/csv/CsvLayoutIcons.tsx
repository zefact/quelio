/**
 * 固定長のお気に入りの一覧で使うアイコン。
 * フォルダはSQLのお気に入りと同じものを使い、ここにはお気に入り1件の絵だけを置く
 */

/** 固定長のお気に入り (桁で区切った1行の絵) */
export function LayoutIcon() {
  return (
    <svg
      className="saved-icon csv-layout-icon"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <rect
        x="3"
        y="6"
        width="18"
        height="12"
        rx="2"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M8 6v12M13 6v12M17 6v12"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}
