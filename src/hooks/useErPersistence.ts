import { useEffect, useRef, useState } from "react";
import {
  deleteErDiagram,
  getErDiagram,
  listErDiagrams,
  saveErDiagram,
} from "../api";
import type {
  ErAnchorPoint,
  ErCustomEdge,
  ErDiagramData,
  ErEdgeStyle,
  ErFrame,
  ErPageData,
  FkInfo,
  SchemaEntry,
} from "../types";

/** ページ (タブ) の見出し */
export interface ErPageMeta {
  id: string;
  name: string;
}

/**
 * 1ページぶんの保存内容。
 * 表示中のページは各stateが持っているので、保存の直前に集めてもらう
 */
export interface ErPageSnapshot {
  entries: SchemaEntry[];
  fks: FkInfo[];
  positions: Map<string, { x: number; y: number }>;
  options: { allCols: boolean; showLogical: boolean; showTypes: boolean };
  removedEdges: Set<string>;
  removedTables: Set<string>;
  tableWidths: Record<string, number>;
  customEdges: ErCustomEdge[];
  anchors: Record<string, { from?: ErAnchorPoint; to?: ErAnchorPoint }>;
  edgeColumns: Record<string, { from: string[]; to: string[] }>;
  edgeStyles: Record<string, ErEdgeStyle>;
  frames: ErFrame[];
}

interface Options {
  /** 表示中のページの内容を集めて返す (保存の直前に呼ばれる) */
  snapshot: () => ErPageSnapshot;
  /** 読み込んだページの内容を画面へ反映する */
  apply: (page: ErPageData) => void;
  /** 右上のトーストに出す文言 (nullで消す) */
  onNotice: (message: string | null) => void;
  /** ページを切り替えたので全体が入るように表示し直す */
  onFit: () => void;
}

/** 空ページの内容 */
function emptyPageData(id: string, name: string): ErPageData {
  return { id, name, entries: [], fks: [], positions: {} };
}

/** 保存されている1ページを、今の形に整えて返す */
function toPageData(id: string, name: string, s: ErPageSnapshot): ErPageData {
  return {
    id,
    name,
    entries: s.entries,
    fks: s.fks,
    positions: Object.fromEntries(s.positions),
    options: s.options,
    removedEdges: [...s.removedEdges],
    removedTables: [...s.removedTables],
    tableWidths: s.tableWidths,
    customEdges: s.customEdges,
    anchors: s.anchors,
    edgeColumns: s.edgeColumns,
    edgeStyles: s.edgeStyles,
    frames: s.frames,
  };
}

/**
 * ER図の保存・読み込みまわり。
 *
 * 1つの保存ファイル (図の名前) に複数のページ (タブ) を持つ。
 * 表示中のページの内容は呼び出し側のstateにあるので、
 * 保存するときだけ `snapshot()` で集め、読み込んだら `apply()` で戻す
 */
export function useErPersistence({
  snapshot,
  apply,
  onNotice,
  onFit,
}: Options) {
  /** 開いている図の名前 (未保存はnull) */
  const [diagName, setDiagName] = useState<string | null>(null);
  const diagNameRef = useRef<string | null>(null);
  diagNameRef.current = diagName;
  /** 保存済みの図の名前一覧 */
  const [diagList, setDiagList] = useState<string[]>([]);

  const [pages, setPages] = useState<ErPageMeta[]>([{ id: "p1", name: "ER図1" }]);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const [pageId, setPageId] = useState("p1");
  const pageIdRef = useRef(pageId);
  pageIdRef.current = pageId;
  /** 表示していないページの内容 (表示中のページは呼び出し側のstateが持つ) */
  const pagesDataRef = useRef<Map<string, ErPageData>>(new Map());

  // 毎描画で最新のコールバックを差し替える (依存に入れて登録し直さない)
  const cb = useRef({ snapshot, apply, onNotice, onFit });
  cb.current = { snapshot, apply, onNotice, onFit };

  const refreshDiagList = () => {
    listErDiagrams()
      .then(setDiagList)
      .catch(() => {});
  };

  // 起動時に図の一覧を読み込む
  useEffect(() => {
    refreshDiagList();
  }, []);

  /** 表示中のページの名前 */
  const activeName = () =>
    pagesRef.current.find((p) => p.id === pageIdRef.current)?.name ?? "ER図1";

  /** 表示中のページの保存内容を組み立てる */
  const buildActivePage = (override?: Partial<ErPageSnapshot>): ErPageData =>
    toPageData(pageIdRef.current, activeName(), {
      ...cb.current.snapshot(),
      ...override,
    });

  /**
   * ページ一覧と控えからファイル全体の保存データを組み立てる。
   * 呼び出す前に、表示中のページを控えへ入れておくこと
   */
  const assembleFileData = (): ErDiagramData => {
    const metas = pagesRef.current;
    return {
      savedAtMs: Date.now(),
      pages: metas.map((p) => {
        const d = pagesDataRef.current.get(p.id) ?? emptyPageData(p.id, p.name);
        return { ...d, id: p.id, name: p.name };
      }),
      activePage: Math.max(
        0,
        metas.findIndex((p) => p.id === pageIdRef.current)
      ),
    };
  };

  /** ファイル全体を保存する (名前が付いていなければ何もしない) */
  const saveFile = () => {
    const key = diagNameRef.current;
    if (!key) return;
    saveErDiagram(key, assembleFileData()).catch(() => {});
  };

  /**
   * 表示中のページを控えへ入れて自動保存する。
   *
   * @param override まだstateに反映していない値があればここで差し替える
   */
  const persist = (override?: Partial<ErPageSnapshot>) => {
    const active = buildActivePage(override);
    pagesDataRef.current.set(active.id, active);
    saveFile();
  };

  /** 今の状態から保存データを組み立てる (名前を付けて保存に使う) */
  const buildData = (): ErDiagramData => {
    pagesDataRef.current.set(pageIdRef.current, buildActivePage());
    return assembleFileData();
  };

  /**
   * 表示するページを差し替える。
   *
   * @param fit 全体が入るように表示し直すか (タブ追加のときは今の倍率のまま)
   */
  const goToPage = (
    target: ErPageData,
    opts: { fit: boolean; save: boolean }
  ) => {
    setPageId(target.id);
    pageIdRef.current = target.id;
    cb.current.apply(target);
    if (opts.fit) cb.current.onFit();
    if (opts.save) saveFile();
  };

  /** キャンバスを空の未保存状態に戻す */
  const clearDiagram = () => {
    const pid = `p${Date.now()}`;
    const meta = [{ id: pid, name: "ER図1" }];
    pagesDataRef.current = new Map();
    setPages(meta);
    pagesRef.current = meta;
    setPageId(pid);
    pageIdRef.current = pid;
    cb.current.apply(emptyPageData(pid, "ER図1"));
    setDiagName(null);
    diagNameRef.current = null;
  };

  /** 保存済みの図を名前で開く (どの接続からでも開ける) */
  const openDiagram = (name: string) => {
    getErDiagram(name)
      .then((data) => {
        if (!data) return;
        // 旧形式 (単一ページ) は1ページに移行して読み込む
        const pageList: ErPageData[] =
          data.pages && data.pages.length > 0
            ? data.pages
            : [
                {
                  id: "p1",
                  name: "ER図1",
                  entries: data.entries ?? [],
                  fks: data.fks ?? [],
                  positions: data.positions ?? {},
                  options: data.options,
                  removedEdges: data.removedEdges,
                  removedTables: data.removedTables,
                  tableWidths: data.tableWidths,
                  customEdges: data.customEdges,
                  anchors: data.anchors,
                  edgeColumns: data.edgeColumns,
                  edgeStyles: data.edgeStyles,
                  frames: data.frames,
                },
              ];
        pagesDataRef.current = new Map(pageList.map((p) => [p.id, p]));
        const metas = pageList.map((p) => ({ id: p.id, name: p.name }));
        setPages(metas);
        pagesRef.current = metas;
        const idx = Math.min(data.activePage ?? 0, pageList.length - 1);
        setDiagName(name);
        diagNameRef.current = name;
        goToPage(pageList[idx], { fit: true, save: false });
        cb.current.onNotice(null);
      })
      .catch(() => {});
  };

  /** タブを切り替える */
  const switchPage = (id: string) => {
    if (id === pageIdRef.current) return;
    pagesDataRef.current.set(pageIdRef.current, buildActivePage());
    const meta = pagesRef.current.find((p) => p.id === id);
    goToPage(
      pagesDataRef.current.get(id) ?? emptyPageData(id, meta?.name ?? "ER図"),
      { fit: true, save: true }
    );
  };

  /** タブを追加して切り替える */
  const addPage = () => {
    pagesDataRef.current.set(pageIdRef.current, buildActivePage());
    const id = `p${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
    const name = `ER図${pagesRef.current.length + 1}`;
    const meta = [...pagesRef.current, { id, name }];
    setPages(meta);
    pagesRef.current = meta;
    const fresh = emptyPageData(id, name);
    pagesDataRef.current.set(id, fresh);
    // タブを足しただけでは表示倍率を変えない (中身が無いので合わせようがない)
    goToPage(fresh, { fit: false, save: true });
  };

  /** タブを削除する (最後の1つは削除しない) */
  const deletePage = (id: string) => {
    if (pagesRef.current.length <= 1) return;
    const target = pagesRef.current.find((p) => p.id === id);
    const next = pagesRef.current.filter((p) => p.id !== id);
    pagesDataRef.current.delete(id);
    setPages(next);
    pagesRef.current = next;
    if (pageIdRef.current === id) {
      const act = next[0];
      setPageId(act.id);
      pageIdRef.current = act.id;
      cb.current.apply(
        pagesDataRef.current.get(act.id) ?? emptyPageData(act.id, act.name)
      );
    }
    saveFile();
    cb.current.onNotice(`タブ「${target?.name ?? id}」を削除しました`);
  };

  /** タブの並べ替え (ドラッグ中にindexを入れ替える。保存はドラッグ終了時) */
  const reorderPages = (from: number, to: number) => {
    const next = [...pagesRef.current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setPages(next);
    pagesRef.current = next;
  };

  /** 並べ替えのドラッグが終わったら保存する */
  const saveAfterReorder = () => {
    pagesDataRef.current.set(pageIdRef.current, buildActivePage());
    saveFile();
  };

  /** タブ名を変える */
  const renamePage = (id: string, name: string) => {
    const next = pagesRef.current.map((p) =>
      p.id === id ? { ...p, name } : p
    );
    setPages(next);
    pagesRef.current = next;
    pagesDataRef.current.set(pageIdRef.current, buildActivePage());
    saveFile();
  };

  /**
   * 名前を付けて保存する。
   * 名前変更のときは、保存できてから古い名前のファイルを消す
   */
  const saveAs = (name: string, mode: "saveAs" | "rename") => {
    const old = diagNameRef.current;
    saveErDiagram(name, buildData())
      .then(async () => {
        if (mode === "rename" && old && old !== name) {
          await deleteErDiagram(old).catch(() => {});
        }
        diagNameRef.current = name;
        setDiagName(name);
        refreshDiagList();
        cb.current.onNotice(`「${name}」として保存しました`);
      })
      .catch((e) => cb.current.onNotice(`保存に失敗: ${e}`));
  };

  /** 開いている図を削除して、空の未保存状態に戻す */
  const deleteDiagram = () => {
    const name = diagNameRef.current;
    if (!name) return;
    deleteErDiagram(name)
      .then(() => refreshDiagList())
      .catch(() => {});
    clearDiagram();
    cb.current.onNotice(`「${name}」を削除しました`);
  };

  /**
   * まだ名前が付いていなければ自動で付ける (リバース直後の初回保存用)。
   * 同じ名前があれば「(2)」を足す
   */
  const ensureName = (base: string): string => {
    if (diagNameRef.current) return diagNameRef.current;
    let name = base;
    let n = 2;
    while (diagList.includes(name)) name = `${base} (${n++})`;
    diagNameRef.current = name;
    setDiagName(name);
    return name;
  };

  return {
    diagName,
    diagList,
    refreshDiagList,
    pages,
    pageId,
    persist,
    saveFile,
    clearDiagram,
    openDiagram,
    switchPage,
    addPage,
    deletePage,
    reorderPages,
    saveAfterReorder,
    renamePage,
    saveAs,
    deleteDiagram,
    ensureName,
  };
}
