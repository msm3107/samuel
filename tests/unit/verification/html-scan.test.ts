import { describe, expect, it } from "vitest";

import { findHtmlTags } from "@/features/verification/html-scan";

/**
 * The tokenizer (TASK-024), tested against HTML that is trying to lie rather
 * than HTML that is trying to work.
 *
 * Nothing here mentions a deployment identifier or a widget URL: this module
 * knows nothing about Article50.js, and a test that had to know would be
 * testing the matcher in `inspect-page.ts` instead. The two fail in opposite
 * directions — a tokenizer bug invents presence, a matcher bug denies it —
 * which is why they are separated at all.
 */

/** The attributes of the tags found, for a shorter assertion. */
function attributesOf(html: string): Record<string, string>[] {
  return findHtmlTags(html, "script").map((tag) =>
    Object.fromEntries(tag.attributes),
  );
}

describe("findHtmlTags: ordinary HTML", () => {
  it("finds a script tag and reads its attributes", () => {
    expect(
      attributesOf(
        '<html><body><p>hi</p><script async src="https://a/w.js" data-deployment="dep_x"></script></body></html>',
      ),
    ).toEqual([
      { async: "", src: "https://a/w.js", "data-deployment": "dep_x" },
    ]);
  });

  it("lowercases the tag name and the attribute names, never the values", () => {
    expect(
      attributesOf('<SCRIPT SRC="https://A/W.js" DATA-Deployment="dep_X">'),
    ).toEqual([{ src: "https://A/W.js", "data-deployment": "dep_X" }]);
  });

  it("reads unquoted, single-quoted and valueless attributes", () => {
    expect(
      attributesOf("<script src=https://a/w.js defer data-x='y'>"),
    ).toEqual([{ src: "https://a/w.js", defer: "", "data-x": "y" }]);
  });

  it("keeps the first of a duplicated attribute, as a parser does", () => {
    expect(attributesOf('<script src="first" src="second">')).toEqual([
      { src: "first" },
    ]);
  });

  it("finds every tag, in document order", () => {
    expect(
      attributesOf('<script src="a"></script><div></div><script src="b">'),
    ).toEqual([{ src: "a" }, { src: "b" }]);
  });

  it("tolerates newlines and tabs between attributes", () => {
    expect(attributesOf('<script\n  async\n  src="a"\n></script>')).toEqual([
      { async: "", src: "a" },
    ]);
  });

  it("ignores the solidus in a self-closing spelling", () => {
    // `<script/>` still opens a script element; the solidus is discarded.
    expect(attributesOf('<script src="a"/>')).toEqual([{ src: "a" }]);
  });
});

describe("findHtmlTags: what a browser would not run", () => {
  it("does not find a tag inside a comment", () => {
    expect(attributesOf('<!-- <script src="a"></script> -->')).toEqual([]);
  });

  it("does not find a tag inside another script's body", () => {
    // The outer tag is a real script tag and is found, carrying no attributes.
    // The one written inside its body is a string, and is not.
    expect(
      attributesOf(
        "<script>document.write(\"<script src='a'></script>\")</script>",
      ),
    ).toEqual([{}]);
  });

  it("does not find a tag inside a textarea or a title", () => {
    expect(
      attributesOf('<textarea><script src="a"></script></textarea>'),
    ).toEqual([]);
    expect(attributesOf('<title><script src="a"></script></title>')).toEqual(
      [],
    );
  });

  it("does not find a tag inside noscript, which needs scripting disabled", () => {
    // Our widget is a script: a notice installed here shows nothing to anyone
    // the widget was written for.
    expect(
      attributesOf('<noscript><script src="a"></script></noscript>'),
    ).toEqual([]);
  });

  it("does not find a tag inside a template, whose contents never execute", () => {
    expect(
      attributesOf('<template><script src="a"></script></template>'),
    ).toEqual([]);
  });

  it("does not find a tag inside a nested template", () => {
    expect(
      attributesOf(
        '<template><div><template><script src="a"></script></template></div></template>',
      ),
    ).toEqual([]);
  });

  it("finds a tag after a template has closed", () => {
    expect(
      attributesOf('<template><p></p></template><script src="a"></script>'),
    ).toEqual([{ src: "a" }]);
  });

  it("does not find a tag inside style, xmp, iframe, noembed or noframes", () => {
    for (const element of ["style", "xmp", "iframe", "noembed", "noframes"]) {
      expect(
        attributesOf(`<${element}><script src="a"></script></${element}>`),
      ).toEqual([]);
    }
  });

  it("does not find a tag written in an attribute value of another tag", () => {
    expect(attributesOf("<div title=\"<script src='a'>\"></div>")).toEqual([]);
  });

  it("does not find a tag inside a doctype or a bogus comment", () => {
    expect(attributesOf('<!DOCTYPE html><script src="a">')).toEqual([
      { src: "a" },
    ]);
    expect(attributesOf('<?xml version="1.0"?><script src="a">')).toEqual([
      { src: "a" },
    ]);
  });

  it("treats an unclosed comment as running to the end of the document", () => {
    expect(attributesOf('<!-- <script src="a">')).toEqual([]);
  });

  it("accepts the short comment forms the parser accepts", () => {
    expect(attributesOf('<!--><script src="a">')).toEqual([{ src: "a" }]);
    expect(attributesOf('<!---><script src="a">')).toEqual([{ src: "a" }]);
  });

  it("does not end a raw-text element on a near miss", () => {
    // `</scriptx>` is text inside a script body: only `</script` followed by
    // whitespace, a solidus or `>` closes it. So the tag carrying `src` is
    // still inside the first script's body, and only that first tag is found.
    expect(
      attributesOf('<script></scriptx><script src="a"></script></script>'),
    ).toEqual([{}]);
  });

  it("ends a raw-text element on an end tag carrying attributes", () => {
    expect(
      attributesOf('<script></script foo="bar"><script src="a"></script>'),
    ).toEqual([{}, { src: "a" }]);
  });

  it("reads an unterminated attribute value to the end of the document", () => {
    // Which is what a browser does with a truncated page: there is no tag
    // after an unclosed quote.
    expect(attributesOf('<p>x</p><script src="never closed')).toEqual([
      { src: "never closed" },
    ]);
  });

  it("reads a lone opening bracket as text", () => {
    expect(attributesOf('a < b and <script src="a">')).toEqual([{ src: "a" }]);
    expect(attributesOf('</><script src="a">')).toEqual([{ src: "a" }]);
  });

  it("does not find a tag whose name the tokenizer extends past 'script'", () => {
    // The tag-name state appends the `<`, so this element is `script<x`, which
    // no browser runs (PR #41 review, note 1).
    expect(attributesOf('<script<x src="a">')).toEqual([]);
  });

  it("still finds a real tag after a stray opening bracket", () => {
    // The other half of the same rule: `<` not followed by an ASCII letter is
    // text, so the tag on the next character is found.
    expect(attributesOf('<<script src="a">')).toEqual([{ src: "a" }]);
  });

  it.each([
    ["a space", "</ "],
    ["a digit", "</1"],
    ["a bracket", "</<"],
  ])("swallows a bogus comment opened by an end tag with %s", (_what, open) => {
    // `</` followed by anything but a letter enters the bogus-comment state,
    // which runs to the first `>` — taking the tag written inside it.
    expect(attributesOf(`${open}<script src="a">`)).toEqual([]);
  });

  it("does not find a tag inside an svg or math subtree", () => {
    // Foreign content: `script` there takes `href`, not `src`, so a browser
    // fetches nothing.
    expect(attributesOf('<svg><script src="a"></script></svg>')).toEqual([]);
    expect(attributesOf('<math><script src="a"></script></math>')).toEqual([]);
  });

  it("does not find a tag inside a nested foreign subtree", () => {
    expect(
      attributesOf('<svg><g><math><script src="a"></script></math></g></svg>'),
    ).toEqual([]);
  });

  it("finds a tag after a foreign subtree has closed", () => {
    expect(attributesOf('<svg><circle/></svg><script src="a">')).toEqual([
      { src: "a" },
    ]);
  });

  it("treats a self-closing svg as closed, which it is in foreign content", () => {
    // The solidus an HTML element ignores really does close a foreign one.
    // Counting it as open would silence every tag on the rest of the page —
    // trading a narrow false positive for a broad false negative.
    expect(attributesOf('<svg/><script src="a">')).toEqual([{ src: "a" }]);
    expect(attributesOf('<math/><script src="a">')).toEqual([{ src: "a" }]);
  });

  it("finds nothing after plaintext, which never ends", () => {
    expect(attributesOf('<plaintext><script src="a"></script>')).toEqual([]);
  });

  it("finds a tag written before plaintext", () => {
    expect(
      attributesOf('<script src="a"></script><plaintext><script src="b">'),
    ).toEqual([{ src: "a" }]);
  });

  it("finds nothing in an empty document or one with no script", () => {
    expect(attributesOf("")).toEqual([]);
    expect(attributesOf("<html><body><p>hello</p></body></html>")).toEqual([]);
  });
});

describe("findHtmlTags: character references in attribute values", () => {
  it("decodes the references a URL can carry", () => {
    expect(
      attributesOf('<script src="https://a/w.js?x=1&amp;y=2&#61;3">'),
    ).toEqual([{ src: "https://a/w.js?x=1&y=2=3" }]);
  });

  it("decodes hexadecimal references", () => {
    expect(attributesOf('<script src="https://a&#x2F;w.js">')).toEqual([
      { src: "https://a/w.js" },
    ]);
  });

  it("leaves a reference it does not know exactly as written", () => {
    // The full named table is 2231 entries, none of which can appear in an
    // origin or in a path of ours.
    expect(attributesOf('<script src="https://a/w.js?x=&nbsp;">')).toEqual([
      { src: "https://a/w.js?x=&nbsp;" },
    ]);
  });

  it("leaves a reference without its semicolon alone", () => {
    expect(attributesOf('<script src="https://a/w.js?x=1&ampy=2">')).toEqual([
      { src: "https://a/w.js?x=1&ampy=2" },
    ]);
  });

  it("leaves a numeric reference naming nothing a string can hold", () => {
    expect(attributesOf('<script src="a&#0;b&#xD800;c&#1114112;">')).toEqual([
      { src: "a&#0;b&#xD800;c&#1114112;" },
    ]);
  });
});

describe("findHtmlTags: size", () => {
  it("scans the whole body rather than a prefix", () => {
    // The dashboard's own instructions suggest a tag just before </body>, and
    // 1 MiB is the bound the fetch already accepts.
    const filler = "<p>x</p>".repeat(40_000);
    expect(attributesOf(`${filler}<script src="a"></script>`)).toEqual([
      { src: "a" },
    ]);
  });
});
