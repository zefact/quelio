/** ER図の右クリックメニューの対象 (どこを右クリックしたか) */
export type ErCtxMenu =
  | { x: number; y: number; kind: "edge"; edge: number }
  | { x: number; y: number; kind: "column"; table: string; column: string }
  | { x: number; y: number; kind: "frame"; frameId: string }
  | { x: number; y: number; kind: "node"; table: string }
  | { x: number; y: number; kind: "canvas"; worldX: number; worldY: number };
