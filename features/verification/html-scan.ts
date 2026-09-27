/**
 * Finding a start tag in somebody else's HTML (TASK-024; README §18).
 *
 * This is a tokenizer, not a parser: it builds no tree, resolves no implied
 * end tag, and knows nothing about Article50.js. It answers one question —
 * where are the `<script>` start tags a browser would actually run, and what
 * attributes do they carry — because that is the only question HTML
 * inspection can answer without executing anything (§18 forbids executing
 * customer JavaScript, and this module is why nothing has to).
 *
 * Written here rather than taken from a package (owner, 2026-09-27; §56):
 * the alternative is a dependency whose entire job is to be fed hostile bytes
 * from arbitrary websites inside our own process, and a spec-following parse
 * buys nothing we need — we are looking for one element by name, not building
 * a DOM. The cost is honest: this is only as good as its tests, which is why
 * they are written against HTML that is trying to lie rather than against
 * HTML that is trying to work.
 *
 * ## What it skips, and why that is the whole point
 *
 * A page can carry the text of our installation in several places where a
 * browser would never run it. Each one is a way to look compliant while
 * rendering no notice, so "found" is defined by what *runs*, not by what
 * parses:
 *
 * - **Comments**, including the `<!-->` short form the HTML parser accepts.
 * - **Doctypes and bogus comments** (`<!…>`, `<?…>`), which end at the first
 *   `>`.
 * - **Raw-text elements** — `script`, `style`, `textarea`, `title`, `xmp`,
 *   `iframe`, `noembed`, `noframes` — whose contents are text until their
 *   own end tag. Our tag inside another script's body is a string.
 * - **`noscript`**, which is a raw-text element exactly when scripting is
 *   enabled. Our widget needs scripting, so a tag hidden there is a tag that
 *   can never render a notice.
 * - **`template`** contents, which are parsed as markup but belong to a
 *   fragment that never executes.
 * - **`svg` and `math`** subtrees, parsed in another namespace where `script`
 *   takes an `href` rather than a `src`, so a `<script src>` there fetches
 *   nothing.
 * - **Everything after `<plaintext>`**, which is text for the rest of the
 *   document in every browser.
 * - **`<script<x …>`**, an element called `script<x`: the tokenizer's tag-name
 *   state appends the `<`, and no browser runs an unknown element.
 * - **A bogus comment**: `</` followed by anything but an ASCII letter swallows
 *   everything to the first `>`.
 *
 * ## Its limits, stated rather than discovered
 *
 * It does not know that `</template>` inside a raw-text element is text, and it
 * cannot know that a subtree was discarded by a real parser's error handling.
 * Both make it find a tag a browser would not run, which is the direction that
 * records a success wrongly — so both are reasons to keep the matching in
 * `inspect-page.ts` strict.
 *
 * What is **not** an excuse for such a limit: that reaching it takes a
 * deliberately built page. An earlier version of this comment said the limits
 * were unreachable "by a page that is merely unusual rather than deliberate",
 * and the PR #41 review was right to reject that reasoning. For this module
 * deliberate *is* the threat model: a customer who wants the record to say
 * compliant without disclosing anything is precisely who it exists to catch. A
 * limit here is a cost to be paid down, not a risk to be discounted.
 *
 * The limits that remain are therefore all in the safe direction — a tag a
 * browser *would* run and this does not report. `svg` and `math` are skipped
 * whole, so a script inside one of their HTML integration points (`mtext`,
 * `mi`, `mo`, `mn`, `ms`, `annotation-xml` with `encoding="text/html"`,
 * `foreignObject`, `desc`, `title`) is missed, because parsing resumes as HTML
 * there. That is a false negative on a page nobody serves, and a customer who
 * hits it can dispute the check — where the opposite error writes a compliance
 * record that is simply untrue.
 */

/** A start tag, with its attribute names lowercased. */
export type HtmlTag = Readonly<{
  /** Lowercased, as HTML tag names are case-insensitive. */
  name: string;
  /** First occurrence wins, as an HTML parser does with a duplicate. */
  attributes: ReadonlyMap<string, string>;
}>;

/**
 * Elements whose contents are text until their own end tag.
 *
 * `noscript` is here because scripting is enabled for the visitors we are
 * reasoning about: our widget is a script, so a page whose notice is inside
 * `<noscript>` shows no notice to anybody the widget was written for.
 */
const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
]);

/**
 * The elements whose contents are parsed in another namespace, where `script`
 * takes an `href` rather than a `src` — so a `<script src>` written inside one
 * fetches nothing and renders no notice (PR #41 review, note 1).
 */
const FOREIGN = new Set(["svg", "math"]);

/** ASCII whitespace, as the HTML tokenizer defines it. */
const WHITESPACE = new Set([" ", "\t", "\n", "\f", "\r"]);

/**
 * The character references that can appear inside a value we compare: a URL
 * and 26 characters of base32. The full named table is 2231 entries, none of
 * which can appear in an origin or in `/widget.js`, so decoding these five
 * and the numeric forms closes the question without importing a table.
 *
 * A reference without its semicolon is not decoded. Attribute values in the
 * wild do carry them, but the ambiguity is only resolvable with the full
 * table, and a bare `&amp` in a widget URL is not a case anybody has.
 */
const NAMED_REFERENCES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

const REFERENCE = /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g;

/**
 * Decodes the character references an attribute value may carry.
 *
 * Without this, a `src` whose query a content management system escaped
 * reads as a different URL and the installation is reported missing — a
 * failure recorded against a customer who did comply.
 */
function decodeReferences(value: string): string {
  if (!value.includes("&")) {
    return value;
  }
  return value.replace(
    REFERENCE,
    (whole, decimal?: string, hex?: string, name?: string) => {
      if (decimal !== undefined) {
        return codePoint(Number.parseInt(decimal, 10)) ?? whole;
      }
      if (hex !== undefined) {
        return codePoint(Number.parseInt(hex, 16)) ?? whole;
      }
      // Named references are case-sensitive; only the lowercase spellings
      // above are real.
      return (name !== undefined && NAMED_REFERENCES.get(name)) || whole;
    },
  );
}

/**
 * A numeric reference, or null if it names nothing a string can hold. A lone
 * surrogate and anything past the last code point are left as written rather
 * than turned into a replacement character, because the point of decoding is
 * to compare the value a browser would use, and a browser would not find our
 * URL in either case.
 */
function codePoint(value: number): string | null {
  if (
    !Number.isInteger(value) ||
    value <= 0 ||
    value > 0x10ffff ||
    (value >= 0xd800 && value <= 0xdfff)
  ) {
    return null;
  }
  return String.fromCodePoint(value);
}

/**
 * Whether a tag name may begin here. Only an ASCII letter opens a tag: `<`
 * followed by anything else is text, and `</` followed by anything else is a
 * bogus comment (PR #41 review, note 1).
 */
function isAsciiLetter(character: string): boolean {
  return (
    (character >= "a" && character <= "z") ||
    (character >= "A" && character <= "Z")
  );
}

/**
 * Where a tag name ends: whitespace, a solidus or `>`.
 *
 * `<` is deliberately **not** a terminator, because the tokenizer's tag-name
 * state appends it to the name — so `<script<x …>` is an element called
 * `script<x`, which no browser runs. Treating `<` as a terminator would have
 * read it as a `script` tag with attributes (PR #41 review, note 1); the
 * `isAsciiLetter` gate at the tag-open state is what keeps `<<script src=x>`
 * working instead.
 */
function isNameCharacter(character: string): boolean {
  return !WHITESPACE.has(character) && character !== "/" && character !== ">";
}

type TagBody = Readonly<{
  attributes: Map<string, string>;
  end: number;
  /**
   * Whether the tag ended with `/>`. Ignored for an HTML element, but it really
   * does close a foreign one, so `<svg/>` opens no subtree.
   */
  selfClosing: boolean;
}>;

/**
 * Reads a start tag's attributes, from just after its name to just after its
 * `>`.
 *
 * A tag that runs off the end of the document ends at the end of the
 * document, which is what a browser does with a truncated page.
 */
function readTagBody(html: string, from: number): TagBody {
  const attributes = new Map<string, string>();
  let index = from;
  let selfClosing = false;

  while (index < html.length) {
    while (index < html.length && WHITESPACE.has(html[index] ?? "")) {
      index += 1;
    }
    if (index >= html.length) {
      break;
    }
    const character = html[index] ?? "";
    if (character === ">") {
      index += 1;
      break;
    }
    // A solidus anywhere in a start tag is ignored for HTML elements, `/>`
    // included: `<script/>` still opens a script element. It is recorded
    // anyway, because the same `/>` does close a foreign element.
    if (character === "/") {
      index += 1;
      if (html[index] === ">") {
        index += 1;
        selfClosing = true;
        break;
      }
      continue;
    }

    const nameStart = index;
    while (index < html.length) {
      const next = html[index] ?? "";
      if (
        WHITESPACE.has(next) ||
        next === "/" ||
        next === ">" ||
        next === "="
      ) {
        break;
      }
      index += 1;
    }
    const name = html.slice(nameStart, index).toLowerCase();

    while (index < html.length && WHITESPACE.has(html[index] ?? "")) {
      index += 1;
    }

    let value = "";
    if (html[index] === "=") {
      index += 1;
      while (index < html.length && WHITESPACE.has(html[index] ?? "")) {
        index += 1;
      }
      const quote = html[index] ?? "";
      if (quote === '"' || quote === "'") {
        index += 1;
        const close = html.indexOf(quote, index);
        if (close === -1) {
          // An unterminated value swallows the rest of the document, exactly
          // as it does in a browser: there is no tag after it.
          value = html.slice(index);
          index = html.length;
        } else {
          value = html.slice(index, close);
          index = close + 1;
        }
      } else {
        const valueStart = index;
        while (index < html.length) {
          const next = html[index] ?? "";
          if (WHITESPACE.has(next) || next === ">") {
            break;
          }
          index += 1;
        }
        value = html.slice(valueStart, index);
      }
    }

    if (name !== "" && !attributes.has(name)) {
      attributes.set(name, decodeReferences(value));
    }
  }

  return { attributes, end: index, selfClosing };
}

/** Past a comment, whether or not it was ever closed. */
function skipComment(html: string, from: number): number {
  // `<!-->` and `<!--->` are complete comments: the parser accepts the
  // closing sequence immediately.
  if (html.startsWith(">", from)) {
    return from + 1;
  }
  if (html.startsWith("->", from)) {
    return from + 2;
  }
  const close = html.indexOf("-->", from);
  return close === -1 ? html.length : close + 3;
}

/** Past a doctype or a bogus comment, both of which end at the first `>`. */
function skipToTagEnd(html: string, from: number): number {
  const close = html.indexOf(">", from);
  return close === -1 ? html.length : close + 1;
}

/**
 * Past a raw-text element's contents, to just before its end tag.
 *
 * Only `</name` followed by whitespace, `/` or `>` closes it, so `</scriptx>`
 * inside a script body stays text — the same rule the tokenizer uses, and the
 * reason a page cannot end our scan early with a near miss.
 */
function skipRawText(html: string, from: number, name: string): number {
  let index = from;
  while (index < html.length) {
    const at = html.indexOf("<", index);
    if (at === -1) {
      return html.length;
    }
    // Case-folded a name at a time rather than over the whole document:
    // `String.prototype.toLowerCase` is not length-preserving (U+0130 becomes
    // two code units), and a folded copy used for indices would silently
    // misalign every position after the first such character.
    const end = at + 2 + name.length;
    if (
      html[at + 1] === "/" &&
      html.slice(at + 2, end).toLowerCase() === name
    ) {
      const after = html[end] ?? ">";
      if (WHITESPACE.has(after) || after === "/" || after === ">") {
        return at;
      }
    }
    index = at + 1;
  }
  return html.length;
}

/**
 * Every start tag named `name` that a browser would run, in document order.
 *
 * @param html The page, already decoded to text.
 * @param name The element to find, lowercase.
 */
export function findHtmlTags(html: string, name: string): readonly HtmlTag[] {
  const found: HtmlTag[] = [];
  /**
   * How deep inside `<template>` we are. Its contents are markup — nested
   * templates and all — but they belong to a fragment that never executes,
   * so tags are still read (to keep the tokenizer honest about what closes
   * what) and simply not reported.
   */
  let templateDepth = 0;
  /**
   * How deep inside `<svg>` or `<math>` we are. Their contents are parsed in
   * another namespace, where `script` takes `href` rather than `src` — so a
   * `<script src>` there fetches nothing, and a browser renders no notice
   * (PR #41 review, note 1). Counted the same way as `template`, for the same
   * reason: reading the tags is what keeps the tokenizer honest about what
   * closes what.
   */
  let foreignDepth = 0;
  let index = 0;

  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) {
      break;
    }
    index = open + 1;
    const marker = html[index] ?? "";

    if (marker === "!") {
      index = html.startsWith("--", index + 1)
        ? skipComment(html, index + 3)
        : skipToTagEnd(html, index + 1);
      continue;
    }
    if (marker === "?") {
      // A processing instruction is a bogus comment in HTML.
      index = skipToTagEnd(html, index + 1);
      continue;
    }

    const closing = marker === "/";
    // The tag-open state: only an ASCII letter starts a tag name. `<` followed
    // by anything else is literal text, and `</` followed by anything else is a
    // bogus comment — which a browser swallows to the first `>`, taking any tag
    // written inside it with it.
    if (closing) {
      if (!isAsciiLetter(html[index + 1] ?? "")) {
        index = skipToTagEnd(html, index + 1);
        continue;
      }
      index += 1;
    } else if (!isAsciiLetter(marker)) {
      continue;
    }

    const nameStart = index;
    while (index < html.length && isNameCharacter(html[index] ?? "")) {
      index += 1;
    }
    const tagName = html.slice(nameStart, index).toLowerCase();

    const body = readTagBody(html, index);
    index = body.end;

    if (closing) {
      if (tagName === "template" && templateDepth > 0) {
        templateDepth -= 1;
      }
      if (FOREIGN.has(tagName) && foreignDepth > 0) {
        foreignDepth -= 1;
      }
      continue;
    }

    if (tagName === "plaintext") {
      // Everything after it is text, forever: there is no end tag, and no
      // markup can follow it in any browser.
      break;
    }

    if (tagName === "template") {
      templateDepth += 1;
      continue;
    }

    if (FOREIGN.has(tagName)) {
      // `<svg/>` really does self-close in foreign content, where the solidus
      // an HTML element ignores is honoured. Counting it as an open subtree
      // would silence every tag on the rest of the page.
      if (!body.selfClosing) {
        foreignDepth += 1;
      }
      continue;
    }

    if (tagName === name && templateDepth === 0 && foreignDepth === 0) {
      found.push(Object.freeze({ name: tagName, attributes: body.attributes }));
    }

    if (RAW_TEXT.has(tagName)) {
      index = skipRawText(html, index, tagName);
    }
  }

  return Object.freeze(found);
}
