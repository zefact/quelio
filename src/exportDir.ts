/**
 * 書き出し先フォルダの扱い (どの書き出しもここを通す)。
 *
 * 書き出し先は設定の「書き出し先フォルダ」(downloadDir) の1か所だけ。
 * - ダイアログを出さずに書くもの (データ・SQL結果の CSV / Excel、キャプチャ、
 *   スキーマ一覧、コンソール、ER 図) は Rust 側がこのフォルダへ書く
 * - 保存ダイアログで場所を選ぶもの (CSV エディタの Excel、各種バックアップ、
 *   SQL ダンプのフォルダ選び) は、ダイアログをこのフォルダから開く
 *
 * 決め方が「最後に使ったフォルダ」のときは、ダイアログで別のフォルダを選ぶと
 * それを書き出し先フォルダとして覚える (次の書き出しはどれもそこから始まる)。
 * 「決まったフォルダ」のときは、選んだ場所はその回だけで、設定は変えない
 */
import { save } from "@tauri-apps/plugin-dialog";
import type { DialogFilter } from "@tauri-apps/plugin-dialog";
import { downloadDir, homeDir } from "@tauri-apps/api/path";
import { getAppSettings, saveAppSettings } from "./api";
import { joinPath, splitPath } from "./dumpTarget";
import type { AppSettings } from "./types";

/** 書き出し先フォルダの決め方 */
export type ExportDirMode = "last" | "fixed";

/**
 * 設定から決め方を読む。
 *
 * この項目が無い古い設定では、フォルダを自分で決めてあった人は「決まったフォルダ」
 * (決めた場所が勝手に変わらないように)、決めていない人は「最後に使ったフォルダ」とする
 */
export function exportDirMode(
  s: Pick<AppSettings, "exportDirMode" | "downloadDir">
): ExportDirMode {
  if (s.exportDirMode === "last" || s.exportDirMode === "fixed") return s.exportDirMode;
  return s.downloadDir.trim() ? "fixed" : "last";
}

/** 末尾の区切りを除いたフォルダのパス (同じフォルダかを比べるため) */
function trimDir(dir: string): string {
  const t = dir.trim();
  return t.length > 1 ? t.replace(/[\\/]+$/, "") : t;
}

/** 保存ダイアログに渡す初期のパス (フォルダが分からなければファイル名だけ) */
export function dialogDefaultPath(dir: string, fileName: string): string {
  const d = trimDir(dir);
  return d ? joinPath(d, fileName) : fileName;
}

/**
 * 書き出したファイルのパスから、次に保存する設定を作る。変えなくてよければ null。
 *
 * @param current いまの書き出し先フォルダ (設定が空ならOSのダウンロードフォルダ)
 */
export function settingsAfterExport(
  s: AppSettings,
  current: string,
  filePath: string
): AppSettings | null {
  if (exportDirMode(s) !== "last") return null;
  const dir = trimDir(splitPath(filePath).dir);
  if (!dir || dir === trimDir(current)) return null;
  // 決め方も書いておく (フォルダが入ると、項目が無いときの読み方が「決まったフォルダ」に変わるため)
  return { ...s, downloadDir: dir, exportDirMode: "last" };
}

/** OSのダウンロードフォルダ (取れなければホーム。Rust 側の既定と同じ順) */
async function osDownloadDir(): Promise<string> {
  try {
    return await downloadDir();
  } catch {
    return homeDir().catch(() => "");
  }
}

/** いまの書き出し先フォルダ (設定が空ならOSのダウンロードフォルダ) */
export async function resolveExportDir(s?: AppSettings): Promise<string> {
  const settings = s ?? (await getAppSettings().catch(() => null));
  const dir = settings?.downloadDir.trim();
  return dir || osDownloadDir();
}

/**
 * 書き出したファイルのフォルダを覚える (「最後に使ったフォルダ」のときだけ)。
 * 覚えられなくても書き出し自体は済んでいるので、失敗は黙って流す
 */
export async function rememberExportDir(filePath: string): Promise<void> {
  try {
    const s = await getAppSettings();
    const next = settingsAfterExport(s, await resolveExportDir(s), filePath);
    if (next) await saveAppSettings(next);
  } catch {
    /* 次回の初期位置が変わらないだけ */
  }
}

/** 書き出し用の保存ダイアログの指定 */
export interface ExportPathRequest {
  /** 初めに入れておくファイル名 */
  fileName: string;
  filters?: DialogFilter[];
  title?: string;
  /**
   * 選んだフォルダを覚えるか (既定は覚える)。
   * 自分で編集しているファイルの「保存」は書き出しではないので覚えない
   */
  remember?: boolean;
}

/**
 * 書き出し先を保存ダイアログで選ぶ。やめたら null。
 * ダイアログは書き出し先フォルダから開く
 */
export async function pickExportPath(req: ExportPathRequest): Promise<string | null> {
  const s = await getAppSettings().catch(() => null);
  const dir = await resolveExportDir(s ?? undefined);
  const path = await save({
    defaultPath: dialogDefaultPath(dir, req.fileName),
    filters: req.filters,
    title: req.title,
  }).catch(() => null);
  if (typeof path !== "string" || !path) return null;
  if (req.remember !== false) await rememberExportDir(path);
  return path;
}
