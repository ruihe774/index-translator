// What a request's `Accept` header says about one media type of the speech answer.

/**
 * The weight a header gives `type`, 0 when it does not name it or gives it no weight. Only a
 * range that names the type counts: `*` and `audio/*` are answered with WAV, which every client can
 * play.
 */
export function acceptWeight(accept: string | null, type: string): number {
  for (const range of (accept ?? "").split(",")) {
    const [name, ...params] = range.split(";").map((part) => part.trim().toLowerCase());
    if (name !== type) {
      continue;
    }
    const q = params.find((p) => p.startsWith("q="));
    return q === undefined ? 1 : Math.max(0, Number(q.slice(2)) || 0);
  }
  return 0;
}
