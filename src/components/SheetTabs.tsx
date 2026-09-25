import { useState } from "react";
import type { QuerySheet } from "../types";
import { HoverTip } from "./HoverTip";
import { MAX_SHEETS } from "../workspace";
import { SheetTabMenu } from "./SheetTabMenu";
import { autoTitle } from "./sheetTitle";
import { FormatIcon, FunctionsIcon } from "./SqlToolIcons";
import { MOD, SHIFT } from "../keyLabel";
import { imeBusy } from "../ime";

interface Props {
  /** 表に出していないシートも含めた一覧 (表示中は activeId で示す) */
  sheets: QuerySheet[];
  activeId: string;
  /** 実行中はシートを切り替えない (結果の行き先が変わってしまうため) */
  running: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
  /** そのシートだけ残して閉じる */
  onCloseOthers: (id: string) => void;
  /** すべて閉じる (空のシートが1枚だけ残る) */
  onCloseAll: () => void;
  onRename: (id: string, title: string) => void;
  /** そのシートのSQLをファイルに保存する */
  onSaveFile: (id: string) => void;
  /** 書いてあるSQLを整形する */
  onFormat: () => void;
  /** 関数リファレンスを開く */
  onFunctions: () => void;
  /** 整形できるSQLが書いてあるか */
  canFormat: boolean;
}

/**
 * SQLエディタのシート切り替え。
 *
 * 1つの接続で複数の書きかけSQLを持てるようにする。
 * 接続は1本なので同時には実行できず、実行中は切り替えを止める
 */
export function SheetTabs({
  sheets,
  activeId,
  running,
  onSelect,
  onAdd,
  onClose,
  onCloseOthers,
  onCloseAll,
  onRename,
  onSaveFile,
  onFormat,
  onFunctions,
  canFormat,
}: Props) {
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(
    null
  );
  /** 右クリックしたタブと、その位置 */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
    null
  );
  const menuSheet = sheets.find((s) => s.id === menu?.id) ?? null;
  const full = sheets.length >= MAX_SHEETS;

  // 表示中のシートは必ず一覧にいる (emptyTab / workspace で1枚は用意する)
  const list = sheets;

  // 書きかけのSQLはシート自身が持っているので、表示中かどうかで分けなくてよい
  const label = (s: QuerySheet) => s.title || autoTitle(s.sql);

  return (
    // ページ内検索の対象外 (画面の枠)
    <div className="sheet-tabs" data-find-skip>
      {/*
        タブの並びだけを横スクロールさせる。
        列ごとスクロールさせると、右端の道具が流れていってしまう
      */}
      <div className="sheet-tabs-list">
      {list.map((s) => {
        const active = s.id === activeId;
        if (editing?.id === s.id) {
          return (
            <input
              key={s.id}
              className="sheet-rename mono"
              value={editing.value}
              autoFocus
              spellCheck={false}
              placeholder="シート名"
              onChange={(e) => setEditing({ id: s.id, value: e.target.value })}
              onBlur={() => {
                onRename(s.id, editing.value.trim());
                setEditing(null);
              }}
              onKeyDown={(e) => {
                if (imeBusy(e)) return;
                if (e.key === "Enter") {
                  onRename(s.id, editing.value.trim());
                  setEditing(null);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(null);
                }
              }}
            />
          );
        }
        return (
          <HoverTip
            key={s.id}
            className="sheet-tip"
            text={
              running && !active
                ? "実行中はシートを切り替えられません"
                : "ダブルクリックで名前を変えられます"
            }
          >
          <button
            className={"sheet-tab" + (active ? " active" : "")}
            disabled={running && !active}
            onClick={() => onSelect(s.id)}
            onDoubleClick={() => setEditing({ id: s.id, value: s.title })}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ id: s.id, x: e.clientX, y: e.clientY });
            }}
          >
            <span className="sheet-name">{label(s)}</span>
            {list.length > 1 && !running && (
              <span
                className="sheet-close"
                role="button"
                aria-label="このシートを閉じる"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(s.id);
                }}
              >
                ×
              </span>
            )}
          </button>
          </HoverTip>
        );
      })}
      <HoverTip
        className="sheet-tip"
        text={
          full
            ? `シートは${MAX_SHEETS}枚までです`
            : "SQLのシートを増やす (検証用と本命を並べて持てます)"
        }
      >
        <button
          className="sheet-add"
          aria-label="SQLのシートを増やす"
          disabled={running || full}
          onClick={onAdd}
        >
          ＋
        </button>
      </HoverTip>
      </div>

      {/* 書くときに使う道具は、シート列の右端にまとめる */}
      <div className="sheet-tools">
        <button
          className="pane-icon-btn has-tooltip tooltip-wrap"
          data-tooltip={`SQLを見やすく整形する (${MOD}${SHIFT}F)\nキーワードを大文字にし、カンマを行の先頭に置きます`}
          disabled={running || !canFormat}
          onClick={onFormat}
        >
          <FormatIcon />
        </button>
        <button
          className="pane-icon-btn has-tooltip tooltip-wrap"
          data-tooltip={`関数リファレンス (${MOD}${SHIFT}H)\n名前を覚えていなくても「切り捨て」「前ゼロ」「月末」などの言葉で探せます`}
          onClick={onFunctions}
        >
          <FunctionsIcon />
        </button>
      </div>

      {menu && menuSheet && (
        <SheetTabMenu
          sheet={menuSheet}
          sheets={sheets}
          x={menu.x}
          y={menu.y}
          running={running}
          onClose={onClose}
          onCloseOthers={onCloseOthers}
          onCloseAll={onCloseAll}
          onSaveFile={onSaveFile}
          onDismiss={() => setMenu(null)}
        />
      )}
    </div>
  );
}
