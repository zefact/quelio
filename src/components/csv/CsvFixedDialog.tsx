/**
 * 固定長の桁を決めるダイアログ。
 *
 * 固定長のファイルには桁の情報が入っていないので、
 * 開いたときの推測をここで直してもらう。
 * よく使う形は名前を付けて残し、次からは選ぶだけにできる
 */
import { useEffect, useState } from "react";
import { csvDeleteLayout, csvLayouts, csvSaveLayout } from "../../api";
import type {
  CsvAlign,
  CsvFixedLayout,
  CsvSavedLayout,
  CsvWidthUnit,
} from "../../types";
import { ConfirmDialog } from "../ConfirmDialog";
import { SelectMenu } from "../SelectMenu";
import {
  UNIT_LABEL,
  applyWidths,
  newColumn,
  parseWidths,
  totalWidth,
  widthsText,
} from "./csvFixed";

interface Props {
  /** 今の桁 (固定長で開いていなければ null) */
  current: CsvFixedLayout | null;
  /** 決めた桁で読み直す */
  onApply: (layout: CsvFixedLayout) => void;
  /** 区切り文字として読み直す */
  onUseDelimiter: () => void;
  onClose: () => void;
}

/** 桁の数え方の選択肢 */
const UNITS = [
  { value: "byte", label: "バイト数 (Shift_JISなら漢字は2桁ぶん)" },
  { value: "char", label: "文字数 (漢字も1桁ぶん)" },
];

/** 寄せる向きの選択肢 */
const ALIGNS = [
  { value: "left", label: "左" },
  { value: "right", label: "右" },
];

/** 埋め文字の選択肢 */
const PADS = [
  { value: " ", label: "空白" },
  { value: "0", label: "0" },
];

/** 固定長で開いていないときの初めの桁 */
const EMPTY: CsvFixedLayout = {
  unit: "byte",
  columns: [newColumn(10)],
  trim: true,
};

export function CsvFixedDialog({
  current,
  onApply,
  onUseDelimiter,
  onClose,
}: Props) {
  const [layout, setLayout] = useState<CsvFixedLayout>(current ?? EMPTY);
  /** 幅をまとめて入れる欄 */
  const [bulk, setBulk] = useState(() => widthsText((current ?? EMPTY).columns));
  const [saved, setSaved] = useState<CsvSavedLayout[]>([]);
  const [name, setName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  /** 消そうとしているレイアウト */
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    void csvLayouts()
      .then(setSaved)
      .catch((e) => setNote(String(e)));
  }, []);

  /** 桁を1つ書き換える */
  const patch = (at: number, fix: Partial<CsvFixedLayout["columns"][number]>) => {
    setLayout((prev) => {
      const columns = prev.columns.map((c, i) =>
        i === at ? { ...c, ...fix } : c
      );
      setBulk(widthsText(columns));
      return { ...prev, columns };
    });
  };

  const addColumn = () => {
    setLayout((prev) => {
      const columns = [...prev.columns, newColumn(10)];
      setBulk(widthsText(columns));
      return { ...prev, columns };
    });
  };

  const removeColumn = (at: number) => {
    setLayout((prev) => {
      const columns = prev.columns.filter((_, i) => i !== at);
      setBulk(widthsText(columns));
      return { ...prev, columns };
    });
  };

  /** まとめて入力した幅を反映する */
  const applyBulk = (text: string) => {
    setBulk(text);
    const widths = parseWidths(text);
    if (widths.length > 0) setLayout((prev) => applyWidths(prev, widths));
  };

  const use = (s: CsvSavedLayout) => {
    setLayout(s.layout);
    setBulk(widthsText(s.layout.columns));
    setName(s.name);
  };

  const save = async () => {
    setNote(null);
    try {
      setSaved(await csvSaveLayout(name, layout));
      setNote(`「${name.trim()}」を残しました`);
    } catch (e) {
      setNote(String(e));
    }
  };

  const remove = async (target: string) => {
    setRemoving(null);
    setNote(null);
    try {
      setSaved(await csvDeleteLayout(target));
    } catch (e) {
      setNote(String(e));
    }
  };

  const total = totalWidth(layout.columns);
  const ready = layout.columns.length > 0 && layout.columns.every((c) => c.width > 0);

  if (removing) {
    return (
      <ConfirmDialog
        title="レイアウトを消します"
        target={removing}
        confirmLabel="消す"
        onConfirm={() => remove(removing)}
        onCancel={() => setRemoving(null)}
      >
        残してある桁の並びを消します。開いているファイルはそのままです。
      </ConfirmDialog>
    );
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal csv-fixed-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-title">固定長の桁</div>

        <div className="csv-form-row">
          <span>数え方</span>
          <SelectMenu
            popFixed
            value={layout.unit}
            options={UNITS}
            onChange={(v) =>
              setLayout((prev) => ({ ...prev, unit: v as CsvWidthUnit }))
            }
          />
        </div>

        <div className="csv-form-row">
          <span>桁をまとめて</span>
          <input
            className="csv-name-box csv-bulk"
            placeholder="10,8,20,4"
            value={bulk}
            onChange={(e) => applyBulk(e.target.value)}
          />
        </div>

        <div className="csv-fixed-list">
          <div className="csv-fixed-head">
            <span>#</span>
            <span>幅</span>
            <span>寄せ</span>
            <span>埋め</span>
            <span>項目名</span>
            <span />
          </div>
          {layout.columns.map((c, i) => (
            <div className="csv-fixed-row" key={i}>
              <span className="mono csv-fixed-no">{i + 1}</span>
              <input
                className="csv-fixed-w mono"
                type="number"
                min={1}
                value={c.width}
                onChange={(e) =>
                  patch(i, { width: Math.max(1, +e.target.value || 1) })
                }
              />
              <SelectMenu
                popFixed
                value={c.align}
                options={ALIGNS}
                onChange={(v) => patch(i, { align: v as CsvAlign })}
              />
              <SelectMenu
                popFixed
                value={c.pad}
                options={PADS}
                onChange={(pad) => patch(i, { pad })}
              />
              <input
                className="csv-fixed-name"
                placeholder={`${i + 1}`}
                value={c.name}
                onChange={(e) => patch(i, { name: e.target.value })}
              />
              <button
                className="btn-ghost csv-fixed-del"
                title="この桁を消す"
                disabled={layout.columns.length <= 1}
                onClick={() => removeColumn(i)}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="csv-fixed-foot">
            <button className="btn-secondary" onClick={addColumn}>
              桁を足す
            </button>
            <span className="toolbar-spacer" />
            <span className="mono">
              計 {total}
              {UNIT_LABEL[layout.unit]}
            </span>
          </div>
        </div>

        <label className="csv-check">
          <input
            type="checkbox"
            checked={layout.trim}
            onChange={(e) =>
              setLayout((prev) => ({ ...prev, trim: e.target.checked }))
            }
          />
          埋め文字を落として表示する (保存のときに詰め直します)
        </label>

        <div className="csv-fixed-saved">
          <div className="csv-key-head">残してあるレイアウト</div>
          {saved.length === 0 ? (
            <div className="csv-empty-hint">まだありません</div>
          ) : (
            <div className="csv-fixed-saved-list">
              {saved.map((s) => (
                <div className="csv-fixed-saved-row" key={s.name}>
                  <button className="btn-ghost" onClick={() => use(s)}>
                    {s.name}
                  </button>
                  <span className="csv-find-note">
                    {s.layout.columns.length}桁
                  </span>
                  <button
                    className="btn-ghost csv-fixed-del"
                    title="消す"
                    onClick={() => setRemoving(s.name)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="csv-fixed-save">
            <input
              className="csv-name-box"
              placeholder="名前を付けて残す"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              className="btn-secondary"
              disabled={!name.trim() || !ready}
              onClick={() => void save()}
            >
              残す
            </button>
          </div>
        </div>

        {note && <div className="csv-find-note">{note}</div>}

        <div className="modal-actions csv-fixed-actions">
          <button className="btn-ghost" onClick={onUseDelimiter}>
            区切り文字として読み直す
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
            この桁で読み直す
          </button>
        </div>
      </div>
    </div>
  );
}
