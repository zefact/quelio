/**
 * キー詳細の値プレビュー整形。
 * JSONとPHPシリアライズ (Laravelのセッション等) に対応する。
 */

/** 整形できれば整形後の文字列、できなければnullを返す */
export function tryFormatValue(raw: string): string | null {
  const t = raw.trim();

  // JSON
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.stringify(deepParseStrings(JSON.parse(t)), null, 2);
    } catch {
      // 整形できないだけなのでフォールバックへ
    }
  }

  // PHPシリアライズ
  const parsed = tryPhpUnserialize(t);
  if (parsed !== undefined) {
    return JSON.stringify(parsed, null, 2);
  }
  return null;
}

/** PHPシリアライズ形式らしければパースする (失敗時はundefined) */
function tryPhpUnserialize(t: string): unknown | undefined {
  if (!/^(N;|[bidsaO]:)/.test(t)) return undefined;
  try {
    const parser = new PhpParser(t);
    const value = parser.parse();
    if (!parser.atEnd()) return undefined;
    return deepParseStrings(value);
  } catch {
    return undefined;
  }
}

/**
 * 値の中にシリアライズ文字列が入れ子になっているケース
 * (例: セッション全体が s:N:"a:4:{...}" ) を再帰的に展開する
 */
function deepParseStrings(v: unknown): unknown {
  if (typeof v === "string") {
    const t = v.trim();
    if (/^(N;|[bidsaO]:)/.test(t)) {
      const inner = tryPhpUnserialize(t);
      if (inner !== undefined) return inner;
    } else if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return deepParseStrings(JSON.parse(t));
      } catch {
        // そのまま文字列として返す
      }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(deepParseStrings);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, val]) => [k, deepParseStrings(val)])
    );
  }
  return v;
}

/**
 * PHPシリアライズのパーサー。
 * 文字列長 (s:N) はUTF-8のバイト数なので、バイト列上で走査する。
 */
class PhpParser {
  private bytes: Uint8Array;
  private pos = 0;
  private decoder = new TextDecoder();

  constructor(input: string) {
    this.bytes = new TextEncoder().encode(input);
  }

  atEnd(): boolean {
    // 末尾の空白は許容する
    for (let i = this.pos; i < this.bytes.length; i++) {
      const b = this.bytes[i];
      if (b !== 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09) return false;
    }
    return true;
  }

  parse(): unknown {
    const type = this.readChar();
    switch (type) {
      case "N":
        this.expect(";");
        return null;
      case "b": {
        this.expect(":");
        const v = this.readChar();
        this.expect(";");
        return v === "1";
      }
      case "i": {
        this.expect(":");
        return parseInt(this.readUntil(";"), 10);
      }
      case "d": {
        this.expect(":");
        return parseFloat(this.readUntil(";"));
      }
      case "s": {
        this.expect(":");
        const len = this.readLength(":");
        this.expect('"');
        const v = this.decoder.decode(
          this.bytes.slice(this.pos, this.pos + len)
        );
        this.pos += len;
        this.expect('"');
        this.expect(";");
        return v;
      }
      case "a": {
        this.expect(":");
        const n = this.readLength(":");
        this.expect("{");
        const entries: [unknown, unknown][] = [];
        for (let i = 0; i < n; i++) {
          const key = this.parse();
          const value = this.parse();
          entries.push([key, value]);
        }
        this.expect("}");
        // キーが0..n-1の連番なら配列、それ以外はオブジェクトとして返す
        const isList = entries.every(([k], i) => k === i);
        if (isList) return entries.map(([, v]) => v);
        const obj: Record<string, unknown> = {};
        for (const [k, v] of entries) obj[String(k)] = v;
        return obj;
      }
      case "O": {
        this.expect(":");
        const nameLen = this.readLength(":");
        this.expect('"');
        const name = this.decoder.decode(
          this.bytes.slice(this.pos, this.pos + nameLen)
        );
        this.pos += nameLen;
        this.expect('"');
        this.expect(":");
        const n = this.readLength(":");
        this.expect("{");
        const obj: Record<string, unknown> = { "(class)": name };
        for (let i = 0; i < n; i++) {
          const key = this.parse();
          const value = this.parse();
          obj[String(key)] = value;
        }
        this.expect("}");
        return obj;
      }
      default:
        throw new Error(`未対応の型: ${type}`);
    }
  }

  private readChar(): string {
    if (this.pos >= this.bytes.length) throw new Error("入力が途切れています");
    return String.fromCharCode(this.bytes[this.pos++]);
  }

  private expect(ch: string): void {
    const c = this.readChar();
    if (c !== ch) throw new Error(`'${ch}'を期待しましたが'${c}'でした`);
  }

  private readUntil(terminator: string): string {
    const t = terminator.charCodeAt(0);
    const start = this.pos;
    while (this.pos < this.bytes.length && this.bytes[this.pos] !== t) {
      this.pos++;
    }
    if (this.pos >= this.bytes.length) throw new Error("入力が途切れています");
    const s = this.decoder.decode(this.bytes.slice(start, this.pos));
    this.pos++; // terminatorを読み飛ばす
    return s;
  }

  private readLength(terminator: string): number {
    const n = parseInt(this.readUntil(terminator), 10);
    if (!Number.isFinite(n) || n < 0) throw new Error("長さが不正です");
    return n;
  }
}
