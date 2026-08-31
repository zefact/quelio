import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  listSessions,
  saveCapture,
  saveTextFile,
  schemaWithForeignKeys,
} from "../api";
import { writeClipboard } from "../gridCopy";
import { usePopupPosition } from "../hooks/usePopupPosition";
import { useWatchedSettings } from "../hooks/useWatchedSettings";
import { parseComment } from "../comment";
import { layoutEr } from "../erLayout";
import type {
  ErAnchorPoint,
  ErCustomEdge,
  ErEdgeStyle,
  ErFrame,
  ErPageData,
  FkInfo,
  SchemaEntry,
  SessionSummary,
} from "../types";
import { isCancelled, LoadingWithCancel } from "./LoadingWithCancel";
import { rafThrottle } from "../rafThrottle";
import { drawErPng } from "../er/exportPng";
import { toMermaid, toPlantUml } from "../er/exportText";
import { usePolling } from "../hooks/usePolling";
import { useDismiss } from "../hooks/useDismiss";
import { useErPersistence } from "../hooks/useErPersistence";
import {
  ErDialogs,
  type ErConfirm,
  type ErNameDialog,
} from "./ErDialogs";
import { CanvasMenu } from "./erMenu/CanvasMenu";
import { ColumnMenu } from "./erMenu/ColumnMenu";
import { EdgeMenu } from "./erMenu/EdgeMenu";
import { FrameMenu } from "./erMenu/FrameMenu";
import { NodeMenu } from "./erMenu/NodeMenu";
import type { ErCtxMenu } from "./erMenu/types";
import { ErEdgeLayer } from "./ErEdgeLayer";
import { ErToolbar } from "./ErToolbar";
import { ErNodeView } from "./ErNodeView";
import { ErFrameLayer, type FrameHandlers } from "./ErFrameLayer";
import { ErPageTabs } from "./ErPageTabs";
import { useEvent } from "../hooks/useEvent";
import { useErViewport } from "../er/useErViewport";
import { useErSelection } from "../er/useErSelection";

import {
  buildEdges,
  buildNodes,
  edgeKey,
  ErEdge,
  ErNode,
  NODE_HEAD_H,
  ROW_H,
} from "../er/model";
import {
  anchorPointPos,
  anchorY,
  AnchoredPt,
  colSideAnchor,
  edgePoints,
  nearestBorderAnchor,
  pathClear,
  Rect,
  routeAnchored,
  routeAvoid,
  verticalSegments,
} from "../er/geometry";


/** ER図ウィンドウ (DB全体のテーブルとリレーションを描画・PNG出力) */
export function ErWindow() {
  const params = new URLSearchParams(window.location.search);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sel, setSel] = useState({
    sessionId: params.get("session") ?? "",
    database: params.get("db") ?? "",
  });
  const [entries, setEntries] = useState<SchemaEntry[] | null>(null);
  const [fks, setFks] = useState<FkInfo[]>([]);
  // 表示オプション (新規作成時の既定は全てON。保存済みの図を開くと上書きされる)
  const [allCols, setAllCols] = useState(true);
  const [showLogical, setShowLogical] = useState(true);
  const [showTypes, setShowTypes] = useState(true);
  /** 論理名の区切り文字 (設定から読み込む) */
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ドラッグで動かしたノードの位置 (自動レイアウトへの上書き。state更新は再描画トリガrevで行う)
  const posRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const [rev, setRev] = useState(0);
  // 表示 (パン・ズーム) の扱いはまとめてフックへ
  const {
    view,
    viewRef,
    canvasRef,
    toWorld,
    zoomBy,
    fitTo,
    startPan,
    panBy,
    useWheel,
  } = useErViewport();

  const session = sessions.find((s) => s.sessionId === sel.sessionId);
  // コメントの区切り文字は設定で変わる (別ウィンドウでの変更にも追従する)
  const delim = useWatchedSettings().commentDelimiter;



  // 接続一覧は定期的に再取得する。
  // スキーマ読み込み中のセッションは一覧から一時的に外れるため、
  // 開いた直後の1回だけだと空のまま固まってしまう
  usePolling(() => {
    listSessions().then(setSessions).catch(() => {});
  }, 3000);

  // 開いている図の名前 (=保存キー)。プロファイルに縛られず自由に付けられ、
  // どの接続からでも同じ図を開ける
  /** 図の名前入力ダイアログ (名前を付けて保存 / 名前変更) */
  const [nameDialog, setNameDialog] = useState<ErNameDialog | null>(null);
  /** リバース時の確認ダイアログ (既存の図がある場合のみ表示) */
  const [reverseDialog, setReverseDialog] = useState(false);
  /** リバース時に削除済みテーブルも復活させるか (ダイアログのチェック) */
  const [reviveTables, setReviveTables] = useState(false);
  /** 削除確認ダイアログ (タブ・テーブル・線・枠などの削除前に出す)。
   * subを指定するとサブテキストを差し替えられる (既定は「元に戻せません」) */
  const [confirm, setConfirm] = useState<ErConfirm | null>(null);
  // 保存用に最新のスキーマを参照できるようにしておく (ドラッグ終了時などに使う)
  const entriesRef = useRef<SchemaEntry[] | null>(null);
  entriesRef.current = entries;
  const fksRef = useRef<FkInfo[]>([]);
  fksRef.current = fks;
  /** 全体フィット表示のトリガ (読み込み/新規作成時に+1する) */
  const [fitTick, setFitTick] = useState(0);
  // 選択 (リレーション・テーブル・カラム行・矩形) はまとめてフックへ
  const {
    selEdge,
    setSelEdge,
    selEdges,
    setSelEdges,
    selNodes,
    setSelNodes,
    band,
    setBand,
    selCol,
    setSelCol,
    clearAll: clearSelection,
  } = useErSelection();
  /** 削除した自動検出リレーションのキー */
  const [removedEdges, setRemovedEdges] = useState<Set<string>>(new Set());
  /** 図から削除したテーブル名 (リバースしても再追加しない) */
  const [removedTables, setRemovedTables] = useState<Set<string>>(new Set());
  /** テーブルごとの横幅の上書き (px。未設定は内容に合わせて自動=Fit) */
  const [tableWidths, setTableWidths] = useState<Record<string, number>>({});
  /** 手動で追加したリレーション */
  const [customEdges, setCustomEdges] = useState<ErCustomEdge[]>([]);
  /** 線ごとの接続位置の上書き (キーはedgeKey) */
  const [anchors, setAnchors] = useState<
    Record<string, { from?: ErAnchorPoint; to?: ErAnchorPoint }>
  >({});
  /** 線に対応するカラムの追加分 (キーはedgeKey。複合キーなどの複数対応) */
  const [edgeCols, setEdgeCols] = useState<
    Record<string, { from: string[]; to: string[] }>
  >({});
  /** 線ごとの見た目 (キーはedgeKey。線種・色) */
  const [edgeStyles, setEdgeStyles] = useState<Record<string, ErEdgeStyle>>(
    {}
  );
  /** 線の追加モード (接続元→接続先の順にカラムをクリック) */
  const [linkMode, setLinkMode] = useState(false);
  const [linkSrc, setLinkSrc] = useState<{
    table: string;
    column: string;
  } | null>(null);
  /** マウスが乗っているテーブル (そのテーブルの行にだけ●ハンドルを描く)。
   *  どの行に出すかはCSSの:hoverが決めるので、テーブルを出入りしたときしか更新しない */
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  /** ●ハンドルからのドラッグ接続 (プレビュー線と接続先ハイライト) */
  const [linkDrag, setLinkDrag] = useState<{
    from: { table: string; column: string };
    x: number;
    y: number;
    target: { table: string; column: string } | null;
  } | null>(null);
  /** 線の編集パネル (カラムの対応をチェックボックスで設定) */
  const [edgePanel, setEdgePanel] = useState<{
    edge: number;
    x: number;
    y: number;
  } | null>(null);
  /** 注釈枠 */
  const [frames, setFrames] = useState<ErFrame[]>([]);
  /** インライン編集中の枠/テキストのID (画面上で直接編集する) */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  /** 右クリックメニュー */
  const [ctxMenu, setCtxMenu] = useState<ErCtxMenu | null>(null);
  // メニューが画面の外へはみ出さないように位置を補正する
  const [ctxMenuRef, ctxMenuStyle] = usePopupPosition<HTMLDivElement>(
    ctxMenu?.x ?? 0,
    ctxMenu?.y ?? 0
  );
  const [edgePanelRef, edgePanelStyle] = usePopupPosition<HTMLDivElement>(
    edgePanel?.x ?? 0,
    edgePanel?.y ?? 0
  );

  /** ページの内容を各stateへ反映する */
  const applyPageData = (d: ErPageData) => {
    posRef.current = new Map(Object.entries(d.positions ?? {}));
    if (d.options) {
      setAllCols(d.options.allCols);
      setShowLogical(d.options.showLogical);
      setShowTypes(d.options.showTypes);
    } else {
      setAllCols(true);
      setShowLogical(true);
      setShowTypes(true);
    }
    setRemovedEdges(new Set(d.removedEdges ?? []));
    setRemovedTables(new Set(d.removedTables ?? []));
    setTableWidths(d.tableWidths ?? {});
    setCustomEdges(d.customEdges ?? []);
    setAnchors(d.anchors ?? {});
    setEdgeCols(d.edgeColumns ?? {});
    setEdgeStyles(d.edgeStyles ?? {});
    setFrames(d.frames ?? []);
    setEntries(d.entries.length > 0 ? d.entries : null);
    setFks(d.fks ?? []);
    clearSelection();
    setRev((r) => r + 1);
  };

  /*
   * 保存・読み込みとページ (タブ) の管理はフックへ出してある。
   * 表示中のページの内容はここのstateにあるので、
   * 保存の直前に snapshot() で集めてもらい、読み込んだら apply() で戻す
   */
  const store = useErPersistence({
    snapshot: () => ({
      entries: entriesRef.current ?? [],
      fks: fksRef.current,
      positions: posRef.current,
      options: { allCols, showLogical, showTypes },
      removedEdges,
      removedTables,
      tableWidths,
      customEdges,
      anchors,
      edgeColumns: edgeCols,
      edgeStyles,
      frames,
    }),
    apply: applyPageData,
    onNotice: setNotice,
    onFit: () => setFitTick((t) => t + 1),
  });
  const { persist, diagName, diagList, pages, pageId } = store;

  /** 保存済みの図を開く (前の読み込みエラーと通知は消してから) */
  const openDiagram = (name: string) => {
    setError(null);
    store.openDiagram(name);
  };

  /** タブの削除は確認してから (フック側は確認しない) */
  const askDeletePage = (id: string) => {
    if (pages.length <= 1) return;
    const name = pages.find((p) => p.id === id)?.name ?? id;
    setConfirm({
      title: "タブを削除",
      message: `タブ「${name}」とその内容を削除しますか？この操作は元に戻せません。`,
      action: () => store.deletePage(id),
    });
  };


  // 通知は右上のトーストとして表示し、5秒で自動的に消す
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // ページ内検索 (⌘F) がER図内の一致へ移動するとき、キャンバスをパンして
  // 一致位置を中央に表示する (ズームは変えない)
  useEffect(() => {
    const onReveal = (e: Event) => {
      const el = (e as CustomEvent).detail as HTMLElement | null;
      const canvas = canvasRef.current;
      if (!el || !canvas || !canvas.contains(el)) return;
      const r = el.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      const dx = c.left + c.width / 2 - (r.left + r.width / 2);
      const dy = c.top + c.height / 2 - (r.top + r.height / 2);
      panBy(dx, dy);
    };
    window.addEventListener("quelio-find-reveal-er", onReveal);
    return () => window.removeEventListener("quelio-find-reveal-er", onReveal);
  }, [canvasRef, panBy]);

  // 開いたときに、この接続/DBに対応する図が保存済みなら自動で開く
  // (旧形式の「プロファイルID:DB名」キーも引き続き開ける)
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current || diagName || !session || !sel.database) return;
    if (diagList.length === 0) return;
    const candidates = [
      `${session.name}/${sel.database}`,
      `${session.profileId}:${sel.database}`,
    ];
    const hit = candidates.find((c) => diagList.includes(c));
    if (hit) {
      autoOpenedRef.current = true;
      openDiagram(hit);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sel.database, diagList, diagName]);

  /** 名前ダイアログの確定 (名前を付けて保存 / 名前変更) */
  const commitNameDialog = () => {
    if (!nameDialog) return;
    const name = nameDialog.value.trim();
    if (!name) return;
    setNameDialog(null);
    store.saveAs(name, nameDialog.mode);
  };

  /** 現在の図の削除を確認してから実行する */
  const deleteCurrentDiagram = () => {
    if (!diagName) return;
    setConfirm({
      title: "図を削除",
      message: `「${diagName}」を全てのタブごと削除しますか？この操作は元に戻せません。`,
      action: () => store.deleteDiagram(),
    });
  };

  /** リバース: DBからスキーマを読み込んでER図を作成/更新する。
   * 既存の図がある場合はテーブルの配置を維持し、新規テーブルは右側へ追加する。
   * addNew: 図に無い新規テーブルを追加するか (既存図でundefinedなら確認ダイアログを出す)
   * revive: 図から削除したテーブルも復活させるか */
  const doReverse = async (addNew?: boolean, revive?: boolean) => {
    if (!sel.sessionId || !sel.database) return;
    // 既にテーブルがある場合は、新規テーブルの扱いを確認してから実行する
    if (
      addNew === undefined &&
      entriesRef.current !== null &&
      posRef.current.size > 0
    ) {
      setReviveTables(false);
      setReverseDialog(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // スキーマと外部キーは1回の呼び出しで取る (収集用の接続を1本にするため)
      const { entries: snapAll, foreignKeys: fk } = await schemaWithForeignKeys(
        sel.sessionId,
        sel.database
      );
      // 図から削除したテーブルはリバースしても再追加しない
      // (reviveチェック時は削除の記憶を解除して復活させる)
      const removedNow = revive ? new Set<string>() : removedTables;
      if (revive && removedTables.size > 0) setRemovedTables(new Set());
      let snap = snapAll.filter((e) => !removedNow.has(e.table.name));
      // 「いいえ」= 図にあるテーブルだけ更新 (カラムの増減は反映、新規テーブルは追加しない)
      // reviveチェック時は削除済みだったテーブルも対象に含める
      if (addNew === false && entriesRef.current) {
        const allowed = new Set(entriesRef.current.map((e) => e.table.name));
        if (revive) for (const n of removedTables) allowed.add(n);
        snap = snap.filter((e) => allowed.has(e.table.name));
      }
      const freshNodes = buildNodes(snap, allCols, showTypes, showLogical, delim);
      const freshEdges = buildEdges(snap, fk);
      const prev = posRef.current;
      const isUpdate = entriesRef.current !== null && prev.size > 0;
      let positions: Map<string, { x: number; y: number }>;
      const addedNames: string[] = [];
      if (!isUpdate) {
        // 新規作成: 自動レイアウト
        positions = layoutEr(freshNodes, freshEdges);
      } else {
        // 更新: 既存テーブルの配置を維持し、新規テーブルは右側へ縦積み
        positions = new Map();
        let maxX = 0;
        for (const n of freshNodes) {
          const p = prev.get(n.name);
          if (p) {
            positions.set(n.name, p);
            maxX = Math.max(maxX, p.x + n.w);
          }
        }
        let y = 20;
        for (const n of freshNodes) {
          if (positions.has(n.name)) continue;
          positions.set(n.name, { x: maxX + 80, y });
          y += n.h + 40;
          addedNames.push(n.name);
        }
      }
      posRef.current = positions;
      setEntries(snap);
      setFks(fk);
      setRev((r) => r + 1);
      if (!isUpdate) setFitTick((t) => t + 1);
      // 図の名前が未設定なら「接続名/DB名」で自動命名する (重複時は連番)
      const savedName = store.ensureName(
        `${session?.name ?? "ER図"}/${sel.database}`
      );
      persist({
        entries: snap,
        fks: fk,
        positions,
        ...(revive ? { removedTables: removedNow } : {}),
      });
      store.refreshDiagList();
      // 追加されたテーブル名を通知する (多い場合は先頭数件+件数)
      const shown = addedNames.slice(0, 6).join(", ");
      const more =
        addedNames.length > 6 ? ` 他${addedNames.length - 6}件` : "";
      setNotice(
        isUpdate
          ? addedNames.length > 0
            ? `更新しました — 新規${addedNames.length}テーブル: ${shown}${more}`
            : "更新しました"
          : `「${savedName}」として保存しました`
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      // 読み込み中はこのセッションが接続一覧から外れているため取り直す
      listSessions().then(setSessions).catch(() => {});
    }
  };

  // ノードとエッジの組み立て (横幅の上書きがあれば適用。未設定は内容にFit)
  const nodes: ErNode[] = useMemo(() => {
    if (!entries) return [];
    return buildNodes(entries, allCols, showTypes, showLogical, delim).map(
      (n) => (tableWidths[n.name] ? { ...n, w: tableWidths[n.name] } : n)
    );
  }, [entries, allCols, showTypes, showLogical, delim, tableWidths]);

  const edges = useMemo(() => {
    if (!entries) return [];
    const tableSet = new Set(entries.map((e) => e.table.name));
    // 自動検出 (削除済みは除く) + 手動追加 (存在するテーブルのみ)
    const auto = buildEdges(entries, fks).filter(
      (e) => !removedEdges.has(edgeKey(e))
    );
    const manual: ErEdge[] = customEdges
      .filter((c) => tableSet.has(c.from) && tableSet.has(c.to))
      .map((c) => ({
        from: c.from,
        to: c.to,
        fromColumn: c.fromColumn,
        toColumn: c.toColumn,
        label: `${c.fromColumn} → ${c.toColumn} (手動)`,
        guessed: false,
        manual: true,
      }));
    return [...auto, ...manual];
  }, [entries, fks, removedEdges, customEdges]);

  /*
   * テーブル1つぶんの操作。
   *
   * ErNodeView は memo してあるので、描画のたびに新しい関数を渡すと
   * 意味が無くなる。useEvent で関数を固定し、
   * どのテーブルかは引数で受け取る
   */
  const handleNodeMouseDown = useEvent((e: React.MouseEvent, table: string) => {
    startNodeDrag(e, table);
  });
  const handleNodeHover = useEvent((hovered: boolean, table: string) => {
    setHoverNode((h) => (hovered ? table : h === table ? null : h));
  });
  const handleNodeContextMenu = useEvent(
    (e: React.MouseEvent, table: string) => {
      e.preventDefault();
      e.stopPropagation();
      setSelNodes((prev) => (prev.has(table) ? prev : new Set([table])));
      setCtxMenu({ x: e.clientX, y: e.clientY, kind: "node", table });
    }
  );
  const handleColumnClickAt = useEvent((table: string, column: string) => {
    handleColumnClick(table, column);
  });
  const handleColumnContextMenu = useEvent(
    (ev: React.MouseEvent, table: string, column: string) => {
      ev.preventDefault();
      ev.stopPropagation();
      setCtxMenu({
        x: ev.clientX,
        y: ev.clientY,
        kind: "column",
        table,
        column,
      });
    }
  );
  const handleLinkHandleMouseDown = useEvent(
    (e: React.MouseEvent, table: string, column: string) => {
      startLinkDrag(e, table, column);
    }
  );
  const handleNodeResize = useEvent((e: React.MouseEvent, table: string) => {
    startNodeResize(e, table);
  });

  /** ノードの表示位置 (リバース/読み込みで確定した配置。ドラッグで上書き) */
  const posOf = (name: string): { x: number; y: number } =>
    posRef.current.get(name) ?? { x: 20, y: 20 };

  // 読み込み/新規作成の直後は全体が画面に収まるように表示を合わせる。
  // (テーブル数の増減だけではフィットし直さない。fitTickが進んだときのみ)
  const doneFitRef = useRef(0);
  useEffect(() => {
    if (fitTick === 0 || nodes.length === 0) return;
    if (doneFitRef.current === fitTick) return;
    doneFitRef.current = fitTick;
    let maxX = 400;
    let maxY = 300;
    for (const nd of nodes) {
      const p = posRef.current.get(nd.name);
      if (!p) continue;
      maxX = Math.max(maxX, p.x + nd.w);
      maxY = Math.max(maxY, p.y + nd.h);
    }
    fitTo(maxX, maxY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitTick, nodes.length]);

  // 図が出ているあいだ、ホイール操作を受け付ける
  useWheel([entries, loading]);

  /** テーブルを図から削除する (複数可。リバースしても再追加されない) */
  const removeTables = (names: string[]) => deleteSelection([], names);

  /** 削除したテーブルの記憶を解除する (次のリバースで再追加される) */
  const restoreRemovedTables = () => {
    if (removedTables.size === 0) return;
    setRemovedTables(new Set());
    setNotice("削除したテーブルを戻しました。リバースすると再表示されます");
    if (entriesRef.current) {
      persist({
        removedTables: new Set(),
      });
    }
  };

  /** ノードのドラッグ移動 (ヘッダ・カラム部どこからでも掴める)。
   * 複数選択中に選択済みのテーブルを掴むと、選択中の全テーブルをまとめて動かす。
   * カラム行の上から始めた場合はテーブル選択にせず行クリックを優先する */
  const startNodeDrag = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    const t = e.target as HTMLElement;
    let selected = selNodes;
    if (!t.closest(".er-col-name, .er-col-type, .er-col-logical")) {
      if (e.shiftKey) {
        // Shift+クリックで選択に追加/解除
        selected = new Set(selNodes);
        if (selected.has(name)) selected.delete(name);
        else selected.add(name);
        setSelNodes(selected);
      } else if (!selNodes.has(name)) {
        selected = new Set([name]);
        setSelNodes(selected);
      }
    }
    // まとめて動かす対象 (選択中のテーブルを掴んだ場合は選択全体)
    const moveNames =
      selected.has(name) && selected.size > 1 ? [...selected] : [name];
    const start = { x: e.clientX, y: e.clientY };
    const origs = new Map(moveNames.map((nm) => [nm, posOf(nm)]));
    // 位置はrefに毎回入れ、再描画だけ1フレーム1回に間引く
    const redraw = rafThrottle<void>(() => setRev((r) => r + 1));
    const move = (ev: MouseEvent) => {
      const dx = (ev.clientX - start.x) / viewRef.current.scale;
      const dy = (ev.clientY - start.y) / viewRef.current.scale;
      for (const [nm, o] of origs) {
        posRef.current.set(nm, { x: o.x + dx, y: o.y + dy });
      }
      redraw.run(undefined);
    };
    const up = () => {
      redraw.cancel();
      setRev((r) => r + 1);
      document.removeEventListener("mousemove", move);
      // 配置の変更を自動保存する
      if (entriesRef.current) {
        persist();
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** 指定のワールド座標にあるカラム行を返す (excludeTableは除く) */
  const hitColumn = (
    wx: number,
    wy: number,
    excludeTable: string
  ): { table: string; column: string } | null => {
    for (const n of nodes) {
      if (n.name === excludeTable) continue;
      const p = posOf(n.name);
      if (wx < p.x || wx > p.x + n.w || wy < p.y || wy > p.y + n.h) continue;
      const idx = Math.floor((wy - p.y - NODE_HEAD_H) / ROW_H);
      if (idx >= 0 && idx < n.columns.length) {
        return { table: n.name, column: n.columns[idx].name };
      }
      return null;
    }
    return null;
  };

  /** 手動リレーションを追加する (重複は追加しない) */
  const addCustomEdge = (
    fromT: string,
    fromC: string,
    toT: string,
    toC: string
  ) => {
    if (fromT === toT) return;
    const dup = edges.some(
      (e) =>
        e.from === fromT &&
        e.fromColumn === fromC &&
        e.to === toT &&
        e.toColumn === toC
    );
    if (dup) {
      setNotice("同じ対応の線が既にあります");
      return;
    }
    const c: ErCustomEdge = {
      from: fromT,
      fromColumn: fromC,
      to: toT,
      toColumn: toC,
    };
    const custom = [...customEdges, c];
    setCustomEdges(custom);
    setNotice(`${fromT}.${fromC} → ${toT}.${toC} を追加しました`);
    if (entriesRef.current) {
      persist({
        customEdges: custom,
      });
    }
  };

  /** カラム行の●ハンドルからドラッグして線をつなぐ */
  const startLinkDrag = (
    e: React.MouseEvent,
    table: string,
    column: string
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const p0 = toWorld(e.clientX, e.clientY);
    setLinkDrag({ from: { table, column }, x: p0.x, y: p0.y, target: null });
    const move = (ev: MouseEvent) => {
      const q = toWorld(ev.clientX, ev.clientY);
      setLinkDrag({
        from: { table, column },
        x: q.x,
        y: q.y,
        target: hitColumn(q.x, q.y, table),
      });
    };
    const up = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", move);
      const q = toWorld(ev.clientX, ev.clientY);
      const target = hitColumn(q.x, q.y, table);
      setLinkDrag(null);
      if (target) addCustomEdge(table, column, target.table, target.column);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** テーブルの横幅を右端ドラッグで調整する */
  const startNodeResize = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    const node = nodes.find((n) => n.name === name);
    if (!node) return;
    const startX = e.clientX;
    const orig = node.w;
    let latest = tableWidths;
    const applyWidth = (x: number) => {
      const w = Math.round(
        Math.min(1200, Math.max(120, orig + (x - startX) / viewRef.current.scale))
      );
      if (latest[name] === w) return;
      latest = { ...tableWidths, [name]: w };
      setTableWidths(latest);
    };
    // 更新は1フレーム1回に間引く
    const apply = rafThrottle<number>(applyWidth);
    let moved = false;
    const move = (ev: MouseEvent) => {
      // 数pxのぶれはクリック扱いにする (押しただけで幅が固定されないように)
      if (Math.abs(ev.clientX - startX) > 2) moved = true;
      if (moved) apply.run(ev.clientX);
    };
    const up = (ev: MouseEvent) => {
      apply.cancel();
      document.removeEventListener("mousemove", move);
      // 動かしていなければ何もしない (クリックしただけで幅が固定されるのを防ぐ)
      if (!moved) return;
      // 間引きで取りこぼした最後の位置を、保存の前に確定させる
      applyWidth(ev.clientX);
      if (entriesRef.current) {
        persist({
          tableWidths: latest,
        });
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** テーブルの横幅を自動 (Fit) に戻す */
  const resetTableWidth = (name: string) => {
    if (tableWidths[name] === undefined) return;
    const next = { ...tableWidths };
    delete next[name];
    setTableWidths(next);
    if (entriesRef.current) {
      persist({
        tableWidths: next,
      });
    }
  };

  /** 線とテーブルをまとめて削除する (一括選択のDelete用)。
   * 手動追加の線は一覧から外し、自動検出の線・テーブルは「削除済み」として
   * 記憶する (再リバースしても復活しない) */
  const deleteSelection = (edgeIdxs: number[], tableNames: string[]) => {
    const objs = edgeIdxs.map((i) => edges[i]).filter(Boolean);
    if (objs.length === 0 && tableNames.length === 0) return;
    // 線の削除
    const removed = new Set(removedEdges);
    let custom = customEdges;
    const nextAnchors = { ...anchors };
    const nextEdgeCols = { ...edgeCols };
    const nextEdgeStyles = { ...edgeStyles };
    for (const e of objs) {
      if (e.manual) {
        custom = custom.filter(
          (c) =>
            !(
              c.from === e.from &&
              c.to === e.to &&
              c.fromColumn === e.fromColumn &&
              c.toColumn === e.toColumn
            )
        );
      } else {
        removed.add(edgeKey(e));
      }
      // 付随する接続位置・対応カラム・線種の設定も一緒に削除する
      const key = edgeKey(e);
      delete nextAnchors[key];
      delete nextEdgeCols[key];
      delete nextEdgeStyles[key];
    }
    // テーブルの削除
    const nameSet = new Set(tableNames);
    const ents = (entriesRef.current ?? []).filter(
      (e) => !nameSet.has(e.table.name)
    );
    const removedT = new Set(removedTables);
    for (const n of tableNames) {
      removedT.add(n);
      posRef.current.delete(n);
    }
    setRemovedEdges(removed);
    setCustomEdges(custom);
    setAnchors(nextAnchors);
    setEdgeCols(nextEdgeCols);
    setEdgeStyles(nextEdgeStyles);
    if (tableNames.length > 0) {
      setRemovedTables(removedT);
      setEntries(ents);
    }
    setSelEdge(null);
    setSelEdges(new Set());
    setSelNodes(new Set());
    setRev((r) => r + 1);
    const parts: string[] = [];
    if (tableNames.length === 1) parts.push(`${tableNames[0]}`);
    else if (tableNames.length > 1) parts.push(`${tableNames.length}テーブル`);
    if (objs.length === 1 && tableNames.length === 0) {
      parts.push(`${objs[0].from} → ${objs[0].to} の線`);
    } else if (objs.length > 0) {
      parts.push(`${objs.length}本の線`);
    }
    setNotice(`${parts.join("と")}を削除しました`);
    persist({
      entries: ents,
      removedEdges: removed,
      customEdges: custom,
      anchors: nextAnchors,
      edgeColumns: nextEdgeCols,
      edgeStyles: nextEdgeStyles,
      removedTables: removedT,
    });
  };
  const deleteEdgesByIdx = (idxs: number[]) => deleteSelection(idxs, []);
  /** 線の削除を確認してから実行する */
  const askDeleteEdges = (idxs: number[]) => {
    const objs = idxs.map((i) => edges[i]).filter(Boolean);
    if (objs.length === 0) return;
    setConfirm({
      title: "線を削除",
      message:
        objs.length === 1
          ? `${objs[0].from} → ${objs[0].to} の線を削除しますか？`
          : `選択中の${objs.length}本の線を削除しますか？`,
      action: () => deleteEdgesByIdx(idxs),
    });
  };

  /** テーブルの削除を確認してから実行する */
  const askDeleteTables = (names: string[]) => {
    if (names.length === 0) return;
    setConfirm({
      title: "テーブルを図から削除",
      message:
        (names.length === 1
          ? `${names[0]} を図から削除しますか？`
          : `選択中の${names.length}テーブルを図から削除しますか？`) +
        " (戻したい場合はリバース時に「削除したテーブルも復活させる」を選べます)",
      sub: "DBからは削除されません",
      action: () => removeTables(names),
    });
  };

  const deleteSelectedRef = useRef(() => {});
  deleteSelectedRef.current = () => {
    const edgeIdxs =
      selEdges.size > 0 ? [...selEdges] : selEdge !== null ? [selEdge] : [];
    const tableNames = [...selNodes];
    if (edgeIdxs.length === 0 && tableNames.length === 0) return;
    // 線とテーブルの両方が選択されていればまとめて削除する
    if (edgeIdxs.length > 0 && tableNames.length > 0) {
      setConfirm({
        title: "選択中の要素を削除",
        message: `${tableNames.length}テーブルと${edgeIdxs.length}本の線を削除しますか？ (テーブルはリバース時に「削除したテーブルも復活させる」で戻せます)`,
        sub: "DBからは削除されません",
        action: () => deleteSelection(edgeIdxs, tableNames),
      });
    } else if (edgeIdxs.length > 0) {
      askDeleteEdges(edgeIdxs);
    } else {
      askDeleteTables(tableNames);
    }
  };

  /** テーブルコピー用の内部クリップボード (タブ間の貼り付けに使う) */
  const tableClipRef = useRef<{
    entries: SchemaEntry[];
    positions: Record<string, { x: number; y: number }>;
    widths: Record<string, number>;
    fks: FkInfo[];
  } | null>(null);

  /** ⌘/Ctrl+C: 選択中のテーブルをコピー (無ければカラム行の内容をコピー) */
  const copySelectedRef = useRef(() => {});
  copySelectedRef.current = () => {
    // テーブル選択中はテーブルをコピー (⌘Vで別タブへ貼り付けられる)
    if (selNodes.size > 0 && entriesRef.current) {
      const ents = entriesRef.current.filter((e) =>
        selNodes.has(e.table.name)
      );
      const positions: Record<string, { x: number; y: number }> = {};
      const widths: Record<string, number> = {};
      for (const n of selNodes) {
        positions[n] = posOf(n);
        if (tableWidths[n] !== undefined) widths[n] = tableWidths[n];
      }
      tableClipRef.current = {
        entries: ents,
        positions,
        widths,
        fks: fksRef.current.filter(
          (f) => selNodes.has(f.table) && selNodes.has(f.refTable)
        ),
      };
      setNotice(
        `${ents.length}テーブルをコピーしました (⌘/Ctrl+Vで貼り付け)`
      );
      return;
    }
    if (!selCol || !entriesRef.current) return;
    const ent = entriesRef.current.find((x) => x.table.name === selCol.table);
    const col = ent?.detail.columns.find((c) => c.name === selCol.column);
    if (!col) return;
    const logical = parseComment(col.comment ?? "", delim)[0];
    const parts = [col.name];
    if (col.colType) parts.push(col.colType);
    if (logical) parts.push(logical);
    navigator.clipboard.writeText(parts.join("\t")).then(
      () => setNotice(`コピーしました: ${parts.join(" ")}`),
      () => {}
    );
  };

  /** ⌘/Ctrl+V: コピーしたテーブルを現在のタブへ貼り付ける */
  const pasteRef = useRef(() => {});
  pasteRef.current = () => {
    const clip = tableClipRef.current;
    if (!clip) return;
    const cur = entriesRef.current ?? [];
    const existing = new Set(cur.map((e) => e.table.name));
    const add = clip.entries.filter((e) => !existing.has(e.table.name));
    if (add.length === 0) {
      setNotice("コピーしたテーブルは全てこのタブに存在します");
      return;
    }
    const ents = [...cur, ...add];
    // 位置は元の座標から少しずらして貼り付ける
    for (const e of add) {
      const p = clip.positions[e.table.name] ?? { x: 40, y: 40 };
      posRef.current.set(e.table.name, { x: p.x + 24, y: p.y + 24 });
    }
    // 幅の上書きも引き継ぐ
    let widths = tableWidths;
    const wPicked: Record<string, number> = {};
    for (const e of add) {
      const w = clip.widths[e.table.name];
      if (w !== undefined) wPicked[e.table.name] = w;
    }
    if (Object.keys(wPicked).length > 0) {
      widths = { ...tableWidths, ...wPicked };
      setTableWidths(widths);
    }
    // コピー元のFKもマージする (重複は除外)
    const fkKeyOf = (f: FkInfo) =>
      `${f.table}.${f.column}->${f.refTable}.${f.refColumn}`;
    const have = new Set(fksRef.current.map(fkKeyOf));
    const fkList = [
      ...fksRef.current,
      ...clip.fks.filter((f) => !have.has(fkKeyOf(f))),
    ];
    setFks(fkList);
    setEntries(ents);
    // 削除済みテーブルとして記憶されていたら解除する
    let removed = removedTables;
    if (add.some((e) => removed.has(e.table.name))) {
      removed = new Set(removed);
      for (const e of add) removed.delete(e.table.name);
      setRemovedTables(removed);
    }
    setSelNodes(new Set(add.map((e) => e.table.name)));
    setSelEdge(null);
    setSelEdges(new Set());
    setRev((r) => r + 1);
    setNotice(`${add.length}テーブルを貼り付けました`);
    persist({
      entries: ents,
      fks: fkList,
      removedTables: removed,
      tableWidths: widths,
    });
  };

  // Delete/Backspaceで選択中の線を削除、Escで選択・追加モードを解除
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Delete" || e.key === "Backspace") {
        deleteSelectedRef.current();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        copySelectedRef.current();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
        pasteRef.current();
      } else if (e.key === "Escape") {
        clearSelection();
        setLinkMode(false);
        setLinkSrc(null);
        setCtxMenu(null);
        setEdgePanel(null);
        setConfirm(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearSelection]);

  /** 表示オプションを切り替えて自動保存する */
  const toggleOpt = (k: "allCols" | "showLogical" | "showTypes") => {
    const cur = { allCols, showLogical, showTypes };
    const next = { ...cur, [k]: !cur[k] };
    setAllCols(next.allCols);
    setShowLogical(next.showLogical);
    setShowTypes(next.showTypes);
    if (entriesRef.current) {
      persist({ options: next });
    }
  };

  // 右クリックメニューは画面のどこかをクリックしたら閉じる
  // (メニュー内のクリックは除く。stopPropagation対策でキャプチャ段階で検知)
  useDismiss(!!ctxMenu, () => setCtxMenu(null), {
    capture: true,
    inside: ".context-menu",
  });

  // 線の編集パネルは外側をクリックしたら閉じる
  useDismiss(!!edgePanel, () => setEdgePanel(null), {
    capture: true,
    inside: ".er-edge-panel",
  });

  /** 線の編集パネルを開く (画面外にはみ出さない位置に調整) */
  const openEdgePanel = (edgeIdx: number, cx: number, cy: number) => {
    setSelEdge(edgeIdx);
    setSelEdges(new Set([edgeIdx]));
    setEdgePanel({
      edge: edgeIdx,
      x: Math.max(8, Math.min(cx, window.innerWidth - 428)),
      y: Math.max(8, Math.min(cy, window.innerHeight - 380)),
    });
  };

  /** カラムをクリックしたときの処理。
   * 通常時は行を選択 (再クリックで解除)、線の追加モード中は接続先の指定 */
  const handleColumnClick = (table: string, column: string) => {
    if (!linkMode) {
      setSelNodes(new Set());
      setSelCol((cur) =>
        cur && cur.table === table && cur.column === column
          ? null
          : { table, column }
      );
      return;
    }
    if (!linkSrc) {
      setLinkSrc({ table, column });
      setNotice(`接続元: ${table}.${column} — 接続先のカラムをクリック`);
      return;
    }
    if (linkSrc.table === table) {
      setNotice("別のテーブルのカラムを選択してください");
      return;
    }
    const c: ErCustomEdge = {
      from: linkSrc.table,
      fromColumn: linkSrc.column,
      to: table,
      toColumn: column,
    };
    const custom = [...customEdges, c];
    setCustomEdges(custom);
    setLinkMode(false);
    setLinkSrc(null);
    setNotice(`${c.from}.${c.fromColumn} → ${c.to}.${c.toColumn} を追加しました`);
    if (entriesRef.current) {
      persist({
        customEdges: custom,
      });
    }
  };

  /** 枠の一覧を更新して自動保存する */
  const updateFrames = (next: ErFrame[]) => {
    setFrames(next);
    if (entriesRef.current) {
      persist({
        frames: next,
      });
    }
  };

  /** 枠/テキストのインライン編集を開始する */
  const startEditing = (f: ErFrame) => {
    setEditingId(f.id);
    setEditText(f.label);
  };

  /** インライン編集を確定する */
  const commitEdit = () => {
    if (editingId === null) return;
    updateFrames(
      frames.map((x) => (x.id === editingId ? { ...x, label: editText } : x))
    );
    setEditingId(null);
  };
  const commitEditRef = useRef(() => {});
  commitEditRef.current = commitEdit;

  // 編集中に入力欄の外をクリックしたら編集を確定して終了する。
  // (キャンバス側はmousedownでpreventDefaultするためblurが飛ばないケースがある)
  useDismiss(editingId !== null, () => commitEditRef.current(), {
    capture: true,
    inside: ".er-text-edit, .er-inline-input",
  });

  /** 枠を追加してテキスト編集ダイアログを開く */
  const addFrame = (worldX: number, worldY: number) => {
    const f: ErFrame = {
      id: `f${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      kind: "box",
      label: "グループ",
      style: "dashed",
      x: worldX,
      y: worldY,
      w: 340,
      h: 240,
    };
    updateFrames([...frames, f]);
    startEditing(f);
  };

  /** テキスト見出しを追加してテキスト編集ダイアログを開く */
  const addText = (worldX: number, worldY: number) => {
    const f: ErFrame = {
      id: `t${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      kind: "text",
      label: "テキスト",
      style: "none",
      fontSize: 18,
      x: worldX,
      y: worldY,
      w: 200,
      h: 40,
    };
    updateFrames([...frames, f]);
    startEditing(f);
  };

  /** 枠のドラッグ移動 (ラベル部分をつかむ) */
  const startFrameDrag = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const f = frames.find((x) => x.id === id);
    if (!f) return;
    const start = { x: e.clientX, y: e.clientY };
    const orig = { x: f.x, y: f.y };
    let latest = frames;
    const move = (ev: MouseEvent) => {
      latest = frames.map((x) =>
        x.id === id
          ? {
              ...x,
              x: orig.x + (ev.clientX - start.x) / viewRef.current.scale,
              y: orig.y + (ev.clientY - start.y) / viewRef.current.scale,
            }
          : x
      );
      setFrames(latest);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      if (entriesRef.current) {
        persist({
          frames: latest,
        });
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** 枠のリサイズ (右下ハンドル) */
  const startFrameResize = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    const f = frames.find((x) => x.id === id);
    if (!f) return;
    const start = { x: e.clientX, y: e.clientY };
    const orig = { w: f.w, h: f.h };
    let latest = frames;
    const move = (ev: MouseEvent) => {
      latest = frames.map((x) =>
        x.id === id
          ? {
              ...x,
              w: Math.max(
                120,
                orig.w + (ev.clientX - start.x) / viewRef.current.scale
              ),
              h: Math.max(
                80,
                orig.h + (ev.clientY - start.y) / viewRef.current.scale
              ),
            }
          : x
      );
      setFrames(latest);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      if (entriesRef.current) {
        persist({
          frames: latest,
        });
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** 線の端点ドラッグ: テーブル境界上を自由に動かして接続位置を変える。
   * カーソルに最も近い辺へ吸着し、左右の辺ではカラム行にも吸着する */
  const startAnchorDrag = (
    e: React.MouseEvent,
    edgeIdx: number,
    which: "from" | "to"
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const edge = edges[edgeIdx];
    const el = canvasRef.current;
    if (!edge || !el) return;
    const table = which === "from" ? edge.from : edge.to;
    const node = nodeByName.get(table);
    if (!node) return;
    const key = edgeKey(edge);
    let latest = anchors;
    const move = (ev: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const wx = (ev.clientX - rect.left - viewRef.current.x) / viewRef.current.scale;
      const wy = (ev.clientY - rect.top - viewRef.current.y) / viewRef.current.scale;
      const a = nearestBorderAnchor(node, posOf(table), wx, wy);
      latest = { ...anchors, [key]: { ...anchors[key], [which]: a } };
      setAnchors(latest);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      if (entriesRef.current) {
        persist({
          anchors: latest,
        });
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** 線の見た目 (線種・色) を変更する。既定値 (破線・既定色) に戻ったら設定を消す */
  const setEdgeStyle = (edgeIdx: number, patch: Partial<ErEdgeStyle>) => {
    const edge = edges[edgeIdx];
    if (!edge) return;
    const key = edgeKey(edge);
    const entry: ErEdgeStyle = { ...edgeStyles[key], ...patch };
    if (entry.style === "dashed") delete entry.style;
    if (!entry.color) delete entry.color;
    const next = { ...edgeStyles };
    if (!entry.style && !entry.color) delete next[key];
    else next[key] = entry;
    setEdgeStyles(next);
    if (entriesRef.current) {
      persist({
        edgeStyles: next,
      });
    }
  };

  /** 選択中の線の対応カラムを追加/解除する (複合キーなど複数カラムの対応用)。
   * 対応カラムは線を選択したときにハイライトされる */
  const toggleEdgeColumn = (
    edgeIdx: number,
    side: "from" | "to",
    column: string
  ) => {
    const edge = edges[edgeIdx];
    if (!edge) return;
    const key = edgeKey(edge);
    const cur = edgeCols[key] ?? { from: [], to: [] };
    const list = cur[side];
    const entry = {
      ...cur,
      [side]: list.includes(column)
        ? list.filter((c) => c !== column)
        : [...list, column],
    };
    const next = { ...edgeCols };
    if (entry.from.length === 0 && entry.to.length === 0) delete next[key];
    else next[key] = entry;
    setEdgeCols(next);
    if (entriesRef.current) {
      persist({
        edgeColumns: next,
      });
    }
  };

  /**
   * 右クリックしたカラムを「選択中の線の対応カラム」に足せるか調べる。
   * 線を選んでいない・その線と関係ないテーブル・代表カラム自身なら null
   */
  const edgeColumnAction = (table: string, column: string) => {
    if (selEdge === null) return null;
    const se = edges[selEdge];
    if (!se) return null;
    const side =
      se.from === table
        ? ("from" as const)
        : se.to === table
          ? ("to" as const)
          : null;
    if (!side) return null;
    const primary = side === "from" ? se.fromColumn : se.toColumn;
    if (column === primary) return null;
    const idx = selEdge;
    return {
      has: (edgeCols[edgeKey(se)]?.[side] ?? []).includes(column),
      onToggle: () => {
        toggleEdgeColumn(idx, side, column);
        setCtxMenu(null);
      },
    };
  };

  /** 線の接続位置指定を解除して自動 (カラム横) に戻す */
  const resetAnchors = (edgeIdx: number) => {
    const edge = edges[edgeIdx];
    if (!edge) return;
    const key = edgeKey(edge);
    if (!anchors[key]) return;
    const next = { ...anchors };
    delete next[key];
    setAnchors(next);
    if (entriesRef.current) {
      persist({
        anchors: next,
      });
    }
  };

  /** Shift+背景ドラッグで矩形選択 (テーブル・線の複数選択) */
  const startBand = (e: React.MouseEvent) => {
    if (!canvasRef.current) return;
    const p0 = toWorld(e.clientX, e.clientY);
    setBand({ x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y });
    const move = (ev: MouseEvent) => {
      const p = toWorld(ev.clientX, ev.clientY);
      setBand({ x0: p0.x, y0: p0.y, x1: p.x, y1: p.y });
    };
    const up = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", move);
      const p = toWorld(ev.clientX, ev.clientY);
      const minX = Math.min(p0.x, p.x);
      const maxX = Math.max(p0.x, p.x);
      const minY = Math.min(p0.y, p.y);
      const maxY = Math.max(p0.y, p.y);
      // 矩形にかかったテーブルを選択
      const selN = new Set<string>();
      for (const n of nodes) {
        const q = posOf(n.name);
        if (
          q.x < maxX &&
          q.x + n.w > minX &&
          q.y < maxY &&
          q.y + n.h > minY
        ) {
          selN.add(n.name);
        }
      }
      // 矩形にかかった線を選択 (一部でも重なればOK。線分は全て直交なので
      // 各線分のバウンディングボックスと矩形の重なりで判定できる)
      const selE = new Set<number>();
      edgeGeoms.forEach((pts, i) => {
        if (!pts) return;
        for (let k = 1; k < pts.length; k++) {
          const sx0 = Math.min(pts[k - 1][0], pts[k][0]);
          const sx1 = Math.max(pts[k - 1][0], pts[k][0]);
          const sy0 = Math.min(pts[k - 1][1], pts[k][1]);
          const sy1 = Math.max(pts[k - 1][1], pts[k][1]);
          if (sx0 <= maxX && sx1 >= minX && sy0 <= maxY && sy1 >= minY) {
            selE.add(i);
            break;
          }
        }
      });
      setSelNodes(selN);
      setSelEdges(selE);
      setSelEdge(null);
      setBand(null);
      if (selN.size + selE.size > 0) {
        setNotice(
          `${selN.size}テーブル / ${selE.size}本の線を選択しました (Deleteで削除)`
        );
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, { once: true });
  };

  /** 背景を押したとき (左ドラッグ=範囲選択、Shift・中ボタン=図の移動) */
  const handleBackgroundMouseDown = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.button === 2) return;
    // 背景クリックでリレーション・テーブル・カラム行の選択を解除する
    clearSelection();
    e.preventDefault();
    if (e.button === 0 && !e.shiftKey) {
      startBand(e);
      return;
    }
    startPan(e);
  };

  /** コンテンツ全体のバウンディングボックス */
  const bounds = useMemo(() => {
    let maxX = 400;
    let maxY = 300;
    for (const n of nodes) {
      const p = posOf(n.name);
      maxX = Math.max(maxX, p.x + n.w);
      maxY = Math.max(maxY, p.y + n.h);
    }
    for (const f of frames) {
      maxX = Math.max(maxX, f.x + f.w);
      maxY = Math.max(maxY, f.y + f.h);
    }
    return { w: maxX + 60, h: maxY + 60 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, rev, frames]);

  const nodeByName = useMemo(
    () => new Map(nodes.map((n) => [n.name, n])),
    [nodes]
  );

  /** 各エッジの折れ線経路 (画面描画・PNG出力・交差判定で共用)。
   * 迂回経路の探索が重いので、配置(rev)・線・接続位置が変わったときだけ計算する。
   * (位置はrefで持っているため、revを目印にする) */
  const edgeGeoms: ([number, number][] | null)[] = useMemo(
    () =>
      edges.map((e) => {
        const a = nodeByName.get(e.from);
        const b = nodeByName.get(e.to);
        if (!a || !b) return null;
        const pa = posOf(e.from);
        const pb = posOf(e.to);
        // 両端のテーブル矩形 (線がこの後ろに隠れないように迂回する)
        const rects: Rect[] = [
          { x: pa.x, y: pa.y, w: a.w, h: a.h },
          { x: pb.x, y: pb.y, w: b.w, h: b.h },
        ];
        const ov = anchors[edgeKey(e)];
        let fromPt: AnchoredPt;
        let toPt: AnchoredPt;
        if (ov?.from || ov?.to) {
          // 接続位置が手動指定されている線: 指定の辺から出す
          const toPre = ov.to ? anchorPointPos(b, pb, ov.to) : null;
          fromPt = ov.from
            ? anchorPointPos(a, pa, ov.from)
            : colSideAnchor(a, pa, e.fromColumn, toPre?.x ?? pb.x + b.w / 2);
          toPt = toPre ?? colSideAnchor(b, pb, e.toColumn, fromPt.x);
        } else {
          // 既定 (カラム横)。従来の経路がテーブルに隠れなければそのまま使う
          const ay = anchorY(a, pa.y, e.fromColumn);
          const by = anchorY(b, pb.y, e.toColumn);
          const pts = edgePoints(
            { x: pa.x, w: a.w },
            ay,
            { x: pb.x, w: b.w },
            by
          );
          if (pathClear(pts, rects)) return pts;
          fromPt = colSideAnchor(a, pa, e.fromColumn, pb.x + b.w / 2);
          toPt = colSideAnchor(b, pb, e.toColumn, pa.x + a.w / 2);
        }
        // 単純経路がテーブルにかからなければ採用、かかるなら迂回経路を探す
        const simple = routeAnchored(fromPt, toPt);
        if (pathClear(simple, rects)) return simple;
        return routeAvoid(fromPt, toPt, rects) ?? simple;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edges, nodeByName, anchors, rev]
  );
  /** 全エッジの垂直区間 (エッジごと)。自分以外との交差判定に使う */
  const allVerticals = useMemo(
    () => edgeGeoms.map((p) => (p ? verticalSegments(p) : [])),
    [edgeGeoms]
  );
  const verticalsExcept = (i: number) =>
    allVerticals.flatMap((segs, j) => (j === i ? [] : segs));

  /** ドラッグで接続中のプレビュー線 (接続元のカラムからカーソルまで) */
  const linkPreview = (() => {
    if (!linkDrag) return null;
    const n = nodeByName.get(linkDrag.from.table);
    if (!n) return null;
    const src = colSideAnchor(
      n,
      posOf(linkDrag.from.table),
      linkDrag.from.column,
      linkDrag.x
    );
    return { x1: src.x, y1: src.y, x2: linkDrag.x, y2: linkDrag.y };
  })();

  /** PNG出力 (現在の配置をcanvasに描き直して保存) */
  const exportPng = async () => {
    if (nodes.length === 0) return;
    try {
      setNotice("PNG生成中...");
      const base64 = drawErPng({
        database: sel.database,
        nodes,
        bounds,
        frames,
        edges,
        edgeGeoms,
        edgeStyles,
        posOf,
        verticalsExcept,
        // 表示中のテーマのまま出力する
        light: document.documentElement.dataset.theme === "light",
      });
      const d = new Date();
      const p2 = (v: number) => String(v).padStart(2, "0");
      const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      const path = await saveCapture(`quelio_er_${sel.database}_${ts}.png`, base64);
      setNotice(`保存しました → ${path}`);
    } catch (e) {
      setNotice(`PNG保存に失敗: ${e}`);
    }
  };

  /**
   * テキスト形式で書き出す (コピー / 保存)。
   *
   * 図の見た目 (型や日本語名を隠す指定) に関わらず、テキストには全部入れる。
   * 幅の制約が無く、Mermaidは型が無いと書けないため。
   * 「主キーだけ表示」の指定はそのまま反映する (絞って見せている図なので)
   */
  const exportText = async (
    format: "mermaid" | "plantuml",
    save: boolean
  ) => {
    if (!entries || nodes.length === 0) return;
    try {
      const full = buildNodes(entries, allCols, true, true, delim);
      const input = { database: sel.database, nodes: full, edges };
      const text =
        format === "mermaid" ? toMermaid(input) : toPlantUml(input);
      if (!save) {
        await writeClipboard(text);
        setNotice(
          `${format === "mermaid" ? "Mermaid" : "PlantUML"} をコピーしました`
        );
        return;
      }
      const d = new Date();
      const p2 = (v: number) => String(v).padStart(2, "0");
      const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      const ext = format === "mermaid" ? "mmd" : "puml";
      const path = await saveTextFile(
        `quelio_er_${sel.database}_${ts}.${ext}`,
        text
      );
      setNotice(`保存しました → ${path}`);
    } catch (e) {
      setNotice(`書き出しに失敗: ${e}`);
    }
  };

  /** 注釈 (枠・見出し) への操作をまとめて渡す */
  const frameHandlers: FrameHandlers = {
    editingId,
    editText,
    onEditText: setEditText,
    onCommitEdit: commitEdit,
    onCancelEdit: () => setEditingId(null),
    onStartDrag: (e, id) => startFrameDrag(e, id),
    onStartResize: (e, id) => startFrameResize(e, id),
    onStartEditing: startEditing,
    onContextMenu: (e, id) => {
      e.preventDefault();
      e.stopPropagation();
      setCtxMenu({ x: e.clientX, y: e.clientY, kind: "frame", frameId: id });
    },
  };


  const backBoxes = frames.filter((f) => f.kind !== "text" && !f.front);
  const frontBoxes = frames.filter((f) => f.kind !== "text" && f.front);
  const texts = frames.filter((f) => f.kind === "text");

  return (
    <div className="er-window">
      <ErToolbar
        diagName={diagName}
        diagList={diagList}
        onOpenDiagram={openDiagram}
        onNewDiagram={() => {
          store.clearDiagram();
          setNotice("新しい図です。「リバース」でDBから読み込んでください");
        }}
        onSaveAs={() =>
          setNameDialog({
            mode: "saveAs",
            value: diagName ?? `${session?.name ?? "ER図"}/${sel.database}`,
          })
        }
        onRename={() =>
          diagName && setNameDialog({ mode: "rename", value: diagName })
        }
        onDelete={deleteCurrentDiagram}
        canSaveAs={!!entries}
        sessions={sessions}
        sessionId={sel.sessionId}
        database={sel.database}
        session={session}
        onChangeSession={(v) => {
          const s = sessions.find((x) => x.sessionId === v);
          setSel({
            sessionId: v,
            database: s?.currentDb ?? s?.databases[0] ?? "",
          });
        }}
        onChangeDatabase={(v) => setSel({ ...sel, database: v })}
        loading={loading}
        onReverse={() => doReverse()}
        options={{ allCols, showLogical, showTypes }}
        onToggleOption={toggleOpt}
        onExportPng={exportPng}
        onExportText={(f, save) => void exportText(f, save)}
        canExportPng={nodes.length > 0}
        meta={
          entries
            ? `${nodes.length}テーブル / ${edges.length}リレーション`
            : ""
        }
      />


      {/* ページ (タブ) バー: 1つの保存ファイルに複数のER図を持てる */}
      <ErPageTabs
        pages={pages}
        activeId={pageId}
        onSwitch={store.switchPage}
        onAdd={store.addPage}
        onDelete={askDeletePage}
        onReorder={store.reorderPages}
        onRename={store.renamePage}
        onReorderEnd={store.saveAfterReorder}
      />

      {/* 右上の通知トースト (5秒で自動的に消える) */}
      {notice && (
        <div className="er-toast" key={notice}>
          <span className="er-toast-icon">✓</span>
          {notice}
        </div>
      )}

      {error && (
        <div
          className={`result-banner ${isCancelled(error) ? "ok" : "ng"} er-error`}
        >
          {error}
        </div>
      )}
      {loading && (
        <LoadingWithCancel
          label="スキーマを読み込み中..."
          sessionIds={[sel.sessionId]}
          dbTypes={[sessions.find((s) => s.sessionId === sel.sessionId)?.dbType]}
        />
      )}
      {!loading && !error && !entries && (
        <div className="content-placeholder dim-center">
          {sel.sessionId
            ? "図は空です。「リバース」でDBから作成するか、図メニューから保存済みの図を開いてください"
            : "接続とデータベースを選択してください"}
        </div>
      )}

      {!loading && entries && (
        <div
          className={"er-canvas" + (linkMode ? " link-mode" : "")}
          ref={canvasRef}
          onMouseDownCapture={() => {
            // 検索窓にフォーカスが残っているとDeleteキー等が検索欄に
            // 取られるため、キャンバス操作を始めたらフォーカスを外す
            const ae = document.activeElement as HTMLElement | null;
            if (ae && ae.closest(".find-bar")) ae.blur();
          }}
          onMouseDown={handleBackgroundMouseDown}
          onContextMenu={(e) => {
            // 背景の右クリック → 枠の追加メニュー
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            const w = toWorld(e.clientX, e.clientY);
            setCtxMenu({
              x: e.clientX,
              y: e.clientY,
              kind: "canvas",
              worldX: w.x,
              worldY: w.y,
            });
          }}
        >
          <div
            className="er-content"
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          >
            {/* 注釈枠 (背面) */}
            <ErFrameLayer frames={backBoxes} h={frameHandlers} />
            <ErEdgeLayer
              edges={edges}
              geoms={edgeGeoms}
              styles={edgeStyles}
              selected={selEdge}
              selectedSet={selEdges}
              width={bounds.w}
              height={bounds.h}
              rev={rev}
              verticalsExcept={verticalsExcept}
              preview={linkPreview}
              onSelect={(i) => {
                const next = i === selEdge ? null : i;
                setSelEdge(next);
                setSelEdges(next === null ? new Set() : new Set([next]));
                setSelNodes(new Set());
              }}
              onOpenPanel={openEdgePanel}
              onContextMenu={(i, x, y) => {
                setSelEdge(i);
                setSelEdges(new Set([i]));
                setCtxMenu({ x, y, kind: "edge", edge: i });
              }}
              onAnchorMouseDown={startAnchorDrag}
            />
            {nodes.map((n) => {
              const p = posOf(n.name);
              const sel = selEdge !== null ? edges[selEdge] : null;
              /** 選択中リレーションの接続カラム名 (このノードに関係するもの)。
               * 代表カラムに加えて、手動追加した対応カラムもハイライトする */
              const hlCols = new Set<string>();
              const selCols = sel ? edgeCols[edgeKey(sel)] : undefined;
              if (sel && sel.from === n.name) {
                hlCols.add(sel.fromColumn);
                for (const c of selCols?.from ?? []) hlCols.add(c);
              }
              if (sel && sel.to === n.name) {
                hlCols.add(sel.toColumn);
                for (const c of selCols?.to ?? []) hlCols.add(c);
              }
              // 線の追加モードで選択済みの接続元カラムもハイライト
              if (linkSrc && linkSrc.table === n.name) hlCols.add(linkSrc.column);
              // ドラッグ接続中の接続元・接続先候補もハイライト
              if (linkDrag?.from.table === n.name) {
                hlCols.add(linkDrag.from.column);
              }
              if (linkDrag?.target && linkDrag.target.table === n.name) {
                hlCols.add(linkDrag.target.column);
              }
              return (
                <ErNodeView
                  key={n.name}
                  node={n}
                  x={p.x}
                  y={p.y}
                  related={
                    sel !== null && (sel.from === n.name || sel.to === n.name)
                  }
                  selected={selNodes.has(n.name)}
                  highlighted={hlCols}
                  selectedColumn={
                    selCol && selCol.table === n.name ? selCol.column : null
                  }
                  showTypes={showTypes}
                  showLogical={showLogical}
                  showHandles={hoverNode === n.name && !linkDrag}
                  onNodeMouseDown={handleNodeMouseDown}
                  onHoverChange={handleNodeHover}
                  onHeadContextMenu={handleNodeContextMenu}
                  onColumnClick={handleColumnClickAt}
                  onColumnContextMenu={handleColumnContextMenu}
                  onHandleMouseDown={handleLinkHandleMouseDown}
                  onResizeMouseDown={handleNodeResize}
                />
              );
            })}
            {/* 注釈枠 (前面) とテキスト見出し */}
            <ErFrameLayer frames={frontBoxes} h={frameHandlers} />
            <ErFrameLayer frames={texts} h={frameHandlers} />
            {/* Shift+ドラッグの矩形選択 */}
            {band && (
              <div
                className="er-band"
                style={{
                  left: Math.min(band.x0, band.x1),
                  top: Math.min(band.y0, band.y1),
                  width: Math.abs(band.x1 - band.x0),
                  height: Math.abs(band.y1 - band.y0),
                }}
              />
            )}
          </div>
          <div className="er-legend mono">
            ● = NOT NULL / ○ = NULL可 (色付き● = 主キー) ・
            線の右クリックで削除 / カラムの右クリックで線を追加 /
            線を選択して端点をドラッグで接続位置を変更 ・
            背景ドラッグで範囲選択 / スクロール・Shift+ドラッグでパン /
            ⌘(Ctrl)+スクロール・ピンチでズーム
          </div>
          <div
            className="er-zoom-controls"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button title="拡大" onClick={() => zoomBy(1.25)}>
              ＋
            </button>
            <button
              className="zoom-pct mono"
              title="100%に戻す"
              onClick={() => zoomBy(1 / view.scale)}
            >
              {Math.round(view.scale * 100)}%
            </button>
            <button title="縮小" onClick={() => zoomBy(1 / 1.25)}>
              −
            </button>
            <button
              className="fit"
              title="全体を画面に収める"
              onClick={() => setFitTick((t) => t + 1)}
            >
              Fit
            </button>
          </div>
        </div>
      )}

      {/* 右クリックメニュー (対象ごとに中身を出し分ける) */}
      {ctxMenu && (
        <div
          className="context-menu"
          ref={ctxMenuRef}
          style={ctxMenuStyle}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {ctxMenu.kind === "edge" && edges[ctxMenu.edge] && (
            <EdgeMenu
              style={edgeStyles[edgeKey(edges[ctxMenu.edge])]}
              hasAnchors={!!anchors[edgeKey(edges[ctxMenu.edge])]}
              onOpenPanel={() => {
                openEdgePanel(ctxMenu.edge, ctxMenu.x, ctxMenu.y);
                setCtxMenu(null);
              }}
              onChangeStyle={(patch) => {
                setEdgeStyle(ctxMenu.edge, patch);
                setCtxMenu(null);
              }}
              onResetAnchors={() => {
                resetAnchors(ctxMenu.edge);
                setCtxMenu(null);
              }}
              onDelete={() => {
                askDeleteEdges([ctxMenu.edge]);
                setCtxMenu(null);
              }}
            />
          )}

          {ctxMenu.kind === "node" && (
            <NodeMenu
              table={ctxMenu.table}
              hasWidth={tableWidths[ctxMenu.table] !== undefined}
              selectedCount={
                selNodes.has(ctxMenu.table) ? selNodes.size : 1
              }
              onResetWidth={() => {
                resetTableWidth(ctxMenu.table);
                setCtxMenu(null);
              }}
              onDelete={() => {
                // 複数選んでいるときはまとめて消す
                const targets =
                  selNodes.size > 1 && selNodes.has(ctxMenu.table)
                    ? [...selNodes]
                    : [ctxMenu.table];
                askDeleteTables(targets);
                setCtxMenu(null);
              }}
            />
          )}

          {ctxMenu.kind === "canvas" && (
            <CanvasMenu
              removedCount={removedTables.size}
              onAddFrame={() => {
                addFrame(ctxMenu.worldX, ctxMenu.worldY);
                setCtxMenu(null);
              }}
              onAddText={() => {
                addText(ctxMenu.worldX, ctxMenu.worldY);
                setCtxMenu(null);
              }}
              onRestoreRemoved={() => {
                restoreRemovedTables();
                setCtxMenu(null);
              }}
            />
          )}

          {ctxMenu.kind === "frame" &&
            (() => {
              const f = frames.find((x) => x.id === ctxMenu.frameId);
              if (!f) return null;
              return (
                <FrameMenu
                  frame={f}
                  onPatch={(patch) => {
                    updateFrames(
                      frames.map((x) => (x.id === f.id ? { ...x, ...patch } : x))
                    );
                    setCtxMenu(null);
                  }}
                  onEdit={() => {
                    startEditing(f);
                    setCtxMenu(null);
                  }}
                  onDelete={() => {
                    setCtxMenu(null);
                    setConfirm({
                      title: f.kind === "text" ? "テキストを削除" : "枠を削除",
                      message: `「${f.label}」を削除しますか？`,
                      action: () =>
                        updateFrames(frames.filter((x) => x.id !== f.id)),
                    });
                  }}
                />
              );
            })()}

          {ctxMenu.kind === "column" && (
            <ColumnMenu
              table={ctxMenu.table}
              column={ctxMenu.column}
              edgeColumn={edgeColumnAction(ctxMenu.table, ctxMenu.column)}
              linkSrc={linkSrc}
              onConnectHere={() => {
                handleColumnClick(ctxMenu.table, ctxMenu.column);
                setCtxMenu(null);
              }}
              onStartLink={() => {
                setLinkMode(true);
                setLinkSrc({ table: ctxMenu.table, column: ctxMenu.column });
                setNotice(
                  `接続元: ${ctxMenu.table}.${ctxMenu.column} — 接続先のカラムをクリック (右クリックでも可)`
                );
                setCtxMenu(null);
              }}
              onCancelLink={() => {
                setLinkMode(false);
                setLinkSrc(null);
                setNotice(null);
                setCtxMenu(null);
              }}
            />
          )}
        </div>
      )}


      {/* 線の編集パネル (カラムの対応をチェックで設定) */}
      {edgePanel &&
        (() => {
          const e = edges[edgePanel.edge];
          if (!e) return null;
          const ek = edgeKey(e);
          const ec = edgeCols[ek] ?? { from: [], to: [] };
          const sides = [
            { side: "from" as const, table: e.from, primary: e.fromColumn },
            { side: "to" as const, table: e.to, primary: e.toColumn },
          ];
          return (
            <div
              className="er-edge-panel"
              ref={edgePanelRef}
              style={edgePanelStyle}
              onMouseDown={(ev) => ev.stopPropagation()}
            >
              <div className="er-edge-panel-head">
                <span className="mono">
                  {e.from} → {e.to}
                </span>
                <button
                  className="modal-close"
                  onClick={() => setEdgePanel(null)}
                >
                  ×
                </button>
              </div>
              <div className="er-edge-panel-cap">
                対応するカラムにチェック (線を選択すると光ります。複合キーは両側で複数チェック)
              </div>
              <div className="er-edge-panel-cols">
                {sides.map(({ side, table, primary }) => {
                  const ent = entries?.find((x) => x.table.name === table);
                  return (
                    <div key={side} className="er-edge-panel-list">
                      <div className="er-edge-panel-table mono" title={table}>
                        {table}
                      </div>
                      {ent?.detail.columns.map((c) => {
                        const isPrimary = c.name === primary;
                        const checked =
                          isPrimary || ec[side].includes(c.name);
                        return (
                          <label
                            key={c.name}
                            className={
                              "er-edge-panel-item" +
                              (isPrimary ? " primary" : "")
                            }
                            title={
                              isPrimary
                                ? "線の代表カラム (外せません)"
                                : c.name
                            }
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={isPrimary}
                              onChange={() =>
                                toggleEdgeColumn(edgePanel.edge, side, c.name)
                              }
                            />
                            <span className="mono">{c.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

      <ErDialogs
        confirm={confirm}
        onCloseConfirm={() => setConfirm(null)}
        reverseOpen={reverseDialog}
        onCloseReverse={() => setReverseDialog(false)}
        reverseTarget={`${session?.name ?? ""} / ${sel.database}`}
        removedCount={removedTables.size}
        reviveTables={reviveTables}
        onChangeRevive={setReviveTables}
        onReverse={doReverse}
        nameDialog={nameDialog}
        onChangeName={(value) =>
          setNameDialog((d) => (d ? { ...d, value } : d))
        }
        onCloseName={() => setNameDialog(null)}
        onCommitName={commitNameDialog}
      />
    </div>
  );
}
