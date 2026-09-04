/**
 * SQL関数の入力補完。
 *
 * テーブル・カラムの補完 (`sqlCompletion`) とは別の口にしてある。
 * あちらは「今どこを書いているか」で候補を絞り込む作りで、
 * 関数はそれとは別の理由で出す/出さないが決まるため。
 *
 * 候補を選ぶと `DATE_FORMAT(日時, 書式)` の形で入り、
 * 引数の所はTabで渡り歩ける。右側には書式・例・結果・注意が出る
 */
import type {
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import { snippetCompletion } from "@codemirror/autocomplete";
import type { DbType } from "../types";
import { flatten, functionsFor, snippetOf } from "../sqlFunctions";
import type { SqlFunc } from "../sqlFunctions";
import { QUALIFIER, TABLE_POS } from "./sqlCompletion";
import type { Cells, SqlOption } from "./sqlCompletion";

/**
 * 関数の候補を出さない場所。
 *
 *  - `別名.` の直後 (そこに来るのはカラム名)
 *  - `FROM` / `JOIN` などの直後 (そこに来るのはテーブル名)
 */
export function skipHere(before: string): boolean {
  return QUALIFIER.test(before) || TABLE_POS.test(before);
}

/** 候補の右に出す説明 (書式・例・結果・注意) */
function infoOf(f: SqlFunc): () => Node {
  return () => {
    const box = document.createElement("div");
    box.className = "fn-info";
    const line = (label: string, text: string, cls = "") => {
      const row = document.createElement("div");
      row.className = `fn-info-row ${cls}`;
      const head = document.createElement("span");
      head.className = "fn-info-label";
      head.textContent = label;
      const body = document.createElement("span");
      body.className = "fn-info-text";
      body.textContent = text;
      row.append(head, body);
      box.append(row);
    };
    line("書式", f.signature, "mono");
    line("例", f.example, "mono");
    line("結果", f.result, "mono result");
    if (f.note) line("注意", f.note, "note");
    if (f.since) line("対応", `${f.since}〜`, "note");
    return box;
  };
}

/** 関数1件を候補にする */
function optionOf(f: SqlFunc, category: string): SqlOption {
  const detail = f.summary;
  const info = infoOf(f);
  const snippet = snippetOf(f);
  /*
   * 表示の列は、テーブル・カラムの候補と同じ並びに合わせる
   * (0=PK 1=テーブル名 2=日本語名 3=型)
   */
  const cells: Cells = ["", "関数", f.summary, category];
  if (snippet === null) {
    // 関数の形をしていないもの (演算子など) は、そのまま入れる
    return { label: f.name, type: "keyword", detail, info, boost: -20, cells };
  }
  return {
    ...snippetCompletion(snippet, {
      label: f.name,
      type: "function",
      detail,
      info,
      boost: -20,
    }),
    cells,
  };
}

/**
 * 関数の候補を出す口を作る。
 *
 * 接続先で中身が変わるので、DBの種類は都度読む
 */
export function sqlFunctionCompletion(getDbType: () => DbType): CompletionSource {
  /** 同じDBで作り直さないよう、作った候補は覚えておく */
  const cache = new Map<DbType, SqlOption[]>();

  const optionsFor = (db: DbType): SqlOption[] => {
    const made = cache.get(db);
    if (made) return made;
    const options = flatten(functionsFor(db)).map((h) =>
      optionOf(h.func, h.category)
    );
    cache.set(db, options);
    return options;
  };

  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[\w$#]*/);
    const from = word ? word.from : context.pos;
    // 何も打っていないときは、自分からは出さない (⌃Space では出す)
    if (!context.explicit && from === context.pos) return null;
    const before = context.state.doc.sliceString(0, from);
    if (skipHere(before)) return null;
    const options = optionsFor(getDbType());
    if (options.length === 0) return null;
    return { from, options, validFor: /^[\w$#]*$/ };
  };
}
