import { useEffect, useMemo, useRef, useState } from "react";
import { killProcess, listProcesses } from "../api";
import { useModal } from "../hooks/useModal";
import { usePolling } from "../hooks/usePolling";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  GridColumn,
  GridRow,
  ResizableGrid,
  RowMenuItem,
} from "./ResizableGrid";
import type { ProcessAction, ProcessInfo } from "../types";

/** 一覧を取り直す間隔 */
const REFRESH_MS = 3000;

const COLS: GridColumn[] = [
  { id: "id", label: "ID", width: 80, minWidth: 60, align: "right" },
  { id: "user", label: "ユーザー", width: 120, minWidth: 70 },
  { id: "host", label: "接続元", width: 150, minWidth: 80 },
  { id: "db", label: "データベース", width: 130, minWidth: 80 },
  { id: "state", label: "状態", width: 150, minWidth: 80 },
  { id: "secs", label: "経過", width: 80, minWidth: 60, align: "right" },
  { id: "query", label: "SQL", width: 420, minWidth: 160, wrap: true },
];

/** 秒数を読みやすくする (1時間を超えたら時分) */
function elapsed(sec: number): string {
  if (sec < 60) return `${sec}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分${sec % 60}秒`;
  return `${Math.floor(sec / 3600)}時間${Math.floor((sec % 3600) / 60)}分`;
}

/** 確認ダイアログに出す内容 */
interface Pending {
  target: ProcessInfo;
  action: ProcessAction;
}

interface Props {
  sessionId: string;
  database: string;
  /** 読み取り専用の接続では中止・切断を出さない */
  readOnly: boolean;
  onClose: () => void;
}

/**
 * サーバー側で動いている接続の一覧。
 *
 * 「重いSQLが誰かの手元で走っている」を確かめて、必要なら止めるための画面。
 * 一覧は読むだけで、止めるときは必ず確認を出す
 */
export function ProcessDialog({
  sessionId,
  database,
  readOnly,
  onClose,
}: Props) {
  const [list, setList] = useState<ProcessInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  /** 実行中のSQLを持つものだけ出すか */
  const [onlyActive, setOnlyActive] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const boxRef = useModal(onClose, !pending);

  // 実行結果の表示は数秒で消す (押した操作の確認なので残し続けない)
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  /** 取得中か (前の取得が終わる前に次を投げない) */
  const fetching = useRef(false);

  /**
   * 一覧を取り直す (失敗しても前の内容は消さない)。
   *
   * @param log コンソールに記録するか。自動更新のぶんで履歴を埋めない
   */
  const reload = (log = false) => {
    if (fetching.current) return;
    fetching.current = true;
    listProcesses(sessionId, database, log)
      .then((v) => {
        setList(v);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => {
        fetching.current = false;
      });
  };

  // 開いたときに1回だけ、コンソールにも残す
  useEffect(() => {
    reload(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, database]);

  /*
   * 開いている間は定期的に取り直す (裏に回ったら止まる)。
   * 確認ダイアログを出している間は止める。
   * 動かしたままだと、確認している最中に相手が終わって
   * 同じIDが別の接続に付け替わることがある
   */
  usePolling(() => reload(false), REFRESH_MS, { enabled: !pending });

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (list ?? []).filter((p) => {
      if (onlyActive && !p.query.trim()) return false;
      if (!q) return true;
      return [p.user, p.host, p.database, p.state, p.query, String(p.id)].some(
        (v) => v.toLowerCase().includes(q)
      );
    });
  }, [list, filter, onlyActive]);

  const rows: GridRow[] = useMemo(
    () =>
      shown.map((p) => ({
        key: String(p.id),
        className: p.isSelf ? "meta" : undefined,
        cells: [
          <span className="mono">{p.id}</span>,
          <span>{p.user}</span>,
          <span className="mono dim">{p.host}</span>,
          <span className="mono">{p.database}</span>,
          <span>
            {p.state}
            {p.isSelf && <span className="faint"> (この画面)</span>}
          </span>,
          <span className="mono faint">{elapsed(p.seconds)}</span>,
          <span className="mono">{p.query}</span>,
        ],
      })),
    [shown]
  );

  /** 行の右クリックメニュー (自分自身と読み取り専用では出さない) */
  const rowMenuItems = (key: string): RowMenuItem[] => {
    const target = shown.find((p) => String(p.id) === key);
    if (!target) return [];
    if (target.isSelf) {
      return [
        {
          label: "この画面自身の接続です",
          disabled: true,
          onSelect: () => {},
        },
      ];
    }
    if (readOnly) {
      return [
        {
          label: "読み取り専用の接続では止められません",
          disabled: true,
          title:
            "接続先の設定で「読み取り専用」を外して接続し直すと操作できます",
          onSelect: () => {},
        },
      ];
    }
    return [
      {
        label: "実行中のSQLを中止 (接続は残す)",
        disabled: !target.query.trim(),
        title: target.query.trim() ? undefined : "SQLを実行していません",
        onSelect: () => setPending({ target, action: "cancel" }),
      },
      {
        label: "接続を切る",
        danger: true,
        onSelect: () => setPending({ target, action: "terminate" }),
      },
    ];
  };

  const run = async () => {
    if (!pending) return;
    const { target, action } = pending;
    /*
     * 確認している間に相手が終わり、同じIDが別の接続に
     * 付け替わっていることがある。送る直前に見比べる
     */
    const now = await listProcesses(sessionId, database, false);
    const same = now.find(
      (p) =>
        p.id === target.id &&
        p.user === target.user &&
        p.host === target.host &&
        p.query === target.query
    );
    if (!same) {
      // 確認ダイアログは開いたままにして、理由をそこに出す
      setList(now);
      throw new Error(
        "対象の接続が見つかりませんでした (既に終了したか、内容が変わっています)"
      );
    }
    await killProcess(sessionId, database, target.id, action);
    setNotice(
      action === "cancel"
        ? `ID ${target.id} のSQLに中止を送りました`
        : `ID ${target.id} の接続に切断を送りました`
    );
    setPending(null);
    reload(true);
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal process-modal"
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <span className="modal-title">
            実行中の接続
            <span className="column-modal-target mono">{database}</span>
          </span>
          <button className="modal-close" onClick={onClose} title="閉じる (Esc)">
            ×
          </button>
        </div>

        <div className="process-toolbar">
          <input
            className="routine-filter"
            value={filter}
            placeholder="絞り込み (ユーザー / 接続元 / SQL)"
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label className="switch">
            <input
              type="checkbox"
              checked={onlyActive}
              onChange={(e) => setOnlyActive(e.target.checked)}
            />
            <span className="track" aria-hidden />
            <span className="switch-label">実行中のみ</span>
          </label>
          <span className="query-meta mono">{shown.length} 件</span>
          <button className="btn-secondary" onClick={() => reload(true)}>
            更新
          </button>
        </div>

        {error && (
          <div className="result-banner ng">
            <span className="dot" aria-hidden />
            <span className="result-detail">{error}</span>
          </div>
        )}
        {notice && <div className="process-notice">{notice}</div>}

        <div className="process-body">
          {list === null && !error ? (
            <div className="routine-empty">
              <span className="spinner accent" /> 読み込み中...
            </div>
          ) : (
            <ResizableGrid
              columns={COLS}
              rows={rows}
              selectable
              stableRowKeys
              rowMenuItems={rowMenuItems}
              emptyText={
                (list ?? []).length === 0
                  ? "表示できる接続がありません (権限が足りない場合もあります)"
                  : "絞り込みに一致する接続がありません"
              }
            />
          )}
        </div>

        <p className="process-hint">
          行を右クリックすると、そのSQLの中止・接続の切断ができます。
          ほかのユーザーのSQLを見るには、接続先で権限
          (MySQLはPROCESS、PostgreSQLはpg_read_all_stats等) が要ります。
        </p>

        {pending && (
          <ConfirmDialog
            title={
              pending.action === "cancel"
                ? "実行中のSQLを中止します"
                : "接続を切ります"
            }
            target={`ID ${pending.target.id} (${pending.target.user})`}
            confirmLabel={pending.action === "cancel" ? "中止する" : "切断する"}
            onCancel={() => setPending(null)}
            onConfirm={run}
          >
            {pending.action === "cancel"
              ? "実行中のSQLだけを止めます。接続は残るので、相手はそのまま操作を続けられます。"
              : "接続ごと切ります。実行中だったSQLは取り消され、相手は接続が切れたと表示されます。"}
            {pending.target.query.trim() && (
              <span className="process-target mono">
                {pending.target.query}
              </span>
            )}
          </ConfirmDialog>
        )}
      </div>
    </div>
  );
}
