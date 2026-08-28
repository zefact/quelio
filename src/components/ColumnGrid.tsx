import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { translateY } from "../domTransform";
import { parseComment } from "../comment";
import type { ColumnChange, ColumnInfo, DbType } from "../types";
import {
  ColumnDraft,
  EditField,
  EXTRA_OPTIONS,
  emptyDraft,
  riskyChanges,
  specOfColumn,
  specOfDraft,
  splitType,
  toDraft,
  withBase,
  withSize,
} from "./columnDraft";
import { ConfirmDialog } from "./ConfirmDialog";
import { GridColumn, GridRow, ResizableGrid } from "./ResizableGrid";
import {
  useAsyncApply,
  useEscapeCancel,
  useGridFocus,
} from "../hooks/useEditableGrid";

interface Props {
  columns: ColumnInfo[];
  /** コメントを論理名+補足に分けて表示するか (設定) */
  split: boolean;
  /** 論理名と補足の区切り文字 (設定) */
  delim: string;
  /** 定義変更 (DDL) が使えるか (Valkey以外・ビュー以外) */
  canEdit: boolean;
  dbType: DbType;
  /**
   * この値が変わったら編集状態を解除する
   * (テーブルを切り替えたときに親が変える)
   */
  resetKey: string | number;
  /**
   * 変更を実行する。失敗したら例外を投げること。
   * 成功すれば編集状態を解除し、失敗すれば行を編集状態のまま残す
   */
  onApply: (change: ColumnChange) => Promise<void>;
  /** 実行せずに、生成されるSQLだけを取得する (並べ替えの確認に使う) */
  onPreview: (change: ColumnChange) => Promise<string[]>;
  /** カラム削除の確認を親に依頼する (取り返しがつかないため) */
  onRequestDrop: (column: ColumnInfo) => void;
  /** 型の選択肢 (接続先から取得したもの) */
  types: string[];
  /** 照合順序の選択肢 (接続先から取得したもの) */
  collations: string[];
  /** テーブルの既定の照合順序 (分からないDBでは空文字) */
  tableCollation: string;
}

/** 追加行に使う行キー (既存カラム名と衝突しない値) */
const NEW_ROW = "__quelio_new_column__";

/** ダブルクリックで編集を始められる列と、対応する入力欄 */
const EDITABLE: Record<string, EditField> = {
  name: "name",
  type: "type",
  size: "size",
  null: "null",
  default: "default",
  extra: "extra",
  collation: "collation",
  logical: "logical",
  note: "note",
  comment: "comment",
};

/** 行番号列 (データの値と区別できるようガター表示にする) */
const ROW_NUM_COL: GridColumn = {
  id: "no",
  label: "No",
  width: 52,
  minWidth: 44,
  align: "right",
  cellClass: "rownum-cell",
  description: "カラムの定義順 (行番号)",
};

/**
 * カラムグリッドの列定義。
 * コメント表示モードと、DBがカラムコメントを持てるかで変わる
 */
function columnCols(split: boolean, showComment: boolean): GridColumn[] {
  return [
    ROW_NUM_COL,
    { id: "name", label: "フィールド", width: 190, minWidth: 90 },
    ...(split && showComment
      ? [{ id: "logical", label: "論理名", width: 160, minWidth: 80 }]
      : []),
    { id: "type", label: "型", width: 110, minWidth: 60 },
    { id: "size", label: "サイズ", width: 70, minWidth: 50, align: "right" as const },
    { id: "null", label: "NULL", width: 62, minWidth: 44, align: "center" as const },
    { id: "key", label: "キー", width: 66, minWidth: 44, align: "center" as const },
    { id: "default", label: "デフォルト", width: 140, minWidth: 60 },
    { id: "extra", label: "属性", width: 120, minWidth: 60 },
    { id: "collation", label: "照合順序", width: 150, minWidth: 60 },
    ...(showComment
      ? [
          split
            ? { id: "note", label: "補足", width: 260, minWidth: 100, wrap: true }
            : {
                id: "comment",
                label: "コメント",
                width: 280,
                minWidth: 100,
                wrap: true,
              },
        ]
      : []),
  ];
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 編集中の行の状態 (既存カラムの変更 or 新規追加) */
type Editing =
  | { mode: "edit"; key: string; field: EditField; draft: ColumnDraft }
  | {
      mode: "add";
      /** このカラムの直後に追加する (nullなら末尾) */
      after: string | null;
      field: EditField;
      draft: ColumnDraft;
    };

/**
 * カラム一覧。行をその場で編集して定義を変更する。
 *
 * セルをダブルクリックすると行が入力欄になり、Enterで即実行する。
 * 失敗したときはエラーを出し、直せるよう行は編集状態のまま残す
 */
export function ColumnGrid({
  columns,
  split,
  delim,
  canEdit,
  dbType,
  resetKey,
  onApply,
  onPreview,
  onRequestDrop,
  types,
  collations,
  tableCollation,
}: Props) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const { busy, error, setError, run } = useAsyncApply<ColumnChange>(onApply);
  /**
   * ドラッグ中のカラムと差し込み位置。
   * at は「動かすカラムを除いた並び」の何番目に入れるかを表す
   */
  const [drag, setDrag] = useState<{ from: string; at: number } | null>(null);
  /**
   * ドロップしたが、まだ実行していない並べ替え。
   * ALTER TABLE は重い操作で取り消せないため、
   * ドロップした時点では実行せず、内容を見せてから反映する
   */
  /** 編集中の内容から生成されるSQL (実行前に見せる) */
  const [previewSql, setPreviewSql] = useState<string[] | null>(null);
  /** 確認が要る変更 (型の変更・縮小・NOT NULL付与) */
  const [confirmEdit, setConfirmEdit] = useState<{
    change: ColumnChange;
    reasons: string[];
    sql: string[];
  } | null>(null);
  const [pendingMove, setPendingMove] = useState<{
    from: string;
    /** FIRST または「この後ろへ」のカラム名 */
    after: string;
    /** 確認バーに出す実行SQL (取得前はnull) */
    sql: string[] | null;
  } | null>(null);
  /** 候補ドロップダウンの位置 (nullなら出さない) */
  const [typeMenu, setTypeMenu] = useState<{
    /** どの入力欄に対する候補か */
    field: "type" | "collation";
    x: number;
    w: number;
    /** 入力欄の下に出すか、上に出すか */
    place: "below" | "above";
    /** 画面外へはみ出さないための位置と高さ */
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);
  /** 候補の絞り込みに使う入力中の型名 */
  const [typeQuery, setTypeQuery] = useState("");

  // テーブルを切り替えたら編集状態とエラーを解除する
  useEffect(() => {
    setEditing(null);
    setError(null);
    setTypeMenu(null);
    setPendingMove(null);
  }, [resetKey]);

  // 編集対象のセルが変わったらその入力欄へフォーカスを移す
  // (同じ行の別セルをダブルクリックしたときは要素が作り直されないため、
  //  autoFocusだけでは移動しない)
  useGridFocus(
    editing
      ? `${editing.mode}:${editing.mode === "edit" ? editing.key : editing.after}:${editing.field}`
      : "",
    "data-field"
  );

  // 入力欄からフォーカスが外れていてもEscで編集を取り消せるようにする。
  // 確認ダイアログが開いている間は、そちらに任せる
  // (ここで編集を捨てると、直そうと戻ったのに入力が消える)
  useEscapeCancel(
    !!editing || !!pendingMove,
    () => {
      setEditing(null);
      setPendingMove(null);
      setError(null);
    },
    { busy, blocked: !!confirmEdit }
  );

  /** SQLiteはカラムコメントを保存できない */
  const canComment = dbType !== "sqlite";
  /** AUTO_INCREMENT などの属性を変えられるのはMySQLだけ */
  const canExtra = dbType === "mysql";
  /** 照合順序を持てるのはMySQL / PostgreSQLだけ (SQLiteは型定義の一部) */
  const canCollation = dbType === "mysql" || dbType === "postgresql";

  /**
   * 入力欄のそばに候補を出す。
   * 下に十分な余白が無ければ上側へ出し、はみ出さない高さに収める
   */
  const openTypeMenu = (
    el: HTMLInputElement,
    field: "type" | "collation"
  ) => {
    const r = el.getBoundingClientRect();
    setTypeQuery(el.value);
    const below = window.innerHeight - r.bottom - 10;
    const above = r.top - 10;
    // 下に150px以上あるか、下の方が広ければ下に出す
    const useBelow = below >= 150 || below >= above;
    setTypeMenu({
      field,
      x: Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8)),
      w: r.width,
      place: useBelow ? "below" : "above",
      top: useBelow ? r.bottom + 2 : undefined,
      bottom: useBelow ? undefined : window.innerHeight - r.top + 2,
      maxHeight: Math.max(120, Math.min(280, useBelow ? below : above)),
    });
  };

  /** 入力中の文字で候補を絞る (完全一致だけのときは出さない) */
  const typeOptions = (() => {
    if (!typeMenu) return [];
    const q = typeQuery.trim().toLowerCase();
    const all = typeMenu.field === "type" ? types : collations;
    if (!q) return all;
    // 前方一致を優先しつつ、部分一致も拾う (照合順序は名前が長いため)
    const head = all.filter((t) => t.toLowerCase().startsWith(q));
    const rest = all.filter(
      (t) => !t.toLowerCase().startsWith(q) && t.toLowerCase().includes(q)
    );
    const hit = [...head, ...rest];
    return hit.length === 1 && hit[0].toLowerCase() === q ? [] : hit;
  })();

  /**
   * 既定とみなす照合順序。
   * テーブルの既定が取れるDB (MySQL) はそれを使い、
   * 取れないDB (PostgreSQL) はカラムで一番多く使われているものを既定とみなす
   */
  const baseCollation = (() => {
    const t = tableCollation.trim();
    if (t) return t;
    const counts = new Map<string, number>();
    for (const c of columns) {
      const v = (c.collation ?? "").trim();
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    let best = "";
    let max = 0;
    for (const [name, n] of counts) {
      if (n > max) {
        best = name;
        max = n;
      }
    }
    return best;
  })();

  const patch = (p: Partial<ColumnDraft>) =>
    setEditing((cur) => (cur ? { ...cur, draft: { ...cur.draft, ...p } } : cur));

  /**
   * 指定行の編集を始める。
   * 同じ行を編集中なら入力内容を保ったまま、対象のセルへ移るだけにする。
   * 別の行を編集中のときは、編集内容を失わないよう何もしない
   */
  const startEdit = (c: ColumnInfo, field: EditField) => {
    if (editing && !(editing.mode === "edit" && editing.key === c.name)) return;
    setError(null);
    // 編集すると移動用のSQLが作れなくなるため、保留中の並べ替えは取り消す
    setPendingMove(null);
    setEditing((cur) =>
      cur?.mode === "edit" && cur.key === c.name
        ? { ...cur, field }
        : { mode: "edit", key: c.name, field, draft: toDraft(c, delim) }
    );
  };

  /** 指定カラムの直後に追加行を出す (afterがnullなら末尾) */
  const startAdd = (after: string | null) => {
    if (editing) return;
    setError(null);
    setPendingMove(null);
    setEditing({ mode: "add", after, field: "name", draft: emptyDraft() });
  };

  const cancel = () => {
    setEditing(null);
    setError(null);
    setTypeMenu(null);
  };

  /** 入力できていて、かつ実際に変更があるか */
  const changed = (() => {
    if (!editing) return false;
    const d = editing.draft;
    if (!d.name.trim() || !d.colType.trim()) return false;
    if (editing.mode === "add") return true;
    const before = columns.find((c) => c.name === editing.key);
    if (!before) return false;
    const a = specOfColumn(before);
    const b = specOfDraft(d, split, delim);
    return (
      a.name !== b.name ||
      a.colType.trim() !== b.colType.trim() ||
      a.nullable !== b.nullable ||
      (a.default ?? "").trim() !== (b.default ?? "").trim() ||
      (a.comment ?? "").trim() !== (b.comment ?? "").trim() ||
      (a.extra ?? "") !== (b.extra ?? "") ||
      (a.collation ?? "").trim() !== (b.collation ?? "").trim()
    );
  })();

  /** 編集中の内容から変更内容を組み立てる */
  const buildChange = (): ColumnChange | null => {
    if (!editing) return null;
    const d = editing.draft;
    if (editing.mode === "add") {
      return {
        kind: "add",
        column: {
          ...specOfDraft(d, split, delim),
          after: editing.after ?? undefined,
        },
      };
    }
    const before = columns.find((c) => c.name === editing.key);
    if (!before) return null;
    return {
      kind: "modify",
      before: specOfColumn(before),
      column: specOfDraft(d, split, delim),
    };
  };

  /*
   * 編集中の内容から生成されるSQLを取り寄せて表示する。
   * 何が実行されるか分からないまま反映されるのを防ぐ
   */
  useEffect(() => {
    if (!editing || !changed) {
      setPreviewSql(null);
      return;
    }
    const change = buildChange();
    if (!change) {
      setPreviewSql(null);
      return;
    }
    let alive = true;
    // 取り直すまでは前のSQLを見せない (違う内容が出ていると確認の意味がない)
    setPreviewSql(null);
    // 入力のたびに問い合わせないよう、少し待ってから取る
    const timer = window.setTimeout(() => {
      onPreview(change)
        .then((sql) => {
          if (alive) setPreviewSql(sql);
        })
        .catch(() => {
          if (alive) setPreviewSql(null);
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, changed]);

  /** 変更を実行する */
  const runChange = async (change: ColumnChange) => {
    // 失敗したら直せるよう、行は編集状態のまま残す
    if (await run(change)) setEditing(null);
    setConfirmEdit(null);
  };

  /**
   * 入力内容を反映する。
   * データが失われうる変更 (型の変更・縮小・NOT NULL付与) は確認を挟む
   */
  const commit = async () => {
    if (!editing || busy) return;
    if (!changed) {
      cancel();
      return;
    }
    const change = buildChange();
    if (!change) {
      setError("カラムの定義が変わっています。編集を取り消して読み込み直してください");
      return;
    }
    const reasons =
      change.kind === "modify" ? riskyChanges(change.before, change.column) : [];
    if (reasons.length > 0) {
      // SQLはプレビュー済みのものを使い、無ければ取り直す
      const sql = previewSql ?? (await onPreview(change).catch(() => []));
      setConfirmEdit({ change, reasons, sql });
      return;
    }
    await runChange(change);
  };

  /** カラムの並び順を変えられるのはMySQLだけ (AFTER / FIRST 指定) */
  const canMove = dbType === "mysql";

  /**
   * ドラッグ中の行をポインタに追従させるための情報。
   * 行の高さぶん飛ぶのではなく指の動きにそのまま付いてくるようにする
   */
  const dragRef = useRef<{
    el: HTMLTableRowElement;
    /** つかんだ位置 (行の上端からポインタまでの距離) */
    grabOffset: number;
    pointerY: number;
  } | null>(null);

  /** 動かしている行を、いまのポインタ位置へ置き直す */
  const followPointer = () => {
    const d = dragRef.current;
    if (!d?.el.isConnected) return;
    const rect = d.el.getBoundingClientRect();
    // 今かかっている移動量を引くと、行本来の (レイアウト上の) 位置が分かる
    const layoutTop = rect.top - translateY(d.el);
    d.el.dataset.pointerDrag = "1";
    d.el.style.transition = "none";
    d.el.style.transform = `translateY(${d.pointerY - d.grabOffset - layoutTop}px)`;
  };

  /*
   * 並びが変わると行の位置も変わるため、描画のたびに置き直す。
   * (置き直さないと、次にポインタが動くまで1フレームずれて見える)
   */
  useLayoutEffect(followPointer);

  /**
   * 行番号をつまんだところから並べ替えを始める。
   *
   * HTML5のドラッグ&ドロップではなくポインタイベントで動かしている。
   * 標準のドラッグだとカーソルの形をブラウザが決めてしまい、
   * 「つかんでいる手」のカーソルにできないため
   */
  const startDrag = (c: ColumnInfo, e: React.PointerEvent) => {
    if (!canMove || editing || busy || e.button !== 0) return;
    e.preventDefault();
    // 別のカラムの移動を確認中なら、そちらは取り消す (一度に動かせるのは1つ)
    if (pendingMove && pendingMove.from !== c.name) setPendingMove(null);
    // 差し込み位置の基準になる並び (ドラッグ中は変わらないので先に固定する)
    const rest = columns.filter((x) => x.name !== c.name);
    /*
     * 開始位置。
     * 同じカラムをもう一度動かすときは、確認中の位置から続ける
     * (元の位置に戻ってから動き出すように見えるのを防ぐため)。
     * それ以外は元の位置 = 動かさない状態から始める
     */
    let at =
      pendingMove && pendingMove.from === c.name
        ? pendingMove.after === "FIRST"
          ? 0
          : Math.max(0, rest.findIndex((x) => x.name === pendingMove.after) + 1)
        : Math.max(0, columns.findIndex((x) => x.name === c.name));
    setDrag({ from: c.name, at });
    document.body.classList.add("row-dragging");
    const table = e.currentTarget.closest("table");
    const row = e.currentTarget.closest<HTMLTableRowElement>("tr[data-row-key]");
    if (row) {
      dragRef.current = {
        el: row,
        grabOffset: e.clientY - row.getBoundingClientRect().top,
        pointerY: e.clientY,
      };
      followPointer();
    }

    /*
     * 差し込み位置は、動かしていない行の「レイアウト上の中点」と
     * ポインタのY座標を比べて決める。
     *
     * 見えている位置 (アニメーション中の位置) で判定すると、
     * 動いている最中の行に反応して行き来してしまい、カクついて見える。
     * そのため translateY のぶんを打ち消してから比べる
     */
    const move = (ev: PointerEvent) => {
      // まず指の動きに合わせて行を動かす (並び替えの判定より先に見た目を追従させる)
      if (dragRef.current) {
        dragRef.current.pointerY = ev.clientY;
        followPointer();
      }
      if (!table) return;
      const others = Array.from(
        table.querySelectorAll<HTMLTableRowElement>("tbody > tr[data-row-key]")
      ).filter((tr) => tr.dataset.rowKey !== c.name);
      // 動かしていない行の並びは変わらないので、DOMの順序がそのまま rest の順序になる
      let next = others.length;
      for (let j = 0; j < others.length; j++) {
        const r = others[j].getBoundingClientRect();
        const top = r.top - translateY(others[j]);
        if (ev.clientY < top + r.height / 2) {
          next = j;
          break;
        }
      }
      if (next !== at) {
        at = next;
        setDrag({ from: c.name, at: next });
      }
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.body.classList.remove("row-dragging");
      // 指を離したら、浮いていた行を差し込み先へすっと収める
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.el.isConnected) {
        delete d.el.dataset.pointerDrag;
        d.el.style.transition = "transform 180ms cubic-bezier(0.22, 1, 0.36, 1)";
        d.el.style.transform = "";
      }
      setDrag(null);
      requestMove(c.name, at);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  /** 移動のDDL (MySQLは CHANGE COLUMN の末尾に FIRST / AFTER を付ける) */
  const moveChange = (fromName: string, after: string): ColumnChange | null => {
    const target = columns.find((c) => c.name === fromName);
    if (!target) return null;
    const spec = specOfColumn(target);
    return { kind: "modify", before: spec, column: { ...spec, after } };
  };

  /**
   * ドラッグしたカラムの移動先を確定し、確認バーを出す。
   * ALTER TABLE はテーブルを作り直す重い操作で取り消せないため、
   * ここでは実行せず、実行SQLを見せてから反映してもらう
   */
  const requestMove = (fromName: string, at: number) => {
    if (busy) return;
    const rest = columns.filter((c) => c.name !== fromName);
    const after = at <= 0 ? "FIRST" : rest[at - 1]?.name;
    if (!after) return;

    // 元の位置に戻したときは、確認自体を取り消す
    const cur = columns.findIndex((c) => c.name === fromName);
    const curAfter = cur <= 0 ? "FIRST" : columns[cur - 1].name;
    if (after === curAfter) {
      setPendingMove(null);
      return;
    }

    // 同じ位置に落とし直したときは、そのまま (SQLの再取得でちらつかせない)
    if (pendingMove?.from === fromName && pendingMove.after === after) return;

    const change = moveChange(fromName, after);
    if (!change) return;
    setError(null);
    setPendingMove({ from: fromName, after, sql: null });
    // 実行SQLは非同期で取得して確認バーに出す (取れなくても移動自体はできる)
    onPreview(change)
      .then((sql) =>
        setPendingMove((p) =>
          // 続けてドラッグして移動先が変わっていたら、古い結果は捨てる
          p && p.from === fromName && p.after === after ? { ...p, sql } : p
        )
      )
      .catch(() => {});
  };

  /** 確認バーの「移動する」。ここで初めてALTERを実行する */
  const applyMove = async () => {
    if (!pendingMove || busy) return;
    const change = moveChange(pendingMove.from, pendingMove.after);
    if (!change) return;
    if (await run(change)) setPendingMove(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 日本語入力の変換中のEnter/Escは、確定・取り消しの操作なので拾わない
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  /** 編集中の行のテキスト入力 */
  const textCell = (
    field: EditField,
    value: string,
    opts?: { mono?: boolean; list?: string; placeholder?: string }
  ) => (
    <input
      className={"cell-input" + (opts?.mono === false ? "" : " mono")}
      data-field={field}
      value={value}
      list={opts?.list}
      placeholder={opts?.placeholder}
      disabled={busy}
      onKeyDown={onKeyDown}
      onChange={(e) => {
        const v = e.target.value;
        if (field === "type") patch({ colType: v });
        else if (field === "name") patch({ name: v });
        else if (field === "default") patch({ default: v });
        else if (field === "logical") patch({ logical: v });
        else if (field === "note") patch({ note: v });
        else if (field === "collation") patch({ collation: v });
        else patch({ comment: v });
      }}
    />
  );

  /** 編集中の行のセル (グリッドの列順に合わせて組み立てる) */
  const editCells = (d: ColumnDraft, rowNum: string) => [
    <span className="mono row-num">{rowNum}</span>,
    textCell("name", d.name, { placeholder: "カラム名" }),
    ...(split && canComment
      ? [textCell("logical", d.logical, { mono: false })]
      : []),
    // 型名だけを入力する (サイズは隣の欄。候補は独自のドロップダウンで出す)
    <input
      className="cell-input mono"
      data-field="type"
      value={splitType(d.colType).base}
      placeholder="型"
      disabled={busy}
      onKeyDown={onKeyDown}
      onFocus={(e) => openTypeMenu(e.currentTarget, "type")}
      onClick={(e) => openTypeMenu(e.currentTarget, "type")}
      onBlur={() => setTypeMenu(null)}
      onChange={(e) => {
        patch({ colType: withBase(d.colType, e.target.value) });
        setTypeQuery(e.target.value);
      }}
    />,
    // サイズは型に含まれるので、ここだけの編集でも型文字列を書き換える
    <input
      className="cell-input mono right"
      data-field="size"
      value={splitType(d.colType).size}
      disabled={busy}
      onKeyDown={onKeyDown}
      onChange={(e) => patch({ colType: withSize(d.colType, e.target.value) })}
    />,
    <input
      type="checkbox"
      className="cell-check"
      data-field="null"
      checked={d.nullable}
      disabled={busy}
      title={d.nullable ? "NULLを許可" : "NOT NULL"}
      onKeyDown={onKeyDown}
      onChange={(e) => patch({ nullable: e.target.checked })}
    />,
    <span className="cell-locked">-</span>,
    textCell("default", d.default, { placeholder: "指定なし" }),
    canExtra ? (
      <select
        className="cell-select mono"
        data-field="extra"
        value={d.extra}
        disabled={busy}
        onKeyDown={onKeyDown}
        onChange={(e) =>
          patch({ extra: e.target.value as ColumnDraft["extra"] })
        }
      >
        {EXTRA_OPTIONS.map(([v, label]) => (
          <option key={v || "none"} value={v}>
            {label}
          </option>
        ))}
      </select>
    ) : (
      <span className="cell-locked">-</span>
    ),
    canCollation ? (
      <input
        className="cell-input mono"
        data-field="collation"
        value={d.collation}
        placeholder="既定"
        disabled={busy}
        onKeyDown={onKeyDown}
        onFocus={(e) => openTypeMenu(e.currentTarget, "collation")}
        onClick={(e) => openTypeMenu(e.currentTarget, "collation")}
        onBlur={() => setTypeMenu(null)}
        onChange={(e) => {
          patch({ collation: e.target.value });
          setTypeQuery(e.target.value);
        }}
      />
    ) : (
      <span className="cell-locked">-</span>
    ),
    // SQLiteはカラムコメントを持てないので、コメント系の列自体を出さない
    ...(canComment
      ? [
          split
            ? textCell("note", d.note, { mono: false })
            : textCell("comment", d.comment, { mono: false }),
        ]
      : []),
  ];

  /** 通常表示の行 */
  const viewCells = (c: ColumnInfo, i: number) => {
    const { base, size } = splitType(c.colType);
    const [logical, note] = parseComment(c.comment ?? "", delim);
    return [
      // MySQLは行番号のところをつまんでドラッグすると並べ替えられる
      canMove ? (
        <span
          className="mono row-num drag-handle"
          title="ドラッグして並べ替え"
          onPointerDown={(e) => startDrag(c, e)}
        >
          {i + 1}
        </span>
      ) : (
        <span className="mono row-num">{i + 1}</span>
      ),
      <span className="mono strong" title={c.name}>
        {c.name}
      </span>,
      ...(split && canComment ? [<span>{logical}</span>] : []),
      <span className="mono dim" title={base}>
        {base}
      </span>,
      <span className="mono dim">{size}</span>,
      c.nullable ? <span className="check">✓</span> : null,
      c.key ? (
        <span className={"key-badge" + (c.key === "PRI" ? " pri" : "")}>
          {c.key}
        </span>
      ) : null,
      <span className="mono dim" title={c.default ?? undefined}>
        {c.default === null || c.default === undefined
          ? c.nullable
            ? "NULL"
            : ""
          : c.default === ""
            ? "''"
            : c.default}
      </span>,
      <span className="dim" title={c.extra ?? undefined}>
        {c.extra ?? ""}
      </span>,
      // 既定と違う照合順序は見落とさないよう濃く出す
      (() => {
        const col = (c.collation ?? "").trim();
        const diff = !!col && !!baseCollation && col !== baseCollation;
        return (
          <span
            className={"mono " + (diff ? "collation-diff" : "faint")}
            title={
              diff
                ? `${col}\n既定 (${baseCollation}) と違います`
                : (c.collation ?? undefined)
            }
          >
            {c.collation ?? ""}
          </span>
        );
      })(),
      ...(canComment
        ? [
            <span className="comment-text">
              {split ? note : (c.comment ?? "")}
            </span>,
          ]
        : []),
    ];
  };

  // 行を組み立てる (編集中の行は入力欄に差し替え、追加行は指定位置に挿入する)
  const editRowClass =
    "row-editing" + (busy ? " busy" : "") + (error ? " has-error" : "");

  /*
   * ドラッグ中と、ドロップ後の確認中は、動かしたカラムを移動後の位置で表示する。
   * 行番号も移動後の番号になるので、「反映するとこうなる」を見てから確定できる
   */
  const movingName = drag?.from ?? pendingMove?.from ?? null;
  const moving = movingName
    ? columns.find((c) => c.name === movingName)
    : undefined;
  const restColumns = movingName
    ? columns.filter((c) => c.name !== movingName)
    : columns;
  /** 移動先 (restColumns の何番目に入れるか)。-1なら移動を表示しない */
  const moveAt = (() => {
    if (drag) return drag.at;
    if (!pendingMove) return -1;
    if (pendingMove.after === "FIRST") return 0;
    const i = restColumns.findIndex((c) => c.name === pendingMove.after);
    return i >= 0 ? i + 1 : -1;
  })();
  const displayColumns =
    moving && moveAt >= 0
      ? [
          ...restColumns.slice(0, moveAt),
          moving,
          ...restColumns.slice(moveAt),
        ]
      : columns;

  /*
   * 列定義は毎レンダー作り直さない。
   * 新しい配列を渡すと ResizableGrid 側の列補完effectが毎回動いてしまう
   */
  const gridColumns = useMemo(
    () => columnCols(split, canComment),
    [split, canComment]
  );

  const rows: GridRow[] = [];
  displayColumns.forEach((c, i) => {
    if (editing?.mode === "edit" && editing.key === c.name) {
      rows.push({
        key: c.name,
        className: editRowClass,
        cells: editCells(editing.draft, String(i + 1)),
      });
    } else {
      rows.push({
        key: c.name,
        // 確認中の行は「これが移動する行」と分かるように色を付ける
        className:
          pendingMove?.from === c.name && !busy ? "row-moved" : undefined,
        cells: viewCells(c, i),
      });
    }
    if (editing?.mode === "add" && editing.after === c.name) {
      rows.push({
        key: NEW_ROW,
        className: `${editRowClass} row-new`,
        cells: editCells(editing.draft, "新規"),
      });
    }
  });
  if (editing?.mode === "add" && editing.after === null) {
    rows.push({
      key: NEW_ROW,
      className: `${editRowClass} row-new`,
      cells: editCells(editing.draft, "新規"),
    });
  }

  return (
    <>
      <h3 className="structure-heading">
        カラム <span className="panel-count">{columns.length}</span>
        {canEdit && (
          <>
            <span className="toolbar-spacer" />
            <span className="ddl-hint">
              {editing
                ? "編集中の行を確定するか取り消すと、他の行を編集できます"
                : canMove
                  ? "ダブルクリックで編集 / 右クリックで追加・削除 / 行番号をドラッグで並べ替え"
                  : "ダブルクリックで編集 / 右クリックで追加・削除"}
            </span>
            <button
              className="btn-secondary ddl-add-btn"
              onClick={() => startAdd(null)}
              disabled={!!editing}
              title={
                editing ? "編集中の行を確定するか取り消してください" : undefined
              }
            >
              <PlusIcon />
              カラム追加
            </button>
          </>
        )}
      </h3>

      {/* データが失われうる変更の確認 */}
      {confirmEdit && (
        <ConfirmDialog
          title="この変更を実行します"
          target={confirmEdit.change.kind === "modify" ? confirmEdit.change.before.name : ""}
          confirmLabel="実行する"
          onConfirm={() => runChange(confirmEdit.change)}
          onCancel={() => setConfirmEdit(null)}
        >
          <ul className="column-warn-list">
            {confirmEdit.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          {confirmEdit.sql.length > 0 && (
            <>
              <div className="confirm-sql-head">実行するSQL</div>
              <pre className="mono confirm-sql">{confirmEdit.sql.join("\n")}</pre>
            </>
          )}
        </ConfirmDialog>
      )}

      {/* 並べ替えの確認 (ドロップしただけでは実行しない) */}
      {pendingMove && (
        <div className="ddl-bar move-bar">
          <span className="ddl-bar-icon" aria-hidden>
            ⇅
          </span>
          <span className="ddl-bar-text">
            <b className="mono">{pendingMove.from}</b> を
            {pendingMove.after === "FIRST" ? (
              " 先頭へ移動します"
            ) : (
              <>
                {" "}
                <b className="mono">{pendingMove.after}</b> の後ろへ移動します
              </>
            )}
            <span className="move-note">
              （一覧は移動後の並びで表示しています。まだ実行していません）
            </span>
            {pendingMove.sql && (
              <span className="move-sql mono" title={pendingMove.sql.join("\n")}>
                {pendingMove.sql.join(" / ")}
              </span>
            )}
          </span>
          <span className="toolbar-spacer" />
          <button
            className="ddl-bar-btn"
            onClick={() => setPendingMove(null)}
            disabled={busy}
          >
            取り消し
          </button>
          <button
            className="ddl-bar-btn primary"
            onClick={applyMove}
            disabled={busy}
          >
            移動する
          </button>
        </div>
      )}

      {/* 編集中の案内と、実行中・エラーの表示 (位置変更の失敗もここに出す) */}
      {(editing || busy || error) && (
        <div className="ddl-bar">
          {busy ? (
            <>
              <span className="spinner accent" />
              <span className="ddl-bar-text">実行中...</span>
            </>
          ) : error ? (
            <>
              <span className="ddl-bar-icon ng" aria-hidden>
                !
              </span>
              <span className="ddl-bar-text ng">{error}</span>
            </>
          ) : (
            <span className="ddl-bar-text">
              <kbd>Enter</kbd> で反映 / <kbd>Esc</kbd> で取り消し
              {!changed && "（変更はまだありません）"}
              {changed && previewSql && previewSql.length > 0 && (
                <span className="move-sql mono" title={previewSql.join("\n")}>
                  {previewSql.join(" / ")}
                </span>
              )}
            </span>
          )}
          <span className="toolbar-spacer" />
          {editing ? (
            <>
              <button className="ddl-bar-btn" onClick={cancel} disabled={busy}>
                取り消し
              </button>
              <button
                className="ddl-bar-btn primary"
                onClick={commit}
                disabled={busy || !changed}
              >
                反映
              </button>
            </>
          ) : (
            error && (
              <button className="ddl-bar-btn" onClick={() => setError(null)}>
                閉じる
              </button>
            )
          )}
        </div>
      )}

      <ResizableGrid
        autoFit
        animateRows
        // 行を選んでコピーできるようにする (編集中は選択させない)
        selectable={!editing}
        fitKey={`${columns.length}:${split}:${canComment}`}
        columns={gridColumns}
        rows={rows}
        onCellDoubleClick={
          canEdit
            ? (key, colId) => {
                if (key === NEW_ROW || busy) return;
                // 別の行を編集中は受け付けない (編集内容が消えるため)
                if (editing && !(editing.mode === "edit" && editing.key === key))
                  return;
                const field = EDITABLE[colId];
                if (!field) return;
                if (!canComment && (field === "comment" || field === "note"))
                  return;
                if (!canExtra && field === "extra") return;
                if (!canCollation && field === "collation") return;
                const c = columns.find((x) => x.name === key);
                if (c) startEdit(c, field);
              }
            : undefined
        }
        rowProps={
          drag
            ? (key) => ({
                // 動かしている行はその場で移動して見せる
                className: drag.from === key ? "row-moving" : undefined,
              })
            : undefined
        }
        rowMenuHead={(key) => (key === NEW_ROW ? undefined : key)}
        rowMenuItems={(key) => {
          // 編集中は追加・削除させない (先に確定か取り消しをしてもらう)
          if (!canEdit || key === NEW_ROW || busy || editing) return [];
          const column = columns.find((c) => c.name === key);
          if (!column) return [];
          return [
            {
              label: "このカラムを編集",
              onSelect: () => startEdit(column, "name"),
            },
            {
              label: "この下にカラムを追加",
              onSelect: () => startAdd(column.name),
            },
            {
              label: "このカラムを削除",
              danger: true,
              onSelect: () => onRequestDrop(column),
            },
          ];
        }}
      />

      {/* 型名の候補 (グリッドの外に出してセル幅で切れないようにする) */}
      {typeMenu &&
        (typeOptions.length > 0 || typeMenu.field === "collation") &&
        createPortal(
          <div
            className="context-menu type-suggest"
            style={{
              left: typeMenu.x,
              top: typeMenu.place === "below" ? typeMenu.top : undefined,
              bottom: typeMenu.place === "above" ? typeMenu.bottom : undefined,
              minWidth: Math.max(typeMenu.w, 170),
              maxHeight: typeMenu.maxHeight,
            }}
            // クリックで入力欄のフォーカスが外れないようにする
            onMouseDown={(e) => e.preventDefault()}
          >
            {typeMenu.field === "collation" && (
              <button
                className="context-item"
                onClick={() => {
                  patch({ collation: "" });
                  setTypeMenu(null);
                }}
              >
                既定 (指定しない)
              </button>
            )}
            {typeOptions.map((t) => (
              <button
                key={t}
                className="context-item mono"
                onClick={() => {
                  const field = typeMenu.field;
                  setEditing((cur) =>
                    cur
                      ? {
                          ...cur,
                          draft:
                            field === "type"
                              ? {
                                  ...cur.draft,
                                  colType: withBase(cur.draft.colType, t),
                                }
                              : { ...cur.draft, collation: t },
                        }
                      : cur
                  );
                  setTypeMenu(null);
                }}
              >
                {t}
              </button>
            ))}
          </div>,
          document.body
        )}

    </>
  );
}
