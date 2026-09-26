// @ts-check
/**
 * Article50.js — the public widget (TASK-020).
 *
 * One script tag renders a site's AI transparency notice:
 *
 *   <script async src="https://example.com/widget.js"
 *           data-deployment="dep_..."></script>
 *
 * This file is deliberately not built, minified or bundled: what your
 * browser runs is exactly what is in our repository, and you are welcome to
 * read it. It is the one thing we ask you to run on your own site, so it
 * should be readable by the person who installs it.
 *
 * It loads no other code, defines no global, stores nothing, sets no
 * cookie, and collects nothing about your visitors. If anything at all goes
 * wrong it renders nothing and stays out of your way.
 */
(function () {
  "use strict";

  /**
   * The same rule the server enforces: `dep_` and 26 characters of
   * lowercase base32. Checked here so a typo costs no request.
   */
  const DEPLOYMENT_ID = /^dep_[a-z2-7]{26}$/;

  /** Marks a script tag that has already rendered its notice. */
  const RENDERED = "article50Rendered";

  /**
   * `document.currentScript` is this script while it is executing, async
   * or not — but it is null for module scripts and inside callbacks, so
   * the last tag carrying a deployment identifier is the fallback.
   * @returns {HTMLScriptElement | null}
   */
  function findScript() {
    const current = document.currentScript;
    if (current instanceof HTMLScriptElement) {
      return current;
    }
    const tagged = document.querySelectorAll("script[data-deployment]");
    const last = tagged[tagged.length - 1];
    return last instanceof HTMLScriptElement ? last : null;
  }

  /**
   * Said once, and only for a mistake in the installation, so the person
   * who added the script can see it and fix it. A deployment with nothing
   * to show is a normal state and says nothing at all.
   * @param {string} message
   */
  function explain(message) {
    if (typeof console !== "undefined" && console.error) {
      console.error("[article50] " + message);
    }
  }

  /**
   * Where the notice goes: the element named by `data-target`, or right
   * after the script tag itself.
   *
   * A script in `<head>`, or one whose tag is no longer in the document,
   * has no meaningful position on the page. Rather than guess a corner,
   * the widget asks for `data-target`.
   * @param {HTMLScriptElement} script
   * @returns {{ parent: Node, before: Node | null } | null}
   */
  function findPlace(script) {
    const target = script.getAttribute("data-target");
    if (target) {
      const element = document.querySelector(target);
      if (!element) {
        explain('No element matches data-target="' + target + '".');
        return null;
      }
      return { parent: element, before: null };
    }
    const parent = script.parentNode;
    if (!parent || parent === document.head) {
      explain(
        "A script in <head> has no place on the page: add data-target with a selector for the element the notice belongs in.",
      );
      return null;
    }
    return { parent: parent, before: script.nextSibling };
  }

  /**
   * The notice's own styles. They go in through a constructable stylesheet
   * where possible, because that is not an inline style for your page's
   * Content Security Policy — a site running `style-src 'self'` needs no
   * exception for us. No element gets a `style` attribute either, for the
   * same reason.
   *
   * Everything is scoped to a shadow root, so your CSS cannot reach the
   * notice and the notice's CSS cannot reach your page. The custom
   * properties are the supported way to make it look like your site; the
   * paragraph is also reachable with `::part(notice)`.
   */
  const STYLES =
    ":host{display:block}" +
    ".notice{" +
    "margin:0;" +
    "font-family:var(--article50-font-family,system-ui,-apple-system,Segoe UI,Roboto,sans-serif);" +
    "font-size:var(--article50-font-size,0.875rem);" +
    "line-height:1.5;" +
    "color:var(--article50-color,#1f2937);" +
    "background:var(--article50-background,#f3f4f6);" +
    "border:var(--article50-border,1px solid #d1d5db);" +
    "border-radius:var(--article50-border-radius,0.375rem);" +
    "padding:var(--article50-padding,0.5rem 0.75rem);" +
    "}";

  /**
   * @param {ShadowRoot} root
   */
  function applyStyles(root) {
    // Chrome 73+, Firefox 101+, Safari 16.4+. Anything older falls back to
    // a style element, which a strict style-src would refuse — the notice
    // then renders unstyled rather than not at all.
    if (
      typeof CSSStyleSheet === "function" &&
      "adoptedStyleSheets" in Document.prototype &&
      typeof CSSStyleSheet.prototype.replaceSync === "function"
    ) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(STYLES);
        root.adoptedStyleSheets = [sheet];
        return;
      } catch {
        // Fall through to the style element.
      }
    }
    const style = document.createElement("style");
    style.textContent = STYLES;
    root.appendChild(style);
  }

  /**
   * @param {{ parent: Node, before: Node | null }} place
   * @param {{ version: number, language: string, message: string }} notice
   */
  function render(place, notice) {
    const host = document.createElement("div");
    // Readable by a page, or by an auditor's script, without the notice
    // growing a version number nobody asked to see.
    host.setAttribute("data-article50", "notice");
    host.setAttribute("data-version", String(notice.version));

    const root = host.attachShadow({ mode: "open" });
    applyStyles(root);

    const paragraph = document.createElement("p");
    paragraph.className = "notice";
    paragraph.setAttribute("part", "notice");
    paragraph.setAttribute("lang", notice.language);
    // Text, never markup. This is the last place a stored message could
    // have become HTML, and it does not.
    paragraph.textContent = notice.message;
    root.appendChild(paragraph);

    place.parent.insertBefore(host, place.before);
  }

  /**
   * The three fields the endpoint documents, and nothing else is read.
   * @param {unknown} body
   * @returns {{ version: number, language: string, message: string } | null}
   */
  function readNotice(body) {
    if (typeof body !== "object" || body === null) {
      return null;
    }
    const notice = /** @type {Record<string, unknown>} */ (body);
    if (
      typeof notice.version !== "number" ||
      typeof notice.language !== "string" ||
      typeof notice.message !== "string" ||
      notice.message === ""
    ) {
      return null;
    }
    return {
      version: notice.version,
      language: notice.language,
      message: notice.message,
    };
  }

  function start() {
    const script = findScript();
    if (!script || script.dataset[RENDERED] === "true") {
      return;
    }

    const deployment = script.getAttribute("data-deployment");
    if (!deployment) {
      explain("This script tag has no data-deployment attribute.");
      return;
    }
    if (!DEPLOYMENT_ID.test(deployment)) {
      // Exact: no trimming and no case folding, so one deployment has one
      // spelling. The server answers a malformed identifier the same way
      // and would tell us nothing more, so no request is made.
      explain(
        "data-deployment is not a deployment identifier: it should look like dep_ followed by 26 lowercase letters and digits.",
      );
      return;
    }
    if (!script.src) {
      explain("This script tag has no src, so the notice cannot be fetched.");
      return;
    }

    const place = findPlace(script);
    if (!place) {
      return;
    }

    // The endpoint is found from this script's own URL, so nothing is
    // hardcoded and a preview deployment serves its own notices.
    const endpoint = new URL(
      "/api/public/disclosure/" + deployment,
      script.src,
    ).toString();

    // Marked before the request, not after: a second execution of the same
    // tag must not start a second request either.
    script.dataset[RENDERED] = "true";

    fetch(endpoint, {
      // Nothing about your visitor is sent: no cookie, no credential.
      credentials: "omit",
      mode: "cors",
    })
      .then(function (response) {
        // 404 is the ordinary answer for a deployment with nothing to show
        // — unknown, archived, or a notice that was withdrawn. It is not an
        // error and says nothing in the console.
        return response.ok ? response.json() : null;
      })
      .then(function (body) {
        const notice = body === null ? null : readNotice(body);
        if (notice) {
          render(place, notice);
        }
      })
      .catch(function () {
        // A network failure, a refused request, an unreadable body: the
        // page carries on as though we were never here.
      });
  }

  try {
    start();
  } catch {
    // Nothing this script does is worth breaking somebody else's page for.
  }
})();
