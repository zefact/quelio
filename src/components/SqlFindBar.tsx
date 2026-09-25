import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_FIND_OPTIONS,
  buildMatcher,
  findAll,
  indexAt,
  pickNext,
  replaceAllChanges,
  replaceOneChange,
  type FindHit,
  type FindOptions,
} from "../sqlFind";
import type { SqlEditorHandle } from "./SqlEditor";
import { imeBusy } from "../ime";

interface Props {
  /** エディタ本体 (本文を読み、選び、書き換える) */
  editor: React.RefObject<SqlEditorHandle | null>;
  /**
   * 今の本文。
   *
   * 打ち直したら数え直すためだけに受け取る (本文自体はエディタから読む)
   */
  sql: string;
  /** 最初に入れておく検索語 (エディタで選んでいた文字) */
  initialQuery?: string;
  onClose: () => void;
}

/** 探し方の切り替えボタン1つぶん */
function OptionToggle({
  on,
  label,
  tip,
  onToggle,
}: {
  on: boolean;
  label: string;
  tip: string;
  onToggle: () => void;
}) {
  return (
    <button
      className={"sql-find-opt" + (on ? " on" : "")}
      // 押しても検索欄から入力位置を移さない
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
      title={tip}
      aria-label={tip}
      aria-pressed={on}
    >
      {label}
    </button>
  );
}

/**
 * SQLエディタの中だけを探す検索・置換のバー。
 *
 * ページ内検索 (⌘F) は画面に出ている文字しか見ないので、
 * 折りたたまれた行や画面外の行は見つからない。
 * ここはエディタの本文そのものを相手にするので、どこにあっても見つかるし、
 * 置き換えもできる。
 */
export function SqlFindBar({ editor, sql, initialQuery, onClose }: Props) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [replacement, setReplacement] = useState("");
  /** 置換の行を開いているか */
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [opts, setOpts] = useState<FindOptions>(DEFAULT_FIND_OPTIONS);
  const [hits, setHits] = useState<FindHit[]>([]);
  /** 今いるのは何番目か (0始まり。どこでもなければ -1) */
  const [at, setAt] = useState(-1);

  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  /**
   * 前回数えたときの「検索語と探し方」。
   *
   * これが変わったときだけ一致の所へ飛ぶ。
   * 本文が変わっただけで飛ぶと、バーを開けたままSQLを打ち直せなくなる
   */
  const lastKey = useRef("");
  /** 置換の直後など、本文が変わっても飛んでほしいとき */
  const wantJump = useRef(false);

  /** 正規表現の書き方が壊れているか */
  const badRegex = opts.regex && query !== "" && buildMatcher(query, opts) === null;

  /** 検索欄へ入力位置を戻す (エディタ側へ移ってしまったとき用) */
  const keepFocus = useCallback(() => {
    const el = findRef.current;
    if (!el) return;
    const active = document.activeElement;
    // 置換欄を触っているときは、そちらの邪魔をしない
    if (active === el || active === replaceRef.current) return;
    el.focus();
  }, []);

  // 開いた直後は、入れておいた検索語を選んでおく (すぐ打ち替えられるように)
  useEffect(() => {
    findRef.current?.select();
  }, []);

  /*
   * 検索語・探し方・本文のどれかが変わったら数え直す。
   *
   * 一致の所へ画面を送るのは、検索語か探し方を変えたとき
   * (と、置換したとき) だけ。
   * バーを開けたままSQLを打っている間に画面が飛ぶと、書けなくなるため
   */
  useEffect(() => {
    const ed = editor.current;
    if (!ed) return;
    const key = JSON.stringify([
      query,
      opts.caseSensitive,
      opts.wholeWord,
      opts.regex,
    ]);
    const jump = wantJump.current || key !== lastKey.current;
    lastKey.current = key;
    wantJump.current = false;

    const found = findAll(sql, query, opts);
    setHits(found);
    if (found.length === 0) {
      setAt(-1);
      ed.markFinds([], -1);
      return;
    }
    const cursor = ed.getRange();
    // すでに一致の上にいるなら、そこを今の場所として扱う
    const here = indexAt(found, cursor);
    const next = here >= 0 ? here : pickNext(found, cursor, true);
    setAt(next);
    ed.markFinds(found, next);
    if (jump) {
      ed.selectRange(found[next].from, found[next].to);
      keepFocus();
    }
  }, [editor, query, opts, sql, keepFocus]);

  // 閉じるときは色を消す
  useEffect(() => {
    const ed = editor.current;
    return () => ed?.markFinds([], -1);
  }, [editor]);

  /** 次 (前) の一致へ */
  const step = useCallback(
    (forward: boolean) => {
      const ed = editor.current;
      if (!ed || hits.length === 0) return;
      const next = pickNext(hits, ed.getRange(), forward);
      setAt(next);
      ed.markFinds(hits, next);
      ed.selectRange(hits[next].from, hits[next].to);
      keepFocus();
    },
    [editor, hits, keepFocus]
  );

  /**
   * 今いる1か所を置き換えて、次へ進む。
   *
   * 一致の上にいないとき (打ち替えた直後など) は置き換えず、まず次へ移る
   */
  const replaceOne = useCallback(() => {
    const ed = editor.current;
    if (!ed || hits.length === 0) return;
    const doc = ed.getText();
    const here = indexAt(hits, ed.getRange());
    if (here < 0) {
      step(true);
      return;
    }
    // 置き換えたら、次の1か所へ進みたい
    wantJump.current = true;
    ed.applyChanges([replaceOneChange(doc, hits[here], replacement, opts)]);
    // 本文が変わるので、数え直しは上の useEffect に任せる
    keepFocus();
  }, [editor, hits, replacement, opts, step, keepFocus]);

  /** 見つかった所を全部置き換える */
  const replaceEvery = useCallback(() => {
    const ed = editor.current;
    if (!ed) return;
    const doc = ed.getText();
    const changes = replaceAllChanges(doc, query, replacement, opts);
    if (changes.length === 0) return;
    ed.applyChanges(changes);
    keepFocus();
  }, [editor, query, replacement, opts, keepFocus]);

  /** 閉じて、エディタへ入力位置を戻す */
  const close = useCallback(() => {
    editor.current?.markFinds([], -1);
    editor.current?.focusEditor();
    onClose();
  }, [editor, onClose]);

  /** 検索欄・置換欄で共通のキー操作 */
  const onKeyDown = (e: React.KeyboardEvent, inReplace: boolean) => {
    // 日本語入力の変換中は、確定・取り消しの操作なので拾わない
    if (imeBusy(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      // 置換欄のEnterは「置き換えて次へ」
      if (inReplace) {
        if (e.shiftKey) replaceEvery();
        else replaceOne();
        return;
      }
      step(!e.shiftKey);
    }
  };

  const count = badRegex
    ? "書き方が違います"
    : query === ""
      ? ""
      : hits.length === 0
        ? "見つかりません"
        : `${at + 1}/${hits.length}`;

  return (
    <div
      className={
        "sql-find" +
        (replaceOpen ? " with-replace" : "") +
        (badRegex || (query !== "" && hits.length === 0) ? " not-found" : "")
      }
      // エディタの右クリックメニューを、ここでは出さない
      onContextMenu={(e) => e.stopPropagation()}
    >
      {/* 置換の行を開く / 閉じる */}
      <button
        className={"sql-find-more" + (replaceOpen ? " on" : "")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setReplaceOpen(!replaceOpen)}
        title={replaceOpen ? "置換を隠す" : "置換も使う"}
        aria-label={replaceOpen ? "置換を隠す" : "置換も使う"}
        aria-expanded={replaceOpen}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M9 5l7 7-7 7"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <div className="sql-find-rows">
        <div className="sql-find-row">
          <input
            ref={findRef}
            className="sql-find-input"
            value={query}
            placeholder="エディタ内を検索"
            spellCheck={false}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => onKeyDown(e, false)}
          />
          <OptionToggle
            on={opts.caseSensitive}
            label="Aa"
            tip="大文字と小文字を区別する"
            onToggle={() =>
              setOpts({ ...opts, caseSensitive: !opts.caseSensitive })
            }
          />
          <OptionToggle
            on={opts.wholeWord}
            label="ab|"
            tip="単語として区切れている所だけを探す"
            onToggle={() => setOpts({ ...opts, wholeWord: !opts.wholeWord })}
          />
          <OptionToggle
            on={opts.regex}
            label=".*"
            tip="正規表現として探す (置換では $1 で ( ) の中身を使えます)"
            onToggle={() => setOpts({ ...opts, regex: !opts.regex })}
          />
          <span className="sql-find-count mono">{count}</span>
          <button
            className="sql-find-nav"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => step(false)}
            disabled={hits.length === 0}
            title="前へ (Shift+Enter)"
            aria-label="前へ"
          >
            ↑
          </button>
          <button
            className="sql-find-nav"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => step(true)}
            disabled={hits.length === 0}
            title="次へ (Enter)"
            aria-label="次へ"
          >
            ↓
          </button>
          <button
            className="sql-find-nav"
            onMouseDown={(e) => e.preventDefault()}
            onClick={close}
            title="閉じる (Esc)"
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        {replaceOpen && (
          <div className="sql-find-row">
            <input
              ref={replaceRef}
              className="sql-find-input"
              value={replacement}
              placeholder="置き換える文字"
              spellCheck={false}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={(e) => onKeyDown(e, true)}
            />
            <button
              className="sql-find-do"
              onMouseDown={(e) => e.preventDefault()}
              onClick={replaceOne}
              disabled={hits.length === 0}
              title="今の1か所を置き換えて次へ (Enter)"
            >
              置換
            </button>
            <button
              className="sql-find-do"
              onMouseDown={(e) => e.preventDefault()}
              onClick={replaceEvery}
              disabled={hits.length === 0}
              title={`見つかった${hits.length}か所を全部置き換える (Shift+Enter)`}
            >
              全て置換
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
