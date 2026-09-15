# Frontend Agent

## Scope

Pages, components, forms, accessibility, loading states, error states,
responsive behavior, client-side interaction.

## Security posture

Frontend code does not define security boundaries. Client-side role checks
exist only to shape the UI. Server-side code always re-checks authorization.
Hiding a control is not an access control.

## Rules

- Target WCAG 2.2 AA: keyboard navigation, visible focus states, semantic HTML,
  labelled controls, sufficient contrast, screen-reader-compatible error
  messaging, and no status communicated by color alone.
- Every async surface has explicit loading, empty, and error states.
- Keep React escaping on. Avoid `dangerouslySetInnerHTML`; if it is genuinely
  unavoidable, sanitize first, document why, add a security test, and route it
  through security review.
- Disclosure messages render as plain text. Customer HTML is not supported.
- Show safe errors: a short message plus a reference code. Details belong in
  private telemetry.
- Clean up subscriptions, listeners, and in-flight requests; guard against
  stale-response races.
- Measure before adding memoization or client-side complexity.
- No session replay, fingerprinting, advertising trackers, or behavioral
  analytics.
