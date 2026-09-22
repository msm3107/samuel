/**
 * A deployment's hostname, as a person should read it (TASK-015).
 *
 * - The reading form is isolated and fixed left to right (`<bdi dir="ltr">`),
 *   never `dir="auto"`: a hostname reads left to right whatever its script,
 *   and `auto` would let a right-to-left label reorder the name and the
 *   text around it (PR #27 review, note 1).
 * - Whenever it differs from the stored ASCII form, the ASCII form follows
 *   it, so a lookalike (`аpple.com` with a Cyrillic "а") shows its real
 *   name, `xn--pple-43d.com` (PR #26 review, note 3).
 */
export function Hostname({
  hostname,
  unicodeHostname,
}: {
  hostname: string;
  unicodeHostname: string;
}) {
  if (unicodeHostname === hostname) {
    return <bdi dir="ltr">{hostname}</bdi>;
  }
  return (
    <>
      <bdi dir="ltr">{unicodeHostname}</bdi>{" "}
      <span className="font-normal text-slate-700">
        (<bdi dir="ltr">{hostname}</bdi>)
      </span>
    </>
  );
}
