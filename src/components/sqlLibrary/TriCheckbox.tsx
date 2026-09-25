/**
 * 「全部 / 一部 / なし」を出せるチェックボックス。
 *
 * 「一部」(indeterminate) は属性では付けられず、要素に直接入れる必要がある
 */
import { useEffect, useRef } from "react";
import type { CheckState } from "../../savedSelection";

export function TriCheckbox({
  state,
  onChange,
}: {
  state: CheckState;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="pick-check"
      checked={state === "all"}
      onChange={onChange}
    />
  );
}
