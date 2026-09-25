/**
 * CSVの検索・置換バー。
 *
 * 画面は見えている行しか持っていないので、探すのはRust側に任せる。
 * 見つかった場所を親へ返し、親がそこへカーソルを動かす
 */
import { useEffect, useRef, useState } from "react";
import { csvFind, csvReplaceAll, csvReplaceOne } from "../../api";
import type { CsvFindOptions, CsvInfo, CsvMatch, CsvRect } from "../../types";
import { selectionCells } from "./csvSelection";
import { CsvRegexHelp } from "./CsvRegexHelp";
import {
  CloseIcon,
  DownIcon,
  MoreIcon,
  ReplaceAllIcon,
  ReplaceOneIcon,
  ScopeIcon,
  UpIcon,
} from "./CsvFindIcons";
import { imeBusy } from "../../ime";

interface Props {
  docId: string;
  /** 今選んでいる範囲 (「選んだ所だけ」で使う) */
  ranges: CsvRect[];
  /** 今いるセル (ここの次から探しはじめる) */
  cursor: CsvMatch | null;
  /** 見つかった場所へ移動する */
  onHit: (at: CsvMatch) => void;
  /** 今探している語 (表の中で目立たせるために伝える) */
  onQuery: (query: string, matchCase: boolean) => void;
  /**
   * 開いたときに入れておく語と設定。
   *
   * 検索の状態はファイルごとに持っているので、
   * そのファイルで前に探していたものから始められるようにする
   */
  initialQuery?: string;
  initialMatchCase?: boolean;
  /** 前に「選んだ所だけ」にしていたか */
  initialScoped?: boolean;
  /** 「選んだ所だけ」の入り切りが変わったことを伝える */
  onScope: (scoped: boolean) => void;
  /** 置換したあとの状態 */
  onReplaced: (info: CsvInfo) => void;
  onClose: () => void;
}

export function CsvFind({
  docId,
  ranges,
  cursor,
  onHit,
  onQuery,
  onReplaced,
  onClose,
  initialQuery = "",
  initialMatchCase = false,
  initialScoped = false,
  onScope,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(initialMatchCase);
  const [wholeCell, setWholeCell] = useState(false);
  /** 正規表現として探すか */
  const [useRegex, setUseRegex] = useState(false);
  /**
   * 「選んだ所だけ」を入れているか。
   *
   * 探す範囲そのものは覚えず、そのつど今選んでいる範囲を使う
   */
  const [useScope, setUseScope] = useState(initialScoped);
  const [replacing, setReplacing] = useState(false);
  /** 置換の欄を出しているか (普段はたたんでおく) */
  const [open, setOpen] = useState(false);
  /** 正規表現の早見表を出しているか */
  const [help, setHelp] = useState(false);
  /** 「3件」「見つかりません」などの知らせ */
  const [note, setNote] = useState<string | null>(null);
  const boxRef = useRef<HTMLInputElement>(null);

  useEffect(() => boxRef.current?.focus(), []);

  // 打っている途中でも、表の中の当たった所が見えるようにする
  useEffect(() => {
    onQuery(query, matchCase);
    // 知らせの関数は毎回作り直されるので、依存には入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, matchCase]);

  /** 今なら範囲を絞れるか (1つのセルだけでは絞る意味が無い) */
  const canScope = selectionCells(ranges) > 1;
  /**
   * 実際に範囲を絞って探すか。
   *
   * 入れていても選んでいるのが1セルだけなら、表全体を探す
   */
  const scoped = useScope && canScope;

  /** 「選んだ所だけ」の入り切り */
  const toggleScope = () => {
    const next = !useScope;
    setUseScope(next);
    onScope(next);
  };

  const options = (): CsvFindOptions => ({
    matchCase,
    wholeCell,
    regex: useRegex,
    // 探す範囲は覚えず、押したときに選んでいる範囲をそのつど使う
    areas: scoped ? ranges : [],
  });

  const find = async (backward: boolean) => {
    if (!query) return;
    setNote(null);
    try {
      const r = await csvFind(docId, query, options(), cursor, backward);
      if (r.hit) {
        onHit(r.hit);
        setNote(`${r.total.toLocaleString()}件`);
      } else {
        setNote("見つかりません");
      }
    } catch (e) {
      setNote(String(e));
    }
  };

  /**
   * 今いるセルだけを置き換えて、次の一致へ進む。
   *
   * 今いるセルが引っかからないときは、置き換えずに次へ進むだけにする
   */
  const replaceOne = async () => {
    if (!query) return;
    if (!cursor) {
      await find(false);
      return;
    }
    setReplacing(true);
    setNote(null);
    try {
      const r = await csvReplaceOne(docId, query, replacement, options(), cursor);
      if (r.done) onReplaced(r.info);
      // 置き換えたあとの数を出したいので、進む先はここで数え直す
      const next = await csvFind(docId, query, options(), cursor, false);
      if (next.hit) onHit(next.hit);
      const left = `${next.total.toLocaleString()}件`;
      if (r.done) setNote(`置き換えました (残り${left})`);
      else setNote(next.hit ? left : "見つかりません");
    } catch (e) {
      setNote(String(e));
    } finally {
      setReplacing(false);
    }
  };

  const replaceAll = async () => {
    if (!query) return;
    setReplacing(true);
    setNote(null);
    try {
      const before = await csvFind(docId, query, options(), null, false);
      const info = await csvReplaceAll(docId, query, replacement, options());
      onReplaced(info);
      setNote(`${before.total.toLocaleString()}件を置き換えました`);
    } catch (e) {
      setNote(String(e));
    } finally {
      setReplacing(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (imeBusy(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void find(e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // 早見表を出しているときは、まずそれを閉じる
      if (help) setHelp(false);
      else onClose();
    }
  };

  return (
    <div className="csv-find" onKeyDown={onKeyDown}>
      {/* 1行目: 探す語と、探し方の切り替え */}
      <div className="csv-find-row">
        {/*
          左端の矢印。押すと置換の欄が出る。
          置換はいつも使うものではないので、普段はたたんでおく
        */}
        <button
          className={"csv-find-more" + (open ? " on" : "")}
          title={open ? "置換を閉じる" : "置換を開く"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <MoreIcon />
        </button>

        {/* 探し方の入り切りは、入力欄の中に収める */}
        <div className="csv-find-field">
          <input
            ref={boxRef}
            className="csv-find-box"
            placeholder="検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className={"csv-find-toggle" + (matchCase ? " on" : "")}
            title="英字の大小を区別する"
            aria-pressed={matchCase}
            onClick={() => setMatchCase((v) => !v)}
          >
            Aa
          </button>
          <button
            className={"csv-find-toggle" + (useRegex ? " on" : "")}
            title="正規表現として探す"
            aria-pressed={useRegex}
            onClick={() => setUseRegex((v) => !v)}
          >
            .*
          </button>
          <button
            className={"csv-find-toggle" + (wholeCell ? " on" : "")}
            title="セルの中身がまるごと同じものだけを探す"
            aria-pressed={wholeCell}
            onClick={() => setWholeCell((v) => !v)}
          >
            <span className="csv-find-whole">ab</span>
          </button>
        </div>

        <button
          className="csv-find-step"
          title="前を検索 (Shift+Enter)"
          disabled={!query}
          onClick={() => void find(true)}
        >
          <UpIcon />
        </button>
        <button
          className="csv-find-step"
          title="次を検索 (Enter)"
          disabled={!query}
          onClick={() => void find(false)}
        >
          <DownIcon />
        </button>

        {/* 選んだ所だけを探す */}
        <button
          className={"csv-find-step" + (scoped ? " on" : "")}
          title={
            scoped
              ? `選んだ${selectionCells(ranges).toLocaleString()}セルの中だけを探しています (押すと表全体に戻します)`
              : canScope
                ? "選んだ範囲の中だけを探す"
                : "範囲を選ぶと、その中だけを探せます"
          }
          aria-pressed={scoped}
          disabled={!canScope}
          onClick={toggleScope}
        >
          <ScopeIcon />
        </button>

        {/* 知らせ (長いときは末尾を省くので、全文は吹き出しで出す) */}
        <span className="csv-find-note" title={note ?? undefined}>
          {note}
        </span>
        {/* 正規表現の早見表 (欄の幅を変えないよう、いつも置いておく) */}
        <button
          className={"csv-find-step csv-find-help" + (help ? " on" : "")}
          title="正規表現の書き方"
          aria-pressed={help}
          onClick={() => setHelp((v) => !v)}
        >
          ?
        </button>
        <button
          className="csv-find-step"
          title="閉じる (Esc)"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>

      {/* 2行目: 置換 (左の矢印を押したときだけ出す) */}
      {open && (
        <div className="csv-find-row">
          {/* 1行目の矢印のぶんを空けて、入力欄の左端をそろえる */}
          <span className="csv-find-gap arrow" aria-hidden />
          <div className="csv-find-field">
            <input
              className="csv-find-box"
              placeholder="置換後の文字"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
            />
          </div>
          <button
            className="csv-find-step"
            title="この1つを置換して次へ"
            disabled={!query || replacing}
            onClick={() => void replaceOne()}
          >
            <ReplaceOneIcon />
          </button>
          <button
            className="csv-find-step"
            title="見つかったものをすべて置換"
            disabled={!query || replacing}
            onClick={() => void replaceAll()}
          >
            <ReplaceAllIcon />
          </button>
          {/*
            1行目の「選んだ所だけ」「知らせ」「閉じる」に当たる場所を空ける。
            空けておかないと、入力欄の右端が上下でずれる
          */}
          <span className="csv-find-gap" aria-hidden />
          <span className="csv-find-note" aria-hidden />
          <span className="csv-find-gap" aria-hidden />
          <span className="csv-find-gap" aria-hidden />
        </div>
      )}

      {help && <CsvRegexHelp onClose={() => setHelp(false)} />}
    </div>
  );
}
