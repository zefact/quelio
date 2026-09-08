/**
 * 固定長の桁設定ダイアログ。
 *
 * 固定長のファイルには桁の情報が入っていないので、
 * 開いたときの推測をここで修正する。
 *
 * データ行のほかに、先頭のヘッダ行と末尾のトレーラ行を別の桁で決められる
 * (ホストから来るファイルには、この3種類が混ざっているものがある)。
 *
 * お気に入りから読み込んで開いた場合は、その名前が入った状態で始まるので、
 * 桁を直してそのまま上書きできる。
 * お気に入りの一覧と削除はツールバーのメニュー側に置いてある
 */
import { useState } from "react";
import { csvSaveLayout } from "../../api";
import type {
  CsvFixedColumn,
  CsvFixedKey,
  CsvFixedLayout,
  CsvSavedLayout,
  CsvWidthUnit,
} from "../../types";
import { SelectMenu } from "../SelectMenu";
import { CsvFixedColumns } from "./CsvFixedColumns";
import { UNIT_LABEL, newColumn, totalWidth } from "./csvFixed";

interface Props {
  /** 今の桁 (固定長で開いていなければ null) */
  current: CsvFixedLayout | null;
  /**
   * 今このファイルに使われているお気に入りの名前 (無ければ null)。
   *
   * 名前の欄はここから始める。使われていなければ空欄で開く
   */
  applied: string | null;
  /** 登録済みのお気に入り (保存が上書きになるかの判断に使う) */
  layouts: CsvSavedLayout[];
  /** 決めた桁で読み直す */
  onApply: (layout: CsvFixedLayout) => void;
  onClose: () => void;
}

/** 桁幅の単位の選択肢 */
const UNITS = [
  { value: "byte", label: "バイト数 (Shift_JISでは漢字が2桁)" },
  { value: "char", label: "文字数 (漢字も1桁)" },
];

/** 固定長で開いていないときの初期値 */
const EMPTY: CsvFixedLayout = {
  unit: "byte",
  columns: [newColumn(10)],
  trim: true,
  newline: true,
  header: [],
  trailer: [],
  key: null,
};

/** 種別を見分ける決まりの初めの値 (先頭1つを見る) */
const FIRST: CsvFixedKey = { at: 0, len: 1, header: "" };

export function CsvFixedDialog({
  current,
  applied,
  layouts,
  onApply,
  onClose,
}: Props) {
  const [layout, setLayout] = useState<CsvFixedLayout>(current ?? EMPTY);
  /** お気に入りの名前 (使われているものがあればそこから始める) */
  const [name, setName] = useState(applied ?? "");
  const [note, setNote] = useState<string | null>(null);

  /** レイアウトの一部を差し替える */
  const put = (fix: Partial<CsvFixedLayout>) =>
    setLayout((prev) => ({ ...prev, ...fix }));

  /** ヘッダ・トレーラの有無を切り替える (入れるときは1桁から始める) */
  const toggleEdge = (trailer: boolean, on: boolean) => {
    const columns: CsvFixedColumn[] = on ? [newColumn(10)] : [];
    put(trailer ? { trailer: columns } : { header: columns });
  };

  /** 種別を見分ける決まりの一部を差し替える */
  const putKey = (fix: Partial<CsvFixedKey>) =>
    put({ key: { ...(layout.key ?? FIRST), ...fix } });

  /*
   * 種別を見分けるときは、ヘッダは「先頭の1件」ではなくなる。
   * トレーラ (末尾の1件) とは考え方が合わないので、同時には使わない
   */
  const mixed = layout.key !== null;

  /** 今の桁設定を、入れた名前でお気に入りに保存する */
  const save = async () => {
    const target = name.trim();
    setNote(null);
    try {
      const already = layouts.some((s) => s.name === target);
      await csvSaveLayout(target, layout);
      setNote(
        already
          ? `「${target}」を上書きしました`
          : `「${target}」をお気に入りに保存しました`
      );
    } catch (e) {
      setNote(String(e));
    }
  };

  const total = totalWidth(layout.columns);
  const ready =
    layout.columns.length > 0 && layout.columns.every((c) => c.width > 0);
  /** 入れた名前が、既にあるお気に入りと同じか (同じなら上書きになる) */
  const exists = layouts.some((s) => s.name === name.trim());

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal csv-fixed-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-title">固定長の桁設定</div>

        <div className="csv-form-row">
          <span>お気に入り名</span>
          <input
            className="csv-name-box"
            placeholder="未設定 (保存する場合に入力)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="csv-form-row">
          <span>桁幅の単位</span>
          <SelectMenu
            popFixed
            value={layout.unit}
            options={UNITS}
            onChange={(v) => put({ unit: v as CsvWidthUnit })}
          />
        </div>

        <CsvFixedColumns
          columns={layout.columns}
          unit={layout.unit}
          onChange={(columns) => put({ columns })}
        />

        <label className="csv-check">
          <input
            type="checkbox"
            checked={layout.trim}
            onChange={(e) => put({ trim: e.target.checked })}
          />
          埋め文字を除いて表示する (保存時は元の桁幅に戻します)
        </label>

        {/*
          ホストから来るファイルには、改行が1つも無く
          桁の合計ぶんずつが1件になっているものがある
        */}
        <label className="csv-check">
          <input
            type="checkbox"
            checked={!layout.newline}
            onChange={(e) => put({ newline: !e.target.checked })}
          />
          改行が無いファイル (計{total}
          {UNIT_LABEL[layout.unit]}ごとに1行として読み込む)
        </label>

        {/*
          先頭と末尾だけ桁が違うファイルへの指定。
          どちらも表には混ぜず、表の外に出して編集してもらう
        */}
        <label className="csv-check">
          <input
            type="checkbox"
            checked={layout.header.length > 0}
            onChange={(e) => toggleEdge(false, e.target.checked)}
          />
          ヘッダ行がある (データ行とは別の桁で読み込む)
        </label>
        {layout.header.length > 0 && (
          <div className="csv-fixed-part">
            <div className="csv-key-head">
              ヘッダ行の桁 (計{totalWidth(layout.header)}
              {UNIT_LABEL[layout.unit]})
            </div>
            <CsvFixedColumns
              columns={layout.header}
              unit={layout.unit}
              onChange={(header) => put({ header })}
            />

            {/*
              ヘッダ行とボディ行が交互に来るファイルは、
              決まった位置の値を見てレコードごとに種別を決める
            */}
            <label className="csv-check">
              <input
                type="checkbox"
                checked={mixed}
                onChange={(e) =>
                  put({
                    key: e.target.checked ? FIRST : null,
                    // 末尾の1件という考え方とは合わないので外す
                    trailer: e.target.checked ? [] : layout.trailer,
                  })
                }
              />
              ヘッダ行が何度も出てくる (値を見て1行ずつ種別を決める)
            </label>
            {mixed && (
              <>
                <div className="csv-form-row">
                  <span>見る位置</span>
                  <div className="csv-key-where">
                    <input
                      className="csv-fixed-w mono"
                      type="number"
                      min={1}
                      value={(layout.key?.at ?? 0) + 1}
                      onChange={(e) =>
                        putKey({ at: Math.max(0, (+e.target.value || 1) - 1) })
                      }
                    />
                    <span>
                      {UNIT_LABEL[layout.unit]}目から
                    </span>
                    <input
                      className="csv-fixed-w mono"
                      type="number"
                      min={1}
                      value={layout.key?.len ?? 1}
                      onChange={(e) =>
                        putKey({ len: Math.max(1, +e.target.value || 1) })
                      }
                    />
                    <span>{UNIT_LABEL[layout.unit]}分</span>
                  </div>
                </div>
                <div className="csv-form-row">
                  <span>ヘッダ行の値</span>
                  <input
                    className="csv-name-box mono"
                    placeholder="例: A"
                    value={layout.key?.header ?? ""}
                    onChange={(e) => putKey({ header: e.target.value })}
                  />
                </div>
                <div className="csv-fixed-save-hint">
                  この値になっている行はヘッダ行の桁で、それ以外はデータ行の桁で読み込みます。
                  1つの表に並べて、ヘッダ行に色を付けます
                </div>
              </>
            )}
          </div>
        )}

        {!mixed && (
          <>
            <label className="csv-check">
              <input
                type="checkbox"
                checked={layout.trailer.length > 0}
                onChange={(e) => toggleEdge(true, e.target.checked)}
              />
              末尾にトレーラ行がある (データ行とは別の桁で読み込む)
            </label>
            {layout.trailer.length > 0 && (
              <div className="csv-fixed-part">
                <div className="csv-key-head">
                  トレーラ行の桁 (計{totalWidth(layout.trailer)}
                  {UNIT_LABEL[layout.unit]})
                </div>
                <CsvFixedColumns
                  columns={layout.trailer}
                  unit={layout.unit}
                  onChange={(trailer) => put({ trailer })}
                />
              </div>
            )}
          </>
        )}

        {note && <div className="csv-find-note">{note}</div>}

        <div className="modal-actions csv-fixed-actions">
          <button
            className="btn-secondary"
            disabled={!name.trim() || !ready}
            title={name.trim() ? undefined : "お気に入り名を入力すると保存できます"}
            onClick={() => void save()}
          >
            {exists ? "お気に入りを上書き" : "お気に入りに保存"}
          </button>
          <span className="toolbar-spacer" />
          <button className="btn-secondary" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn-primary"
            disabled={!ready}
            onClick={() => onApply(layout)}
          >
            この桁設定で読み直す
          </button>
        </div>
      </div>
    </div>
  );
}
