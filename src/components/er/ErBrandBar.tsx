/**
 * ER図のウィンドウの名乗り (一番上の帯)。
 *
 * どのウィンドウを見ているのか一目で分かるよう、
 * DBやCSVのウィンドウと同じ位置・同じ形で置く。
 * 右端のアイコンの並びもそろえてある
 */
import { emitAppEvent, FIND_EVENT } from "../../appEvents";
import { isBetaVersion, useAppVersion } from "../../hooks/useAppVersion";
import { DbIcon } from "../DbIcon";
import { ErIcon } from "../ErIcon";

interface Props {
  /** DBのウィンドウを前に出す (閉じていれば開き直す) */
  onOpenDb: () => void;
  onOpenSettings: () => void;
}

export function ErBrandBar({ onOpenDb, onOpenSettings }: Props) {
  const isBeta = isBetaVersion(useAppVersion());
  return (
    <div className="er-brandbar" data-tauri-drag-region data-find-skip>
      <div className="brand" title="QuelioER" data-tauri-drag-region>
        <span className="brand-mark er-mark">
          <ErIcon />
        </span>
        <span className="brand-name">QuelioER</span>
        {isBeta && <span className="beta-badge">β</span>}
      </div>

      {/* 余った所を掴んでウィンドウを動かせるようにする */}
      <span className="er-brandbar-drag" data-tauri-drag-region />

      {/* 右端のアイコンはDB・CSVのウィンドウと同じ並び */}
      <button
        className="console-btn has-tooltip"
        data-tooltip="画面内を検索 (⌘F)"
        onClick={() => emitAppEvent(FIND_EVENT)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M20 20l-4.5-4.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <button
        className="console-btn has-tooltip"
        data-tooltip="QuelioDB (閉じていれば開き直します)"
        onClick={onOpenDb}
      >
        <DbIcon />
      </button>
      <button
        className="console-btn has-tooltip"
        data-tooltip="設定"
        onClick={onOpenSettings}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M19.4 13.5a7.6 7.6 0 000-3l2-1.2-2-3.4-2.3 1a7.6 7.6 0 00-2.6-1.5L14.2 3h-4l-.4 2.4a7.6 7.6 0 00-2.6 1.5l-2.3-1-2 3.4 2 1.2a7.6 7.6 0 000 3l-2 1.2 2 3.4 2.3-1a7.6 7.6 0 002.6 1.5l.4 2.4h4l.3-2.4a7.6 7.6 0 002.6-1.5l2.3 1 2-3.4z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}
