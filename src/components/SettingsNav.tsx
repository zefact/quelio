import { ReactElement } from "react";

/** 設定モーダルのページ */
export type SettingsPage =
  | "general"
  | "editor"
  | "tools"
  | "update"
  | "backup";

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M19.4 13.5a7.6 7.6 0 000-3l2-1.2-2-3.4-2.3 1a7.6 7.6 0 00-2.6-1.5L14.2 3h-4l-.4 2.4a7.6 7.6 0 00-2.6 1.5l-2.3-1-2 3.4 2 1.2a7.6 7.6 0 000 3l-2 1.2 2 3.4 2.3-1a7.6 7.6 0 002.6 1.5l.4 2.4h4l.3-2.4a7.6 7.6 0 002.6-1.5l2.3 1 2-3.4z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ToolIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M7 9.5l3 2.5-3 2.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.5 15h4.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PortIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M8 3v10m0 0 3-3m-3 3-3-3M16 21V11m0 0 3 3m-3-3-3 3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EditorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 5h11M4 10h7M4 15h9M4 20h5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M15.5 20.5 21 15l-2-2-5.5 5.5-.6 2.6z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function UpdateIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 5v9m0 0 3.5-3.5M12 14l-3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.5 15v2.5A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5V15"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface NavItem {
  page: SettingsPage;
  label: string;
  icon: () => ReactElement;
}

/** 見出しでゆるくまとめたナビゲーション (見出しなしのグループが先頭) */
const GROUPS: { title?: string; items: NavItem[] }[] = [
  {
    items: [
      { page: "general", label: "一般", icon: GearIcon },
      { page: "editor", label: "エディタ", icon: EditorIcon },
      { page: "tools", label: "外部ツール", icon: ToolIcon },
      { page: "update", label: "アップデート", icon: UpdateIcon },
    ],
  },
  {
    title: "データ",
    items: [
      { page: "backup", label: "バックアップ", icon: PortIcon },
    ],
  },
];

interface Props {
  page: SettingsPage;
  onSelect: (page: SettingsPage) => void;
  /** 末尾に出すアプリのバージョン (空なら出さない) */
  version: string;
}

/** 設定モーダルの左サイドバー */
export function SettingsNav({ page, onSelect, version }: Props) {
  return (
    <aside className="settings-nav">
      <div className="settings-nav-title">設定</div>
      {GROUPS.map((group, i) => (
        <div className="settings-nav-group" key={group.title ?? i}>
          {group.title && (
            <div className="settings-nav-group-title">{group.title}</div>
          )}
          {group.items.map(({ page: p, label, icon: Icon }) => (
            <button
              key={p}
              className={"settings-nav-item" + (page === p ? " active" : "")}
              onClick={() => onSelect(p)}
            >
              <Icon />
              <span className="settings-nav-label">{label}</span>
            </button>
          ))}
        </div>
      ))}
      <span className="settings-nav-spacer" aria-hidden />
      {version && (
        <div className="settings-nav-version mono">
          Quelio v{version}
          {version.startsWith("0.") && " (β)"}
        </div>
      )}
    </aside>
  );
}
