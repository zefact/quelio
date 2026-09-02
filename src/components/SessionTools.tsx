import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { useDismiss } from "../hooks/useDismiss";
import { usePopupPosition } from "../hooks/usePopupPosition";
import type { DbType } from "../types";

interface Props {
  /** 選択中のデータベース (未選択なら、その範囲を要る道具は押せない) */
  selectedDb: string | null;
  dbType: DbType;
  onSearch: () => void;
  onEr: () => void;
  onSchema: () => void;
  onRoutines: () => void;
}

/** メニューの1項目 */
interface Tool {
  key: string;
  label: string;
  /** 名前の下に出す一言 (何ができるのか) */
  note: string;
  icon: ReactNode;
  /** 押せない理由 (押せるときは null) */
  blocked: string | null;
  run: () => void;
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
      <path
        d="M16 16l4.5 4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ErIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="3"
        width="8"
        height="6"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="2"
      />
      <rect
        x="13"
        y="15"
        width="8"
        height="6"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M7 9v6h6M17 15V9h-3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SchemaIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 5h16M4 10h16M4 15h10M4 20h7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RoutineIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 6c-2 0-2 3-2 6s0 6-2 6M15 6c2 0 2 3 2 6s0 6 2 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ToolsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14.5 4.5a4 4 0 0 0 5 5L9.5 19.5a2.1 2.1 0 0 1-3-3z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** メニューの幅 (右端から左へ開くので、位置の計算にも使う) */
const MENU_WIDTH = 300;

/**
 * ツールバーの「ツール」メニュー。
 *
 * 常に使う「プロセス一覧」「SQL」だけをボタンに残し、
 * ときどき開くものはここへまとめる。
 * メニューなら名前の下に説明を置けるので、
 * 「一覧」「定義」のような短い名前で悩ませずに済む
 */
export function SessionTools({
  selectedDb,
  dbType,
  onSearch,
  onEr,
  onSchema,
  onRoutines,
}: Props) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ x: 0, y: 0, top: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const [menuRef, menuStyle] = usePopupPosition<HTMLDivElement>(
    at.x,
    at.y,
    at.top
  );
  useDismiss(open, () => setOpen(false), {
    ref: menuRef,
    resize: true,
    escape: true,
  });

  const noDb = selectedDb ? null : "データベースを選んでください";
  const tools: Tool[] = [
    {
      key: "search",
      label: "検索",
      note: "テーブル名・カラム名・値から探す",
      icon: <SearchIcon />,
      blocked: noDb,
      run: onSearch,
    },
    {
      key: "er",
      label: "ER図",
      note: "リレーションを図で見る (PNG出力)",
      icon: <ErIcon />,
      // DB未選択でも開ける (ER図のウィンドウ側で接続とDBを選べる)
      blocked: null,
      run: onEr,
    },
    {
      key: "schema",
      label: "スキーマ",
      note: "テーブル・カラムの一覧と定義書の出力",
      icon: <SchemaIcon />,
      blocked: noDb,
      run: onSchema,
    },
    {
      key: "routines",
      label: "関数・手続",
      note: "関数・プロシージャ・トリガを見る",
      icon: <RoutineIcon />,
      blocked:
        dbType === "valkey" ? "Valkeyにはこの仕組みがありません" : noDb,
      run: onRoutines,
    },
  ];

  const toggle = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    // ボタンの右端に合わせて開く (画面の端で切れないよう左へ伸ばす)
    if (r) setAt({ x: r.right - MENU_WIDTH, y: r.bottom + 4, top: r.top - 4 });
    setOpen((v) => !v);
  };

  const pick = (tool: Tool) => {
    setOpen(false);
    tool.run();
  };

  return (
    <div className="tools-wrap" ref={wrapRef}>
      <button
        className={"sql-btn" + (open ? "" : " has-tooltip")}
        data-tooltip="検索・ER図・スキーマ・関数の定義"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <ToolsIcon />
        ツール <span className="menu-caret">▾</span>
      </button>
      {open && (
        <div
          className="context-menu tools-menu"
          role="menu"
          ref={menuRef}
          style={menuStyle}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {tools.map((t) => (
            <button
              key={t.key}
              role="menuitem"
              className="context-item tools-menu-item"
              disabled={!!t.blocked}
              title={t.blocked ?? undefined}
              onClick={() => pick(t)}
            >
              <span className="tools-menu-icon" aria-hidden>
                {t.icon}
              </span>
              <span className="tools-menu-text">
                <span className="tools-menu-name">{t.label}</span>
                <span className="tools-menu-note">{t.blocked ?? t.note}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
