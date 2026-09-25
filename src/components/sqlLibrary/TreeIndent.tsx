/**
 * ツリーの字下げ (階層の縦線つき)。
 *
 * 階層1つにつき1マス取り、マスの中央に縦線を引く。
 * 線は親フォルダの開閉の印 (▸) の真下に来るので、
 * どのフォルダの中なのかを目でたどれる
 */
export function TreeIndent({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className="tree-guide" aria-hidden />
      ))}
    </>
  );
}
