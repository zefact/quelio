/**
 * お気に入りの一覧で使うアイコン。
 *
 * フォルダの形は接続一覧と同じにして、見た目の言葉をそろえる。
 * 色はCSS側 (--icon-folder / --icon-sql) で付ける
 */

/** フォルダ (開いているときは口を開けた形) */
export function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg
      className="saved-icon saved-icon-folder"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path
        d={
          open
            ? "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H5.5L3 16V7Zm0 9 2.2-6H22l-2.4 6.7A2 2 0 0 1 17.7 18H5a2 2 0 0 1-2-2Z"
            : "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
        }
        fill="currentColor"
        fillOpacity="0.18"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 保存したSQL (角を折った紙に、文の行) */
export function SqlIcon() {
  return (
    <svg
      className="saved-icon saved-icon-sql"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path
        d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M14 3v4h4" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path
        d="M8.5 12h7M8.5 15.5h5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** フォルダの開閉の印 (開いているときは下を向く) */
export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={"saved-chevron" + (open ? " open" : "")}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path
        d="M9 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
