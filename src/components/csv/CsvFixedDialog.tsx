/**
 * 固定長の桁設定ダイアログ。
 *
 * 固定長のファイルには桁の情報が入っていないので、
 * 開いたときの推測をここで修正する。
 *
 * データ行のほかに、先頭のヘッダ行と末尾のトレーラ行、
 * および「値で見分けるレコードの種別」を別の桁で決められる。
 * 縦に長くならないよう、桁の並びはタブで1つずつ出す。
 *
 * お気に入りから読み込んで開いた場合は、その名前が入った状態で始まるので、
 * 桁を直してそのまま上書きできる。
 * お気に入りの一覧と削除はツールバーのメニュー側に置いてある。
 *
 * 一覧の ✎ から開いたとき (`edit` を渡したとき) は、ファイルは読み直さず、
 * そのお気に入りの名前と桁だけを直す。
 * 読み直す相手が無いとき (`onApply` を渡さないとき) は、お気に入りに保存するだけになる。
 * 下のボタンの並びは CsvFixedFooter に分けてある
 */
import { useState } from "react";
import { csvSaveLayout } from "../../api";
import { useModal } from "../../hooks/useModal";
import type {
  CsvFixedColumn,
  CsvFixedKind,
  CsvFixedLayout,
  CsvSavedLayout,
  CsvWidthUnit,
} from "../../types";
import { SelectMenu } from "../SelectMenu";
import { CsvFixedColumns } from "./CsvFixedColumns";
import { CsvFixedFooter } from "./CsvFixedFooter";
import { CsvFixedKindPart } from "./CsvFixedKinds";
import { UNIT_LABEL, newColumn, newKind, totalWidth } from "./csvFixed";

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
  /**
   * 一覧のお気に入りを直すときに渡す。
   *
   * 渡すと読み直しのボタンは出さず、保存はそのお気に入りの差し替えになる
   * (名前を変えても、並びの場所とフォルダはそのまま)
   */
  edit?: CsvLayoutEdit;
  /**
   * 決めた桁で読み直す。
   *
   * 読み直す相手が無いとき (ファイルを開いていない) は渡さない。
   * そのときは読み直しのボタンを出さず、お気に入りに保存するだけになる
   */
  onApply?: (layout: CsvFixedLayout) => void;
  onClose: () => void;
}

/** 一覧のお気に入りを直すときの、元の名前と残し方 */
export interface CsvLayoutEdit {
  /** 直す前の名前 */
  name: string;
  /** 直した中身を残す (うまくいったら呼び出し側が画面を閉じる) */
  save: (name: string, layout: CsvFixedLayout) => Promise<void>;
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
  kinds: [],
};

export function CsvFixedDialog({
  current,
  applied,
  layouts,
  edit,
  onApply,
  onClose,
}: Props) {
  const [layout, setLayout] = useState<CsvFixedLayout>(current ?? EMPTY);
  /** お気に入りの名前 (使われているものがあればそこから始める) */
  const [name, setName] = useState(applied ?? "");
  const [note, setNote] = useState<string | null>(null);
  /** 保存できなかった理由 (一覧のお気に入りを直しているとき) */
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * 今どの桁を出しているか。
   *
   * 桁の並びは場所ごとに1つずつ出す (全部を縦に並べると読めなくなるため)。
   * "body" はデータ行、"head"/"tail" は先頭と末尾、"kindN" は種別
   */
  const [part, setPart] = useState("body");
  // Esc で閉じる (他のダイアログと同じ)。保存している間は閉じない
  const boxRef = useModal(onClose, !busy);

  /** レイアウトの一部を差し替える */
  const put = (fix: Partial<CsvFixedLayout>) =>
    setLayout((prev) => ({ ...prev, ...fix }));

  /** ヘッダ・トレーラの有無を切り替える (入れるときは1桁から始める) */
  const toggleEdge = (trailer: boolean, on: boolean) => {
    const columns: CsvFixedColumn[] = on ? [newColumn(10)] : [];
    put(trailer ? { trailer: columns } : { header: columns });
  };

  /*
   * 種別を見分けるときは、ヘッダは「先頭の1件」ではなくなる。
   * ヘッダ・トレーラ (先頭と末尾の1件) とは考え方が合わないので、
   * 同時には使わない
   */
  const mixed = layout.kinds.length > 0;

  /** 種別を見分けるかどうかの切り替え (入れるときは1つ目を用意する) */
  const toggleKinds = (on: boolean) =>
    put(
      on
        ? { kinds: [newKind("ヘッダ")], header: [], trailer: [] }
        : { kinds: [] }
    );

  /** 種別を1つ足して、その種別を出す */
  const addKind = () => {
    const kinds = [...layout.kinds, newKind(`種別${layout.kinds.length + 1}`)];
    put({ kinds });
    setPart(`kind${kinds.length - 1}`);
  };

  /** 種別の一部を差し替える */
  const putKind = (at: number, fix: Partial<CsvFixedKind>) =>
    put({ kinds: layout.kinds.map((k, i) => (i === at ? { ...k, ...fix } : k)) });

  /** 種別をやめる (最後の1つをやめたら、種別の見分けそのものをやめる) */
  const removeKind = (at: number) => {
    put({ kinds: layout.kinds.filter((_, i) => i !== at) });
    setPart("body");
  };

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

  /** 一覧のお気に入りを、直した中身で差し替える */
  const saveEdit = async () => {
    if (!edit) return;
    const target = name.trim();
    // ほかのお気に入りと同じ名前にはしない (黙って上書きしないように)
    if (target !== edit.name && layouts.some((s) => s.name === target)) {
      setError(`「${target}」というお気に入りはすでにあります`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await edit.save(target, layout);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  /** 桁を決められる場所の一覧 (タブに並べる) */
  const parts: { key: string; label: string }[] = [
    { key: "body", label: "データ行" },
    ...(layout.header.length > 0 ? [{ key: "head", label: "ヘッダ行" }] : []),
    ...(layout.trailer.length > 0 ? [{ key: "tail", label: "トレーラ行" }] : []),
    ...layout.kinds.map((k, i) => ({
      key: `kind${i}`,
      label: k.name || `種別${i + 1}`,
    })),
  ];
  // 出していた場所が無くなったら、データ行へ戻す
  const shown = parts.some((p) => p.key === part) ? part : "body";
  /** 今出している種別 (種別でなければ -1) */
  const kindAt = shown.startsWith("kind") ? Number(shown.slice(4)) : -1;
  /** 今出している場所の桁 */
  const columns =
    kindAt >= 0
      ? layout.kinds[kindAt].columns
      : shown === "head"
        ? layout.header
        : shown === "tail"
          ? layout.trailer
          : layout.columns;
  /** 今出している場所の桁を差し替える */
  const putColumns = (next: CsvFixedColumn[]) => {
    if (kindAt >= 0) putKind(kindAt, { columns: next });
    else if (shown === "head") put({ header: next });
    else if (shown === "tail") put({ trailer: next });
    else put({ columns: next });
  };

  const total = totalWidth(layout.columns);
  const ready =
    layout.columns.length > 0 && layout.columns.every((c) => c.width > 0);
  /** 入れた名前が、既にあるお気に入りと同じか (同じなら上書きになる) */
  const exists = layouts.some((s) => s.name === name.trim());

  return (
    <div className="modal-overlay" onMouseDown={busy ? undefined : onClose}>
      <div
        className="modal csv-fixed-modal"
        ref={boxRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">
            {edit ? "お気に入りの編集" : "固定長の桁設定"}
          </span>
          <button
            className="modal-close"
            disabled={busy}
            onClick={onClose}
            title="閉じる"
          >
            ×
          </button>
        </div>

        <div className="csv-fixed-body">
          {/* 名前と単位は横に並べる (見出しは欄の上。他のダイアログと同じ形) */}
          <div className="csv-fixed-top">
            <label className="save-sql-label">
              お気に入り名
              <input
                className="save-sql-input"
                placeholder={edit ? "名前を入力" : "未設定 (保存する場合に入力)"}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="save-sql-label">
              桁幅の単位
              <SelectMenu
                popFixed
                value={layout.unit}
                options={UNITS}
                onChange={(v) => put({ unit: v as CsvWidthUnit })}
              />
            </div>
          </div>

          {/* 入り切りは2列に並べて、縦に長くならないようにする */}
          <div className="csv-fixed-opts">
            <label className="csv-check">
              <input
                type="checkbox"
                className="pick-check"
                checked={layout.trim}
                onChange={(e) => put({ trim: e.target.checked })}
              />
              埋め文字を除いて表示する
            </label>

            {/*
              ホストから来るファイルには、改行が1つも無く
              桁の合計ぶんずつが1件になっているものがある
            */}
            <label className="csv-check">
              <input
                type="checkbox"
                className="pick-check"
                checked={!layout.newline}
                onChange={(e) => put({ newline: !e.target.checked })}
              />
              改行が無いファイル (計{total}
              {UNIT_LABEL[layout.unit]}ごと)
            </label>

            {/*
              先頭と末尾だけ桁が違うファイルへの指定。
              どちらも表には混ぜず、表の外に出して編集してもらう。
              種別を見分けるときは使えないので、押せなくして残す (欄が出たり消えたりしないように)
            */}
            <label className={"csv-check" + (mixed ? " off" : "")}>
              <input
                type="checkbox"
                className="pick-check"
                disabled={mixed}
                checked={layout.header.length > 0}
                onChange={(e) => toggleEdge(false, e.target.checked)}
              />
              先頭にヘッダ行がある
            </label>
            <label className={"csv-check" + (mixed ? " off" : "")}>
              <input
                type="checkbox"
                className="pick-check"
                disabled={mixed}
                checked={layout.trailer.length > 0}
                onChange={(e) => toggleEdge(true, e.target.checked)}
              />
              末尾にトレーラ行がある
            </label>

            {/*
              レコードごとに桁が違うファイルへの指定。
              値を見て種別を決め、種別ごとの桁で1つの表に並べる
            */}
            <label className="csv-check csv-fixed-opt-wide">
              <input
                type="checkbox"
                className="pick-check"
                checked={mixed}
                onChange={(e) => toggleKinds(e.target.checked)}
              />
              レコードの種別を見分ける
              <span className="save-sql-note">
                (行ごとに桁が違うファイル。ヘッダ行・トレーラ行とは一緒に使えません)
              </span>
            </label>
          </div>

          {/* 桁の並びは、場所ごとにここで切り替えて出す */}
          <div className="csv-fixed-tabs-row">
            <div className="result-tabs csv-fixed-tabs" role="tablist">
              {parts.map((p) => (
                <button
                  key={p.key}
                  className={"result-tab" + (p.key === shown ? " active" : "")}
                  role="tab"
                  aria-selected={p.key === shown}
                  onClick={() => setPart(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {mixed && (
              <button
                type="button"
                className="lib-action"
                title="レコードの種別を足す"
                onClick={addKind}
              >
                ＋ 種別を追加
              </button>
            )}
          </div>

          <div className="csv-fixed-part">
            {kindAt >= 0 && (
              <CsvFixedKindPart
                kind={layout.kinds[kindAt]}
                unit={layout.unit}
                onChange={(fix) => putKind(kindAt, fix)}
                onRemove={() => removeKind(kindAt)}
              />
            )}
            <CsvFixedColumns
              /*
                出している場所ごとに作り直す。
                同じ部品を使い回すと、一括入力の欄に前の場所の桁が残ってしまう
              */
              key={shown}
              columns={columns}
              unit={layout.unit}
              onChange={putColumns}
            />
            {mixed && kindAt < 0 && shown === "body" && (
              <span className="save-sql-note">
                上のタブの種別を順に見て、はじめに当てはまった桁で読み込みます。
                どれにも当てはまらない行は、このデータ行の桁で読み込みます
              </span>
            )}
          </div>

          {note && <div className="csv-fixed-note">{note}</div>}
          {error && <div className="csv-fixed-note error">{error}</div>}
        </div>

        <CsvFixedFooter
          mode={edit ? "edit" : onApply ? "apply" : "register"}
          named={!!name.trim()}
          ready={ready}
          exists={exists}
          busy={busy}
          onSave={() => void (edit ? saveEdit() : save())}
          onApply={() => onApply?.(layout)}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
