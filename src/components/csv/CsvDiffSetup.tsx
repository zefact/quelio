/**
 * 比較の条件を決めるダイアログ。
 *
 * 「どの列で突き合わせるか」だけは自動で決められないので、
 * 開いた時点で推測した列を入れておき、違えば直してもらう
 */
import { useEffect, useState } from "react";
import { csvGuessKey } from "../../api";
import type { CsvDiffMode, CsvDiffOptions, CsvInfo } from "../../types";
import { SelectMenu } from "../SelectMenu";

/** 突き合わせ方の選択肢 */
const MODES = [
  { value: "key", label: "キーの列で対応させる" },
  { value: "set", label: "行の中身がまるごと同じかで見る" },
];

interface Props {
  tabs: CsvInfo[];
  /** 最初に左へ入れるタブ (今見ているもの) */
  initialLeft: string;
  onStart: (leftId: string, rightId: string, options: CsvDiffOptions) => void;
  onCancel: () => void;
}

export function CsvDiffSetup({ tabs, initialLeft, onStart, onCancel }: Props) {
  const other = tabs.find((t) => t.docId !== initialLeft)?.docId ?? initialLeft;
  const [leftId, setLeftId] = useState(initialLeft);
  const [rightId, setRightId] = useState(other);
  const [mode, setMode] = useState<CsvDiffMode>("key");
  const [key, setKey] = useState<string[]>([]);
  const [trim, setTrim] = useState(false);
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const tabOptions = tabs.map((t) => ({ value: t.docId, label: t.name }));
  const left = tabs.find((t) => t.docId === leftId) ?? null;
  const right = tabs.find((t) => t.docId === rightId) ?? null;
  /** 左右どちらにもある列だけがキーに使える */
  const shared = (left?.columns ?? []).filter((c) =>
    (right?.columns ?? []).includes(c)
  );

  // 組み合わせを変えるたびにキーを推測し直す
  useEffect(() => {
    if (leftId === rightId) {
      setKey([]);
      return;
    }
    let alive = true;
    void csvGuessKey(leftId, rightId)
      .then((got) => {
        if (alive) setKey(got);
      })
      .catch((e) => {
        if (alive) setNote(String(e));
      });
    return () => {
      alive = false;
    };
  }, [leftId, rightId]);

  const toggleKey = (name: string) => {
    setKey((prev) =>
      prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]
    );
  };

  const ready = leftId !== rightId && (mode === "set" || key.length > 0);

  return (
    <div className="modal-overlay" onMouseDown={onCancel}>
      <div className="modal csv-diff-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">CSVを比べる</div>

        <div className="csv-form-row">
          <span>左 (元)</span>
          <SelectMenu
            popFixed
            value={leftId}
            options={tabOptions}
            onChange={setLeftId}
          />
        </div>
        <div className="csv-form-row">
          <span>右 (新)</span>
          <SelectMenu
            popFixed
            value={rightId}
            options={tabOptions}
            onChange={setRightId}
          />
        </div>

        <div className="csv-form-row">
          <span>突き合わせ方</span>
          <SelectMenu
            popFixed
            value={mode}
            options={MODES}
            onChange={(v) => setMode(v as CsvDiffMode)}
          />
        </div>

        {mode === "key" && (
          <div className="csv-key-pick">
            <div className="csv-key-head">キーにする列 (複数可)</div>
            {shared.length === 0 ? (
              <div className="csv-warn">左右に共通の列がありません</div>
            ) : (
              <div className="csv-key-list">
                {shared.map((c) => (
                  <label key={c} className="csv-check">
                    <input
                      type="checkbox"
                      checked={key.includes(c)}
                      onChange={() => toggleKey(c)}
                    />
                    {c}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="csv-diff-opts">
          <label className="csv-check">
            <input
              type="checkbox"
              checked={trim}
              onChange={(e) => setTrim(e.target.checked)}
            />
            前後の空白を無視する
          </label>
          <label className="csv-check">
            <input
              type="checkbox"
              checked={ignoreCase}
              onChange={(e) => setIgnoreCase(e.target.checked)}
            />
            英字の大小を無視する
          </label>
        </div>

        {leftId === rightId && (
          <div className="csv-warn">左右に別のファイルを選んでください</div>
        )}
        {note && <div className="csv-warn">{note}</div>}

        <div className="modal-actions csv-modal-actions">
          <button className="btn-secondary" onClick={onCancel}>
            キャンセル
          </button>
          <button
            className="btn-primary"
            disabled={!ready}
            onClick={() =>
              onStart(leftId, rightId, { mode, key, trim, ignoreCase })
            }
          >
            比べる
          </button>
        </div>
      </div>
    </div>
  );
}
