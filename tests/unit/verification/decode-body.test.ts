import { describe, expect, it } from "vitest";

import {
  charsetFromContentType,
  charsetFromMeta,
  decodeBody,
  DEFAULT_CHARSET,
  SNIFF_BYTES,
} from "@/features/verification/decode-body";

/**
 * Deciding what a fetched body says (TASK-024).
 *
 * Every case here is a way to record `WIDGET_NOT_FOUND` against a customer who
 * complied: a page read with the wrong encoding is a page whose script tag we
 * may not find. The order — mark, header, `<meta>`, UTF-8 — is the order a
 * browser uses, and the point of the tests is that no step can make the next
 * one unreachable.
 */

/** A page in one byte encoding, with a tag that is ASCII either way. */
function page(charset: string, declaration = ""): Buffer {
  return Buffer.from(
    `<html><head>${declaration}</head><body><p>Grüße</p>` +
      `<script src="https://a/w.js"></script></body></html>`,
    charset as BufferEncoding,
  );
}

describe("charsetFromContentType", () => {
  it.each([
    ["text/html; charset=utf-8", "utf-8"],
    ["text/html;charset=ISO-8859-2", "ISO-8859-2"],
    ['text/html; charset="windows-1252"', "windows-1252"],
    ["text/html ; Charset = Shift_JIS", "Shift_JIS"],
    ["text/html; charset=utf-8; boundary=x", "utf-8"],
  ])("reads the charset out of %j", (header, expected) => {
    expect(charsetFromContentType(header)).toBe(expected);
  });

  it.each([["text/html"], ["text/html; charset="], [""]])(
    "finds none in %j",
    (header) => {
      expect(charsetFromContentType(header)).toBeNull();
    },
  );

  it("finds none in an absent header", () => {
    expect(charsetFromContentType(null)).toBeNull();
  });
});

describe("charsetFromMeta", () => {
  it("reads the HTML5 form", () => {
    expect(
      charsetFromMeta(Buffer.from('<html><head><meta charset="Shift_JIS">')),
    ).toBe("Shift_JIS");
  });

  it("reads the HTML5 form unquoted", () => {
    expect(charsetFromMeta(Buffer.from("<meta charset=windows-1252>"))).toBe(
      "windows-1252",
    );
  });

  it("reads the http-equiv form", () => {
    expect(
      charsetFromMeta(
        Buffer.from(
          '<meta http-equiv="Content-Type" content="text/html; charset=EUC-KR">',
        ),
      ),
    ).toBe("EUC-KR");
  });

  it("does not look past the first kilobyte, as browsers do not", () => {
    const late = Buffer.concat([
      Buffer.from("<!--".padEnd(SNIFF_BYTES, " ")),
      Buffer.from('--><meta charset="Shift_JIS">'),
    ]);

    expect(charsetFromMeta(late)).toBeNull();
  });

  it("reads the prefix as Latin-1, so a declaration in a GBK page is found", () => {
    // The declaration is ASCII; reading the prefix as anything else would make
    // finding it depend on the encoding it is being used to discover.
    const body = Buffer.concat([
      Buffer.from('<meta charset="gbk">'),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
    ]);

    expect(charsetFromMeta(body)).toBe("gbk");
  });

  it("finds none when there is no declaration", () => {
    expect(
      charsetFromMeta(Buffer.from("<html><head><title>x</title>")),
    ).toBeNull();
  });
});

describe("decodeBody", () => {
  it("honours the charset the header names", () => {
    const body = page("latin1");
    const { text, charset } = decodeBody(body, "text/html; charset=iso-8859-1");

    expect(charset).toBe("windows-1252");
    expect(text).toContain("Grüße");
    expect(text).toContain('src="https://a/w.js"');
  });

  it("sniffs a meta declaration when the header names none", () => {
    const body = page("latin1", '<meta charset="windows-1252">');
    const { text, charset } = decodeBody(body, "text/html");

    expect(charset).toBe("windows-1252");
    expect(text).toContain("Grüße");
  });

  it("prefers the header to the meta declaration", () => {
    // Both are honoured in browsers, in this order; the row records which won.
    const body = page("latin1", '<meta charset="utf-8">');

    expect(decodeBody(body, "text/html; charset=windows-1252").charset).toBe(
      "windows-1252",
    );
  });

  it("defaults to UTF-8 when nothing says otherwise", () => {
    const { text, charset } = decodeBody(page("utf8"), null);

    expect(charset).toBe(DEFAULT_CHARSET);
    expect(text).toContain("Grüße");
  });

  it("falls through a label the platform does not know", () => {
    // An unrecognized label is not a reason to fail a check.
    const body = page("utf8");

    expect(decodeBody(body, "text/html; charset=x-made-up").charset).toBe(
      DEFAULT_CHARSET,
    );
  });

  it("falls through a label that maps onto the replacement encoding", () => {
    // The encoding standard maps ISO-2022-CN onto an encoding that turns every
    // byte into U+FFFD, to stop a browser being tricked into reinterpreting a
    // page. We render nothing and execute nothing, so honouring it would only
    // guarantee a WIDGET_NOT_FOUND on a page we can otherwise read.
    const { text, charset } = decodeBody(
      page("utf8"),
      "text/html; charset=iso-2022-cn",
    );

    expect(charset).toBe(DEFAULT_CHARSET);
    expect(text).toContain('src="https://a/w.js"');
  });

  it("lets a byte order mark outrank the header and the meta tag", () => {
    const body = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      page("utf8", '<meta charset="windows-1252">'),
    ]);
    const { text, charset } = decodeBody(
      body,
      "text/html; charset=windows-1252",
    );

    expect(charset).toBe("utf-8");
    // Stripped, not left in the text: a document whose first character is
    // U+FEFF would never match a tag at position zero.
    expect(text.startsWith("<html>")).toBe(true);
    expect(text).toContain("Grüße");
  });

  it("decodes a UTF-16 page, mark and all", () => {
    const body = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('<script src="https://a/w.js"></script>', "utf16le"),
    ]);
    const { text, charset } = decodeBody(body, null);

    expect(charset).toBe("utf-16le");
    expect(text).toContain('src="https://a/w.js"');
  });

  it("decodes an empty body without complaining", () => {
    expect(decodeBody(Buffer.alloc(0), null)).toEqual({
      text: "",
      charset: DEFAULT_CHARSET,
    });
  });

  it("finds an ASCII tag in a Shift_JIS page", () => {
    // The case UTF-8-always would get wrong: these bytes are not valid UTF-8,
    // and a replacement character landing inside the tag would lose it.
    const body = Buffer.concat([
      Buffer.from('<html><head><meta charset="Shift_JIS"></head><body>'),
      Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]),
      Buffer.from('<script src="https://a/w.js"></script></body></html>'),
    ]);
    const { text, charset } = decodeBody(body, "text/html");

    expect(charset).toBe("shift_jis");
    expect(text).toContain("日本語");
    expect(text).toContain('src="https://a/w.js"');
  });
});
