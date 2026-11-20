import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconButton } from "./IconButton";
import type { QuerySheet } from "../types";
import { HoverTip } from "./HoverTip";
import { MAX_SHEETS } from "../workspace";
import { SheetTabMenu } from "./SheetTabMenu";
import { autoTitle } from "./sheetTitle";
import { FunctionsIcon } from "./SqlToolIcons";
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
  /** 関数リファレンスを開く */
  onFunctions: () => void;
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
  onFunctions,
}: Props) {
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(
    null
  );
  /** 右クリックしたタブと、その位置 */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
    null
  );
  const menuSheet = sheets.find((s) => s.id === menu?.id) ?? null;
  /** 閉じる前の確認中のシート (書きかけのSQLがあるときだけ確認する) */
  const [closing, setClosing] = useState<QuerySheet | null>(null);
  const closingLive = sheets.find((s) => s.id === closing?.id) ?? null;

  /** シートを閉じる。空白以外が書いてあれば、消える前に確認する */
  const requestClose = (id: string) => {
    const sheet = sheets.find((s) => s.id === id);
    if (!sheet) return;
    if (sheet.sql.trim() === "") onClose(id);
    else setClosing(sheet);
  };
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
          {/*
            タブ本体と × は別のボタンにする
            (ボタンの中にボタンは置けず、× にキーボードで移れなくなるため)
          */}
          <span
            className={
              "sheet-tab" +
              (active ? " active" : "") +
              (running && !active ? " disabled" : "")
            }
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ id: s.id, x: e.clientX, y: e.clientY });
            }}
          >
            <button
              className="sheet-tab-main"
              disabled={running && !active}
              aria-pressed={active}
              onClick={() => onSelect(s.id)}
              onDoubleClick={() => setEditing({ id: s.id, value: s.title })}
            >
              <span className="sheet-name">{label(s)}</span>
            </button>
            {list.length > 1 && !running && (
              <button
                className="sheet-close"
                aria-label={`シート「${label(s)}」を閉じる`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  requestClose(s.id);
                }}
              >
                ×
              </button>
            )}
          </span>
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

      {/*
        書くときに使う道具は、シート列の右端にまとめる。
        整形は実行ボタンの並びの「…」と右クリックにある (入口を増やしすぎない)
      */}
      <div className="sheet-tools">
        <IconButton
          className="pane-icon-btn tooltip-wrap"
          label={`関数リファレンス (${MOD}${SHIFT}H)\n名前を覚えていなくても「切り捨て」「前ゼロ」「月末」などの言葉で探せます`}
          onClick={onFunctions}
        >
          <FunctionsIcon />
        </IconButton>
      </div>

      {menu && menuSheet && (
        <SheetTabMenu
          sheet={menuSheet}
          sheets={sheets}
          x={menu.x}
          y={menu.y}
          running={running}
          onClose={requestClose}
          onCloseOthers={onCloseOthers}
          onCloseAll={onCloseAll}
          onSaveFile={onSaveFile}
          onDismiss={() => setMenu(null)}
        />
      )}

      {closing && closingLive && (
        <ConfirmDialog
          title="シートを閉じます"
          target={label(closingLive)}
          confirmLabel="閉じる"
          onConfirm={() => {
            onClose(closingLive.id);
            setClosing(null);
          }}
          onCancel={() => setClosing(null)}
        >
          書きかけのSQLは元に戻せません。
        </ConfirmDialog>
      )}
    </div>
  );
}
