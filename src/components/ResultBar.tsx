import type { ReactNode } from "react";
import type { HeaderLabelMode } from "../types";
import { HeaderLabelPicker } from "./HeaderLabelPicker";
import { IconButton } from "./IconButton";
import { QUERY_PAGE_SIZE } from "../types";
import type { ResultRange } from "../resultRange";
import { pagerLabel, resultMetaText, showPager } from "../resultRange";

/** ページ送りの状態と操作 */
export interface ResultPage {
  /** 今のページの先頭が何行目か (0始まり) */
  offset: number;
  /** 続きのページがあるか */
  hasMore: boolean;
  /** 取得中など、今は押せないか */
  disabled: boolean;
  /** 押せない理由 (あればボタンの説明に出す。例: 編集中) */
  lockReason?: string | null;
  /** 指定した位置のページを取り直す */
  onPage: (offset: number) => void;
}

interface Props {
  /** 外枠に足す class (データタブは絞り込み欄の見た目を使う) */
  className?: string;
  /** 左端に置くもの (SQL結果 = 文ごとの結果タブ / データタブ = 絞り込み) */
  lead?: ReactNode;
  /** ヘッダに出す名前の切り替え (表にならない結果のときは渡さない) */
  header?: { mode: HeaderLabelMode; onChange: (mode: HeaderLabelMode) => void };
  /** 表の見方を変える道具 (SQL結果 = グラフ) */
  tools?: ReactNode;
  /** 編集の入口 (データタブ = 行を追加・操作の案内) */
  edit?: ReactNode;
  /** 編集できない理由。渡すと「閲覧のみ」の印を出し、理由を説明に入れる */
  readOnly?: string | null;
  /** 書き出し (SQL結果だけ。進捗・結果の知らせもここ) */
  output?: ReactNode;
  /** 全部で何行か (数えるボタン / 数えた結果) */
  total?: ReactNode;
  /** 件数と時間 (出さないときは null) */
  meta?: { range: ResultRange; elapsedMs: number; fetchedAt?: number } | null;
  /** ページ送り (ページで取っていない結果では null) */
  page?: ResultPage | null;
}

/**
 * 結果の表の上に出す1行 (データタブとSQL結果で共通)。
 *
 * どちらの画面でも、左から同じ順に並べる:
 *   左側 … 結果タブ・絞り込み / 列名の切り替え / グラフ
 *   右側 … 編集の入口か「閲覧のみ」/ 書き出し / 全件数 / 件数と時間 / ‹ ›
 * 片方の画面にしか無いものは、渡さなければ出ない
 */
export function ResultBar({
  className,
  lead,
  header,
  tools,
  edit,
  readOnly,
  output,
  total,
  meta,
  page,
}: Props) {
  return (
    <div className={"result-bar" + (className ? " " + className : "")}>
      {lead}
      {header && (
        <HeaderLabelPicker mode={header.mode} onChange={header.onChange} />
      )}
      {tools}

      {/* 右側: 表示中の結果についての情報と操作 (まとめて右端へ寄せる) */}
      <div className="result-bar-right">
        {edit}
        {readOnly && <ReadOnlyMark reason={readOnly} />}
        {output}
        {total}
        {meta && (
          <span className="query-meta mono">
            {resultMetaText(meta.range, meta.elapsedMs, meta.fetchedAt)}
          </span>
        )}
        {page && showPager(page.offset, page.hasMore) && (
          <ResultPager page={page} />
        )}
      </div>
    </div>
  );
}

/**
 * 「閲覧のみ」の印。
 *
 * 編集できると思って探させないよう、編集できない表ではそう書いておく。
 * 理由は説明 (ツールチップ) に出す。キーボードで移っても読めるようにする
 */
function ReadOnlyMark({ reason }: { reason: string }) {
  return (
    <span
      className="readonly-chip has-tooltip tooltip-wrap"
      data-tooltip={reason}
      role="note"
      aria-label={`閲覧のみ: ${reason}`}
      tabIndex={0}
    >
      閲覧のみ
    </span>
  );
}

/** 前後のページへ送るボタン (1ページは QUERY_PAGE_SIZE 行) */
function ResultPager({ page }: { page: ResultPage }) {
  const { offset, hasMore, disabled, lockReason, onPage } = page;
  return (
    <span className="pager">
      <IconButton
        className="pager-btn"
        label={lockReason ?? pagerLabel("prev")}
        disabled={disabled || offset === 0}
        onClick={() => onPage(Math.max(0, offset - QUERY_PAGE_SIZE))}
      >
        ‹
      </IconButton>
      <IconButton
        className="pager-btn"
        label={lockReason ?? pagerLabel("next")}
        disabled={disabled || !hasMore}
        onClick={() => onPage(offset + QUERY_PAGE_SIZE)}
      >
        ›
      </IconButton>
    </span>
  );
}
