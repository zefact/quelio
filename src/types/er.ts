/**
 * ER図の描画データ (ページ・付箋・線の見た目)
 */
import type { FkInfo, SchemaEntry } from "./schema";

/** テーブル境界上の接続位置 (辺 + 辺に沿った割合0〜1)。
 * 割合で持つことでテーブルのサイズが変わっても相対位置を保つ */
export interface ErAnchorPoint {
  side: "top" | "bottom" | "left" | "right";
  t: number;
}

/** 線の見た目 (線種・色)。未設定は破線・既定色 */
export interface ErEdgeStyle {
  style?: "solid" | "dashed" | "dotted";
  /** #rrggbb (未設定は既定のインディゴ) */
  color?: string;
}

/** 手動で追加したER図のリレーション */
export interface ErCustomEdge {
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
}

/** ER図上の注釈要素 (枠 or テキスト見出し) */
export interface ErFrame {
  id: string;
  /** 要素の種類 (box=枠 / text=テキストのみ。未指定はbox) */
  kind?: "box" | "text";
  /** 表示するテキスト */
  label: string;
  /** 枠線の種類 (none=枠線なし) */
  style: "solid" | "dashed" | "dotted" | "none";
  /** 枠線の色 (hex。未指定はグレー) */
  color?: string;
  /** 角丸にするか (未指定はtrue=角丸) */
  rounded?: boolean;
  /** 背景色 (hex。未指定は透明) */
  fill?: string;
  /** テーブルより前面に表示するか (未指定はfalse=背面) */
  front?: boolean;
  /** テキストの文字サイズ (px。kind=text用。未指定は18) */
  fontSize?: number;
  /** テキストの文字色 (hex。kind=text用。未指定はグレー) */
  textColor?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** ER図の1ページ (タブ) 分の内容 */
export interface ErPageData {
  id: string;
  /** タブに表示する名前 */
  name: string;
  entries: SchemaEntry[];
  fks: FkInfo[];
  /** テーブル名 → 位置 (左上座標) */
  positions: Record<string, { x: number; y: number }>;
  /** 表示オプション */
  options?: {
    allCols: boolean;
    showLogical: boolean;
    showTypes: boolean;
  };
  /** 削除した自動検出リレーションのキー (from.col->to.col) */
  removedEdges?: string[];
  /** 図から削除したテーブル名 (リバースしても再追加しない) */
  removedTables?: string[];
  /** テーブルごとの横幅の上書き (px。未設定は内容に合わせて自動) */
  tableWidths?: Record<string, number>;
  /** 手動で追加したリレーション */
  customEdges?: ErCustomEdge[];
  /** 線ごとの接続位置の上書き (キーはfrom.col->to.col形式) */
  anchors?: Record<string, { from?: ErAnchorPoint; to?: ErAnchorPoint }>;
  /** 線に対応するカラムの追加分 (複合キーなど複数カラムの対応に使う)。
   * 線を選択したとき代表カラムに加えてここのカラムもハイライトされる */
  edgeColumns?: Record<string, { from: string[]; to: string[] }>;
  /** 線ごとの見た目 (線種・色。キーはfrom.col->to.col形式) */
  edgeStyles?: Record<string, ErEdgeStyle>;
  /** 注釈枠 */
  frames?: ErFrame[];
}

/** 保存されるER図データ (1ファイル = 複数ページ) */
export interface ErDiagramData {
  savedAtMs: number;
  /** ページ (タブ) 一覧。旧形式のデータには無い */
  pages?: ErPageData[];
  /** 最後に開いていたページのindex */
  activePage?: number;
  // ---- 以下は旧形式 (単一ページ) のフィールド。読み込み時の移行用 ----
  entries?: SchemaEntry[];
  fks?: FkInfo[];
  positions?: Record<string, { x: number; y: number }>;
  options?: {
    allCols: boolean;
    showLogical: boolean;
    showTypes: boolean;
  };
  removedEdges?: string[];
  removedTables?: string[];
  tableWidths?: Record<string, number>;
  customEdges?: ErCustomEdge[];
  anchors?: Record<string, { from?: ErAnchorPoint; to?: ErAnchorPoint }>;
  edgeColumns?: Record<string, { from: string[]; to: string[] }>;
  edgeStyles?: Record<string, ErEdgeStyle>;
  frames?: ErFrame[];
}
