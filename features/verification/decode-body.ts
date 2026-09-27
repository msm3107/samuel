/**
 * Turning a fetched body into text (TASK-024).
 *
 * TASK-023's transport returns bytes and the `Content-Type` it was given; it
 * deliberately does not interpret what it fetched. This decides what those
 * bytes say, in the order a browser does (owner, 2026-09-27):
 *
 * 1. A byte order mark, which outranks everything a page or a header claims.
 * 2. The charset named by `Content-Type`.
 * 3. A `<meta>` declaration in the first 1024 bytes.
 * 4. UTF-8.
 *
 * Why the order matters here and not only for correctness: a page decoded
 * with the wrong encoding is a page whose `<script>` tag we may not find, and
 * that is recorded as `WIDGET_NOT_FOUND` — a compliance failure against a
 * customer who complied. Every step exists to avoid writing that row.
 *
 * Node ships full ICU, so `TextDecoder` accepts every label the encoding
 * standard defines: windows-1252, ISO-8859-2, Shift_JIS, GBK, EUC-KR and the
 * rest. Nothing is decoded here that the platform cannot decode, and an
 * unrecognized label falls through to the next step rather than failing the
 * check.
 */

/** What the body is read as when nothing says otherwise. */
export const DEFAULT_CHARSET = "utf-8";

/** How far into the body a `<meta>` declaration is honoured, as browsers do. */
export const SNIFF_BYTES = 1024;

export type DecodedBody = Readonly<{
  text: string;
  /**
   * The canonical encoding name, never the label the page wrote.
   * `TextDecoder` maps every accepted label onto one of the encoding
   * standard's own names, so this value comes from a fixed list rather than
   * from the customer's bytes — which is what makes it safe to store in
   * `metadata` (README §34).
   */
  charset: string;
}>;

/**
 * `charset=` inside a `Content-Type`, quoted or not. Deliberately narrow: a
 * label is a token, so anything with a space or a semicolon in it is not one.
 */
const HEADER_CHARSET = /;\s*charset\s*=\s*(?:"([^"]*)"|([^\s;]+))/i;

/** `<meta charset="…">`, the HTML5 form. */
const META_CHARSET = /<meta[^>]+?charset\s*=\s*["']?\s*([a-z0-9_:.+-]+)/i;

/** `<meta http-equiv="content-type" content="…; charset=…">`, the older form. */
const META_HTTP_EQUIV =
  /<meta[^>]+?http-equiv\s*=\s*["']?content-type["']?[^>]*?content\s*=\s*["']([^"']*)["']/i;

/**
 * A decoder for `label`, or null if the platform does not recognize it.
 *
 * `replacement` is treated as unrecognized. The encoding standard maps a
 * handful of labels (ISO-2022-CN, HZ-GB-2312 and friends) onto an encoding
 * that turns every byte into U+FFFD, deliberately, so that a browser cannot
 * be tricked into reinterpreting a page's bytes. We render nothing and
 * execute nothing, so that attack has no target here — and honouring it would
 * guarantee a `WIDGET_NOT_FOUND` on a page we could otherwise read.
 */
function decoderFor(label: string | null): TextDecoder | null {
  if (label === null || label.trim() === "") {
    return null;
  }
  try {
    const decoder = new TextDecoder(label.trim());
    return decoder.encoding === "replacement" ? null : decoder;
  } catch {
    // RangeError: not a label the encoding standard defines.
    return null;
  }
}

/** The charset a `Content-Type` names, if it names one. */
export function charsetFromContentType(
  contentType: string | null,
): string | null {
  if (contentType === null) {
    return null;
  }
  const found = HEADER_CHARSET.exec(contentType);
  if (found === null) {
    return null;
  }
  return found[1] ?? found[2] ?? null;
}

/**
 * The charset a `<meta>` tag in the first {@link SNIFF_BYTES} bytes declares.
 *
 * The prefix is read as Latin-1 so that every byte becomes exactly one
 * character: the declaration itself is ASCII, and this must not depend on the
 * encoding it is being used to discover.
 */
export function charsetFromMeta(body: Buffer): string | null {
  const prefix = body.subarray(0, SNIFF_BYTES).toString("latin1");
  const meta = META_CHARSET.exec(prefix);
  if (meta !== null) {
    return meta[1] ?? null;
  }
  const equiv = META_HTTP_EQUIV.exec(prefix);
  if (equiv === null) {
    return null;
  }
  return charsetFromContentType(`;${equiv[1] ?? ""}`);
}

/**
 * The encoding a byte order mark declares, which no header and no `<meta>`
 * tag may override.
 */
function charsetFromMark(body: Buffer): string | null {
  if (
    body.length >= 3 &&
    body[0] === 0xef &&
    body[1] === 0xbb &&
    body[2] === 0xbf
  ) {
    return "utf-8";
  }
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
    return "utf-16le";
  }
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
    return "utf-16be";
  }
  return null;
}

/**
 * Decodes a fetched body to text, and says what it was read as.
 *
 * The mark, the header and the `<meta>` tag are each honoured only if the
 * platform recognizes the label; the fallback is UTF-8, which
 * {@link TextDecoder} always accepts, so this function has no failure mode.
 * A leading byte order mark is stripped rather than left in the text, because
 * `TextDecoder` does that by default and a page whose first character is
 * U+FEFF would never match a tag at position zero.
 */
export function decodeBody(
  body: Buffer,
  contentType: string | null,
): DecodedBody {
  const decoder =
    decoderFor(charsetFromMark(body)) ??
    decoderFor(charsetFromContentType(contentType)) ??
    decoderFor(charsetFromMeta(body)) ??
    new TextDecoder(DEFAULT_CHARSET);

  return Object.freeze({
    text: decoder.decode(body),
    charset: decoder.encoding,
  });
}
