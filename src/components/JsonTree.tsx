/**
 * JSONを折りたたみながら読むためのツリー。
 *
 * 深い入れ子や長い配列は畳んでおき、必要なところだけ開く。
 * 行を選ぶとその位置のパス ($.items[0].name) をコピーでき、
 * そのまま JSON_EXTRACT などに貼れる
 */
import { useMemo, useState } from "react";
import { childPath, indexPath, ROOT_PATH } from "../jsonPath";

/** 一度に描く子の数の上限 (巨大な配列で固まらないように) */
const MAX_CHILDREN = 200;
/** 最初から開いておく深さ */
const OPEN_DEPTH = 2;

interface Props {
  /** 表示する値 (JSON.parse したもの) */
  value: unknown;
  /** 行を選んだときに呼ばれる (パスのコピー用) */
  onPickPath: (path: string) => void;
  /** 今コピーしたパス (印を付ける) */
  pickedPath: string | null;
}

/** 入れ子になっているか (開閉できるか) */
function isBranch(v: unknown): v is object {
  return typeof v === "object" && v !== null;
}

/** 子の [表示名, パス, 値] を並べる */
function childrenOf(v: object, path: string): [string, string, unknown][] {
  if (Array.isArray(v)) {
    return v.map((c, i) => [String(i), indexPath(path, i), c]);
  }
  return Object.entries(v).map(([k, c]) => [k, childPath(path, k), c]);
}

/** 閉じているときに出す要約 */
function summaryOf(v: object): string {
  if (Array.isArray(v)) return `[] ${v.length}件`;
  return `{} ${Object.keys(v).length}項目`;
}

/** 葉の値の見た目 (型ごとに色を変えるためclassも返す) */
function leafOf(v: unknown): { text: string; cls: string } {
  if (v === null) return { text: "null", cls: "null" };
  if (typeof v === "string") return { text: v, cls: "str" };
  if (typeof v === "number") return { text: String(v), cls: "num" };
  if (typeof v === "boolean") return { text: String(v), cls: "bool" };
  return { text: String(v), cls: "" };
}

/** すべてのパスを集める (「すべて開く」用。上限を超える巨大な値では諦める) */
function allPaths(v: unknown, path: string, out: string[]): void {
  if (out.length > 5000 || !isBranch(v)) return;
  out.push(path);
  for (const [, p, c] of childrenOf(v, path)) allPaths(c, p, out);
}

export function JsonTree({ value, onPickPath, pickedPath }: Props) {
  /** 開いているノードのパス */
  const [open, setOpen] = useState<Set<string>>(() => {
    const init = new Set<string>();
    const walk = (v: unknown, path: string, depth: number) => {
      if (depth > OPEN_DEPTH || !isBranch(v)) return;
      init.add(path);
      for (const [, p, c] of childrenOf(v, path)) walk(c, p, depth + 1);
    };
    walk(value, ROOT_PATH, 1);
    return init;
  });

  const everyPath = useMemo(() => {
    const out: string[] = [];
    allPaths(value, ROOT_PATH, out);
    return out;
  }, [value]);

  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /** 1行 (葉ならそのまま、枝なら開閉できる) を描く */
  const row = (
    label: string | null,
    path: string,
    v: unknown,
    depth: number
  ): React.ReactNode => {
    const branch = isBranch(v);
    const opened = branch && open.has(path);
    const leaf = branch ? null : leafOf(v);
    return (
      <div key={path}>
        <div
          className={"json-row" + (pickedPath === path ? " picked" : "")}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => onPickPath(path)}
          title={path}
        >
          <button
            className={"json-caret" + (branch ? "" : " leaf")}
            tabIndex={branch ? 0 : -1}
            onClick={(e) => {
              e.stopPropagation();
              if (branch) toggle(path);
            }}
          >
            {branch ? (opened ? "▾" : "▸") : ""}
          </button>
          {label !== null && <span className="json-key">{label}</span>}
          {branch ? (
            <span className="json-summary">{summaryOf(v)}</span>
          ) : (
            <span className={"json-val " + leaf!.cls}>{leaf!.text}</span>
          )}
        </div>
        {opened && (
          <>
            {childrenOf(v, path)
              .slice(0, MAX_CHILDREN)
              .map(([k, p, c]) => row(k, p, c, depth + 1))}
            {childrenOf(v, path).length > MAX_CHILDREN && (
              <div
                className="json-more"
                style={{ paddingLeft: 20 + (depth + 1) * 14 }}
              >
                他 {childrenOf(v, path).length - MAX_CHILDREN} 件 (省略)
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="json-tree-wrap">
      <div className="json-tree-head">
        <button
          className="btn-secondary"
          onClick={() => setOpen(new Set(everyPath))}
          disabled={everyPath.length > 2000}
          title={
            everyPath.length > 2000
              ? "項目が多すぎるため、まとめて開けません"
              : "すべての入れ子を開きます"
          }
        >
          すべて開く
        </button>
        <button className="btn-secondary" onClick={() => setOpen(new Set())}>
          すべて閉じる
        </button>
        <span className="json-tree-note">
          行をクリックするとパスをコピーします
        </span>
      </div>
      <div className="json-tree mono">{row(null, ROOT_PATH, value, 0)}</div>
    </div>
  );
}
