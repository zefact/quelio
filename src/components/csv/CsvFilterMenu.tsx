/**
 * 見出しの絞り込みボタンから出すメニュー。
 *
 * 上は「その列に入っている値」の一覧、下は「含む・以上」などの条件。
 * どちらも掛けられ、両方に当てはまる行だけが残る
 */
import { useEffect, useMemo, useState } from "react";
import { csvFilterValues } from "../../api";
import { useDismiss } from "../../hooks/useDismiss";
import { usePopupPosition } from "../../hooks/usePopupPosition";
import { SelectMenu } from "../SelectMenu";
import { SortAscIcon, SortDescIcon } from "./CsvFilterIcons";
import type {
  CsvColumnFilter,
  CsvFilterKind,
  CsvFilterRule,
  CsvFilterValue,
  CsvSort,
} from "../../types";
import {
  KINDS,
  matching,
  needsValue,
  pickedValues,
  usableRules,
} from "./csvFilter";

/** 条件の選び方 (アプリ共通の見た目のセレクトに渡す形) */
const KIND_OPTIONS = KINDS.map((k) => ({ value: k.kind, label: k.label }));

/** 一度に並べる値の数 (これより多いときは、上の欄で絞ってもらう) */
const SHOW_LIMIT = 500;

/** 条件を書ける数 (表計算ソフトと同じく2つまで) */
const RULE_SLOTS = 2;

/** 絞り方 (値を選ぶ / 条件を書く) */
type Mode = "values" | "rules";

interface Props {
  docId: string;
  col: number;
  /** 列の名前 (見出しに出す) */
  name: string;
  /** 今その列に掛かっている絞り込み */
  current: CsvColumnFilter | undefined;
  /** 今の並べ替え (この列でなければ、この列は並べ替えていない) */
  sort: CsvSort | null;
  /** 並べ替えを変える (null で元の並びに戻す) */
  onSort: (desc: boolean | null) => void;
  /** 出す位置 (押したつまみの左下) */
  x: number;
  y: number;
  /** 下に入らないときに、上へ折り返す先 (つまみの上端) */
  flipY: number;
  /** 決めた絞り込みを渡す */
  onDecide: (next: CsvColumnFilter) => void;
  onClose: () => void;
}

/** 空欄は「(空白)」と出す (何も見えないと選べないため) */
function label(text: string): string {
  return text === "" ? "(空白)" : text;
}

export function CsvFilterMenu({
  docId,
  col,
  name,
  current,
  sort,
  onSort,
  x,
  y,
  flipY,
  onDecide,
  onClose,
}: Props) {
  const [values, setValues] = useState<CsvFilterValue[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 値の一覧を絞る言葉 */
  const [search, setSearch] = useState("");
  /** 選んでいる値 (一覧が届くまでは決められない) */
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [rules, setRules] = useState<CsvFilterRule[]>(() => {
    const list = [...(current?.rules ?? [])];
    while (list.length < RULE_SLOTS) list.push({ kind: "contains", value: "" });
    return list.slice(0, RULE_SLOTS);
  });
  const [all, setAll] = useState(current?.all ?? true);
  /*
   * どちらで絞るか。
   *
   * 開いたときは、今その列に掛かっている絞り方に合わせる
   * (条件で絞っていれば条件、そうでなければ値)
   */
  const [mode, setMode] = useState<Mode>(
    current && current.rules.length > 0 ? "rules" : "values"
  );
  // 画面の端で切れないよう、出す位置は共通のフックに任せる
  const [boxRef, boxStyle] = usePopupPosition<HTMLDivElement>(x, y, flipY);

  // 値の一覧を取りに行く (他の列で絞ったあとの行から数えたものが届く)
  useEffect(() => {
    let alive = true;
    csvFilterValues(docId, col)
      .then((got) => {
        if (!alive) return;
        setValues(got.values);
        setTruncated(got.truncated);
        // 前に選んでいたものがあればそれを、無ければ全部選んだ形から始める
        const before = current?.values;
        setPicked(
          new Set(before ?? got.values.map((v) => v.text))
        );
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
    // 開いたときに1度だけ取りに行く
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, col]);

  const shown = useMemo(
    () => matching(values ?? [], search),
    [values, search]
  );
  const listed = shown.slice(0, SHOW_LIMIT);
  /** 出ているものが全部選ばれているか */
  const allPicked = listed.length > 0 && listed.every((v) => picked?.has(v.text));

  const toggle = (text: string) =>
    setPicked((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(text)) next.delete(text);
      else next.add(text);
      return next;
    });

  /** 出ているものをまとめて入り切りする */
  const toggleAll = () =>
    setPicked((prev) => {
      const next = new Set(prev ?? []);
      for (const v of listed) {
        if (allPicked) next.delete(v.text);
        else next.add(v.text);
      }
      return next;
    });

  const putRule = (at: number, fix: Partial<CsvFilterRule>) =>
    setRules((prev) => prev.map((r, i) => (i === at ? { ...r, ...fix } : r)));

  /** 今出している絞り方だけを渡す (もう片方は外す) */
  const decide = () =>
    onDecide({
      col,
      values:
        mode === "values" && values && picked
          ? pickedValues(values, picked)
          : null,
      rules: mode === "rules" ? usableRules(rules) : [],
      all,
    });

  /** 絞り込みを外す */
  const clear = () =>
    onDecide({ col, values: null, rules: [], all: true });

  /** この列を小さい順・大きい順に並べているか */
  const asc = sort?.col === col && !sort.desc;
  const desc = sort?.col === col && sort.desc;

  // 外を押したときと Esc で閉じる (他のメニューと同じ扱い)
  useDismiss(true, onClose, { ref: boxRef, escape: true });

  return (
    <div
      className="csv-filter-menu"
      ref={boxRef}
      style={boxStyle}
      role="dialog"
      aria-label={`${name} の絞り込み`}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter") {
          e.preventDefault();
          decide();
        }
      }}
    >
      <div className="csv-filter-head">{name}</div>

      {/* 並べ替えは押すとすぐ効く (もう一度押すと元の並びに戻す) */}
      <div className="csv-filter-sort">
        <button
          className={"csv-filter-order" + (asc ? " on" : "")}
          onClick={() => onSort(asc ? null : false)}
        >
          <SortAscIcon />
          小さい順
        </button>
        <button
          className={"csv-filter-order" + (desc ? " on" : "")}
          onClick={() => onSort(desc ? null : true)}
        >
          <SortDescIcon />
          大きい順
        </button>
      </div>

      {/* 絞り方は2つ。出している側だけが効く */}
      <div className="csv-filter-tabs" role="tablist">
        <button
          className={"csv-filter-tab" + (mode === "values" ? " on" : "")}
          role="tab"
          aria-selected={mode === "values"}
          onClick={() => setMode("values")}
        >
          値で絞る
        </button>
        <button
          className={"csv-filter-tab" + (mode === "rules" ? " on" : "")}
          role="tab"
          aria-selected={mode === "rules"}
          onClick={() => setMode("rules")}
        >
          条件で絞る
        </button>
      </div>

      {mode === "values" && (
        <input
          className="csv-filter-search"
          placeholder="値を探す"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}

      {mode === "values" && error && (
        <div className="csv-filter-note ng">{error}</div>
      )}
      {mode === "values" && !values && !error && (
        <div className="csv-filter-note">読み込み中…</div>
      )}

      {mode === "values" && values && (
        <>
          <div className="csv-filter-list">
            <label className="csv-filter-item all">
              <input type="checkbox" checked={allPicked} onChange={toggleAll} />
              <span>(すべて選択)</span>
            </label>
            {listed.map((v) => (
              <label className="csv-filter-item" key={v.text}>
                <input
                  type="checkbox"
                  checked={picked?.has(v.text) ?? false}
                  onChange={() => toggle(v.text)}
                />
                <span className="csv-filter-text">{label(v.text)}</span>
                <span className="csv-filter-count">
                  {v.count.toLocaleString()}
                </span>
              </label>
            ))}
            {shown.length === 0 && (
              <div className="csv-filter-note">当てはまる値がありません</div>
            )}
          </div>
          {(shown.length > listed.length || truncated) && (
            <div className="csv-filter-note">
              値が多いので{listed.length.toLocaleString()}個まで出しています。
              上の欄で絞り込んでください
            </div>
          )}
        </>
      )}

      {mode === "rules" && (
      <div className="csv-filter-rules">
        {rules.map((r, i) => (
          <div className="csv-filter-rule" key={i}>
            <SelectMenu
              popFixed
              value={r.kind}
              options={KIND_OPTIONS}
              onChange={(v) => putRule(i, { kind: v as CsvFilterKind })}
            />
            <input
              className="csv-filter-value"
              placeholder="値"
              disabled={!needsValue(r.kind)}
              value={r.value}
              onChange={(e) => putRule(i, { value: e.target.value })}
            />
          </div>
        ))}
        <div className="csv-filter-join">
          <label className="csv-check">
            <input
              type="radio"
              checked={all}
              onChange={() => setAll(true)}
            />
            かつ
          </label>
          <label className="csv-check">
            <input
              type="radio"
              checked={!all}
              onChange={() => setAll(false)}
            />
            または
          </label>
        </div>
      </div>
      )}

      <div className="csv-filter-foot">
        <button className="btn-ghost csv-filter-btn" onClick={clear}>
          外す
        </button>
        <span className="toolbar-spacer" />
        <button className="btn-secondary csv-filter-btn" onClick={onClose}>
          キャンセル
        </button>
        <button className="btn-primary csv-filter-btn" onClick={decide}>
          絞り込む
        </button>
      </div>
    </div>
  );
}
