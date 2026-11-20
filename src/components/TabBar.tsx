import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { emitAppEvent, FIND_EVENT } from "../appEvents";
import { CloseMark } from "./CloseMark";
import { IconButton } from "./IconButton";
import { MOD } from "../keyLabel";
import { LOST_HINT, tabLabel, tabState, tabTitle } from "../tabLabel";
import { reconnectSession, useLostSessions } from "../hooks/useConnLost";
import { useDismiss } from "../hooks/useDismiss";
import { isBetaVersion, useAppVersion } from "../hooks/useAppVersion";
import { dotStyle, profileColor } from "../colors";
import type { WorkTab } from "../types";
import { envColor } from "../types";
import { tabEnvMark } from "../envBand";
import { AppMenu } from "./AppMenu";
import { DbIcon } from "./DbIcon";
import { ErIcon } from "./ErIcon";
import { TAB_MARK, useTabReorder } from "../hooks/useTabReorder";

interface Props {
  tabs: WorkTab[];
  activeKey: string;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onAdd: () => void;
  onOpenConsole: () => void;
  onOpenDiff: () => void;
  onOpenCsv: () => void;
  onOpenEr: () => void;
  onOpenSettings: () => void;
  /** ヘルプ (Windows などの︙メニューから) */
  onOpenHelp: () => void;
  /** ショートカット一覧 (同上) */
  onOpenShortcuts: () => void;
  /** ドラッグでタブの並びを変える */
  onReorder: (from: number, to: number) => void;
}

export function TabBar({
  tabs,
  activeKey,
  onActivate,
  onClose,
  onAdd,
  onOpenConsole,
  onOpenDiff,
  onOpenCsv,
  onOpenEr,
  onOpenSettings,
  onOpenHelp,
  onOpenShortcuts,
  onReorder,
}: Props) {
  // ドラッグで並べ替える (掴んだタブが、通りかかったタブと入れ替わる)
  const drag = useTabReorder({ onMove: onReorder });
  const isBeta = isBetaVersion(useAppVersion());
  /** 操作が「接続が切れた」エラーで失敗したタブ */
  const lost = useLostSessions();
  /**
   * スキーマ差分は接続中のセッションから選ぶため、
   * どこにも接続していないときは押せないようにする
   * (Valkeyはスキーマの概念が無いので対象外)
   */
  const canDiff = tabs.some(
    (t) => t.connected && t.profile.dbType !== "valkey"
  );
  // macOSはネイティブメニューバーがあるため︙メニューは出さない
  const isMac = document.documentElement.classList.contains("macos");

  /*
   * タブ列のはみ出し。
   * スクロールバーは出していないので、隠れたタブがある側の端に影を付け、
   * 「タブ一覧」から選べるようにする
   */
  const tabsRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = tabsRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((cur) =>
      cur.left === left && cur.right === right ? cur : { left, right }
    );
  }, []);
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  // タブの数・名前が変わったとき、選んだタブが隠れているときにも測り直す
  useEffect(() => {
    const el = tabsRef.current;
    el?.querySelector<HTMLElement>(".tab.active")?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
    measure();
  }, [tabs, activeKey, measure]);

  /** タブ一覧のメニューを開いているか */
  const [listOpen, setListOpen] = useState(false);
  useDismiss(listOpen, () => setListOpen(false), { escape: true, resize: true });

  return (
    <div className="tabbar" data-tauri-drag-region data-find-skip>
      <div className="brand" title="Quelio" data-tauri-drag-region>
        <span className="brand-mark">
          <DbIcon />
        </span>
        <span className="brand-name">Quelio</span>
        {isBeta && <span className="beta-badge">β</span>}
      </div>

      <div
        className={
          "tabbar-tabs-wrap" +
          (overflow.left ? " over-left" : "") +
          (overflow.right ? " over-right" : "")
        }
      >
      <div className="tabbar-tabs" ref={tabsRef} onScroll={measure} role="tablist">
        {tabs.map((t, i) => {
          /* 本番の接続は、そのタブを見ただけで分かるようにする (非アクティブでも) */
          const envMark = tabEnvMark(t.profile.env, t.connected);
          const lostInfo = t.connected ? lost.get(t.key) : undefined;
          const state = tabState(t, !!lostInfo);
          return (
          <div
            key={t.key}
            {...{ [TAB_MARK]: i }}
            className={
              "tab" +
              (activeKey === t.key ? " active" : "") +
              (drag.dragging === i ? " dragging" : "") +
              (envMark ? " has-env" : "") +
              (state === "lost" ? " lost" : "") +
              " has-tooltip tooltip-left tooltip-wide"
            }
            style={
              {
                ...drag.styleOf(i),
                ...(envMark ? { "--env-color": envColor(envMark.env) } : {}),
              } as CSSProperties
            }
            // 名前は幅で切れるので、全体 (接続名 / つなぎ先) と状態をここで見せる
            data-tooltip={tabTitle(t, !!lostInfo)}
            onClick={() => onActivate(t.key)}
            onMouseDown={(e) => drag.start(i, e)}
            role="tab"
            aria-selected={activeKey === t.key}
          >
            {state === "lost" ? (
              /*
               * 接続が切れたタブ: 点の代わりに赤い印を出し、押せば接続し直す。
               * 確かめている間は回る印にする
               */
              lostInfo?.checking ? (
                <span
                  className="spinner tab-spinner"
                  aria-label="接続し直しています"
                />
              ) : (
                <button
                  className="tab-lost has-tooltip"
                  data-tooltip={LOST_HINT}
                  aria-label={LOST_HINT}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onActivate(t.key);
                    reconnectSession(t.key);
                  }}
                >
                  <LostIcon />
                </button>
              )
            ) : state === "connected" ? (
              <span
                className={`tab-dot ${t.profile.dbType}`}
                style={dotStyle(profileColor(t.profile))}
                aria-hidden
              />
            ) : state === "connecting" ? (
              // 接続しに行っている間は、点の代わりに回る印を出す
              <span className="spinner tab-spinner" aria-label="接続中" />
            ) : (
              <span className="tab-dot idle" aria-hidden />
            )}
            <span className="tab-label">{tabLabel(t)}</span>
            {envMark && (
              <span
                className="tab-env has-tooltip"
                data-tooltip={`${envMark.label}環境の接続です`}
              >
                {envMark.label}
              </span>
            )}
            {t.connected && t.profile.readOnly && (
              <span
                className="tab-lock has-tooltip"
                role="img"
                aria-label="読み取り専用"
                data-tooltip="読み取り専用の接続です (更新・定義の変更はできません)"
              >
                <LockIcon />
              </span>
            )}
            <button
              className="tab-close has-tooltip"
              data-tooltip={t.connected ? "切断して閉じる" : "閉じる"}
              aria-label={t.connected ? "切断して閉じる" : "閉じる"}
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.key);
              }}
            >
              <CloseMark />
            </button>
          </div>
          );
        })}
      </div>
      </div>

      {/* はみ出しているときだけ、隠れたタブも選べる一覧を出す */}
      {(overflow.left || overflow.right) && (
        <div className="tab-list-wrap">
          <IconButton
            className="tab-list-btn"
            label="タブ一覧"
            tipLeft
            aria-haspopup="menu"
            aria-expanded={listOpen}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setListOpen((v) => !v)}
          >
            <span aria-hidden>▾</span>
          </IconButton>
          {listOpen && (
            <div
              className="context-menu tab-list-menu"
              role="menu"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {tabs.map((t) => (
                <button
                  key={t.key}
                  role="menuitem"
                  className={
                    "context-item has-tooltip tooltip-wide" +
                    (t.key === activeKey ? " checked" : "")
                  }
                  data-tooltip={tabTitle(t, t.connected && lost.has(t.key))}
                  onClick={() => {
                    setListOpen(false);
                    onActivate(t.key);
                  }}
                >
                  {tabLabel(t)}
                  {tabEnvMark(t.profile.env, t.connected) && (
                    <span className="tab-list-env">
                      {tabEnvMark(t.profile.env, t.connected)?.label}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <IconButton
        className="tab-add"
        label={`新しいタブ (${MOD}T)`}
        tipLeft
        onClick={onAdd}
      >
        +
      </IconButton>

      <span className="tabbar-spacer" data-tauri-drag-region />

      {/*
        * ここから右は「アプリ全体」の道具 (どの接続にもよらない・別ウィンドウで開くもの)。
        * 接続・データベースごとの道具は、セッション画面の「ツール」にある
        */}
      <div className="tabbar-tools" role="group" aria-label="アプリ全体の道具">
      <IconButton
        className="console-btn"
        label={`画面内を検索 (${MOD}F)`}
        onClick={() => emitAppEvent(FIND_EVENT)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle
            cx="11"
            cy="11"
            r="6"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <path
            d="M20 20l-4.5-4.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </IconButton>

      <IconButton
        className="console-btn"
        label={
          canDiff
            ? "スキーマ差分 (2つのデータベースを比べる・別ウィンドウ)"
            : "スキーマ差分 — データベースに接続すると使えます"
        }
        onClick={onOpenDiff}
        disabled={!canDiff}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M8 7h12m0 0l-3.5-3.5M20 7l-3.5 3.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M16 17H4m0 0l3.5-3.5M4 17l3.5 3.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </IconButton>

      <IconButton
        className="console-btn"
        label="CSVエディタ (CSVを開いて編集・比較・別ウィンドウ)"
        onClick={onOpenCsv}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect
            x="3"
            y="4"
            width="18"
            height="16"
            rx="2.5"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <path
            d="M3 9.5h18M9.5 9.5V20M15 9.5V20"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </IconButton>

      <IconButton
        className="console-btn"
        label="ER図 (テーブルのつながりを図で見る・別ウィンドウ)"
        onClick={onOpenEr}
      >
        <ErIcon />
      </IconButton>

      <IconButton
        className="console-btn"
        label="コンソール (実行したSQLの履歴・別ウィンドウ)"
        onClick={onOpenConsole}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect
            x="3"
            y="4"
            width="18"
            height="16"
            rx="2.5"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <path
            d="M7 9.5l3 2.5-3 2.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M12.5 15h4.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </IconButton>

      <IconButton
        className="console-btn"
        label={`設定 (${MOD},)`}
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
      </IconButton>

      {!isMac && (
        <AppMenu
          onOpenSettings={onOpenSettings}
          onOpenHelp={onOpenHelp}
          onOpenShortcuts={onOpenShortcuts}
        />
      )}
      </div>
    </div>
  );
}

/** 接続が切れた印 (途切れた線) */
function LostIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 15l-2.5 2.5a3.5 3.5 0 0 1-5-5L4 10M15 9l2.5-2.5a3.5 3.5 0 0 1 5 5L20 14"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M8 3v3M3 8h3M16 21v-3M21 16h-3"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 読み取り専用の印 (鍵) */
function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="5"
        y="10.5"
        width="14"
        height="10"
        rx="2"
        stroke="currentColor"
        strokeWidth="2.2"
      />
      <path
        d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
