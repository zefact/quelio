/**
 * CSVエディタのウィンドウ。
 *
 * DBの機能とは別の道具なので、接続タブには混ぜず独立したウィンドウにしてある。
 * 複数のファイルは、このウィンドウの中のタブで持つ
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  csvClose,
  csvCompare,
  csvDeleteCol,
  csvDeleteRows,
  csvInsertCol,
  csvInfo,
  csvInsertRows,
  csvNew,
  csvOpen,
  csvRedo,
  csvRenameCol,
  csvEdge,
  csvExportXlsx,
  csvSave,
  csvSummary,
  csvCopy,
  csvPaste,
  csvSetCells,
  csvDeleteLayout,
  csvLayouts,
  csvSaveLayoutTree,
  csvSetEdge,
  csvSetFixed,
  csvSetFormat,
  csvSetFilters,
  csvSetSort,
  csvSetHeader,
  csvUndo,
  openMainWindow,
} from "../../api";
import { ConfirmDialog } from "../ConfirmDialog";
import { SettingsModal } from "../SettingsModal";
import { useCsvRows } from "../../hooks/useCsvRows";
import type { CsvRows } from "../../hooks/useCsvRows";
import { useDismiss } from "../../hooks/useDismiss";
import { useFileDrop } from "../../hooks/useFileDrop";
import type {
  CsvColumnFilter,
  CsvDiffOptions,
  CsvSummary,
  CsvDiffOverview,
  CsvFixedLayout,
  CsvLayoutNode,
  CsvSavedLayout,
  CsvFormatPatch,
  CsvInfo,
} from "../../types";
import { CsvGrid } from "./CsvGrid";
import type { CsvCursor, CsvRange } from "./CsvGrid";
import type { CsvBlock } from "./csvSelection";
import { fillPatches, pasteAnchor, singleValue } from "./csvPasteFill";
import { selectionCells } from "./csvSelection";
import { readClipboard, writeClipboard } from "../../gridCopy";
import { CsvTabs } from "./CsvTabs";
import { moveItem } from "../../moveItem";
import { CsvTabMenu } from "./CsvTabMenu";
import { CsvToolbar } from "./CsvToolbar";
import { CsvFind } from "./CsvFind";
import { CsvFilterMenu } from "./CsvFilterMenu";
import { filterLabel, filterOf, isFiltered, withFilter } from "./csvFilter";
import { CsvColumnMenu, CsvRowMenu } from "./CsvCellMenu";
import { CsvNameDialog } from "./CsvNameDialog";
import { CsvDiffSetup } from "./CsvDiffSetup";
import { CsvDiffView } from "./CsvDiffView";
import { CsvEdgeRow } from "./CsvEdgeRow";
import { CsvFixedDialog } from "./CsvFixedDialog";
import { CsvFormatMenu } from "./CsvFormatMenu";
import { formatLabel } from "./csvFormat";
import { appliedLayoutName } from "./csvFixed";
import { flatLayouts } from "./csvLayoutTree";
import { MemoryChip } from "../MemoryChip";

/** 種別の色分けに使う色の数 (これを超える種別は最後の色を使い回す) */
const KIND_COLORS = 4;

/**
 * 1つの値で埋められるセルの数の上限。
 *
 * 指定はセル1つにつき1件を渡すので、多すぎると受け渡しが重くなる。
 * 手で選べる範囲としては十分な数
 */
const FILL_MAX = 200_000;

/** ウィンドウが「このファイルを開いて」と伝えられるときのイベント名 */
const OPEN_EVENT = "csv-open-file";

/** 「もう読み込んであるこの表を開いて」と伝えられるときのイベント名 */
const DOC_EVENT = "csv-open-doc";

/** ファイル選択ダイアログの絞り込み */
const FILTERS = [{ name: "CSV / TSV", extensions: ["csv", "tsv", "txt"] }];

/** Excelで書き出すときのファイル選択の絞り込み */
const XLSX_FILTERS = [{ name: "Excel", extensions: ["xlsx"] }];

/** 絞り込みのメニューを出す列と、その位置 */
interface FilterAt {
  col: number;
  x: number;
  y: number;
  /** 下に入らないときに折り返す先 (つまみの上端) */
  flipY: number;
}

/** 右クリックメニューの位置と対象 */
interface Menu {
  kind: "row" | "col";
  index: number;
  x: number;
  y: number;
  /** 押した所と地続きで選ばれている行 (列) のかたまり */
  block: CsvBlock;
}

/** 左右どちら側か (分割表示) */
type Side = "left" | "right";

/** 1つのファイルの検索の状態 */
interface FindState {
  /** 検索の欄を出しているか */
  open: boolean;
  /** 探している語 */
  query: string;
  /** 英字の大小を区別するか */
  matchCase: boolean;
  /** 見つかったセル (無ければ null) */
  hit: CsvCursor | null;
  /** 「選んだ所だけ」を入れているか */
  scoped: boolean;
}

/** まだ何も探していない状態 */
const NO_FIND: FindState = {
  open: false,
  query: "",
  matchCase: false,
  hit: null,
  scoped: false,
};

/** 横位置を合わせるときの、動かした本人 */
type EdgeWho = "grid" | "head" | "tail";

/** 右クリックしたタブと、メニューを出す位置 */
interface TabMenu {
  tab: CsvInfo;
  x: number;
  y: number;
}

/** 比較の状態 (token は結果を取り直す目印) */
interface Compare {
  overview: CsvDiffOverview;
  token: number;
  leftName: string;
  rightName: string;
}

export function CsvWindow() {
  const [tabs, setTabs] = useState<CsvInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** 左側のセル位置 */
  const [leftCursor, setLeftCursor] = useState<CsvCursor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 閉じようとしている未保存のタブ */
  const [closing, setClosing] = useState<CsvInfo | null>(null);
  /** 未保存のままウィンドウごと閉じようとしているか */
  const [closingWindow, setClosingWindow] = useState(false);
  /*
   * 検索の状態は、タブごとに別々に持つ。
   *
   * 1つにまとめて持つと、別のファイルへ移ったときに
   * 前のファイルで探していた語や当たった場所がそのまま残ってしまう
   */
  const [finds, setFinds] = useState<Record<string, FindState>>({});
  /** そのファイルの検索の状態 (まだ探していなければ何もしていない状態) */
  const findOf = (docId: string | null | undefined): FindState =>
    (docId ? finds[docId] : undefined) ?? NO_FIND;
  /** そのファイルの検索の状態を一部だけ書き換える */
  const putFind = (docId: string, fix: Partial<FindState>) =>
    setFinds((prev) => ({
      ...prev,
      [docId]: { ...(prev[docId] ?? NO_FIND), ...fix },
    }));
  /** 閉じたファイルの控えは捨てる */
  const forgetFind = (...docIds: string[]) =>
    setFinds((prev) => {
      const next = { ...prev };
      for (const id of docIds) delete next[id];
      return next;
    });
  /*
   * 見出しに絞り込みのつまみを出しているファイル。
   *
   * 絞り込みそのものはRust側が覚えているので、
   * ここで持つのは「つまみを出しているか」だけ
   */
  const [filterOn, setFilterOn] = useState<Record<string, boolean>>({});
  /** 絞り込みのメニューを出している列と、その位置 */
  const [filterAt, setFilterAt] = useState<FilterAt | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  /** タブを右クリックして出したメニュー */
  const [tabMenu, setTabMenu] = useState<TabMenu | null>(null);
  /** 名前を変えようとしている列 */
  const [renaming, setRenaming] = useState<number | null>(null);
  const [formatOpen, setFormatOpen] = useState(false);
  /** 固定長の桁を決める画面を出しているか */
  const [fixedOpen, setFixedOpen] = useState(false);
  /** お気に入りに登録した固定長の桁設定 (ツールバーから選べるようにする) */
  const [layouts, setLayouts] = useState<CsvLayoutNode[]>([]);
  /** 削除しようとしているお気に入り */
  const [removingLayout, setRemovingLayout] = useState<string | null>(null);
  /** 設定を出しているか (DBの画面に出さず、この窓の中に出す) */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [diffSetup, setDiffSetup] = useState(false);
  const [compare, setCompare] = useState<Compare | null>(null);
  /** 左右に分けて出しているか */
  const [split, setSplit] = useState(false);
  /** 右側に出しているファイル */
  const [rightId, setRightId] = useState<string | null>(null);
  /** 右側のセル位置 (左側は cursor) */
  const [rightCursor, setRightCursor] = useState<CsvCursor | null>(null);
  /** 今どちら側を触っているか (保存・検索などはこちらが相手) */
  const [focus, setFocus] = useState<Side>("left");
  /** 分けているとき、スクロールを合わせるか */
  const [syncScroll, setSyncScroll] = useState(true);
  /** 左側の幅の割合 (0.2〜0.8。真ん中の仕切りを掴んで動かす) */
  const [leftRatio, setLeftRatio] = useState(0.5);
  /** 選んでいる範囲 (触っている側のもの。⌘+クリックで複数になる) */
  const [ranges, setRanges] = useState<CsvRange[]>([]);
  /** 複数選んでいるときの合計・個数 (数えるのはRust側) */
  const [summary, setSummary] = useState<CsvSummary | null>(null);
  /** コピーしたときの短い知らせ (情報バーに少しだけ出す) */
  const [note, setNote] = useState<string | null>(null);
  /** 動かした側とその位置 (相方だけに伝える) */
  const [sync, setSync] = useState<{ top: number; left: number; from: Side } | null>(
    null
  );
  /**
   * ヘッダ・トレーラとデータ行の、横位置を合わせるための控え。
   *
   * 動かした本人 (from) には渡し返さない
   */
  const [hScroll, setHScroll] = useState<{
    side: Side;
    from: EdgeWho;
    left: number;
  } | null>(null);

  const leftTab = tabs.find((t) => t.docId === activeId) ?? null;
  const rightTab = split
    ? (tabs.find((t) => t.docId === rightId) ?? null)
    : null;
  /** 操作の相手は、触っている側に出しているファイル */
  const active = focus === "right" && rightTab ? rightTab : leftTab;

  const leftRows = useCsvRows(activeId, leftTab?.rowCount ?? 0);
  const rightRows = useCsvRows(
    split ? rightId : null,
    rightTab?.rowCount ?? 0
  );
  const rows = focus === "right" && rightTab ? rightRows : leftRows;
  const cursor = focus === "right" && rightTab ? rightCursor : leftCursor;
  const setCursor = focus === "right" && rightTab ? setRightCursor : setLeftCursor;

  /*
   * 新しく開いたファイルは、触っている側に出す。
   * addTab は作り直したくないので、側は覚えておいたものを見る
   */
  const focusRef = useRef<Side>("left");
  focusRef.current = focus === "right" && rightTab ? "right" : "left";

  /*
   * 今いるセルの文字数 (情報バーに出す)。
   * まだその行が届いていなければ数えられないので null にしておく。
   * 絵文字などを1文字と数えるため、長さは文字に割ってから数える
   */
  const picked = selectionCells(ranges);
  const cell = cursor ? rows.row(cursor.row)?.[cursor.col] : undefined;
  const cellLength = cell === undefined ? null : [...cell].length;

  /*
   * 2つ以上選んだときだけ、合計や個数を数えてもらう。
   *
   * ドラッグ中は範囲が細かく変わるので、少し待ってから訊く
   */
  const activeDocId = active?.docId ?? null;
  useEffect(() => {
    if (!activeDocId || selectionCells(ranges) <= 1) {
      setSummary(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      csvSummary(activeDocId, ranges)
        .then((s) => {
          if (alive) setSummary(s);
        })
        .catch(() => {
          if (alive) setSummary(null);
        });
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [activeDocId, ranges]);

  /** 開いたファイルをタブに足す (同じファイルが既にあればそれを選ぶ) */
  const addTab = useCallback((info: CsvInfo) => {
    setTabs((prev) => {
      const at = prev.findIndex((t) => t.docId === info.docId);
      if (at >= 0) return prev.map((t) => (t.docId === info.docId ? info : t));
      return [...prev, info];
    });
    if (focusRef.current === "right") {
      setRightId(info.docId);
      setRightCursor({ row: 0, col: 0 });
    } else {
      setActiveId(info.docId);
      setLeftCursor({ row: 0, col: 0 });
    }
  }, []);

  /** 操作の結果 (最新の状態) を反映する */
  const update = useCallback(
    (info: CsvInfo) => {
      setTabs((prev) => prev.map((t) => (t.docId === info.docId ? info : t)));
      // 行が増減している可能性があるので、溜めたページは捨てる
      // (同じファイルを左右に出していることがあるので、両側とも捨てる)
      leftRows.clear();
      rightRows.clear();
    },
    [leftRows, rightRows]
  );

  const openPath = useCallback(
    async (path: string) => {
      setBusy(true);
      setError(null);
      try {
        addTab(await csvOpen(path));
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [addTab]
  );

  /** まとめて開く (落とし込みは複数のことがある) */
  const openPaths = useCallback(
    async (paths: string[]) => {
      for (const p of paths) await openPath(p);
    },
    [openPath]
  );

  /** ファイルを落とされたら開く (拡張子では絞らず、読めなければエラーを出す) */
  const onDropFiles = useCallback(
    (paths: string[]) => void openPaths(paths),
    [openPaths]
  );
  const dropOver = useFileDrop(onDropFiles);

  /** 既に読み込んである表 (クエリ結果など) をタブにする */
  const openDoc = useCallback(
    async (docId: string) => {
      setError(null);
      try {
        addTab(await csvInfo(docId));
      } catch (e) {
        setError(String(e));
      }
    },
    [addTab]
  );

  // 起動時に渡されたファイル (または表) を開く
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const q = new URLSearchParams(window.location.search);
    const path = q.get("path");
    const docId = q.get("doc");
    if (path) void openPath(path);
    else if (docId) void openDoc(docId);
  }, [openPath, openDoc]);

  // 既に開いているウィンドウへ「これを開いて」と伝えられたとき
  useEffect(() => {
    const file = listen<string>(OPEN_EVENT, (e) => void openPath(e.payload));
    const doc = listen<string>(DOC_EVENT, (e) => void openDoc(e.payload));
    return () => {
      void file.then((f) => f());
      void doc.then((f) => f());
    };
  }, [openPath, openDoc]);

  const pick = async () => {
    const got = await openDialog({ multiple: false, filters: FILTERS });
    if (typeof got === "string") await openPath(got);
  };

  const create = async () => {
    try {
      addTab(await csvNew("新しいCSV"));
    } catch (e) {
      setError(String(e));
    }
  };

  // 知らせは少しだけ出す (残しても次の操作の邪魔になるだけ)
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), 1800);
    return () => clearTimeout(timer);
  }, [note]);

  /**
   * 選んでいる範囲をタブ区切りでクリップボードへ渡す (⌘/Ctrl+C)。
   *
   * どの表のどこを選んでいるかは表から受け取る。
   * 分割表示でも、押した側の表がそのまま相手になる
   */
  const copySelection = async (docId: string, rects: CsvRange[]) => {
    if (rects.length === 0) return;
    try {
      await writeClipboard(await csvCopy(docId, rects));
      const cells = selectionCells(rects);
      setNote(
        cells > 1 ? `${cells.toLocaleString()}セルをコピーしました` : "コピーしました"
      );
    } catch (e) {
      setError(String(e));
    }
  };

  /**
   * クリップボードの中身を、選んでいる範囲へ貼り付ける (⌘/Ctrl+V)。
   *
   * 値が1つだけなら、選んだ範囲を全部その値で埋める (表計算ソフトと同じ)。
   * 表のときは選んだ範囲の左上から流し込む。
   * 下に足りなければ行が増える。右にはみ出したぶんは入らないので、そのときは知らせる
   */
  const pasteAt = async (docId: string, at: CsvCursor, rs: CsvRange[]) => {
    try {
      const text = await readClipboard();
      if (!text) return;
      const one = singleValue(text);
      if (one !== null && selectionCells(rs) > 1) {
        const cells = fillPatches(rs, one);
        if (cells.length > FILL_MAX) {
          setError(
            `選んでいる範囲が広すぎます (${cells.length.toLocaleString()}セル)。` +
              `${FILL_MAX.toLocaleString()}セルまでです`
          );
          return;
        }
        update(await csvSetCells(docId, cells));
        setNote(`${cells.length.toLocaleString()}セルに貼り付けました`);
        return;
      }
      const top = pasteAnchor(at, rs);
      const got = await csvPaste(docId, top.row, top.col, text);
      update(got.info);
      if (got.rows === 0) {
        setNote("貼り付けるものがありませんでした");
        return;
      }
      const added = got.addedRows > 0 ? ` (${got.addedRows.toLocaleString()}行を追加)` : "";
      const over = got.clippedCols ? " ※右にはみ出した列は入れていません" : "";
      setNote(
        `${got.rows.toLocaleString()}行 × ${got.cols.toLocaleString()}列を貼り付けました${added}${over}`
      );
    } catch (e) {
      setError(String(e));
    }
  };

  /*
   * お気に入りの桁設定を読み込む。
   *
   * 桁設定のダイアログ内で登録・削除ができるので、
   * そのダイアログを閉じたときにも読み込み直す
   */
  useEffect(() => {
    if (fixedOpen) return;
    void csvLayouts()
      .then(setLayouts)
      .catch(() => {
        /* 読めなくてもツールバーが空になるだけ */
      });
  }, [fixedOpen]);

  /** お気に入りの桁設定で、開いているファイルを読み直す */
  const applySavedLayout = async (s: CsvSavedLayout) => {
    if (!active) return;
    setError(null);
    try {
      update(
        await csvSetFixed(active.docId, { unit: s.layout.unit, layout: s.layout })
      );
      setNote(`「${s.name}」の桁設定で読み直しました`);
    } catch (e) {
      setError(String(e));
    }
  };

  /** 固定長のヘッダ・トレーラの値を書き換える */
  const setEdge = async (docId: string, trailer: boolean, cells: string[]) => {
    setError(null);
    try {
      update(await csvSetEdge(docId, trailer, cells));
    } catch (e) {
      setError(String(e));
    }
  };

  /** 並び順やフォルダ分けを変えた結果を残す */
  const saveLayoutTree = async (nodes: CsvLayoutNode[]) => {
    // 先に画面へ映しておくと、掴んで放したときに待たされない
    setLayouts(nodes);
    try {
      setLayouts(await csvSaveLayoutTree(nodes));
    } catch (e) {
      setError(String(e));
      setLayouts(await csvLayouts());
    }
  };

  /** お気に入りを削除する */
  const deleteLayout = async (target: string) => {
    setRemovingLayout(null);
    try {
      setLayouts(await csvDeleteLayout(target));
      setNote(`「${target}」を削除しました`);
    } catch (e) {
      setError(String(e));
    }
  };

  const run = async (f: () => Promise<CsvInfo>) => {
    setError(null);
    try {
      update(await f());
    } catch (e) {
      setError(String(e));
    }
  };

  /** そのファイルで絞り込みのつまみを出しているか (絞っていればいつも出す) */
  const showFilter = (tab: CsvInfo) =>
    (filterOn[tab.docId] ?? false) || tab.filters.length > 0;

  /**
   * 絞り込みの入り切り。
   *
   * やめるときは、絞り込みそのものも外して全行に戻す
   */
  const toggleFilter = () => {
    if (!active) return;
    const on = !showFilter(active);
    setFilterAt(null);
    setFilterOn((prev) => ({ ...prev, [active.docId]: on }));
    if (!on && active.filters.length > 0) {
      void run(() => csvSetFilters(active.docId, []));
    }
  };

  /** 並べ替えを変える (押した列を、小さい順・大きい順・元の並びで回す) */
  const putSort = (col: number, desc: boolean | null) => {
    if (!active) return;
    setFilterAt(null);
    void run(() =>
      csvSetSort(active.docId, desc === null ? null : { col, desc })
    );
  };

  /** 1つの列の絞り込みを入れ替える */
  const putFilter = (next: CsvColumnFilter) => {
    if (!active) return;
    setFilterAt(null);
    void run(() => csvSetFilters(active.docId, withFilter(active.filters, next)));
  };

  const save = async (asNew: boolean) => {
    if (!active) return;
    let path: string | undefined;
    if (asNew || !active.path) {
      const got = await saveDialog({
        defaultPath: active.path ?? active.name,
        filters: FILTERS,
      });
      if (typeof got !== "string") return;
      path = got;
    }
    await run(() => csvSave(active.docId, path));
  };

  /**
   * 閉じたファイルを左右の窓から外す。
   *
   * 出していたファイルが無くなった側には、残っている最後のものを出す
   */
  const dropFromPanes = (rest: CsvInfo[], gone: Set<string>) => {
    const last = rest[rest.length - 1]?.docId ?? null;
    if (activeId !== null && gone.has(activeId)) setActiveId(last);
    if (rightId !== null && gone.has(rightId)) setRightId(last);
    if (rest.length === 0) setSplit(false);
  };

  /**
   * Excel (.xlsx) として書き出す。
   *
   * 保存先は毎回訊く (CSVの保存とは別のファイルなので、
   * 上書き先を覚えていると事故のもとになる)
   */
  const exportXlsx = async () => {
    if (!active) return;
    const base = active.name.replace(/\.[^.]+$/, "");
    const got = await saveDialog({
      defaultPath: `${base}.xlsx`,
      filters: XLSX_FILTERS,
    });
    if (typeof got !== "string") return;
    setBusy(true);
    setError(null);
    try {
      await csvExportXlsx(active.docId, got);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** タブを閉じる (未保存なら確認してから) */
  const closeTab = async (t: CsvInfo, force = false) => {
    if (t.dirty && !force) {
      setClosing(t);
      return;
    }
    setClosing(null);
    setClosingWindow(false);
    try {
      await csvClose(t.docId);
    } catch {
      /* 既に閉じていても構わない */
    }
    // 閉じたファイルを使った比較は見せたままにしない
    setCompare(null);
    setTabs((prev) => {
      const rest = prev.filter((x) => x.docId !== t.docId);
      dropFromPanes(rest, new Set([t.docId]));
      return rest;
    });
    forgetFind(t.docId);
  };

  /**
   * まとめて閉じる (タブの右クリックから)。
   *
   * 未保存のものを巻き込むかどうかはメニュー側で確認済みなので、
   * ここでは黙って閉じる
   */
  const closeMany = async (targets: CsvInfo[]) => {
    const ids = new Set(targets.map((t) => t.docId));
    for (const t of targets) {
      try {
        await csvClose(t.docId);
      } catch {
        /* 既に閉じていても構わない */
      }
    }
    // 閉じたファイルを使った比較は見せたままにしない
    setCompare(null);
    setTabs((prev) => {
      const rest = prev.filter((x) => !ids.has(x.docId));
      dropFromPanes(rest, ids);
      return rest;
    });
    forgetFind(...ids);
  };


  // ---------- 行と列の操作 ----------

  const doc = (f: (id: string) => Promise<CsvInfo>) => {
    if (!active) return;
    setMenu(null);
    void run(() => f(active.docId));
  };

  const startCompare = async (
    leftId: string,
    rightId: string,
    options: CsvDiffOptions
  ) => {
    setDiffSetup(false);
    setBusy(true);
    setError(null);
    try {
      const overview = await csvCompare(leftId, rightId, options);
      setCompare({
        overview,
        token: Date.now(),
        leftName: tabs.find((t) => t.docId === leftId)?.name ?? "",
        rightName: tabs.find((t) => t.docId === rightId)?.name ?? "",
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // ⌘S / ⌘Z / ⌘⇧Z / ⌘O / ⌘F はこのウィンドウで受ける
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.isComposing) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        void save(e.shiftKey);
      } else if (k === "z" && active) {
        e.preventDefault();
        void run(() => (e.shiftKey ? csvRedo : csvUndo)(active.docId));
      } else if (k === "o") {
        e.preventDefault();
        void pick();
      } else if (k === "f" && active) {
        e.preventDefault();
        putFind(active.docId, { open: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // メニューは、どこか他を触ったら閉じる (タブバーの空いている所も含めて)
  useDismiss(!!menu, () => setMenu(null));

  /** ウィンドウを本当に閉じる */
  const shutWindow = async () => {
    const w = getCurrentWindow();
    try {
      await w.destroy();
    } catch {
      await w.close().catch(() => {});
    }
  };

  // 未保存のまま閉じようとしたら、いったん止めて確認する
  useEffect(() => {
    const w = getCurrentWindow();
    const un = w.onCloseRequested((e) => {
      const dirty = tabs.filter((t) => t.dirty);
      if (dirty.length === 0) return;
      e.preventDefault();
      setClosing(dirty[0]);
      setClosingWindow(true);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [tabs]);

  /**
   * 左右に分ける・やめる。
   *
   * 分けたときの右側は、まだ決まっていなければ隣のタブを出す
   * (1つしか開いていなければ、同じファイルをもう一度出す)
   */
  const toggleSplit = () => {
    if (split) {
      setSplit(false);
      setFocus("left");
      return;
    }
    if (!leftTab) return;
    setSplit(true);
    if (rightId === null || !tabs.some((t) => t.docId === rightId)) {
      const at = tabs.findIndex((t) => t.docId === leftTab.docId);
      const next = tabs[at + 1] ?? tabs[at - 1] ?? leftTab;
      setRightId(next.docId);
      setRightCursor({ row: 0, col: 0 });
    }
  };

  /**
   * 真ん中の仕切りを掴んで、左右の幅を変える。
   *
   * 割合で持っているので、ウィンドウの大きさを変えても比率は保たれる
   */
  const panesRef = useRef<HTMLDivElement>(null);
  const grabSplitter = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = panesRef.current;
    if (!box) return;
    const onMove = (m: MouseEvent) => {
      const rect = box.getBoundingClientRect();
      if (rect.width <= 0) return;
      const r = (m.clientX - rect.left) / rect.width;
      setLeftRatio(Math.min(0.8, Math.max(0.2, r)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("col-resizing");
    };
    document.body.classList.add("col-resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /** 掴んだ仕切りの位置に合わせた、左右の幅 */
  const paneWidth = (side: Side) =>
    split && side === "left"
      ? { flex: `0 0 ${(leftRatio * 100).toFixed(2)}%` }
      : undefined;

  /** 相方が動かしたときだけスクロール位置を受け取る */
  const syncFor = (side: Side) =>
    split && syncScroll && sync && sync.from !== side
      ? { syncTop: sync.top, syncLeft: sync.left }
      : {};

  /**
   * 片側の表を描く (分けていないときは左だけを使う)。
   *
   * ヘッダ・トレーラの小さな表とデータ行の表は、横だけ位置を合わせる
   * (縦は合わせない。ヘッダとトレーラは1行しかないため)
   */
  const pane = (
    side: Side,
    tab: CsvInfo,
    paneRows: CsvRows,
    paneCursor: CsvCursor | null,
    setPaneCursor: (c: CsvCursor) => void
  ) => {
    const other = syncFor(side);
    /** 自分が動かした側には渡さない (行ったり来たりを止めるため) */
    const hFor = (who: EdgeWho) =>
      hScroll && hScroll.side === side && hScroll.from !== who
        ? hScroll.left
        : undefined;
    const hMove = (who: EdgeWho, left: number) =>
      setHScroll({ side, from: who, left });

    return (
    <div
      className={"csv-pane" + (split && focus === side ? " focus" : "")}
      style={paneWidth(side)}
      onMouseDown={() => setFocus(side)}
    >
      {/* 種別が混ざるファイルは、ヘッダ行も同じ表に並ぶので帯は出さない */}
      {tab.format.fixed &&
        !tab.format.fixed.key &&
        tab.format.fixed.header.length > 0 && (
        <CsvEdgeRow
          label="ヘッダ"
          columns={tab.format.fixed.header}
          values={tab.headRow}
          onCommit={(cells) => void setEdge(tab.docId, false, cells)}
          syncLeft={hFor("head")}
          onScrollLeft={(left) => hMove("head", left)}
        />
      )}

      <CsvGrid
        key={`${side}:${tab.docId}`}
        columns={tab.columns}
        rowCount={tab.rowCount}
        rows={paneRows}
        cursor={paneCursor}
        onCursor={setPaneCursor}
        onEdit={(row, col, value) =>
          void run(() => csvSetCells(tab.docId, [{ row, col, value }]))
        }
        /*
         * 引用符で囲まない形式と固定長では、セルの中の改行が
         * そのままファイルの改行になってしまうので入れさせない
         */
        canNewline={!tab.format.fixed && tab.format.quote !== "none"}
        onDenyNewline={() =>
          setNote(
            tab.format.fixed
              ? "固定長では、セルの中で改行できません"
              : "この形式では、セルの中で改行できません (引用符が「なし」のため)"
          )
        }
        onRowMenu={(row, x, y, block) =>
          setMenu({ kind: "row", index: row, x, y, block })
        }
        onHeaderMenu={(col, x, y, block) =>
          setMenu({ kind: "col", index: col, x, y, block })
        }
        onRange={setRanges}
        /*
          「選んだ範囲の中だけを探す」の最中は、選んだ範囲を残したまま
          カーソルだけを動かす (そうでなければ、見つかった1セルだけを選ぶ)
        */
        keepRange={
          findOf(tab.docId).open &&
          findOf(tab.docId).scoped &&
          selectionCells(ranges) > 1
        }
        /* 種別が混ざったファイルは、種別ごとに色を変える */
        rowClass={(i) => {
          const kind = paneRows.kindOf(i);
          return kind > 0 ? `kind-${Math.min(kind, KIND_COLORS)}` : undefined;
        }}
        /* 絞り込み中は、元のファイルの行番号を出す */
        rowNumber={(i) => paneRows.number(i)}
        showFilter={showFilter(tab)}
        isFiltered={(c) => isFiltered(tab.filters, c)}
        filterTip={(c) => filterLabel(filterOf(tab.filters, c))}
        sortMark={(c) =>
          tab.sort?.col === c ? (tab.sort.desc ? "desc" : "asc") : undefined
        }
        /*
          見出しのダブルクリックで名前を変える。
          1行目を見出しとして扱っていないファイルは、名前を持たないので変えない
        */
        onRename={
          tab.hasHeader
            ? (col, name) => void run(() => csvRenameCol(tab.docId, col, name))
            : undefined
        }
        onFilter={(col, x, y, flipY) => {
          setActiveId(tab.docId);
          setFilterAt((prev) =>
            prev && prev.col === col ? null : { col, x, y, flipY }
          );
        }}
        cellClass={(r, c) => {
          const at = findOf(tab.docId).hit;
          return at && at.row === r && at.col === c ? "found" : undefined;
        }}
        findQuery={findOf(tab.docId).open ? findOf(tab.docId).query : ""}
        findCase={findOf(tab.docId).matchCase}
        onCopy={(rs) => void copySelection(tab.docId, rs)}
        onPaste={(at, rs) => void pasteAt(tab.docId, at, rs)}
        onEdge={(from, dRow, dCol) =>
          csvEdge(tab.docId, from.row, from.col, dRow, dCol)
        }
        onScrollPos={(top, left) => {
          if (split && syncScroll) setSync({ top, left, from: side });
          hMove("grid", left);
        }}
        syncTop={other.syncTop}
        syncLeft={hFor("grid") ?? other.syncLeft}
      />

      {tab.format.fixed && tab.format.fixed.trailer.length > 0 && (
        <CsvEdgeRow
          label="トレーラ"
          columns={tab.format.fixed.trailer}
          values={tab.trailerRow}
          onCommit={(cells) => void setEdge(tab.docId, true, cells)}
          syncLeft={hFor("tail")}
          onScrollLeft={(left) => hMove("tail", left)}
        />
      )}
      </div>
    );
  };

  return (
    <div className="csv-window">
      {dropOver && (
        <div className="csv-drop" aria-hidden>
          <div className="csv-drop-box">ここに落とすと開きます</div>
        </div>
      )}

      <CsvTabs
        tabs={tabs}
        activeId={activeId}
        split={split}
        leftId={activeId}
        rightId={split ? rightId : null}
        onSelect={(id) => {
          if (split && focus === "right") {
            setRightId(id);
            setRightCursor({ row: 0, col: 0 });
          } else {
            setActiveId(id);
            setLeftCursor({ row: 0, col: 0 });
          }
        }}
        onClose={(t) => void closeTab(t)}
        onReorder={(from, to) => setTabs((prev) => moveItem(prev, from, to))}
        onMenu={(tab, x, y) => setTabMenu({ tab, x, y })}
        onAdd={() => void create()}
        onOpenDb={() =>
          void openMainWindow().catch((e) =>
            setError(`DBの画面を開けませんでした: ${e}`)
          )
        }
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <CsvToolbar
        active={active}
        canCompare={tabs.length >= 2}
        split={split}
        onToggleSplit={toggleSplit}
        syncScroll={syncScroll}
        onToggleSync={() => setSyncScroll((v) => !v)}
        onSave={(asNew) => void save(asNew)}
        onExcel={() => void exportXlsx()}
        filterOn={!!active && showFilter(active)}
        onToggleFilter={toggleFilter}
        onFind={() => active && putFind(active.docId, { open: true })}
        onCompare={() => setDiffSetup(true)}
        layouts={layouts}
        onUseLayout={(s) => void applySavedLayout(s)}
        onDeleteLayout={(s) => setRemovingLayout(s.name)}
        onSaveLayoutTree={(nodes) => void saveLayoutTree(nodes)}
        onEditFixed={() => setFixedOpen(true)}
        onUseDelimiter={() =>
          void (active && run(() => csvSetFixed(active.docId, null)))
        }
      />

      {active && findOf(active.docId).open && (
        <CsvFind
          // ファイルごとに作り直して、前のファイルの入力を持ち越さない
          key={active.docId}
          docId={active.docId}
          initialQuery={findOf(active.docId).query}
          initialMatchCase={findOf(active.docId).matchCase}
          initialScoped={findOf(active.docId).scoped}
          onScope={(scoped) => putFind(active.docId, { scoped })}
          ranges={ranges}
          cursor={cursor}
          onHit={(at) => {
            setCursor(at);
            putFind(active.docId, { hit: at });
          }}
          onQuery={(query, matchCase) =>
            putFind(active.docId, { query, matchCase })
          }
          onReplaced={update}
          onClose={() => putFind(active.docId, { ...NO_FIND })}
        />
      )}

      {error && (
        <div className="result-banner ng">
          <span className="dot" aria-hidden />
          <strong>エラー</strong>
          <span className="result-detail">{error}</span>
          <span className="toolbar-spacer" />
          <button className="btn-ghost" onClick={() => setError(null)}>
            閉じる
          </button>
        </div>
      )}

      {compare ? (
        <CsvDiffView
          overview={compare.overview}
          token={compare.token}
          leftName={compare.leftName}
          rightName={compare.rightName}
          onClose={() => setCompare(null)}
        />
      ) : leftTab ? (
        <div
          className={"csv-panes" + (split ? " split" : "")}
          ref={panesRef}
        >
          {pane("left", leftTab, leftRows, leftCursor, setLeftCursor)}
          {split && (
            <div
              className="csv-splitter"
              title="掴んで動かすと幅を変えられます"
              onMouseDown={grabSplitter}
              onDoubleClick={() => setLeftRatio(0.5)}
            />
          )}
          {split &&
            (rightTab ? (
              pane("right", rightTab, rightRows, rightCursor, setRightCursor)
            ) : (
              <div className="csv-pane csv-empty">
                <div className="csv-empty-hint">
                  タブを押すと、こちら側に出します
                </div>
              </div>
            ))}
        </div>
      ) : (
        <div className="csv-empty">
          <div>CSV・TSVファイルを開いてください</div>
          <div className="csv-empty-hint">
            このウィンドウにファイルを落としても開けます
          </div>
          <div className="csv-empty-actions">
            <button className="btn-primary" onClick={() => void pick()}>
              ファイルを開く
            </button>
            <button className="btn-secondary" onClick={() => void create()}>
              新しいCSV
            </button>
          </div>
        </div>
      )}

      {active && !compare && (
        <div className="csv-status" data-find-skip>
          <span className="mono">
            {active.rowCount.toLocaleString()}行 × {active.columns.length}列
          </span>
          {active.filters.length > 0 && (
            <span
              className="csv-note"
              title="絞り込みを外すと、全部の行に戻ります"
            >
              {active.totalRows.toLocaleString()}行中
              {active.rowCount.toLocaleString()}行を表示中
            </span>
          )}
          {cursor && (
            <span className="mono">
              {rows.number(cursor.row).toLocaleString()}:
              {active.columns[cursor.col] ?? ""}
              {picked > 1
                ? `(${picked.toLocaleString()}セル)`
                : cellLength !== null && `(${cellLength.toLocaleString()}文字)`}
            </span>
          )}
          {/*
            2つ以上選んだときは、表計算ソフトと同じように
            数値だけなら合計を、文字が混ざるなら入っているセルの数を出す
          */}
          {picked > 1 && summary && (
            <span className="mono">
              {summary.sum !== null
                ? `合計 ${summary.sum}`
                : `個数 ${summary.filled.toLocaleString()}`}
            </span>
          )}
          {note && <span className="csv-note">{note}</span>}
          {active.ragged && (
            <span className="csv-warn" title="足りない列は空欄で埋めています">
              列数が揃っていません
            </span>
          )}
          {active.replaced && (
            <span className="csv-warn" title="文字コードを指定して開き直せます">
              文字化けの疑いがあります
            </span>
          )}
          <span className="toolbar-spacer" />
          <MemoryChip />
          {busy && <span className="spinner accent" />}
          {/* rtl で末尾を残して省略するため、中身は bdi で1つの塊にする */}
          <span className="path mono" title={active.path ?? "未保存"}>
            <bdi>{active.path ?? "未保存"}</bdi>
          </span>

          {/*
            文字コード・改行・区切りは、よくあるエディタと同じく右下に置く。
            押すとその場で変えられる
          */}
          <div className="csv-format-wrap">
            <button
              className="csv-status-item"
              title="保存する形を変える"
              onClick={() => setFormatOpen((v) => !v)}
            >
              {formatLabel(active.format)}
            </button>
            {formatOpen && (
              <CsvFormatMenu
                up
                format={active.format}
                hasHeader={active.hasHeader}
                onChange={(patch: CsvFormatPatch) =>
                  doc((id) => csvSetFormat(id, patch))
                }
                onHeader={(on) => doc((id) => csvSetHeader(id, on))}
                onClose={() => setFormatOpen(false)}
              />
            )}
          </div>
        </div>
      )}

      {filterAt && active && (
        <CsvFilterMenu
            // 列を変えたら中身も作り直す
            key={`${active.docId}:${filterAt.col}`}
            docId={active.docId}
            col={filterAt.col}
            name={active.columns[filterAt.col] ?? ""}
            current={filterOf(active.filters, filterAt.col)}
            sort={active.sort}
            onSort={(desc) => putSort(filterAt.col, desc)}
            x={filterAt.x}
            y={filterAt.y}
            flipY={filterAt.flipY}
            onDecide={putFilter}
            onClose={() => setFilterAt(null)}
        />
      )}

      {menu && active && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menu.kind === "row" ? (
            <CsvRowMenu
              row={menu.index}
              at={menu.block.at}
              count={menu.block.count}
              onInsertAbove={(n) =>
                doc((id) => csvInsertRows(id, menu.block.at, n))
              }
              onInsertBelow={(n) =>
                doc((id) =>
                  csvInsertRows(id, menu.block.at + menu.block.count, n)
                )
              }
              onDelete={(at, n) => doc((id) => csvDeleteRows(id, at, n))}
            />
          ) : (
            <CsvColumnMenu
              name={active.columns[menu.index] ?? ""}
              at={menu.block.at}
              count={menu.block.count}
              canDelete={(n) => active.columns.length > n}
              onInsertLeft={(n) =>
                doc((id) => csvInsertCol(id, menu.block.at, "新しい列", n))
              }
              onInsertRight={(n) =>
                doc((id) =>
                  csvInsertCol(
                    id,
                    menu.block.at + menu.block.count,
                    "新しい列",
                    n
                  )
                )
              }
              onRename={() => {
                setRenaming(menu.index);
                setMenu(null);
              }}
              onDelete={(at, n) => doc((id) => csvDeleteCol(id, at, n))}
            />
          )}
        </div>
      )}

      {renaming !== null && active && (
        <CsvNameDialog
          title="列名を変更"
          initial={active.columns[renaming] ?? ""}
          onDecide={(name) => {
            const at = renaming;
            setRenaming(null);
            void run(() => csvRenameCol(active.docId, at, name));
          }}
          onCancel={() => setRenaming(null)}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          // この窓には接続の一覧が無いので、読み直すものは無い
          onImported={() => {}}
        />
      )}

      {fixedOpen && active && (
        <CsvFixedDialog
          current={active.format.fixed}
          applied={appliedLayoutName(flatLayouts(layouts), active.format.fixed)}
          layouts={flatLayouts(layouts)}
          onApply={(layout: CsvFixedLayout) => {
            setFixedOpen(false);
            void run(() =>
              csvSetFixed(active.docId, { unit: layout.unit, layout })
            );
          }}
          onClose={() => setFixedOpen(false)}
        />
      )}

      {removingLayout && (
        <ConfirmDialog
          title="お気に入りを削除します"
          target={removingLayout}
          confirmLabel="削除"
          onConfirm={() => void deleteLayout(removingLayout)}
          onCancel={() => setRemovingLayout(null)}
        >
          保存した桁設定を削除します。開いているファイルには影響しません。
        </ConfirmDialog>
      )}

      {diffSetup && active && (
        <CsvDiffSetup
          tabs={tabs}
          initialLeft={active.docId}
          onStart={(l, r, o) => void startCompare(l, r, o)}
          onCancel={() => setDiffSetup(false)}
        />
      )}

      {tabMenu && (
        <CsvTabMenu
          tab={tabMenu.tab}
          tabs={tabs}
          x={tabMenu.x}
          y={tabMenu.y}
          onCloseMany={(targets) => void closeMany(targets)}
          onDismiss={() => setTabMenu(null)}
        />
      )}

      {closing &&
        (() => {
          const dirty = tabs.filter((t) => t.dirty);
          return (
            <ConfirmDialog
              title="保存していない変更があります"
              target={
                closingWindow && dirty.length > 1
                  ? dirty.map((t) => t.name).join("、")
                  : closing.name
              }
              confirmLabel="保存せずに閉じる"
              onConfirm={() => {
                if (closingWindow) void shutWindow();
                else void closeTab(closing, true);
              }}
              onCancel={() => {
                setClosing(null);
                setClosingWindow(false);
              }}
            >
              {closingWindow && dirty.length > 1
                ? "これらのファイルへの変更は失われます。"
                : "このファイルへの変更は失われます。"}
            </ConfirmDialog>
          );
        })()}
    </div>
  );
}
