/**
 * D&Dで受け取ったファイルをアプリの一時フォルダへ預ける処理。
 *
 * ブラウザから見えるFileには実体のパスが無いため、
 * 中身を分割して送り、バックエンド側でファイルに組み立て直している
 */

import { appendTempUpload, createTempUpload } from "./api";

/** 1回の送信でまとめるバイト数 (大きすぎるとbase64化で詰まる) */
const CHUNK = 4 * 1024 * 1024;

/** base64へ直すときに一度に渡す長さ (引数が多すぎるとスタックが溢れる) */
const ENCODE_CHUNK = 0x8000;

/** ArrayBuffer → base64 */
export function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += ENCODE_CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + ENCODE_CHUNK));
  }
  return btoa(s);
}

/**
 * D&DされたFileを一時ファイルへ転送してパスを返す。
 *
 * @param onProgress 送信済みバイト数と全体のバイト数
 */
export async function stageDroppedFile(
  f: File,
  onProgress?: (done: number, total: number) => void
): Promise<string> {
  const path = await createTempUpload(f.name);
  for (let off = 0; off < f.size; off += CHUNK) {
    const buf = await f.slice(off, off + CHUNK).arrayBuffer();
    await appendTempUpload(path, bufToBase64(buf));
    onProgress?.(Math.min(off + CHUNK, f.size), f.size);
  }
  return path;
}
