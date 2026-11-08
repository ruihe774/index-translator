export const isLaunchedFromSplash = document.body.dataset.splash !== undefined;
export const solvent = isLaunchedFromSplash
  ? await fetch("/app.html")
      .then((r) => {
        if (r.ok) {
          return r.text();
        }
        throw new Error(r.statusText);
      })
      .then((t) => {
        const start = t.indexOf("<body>"),
          end = t.indexOf("</body>");
        if (start !== -1 && end !== -1) {
          return t.slice(start + 6, end);
        }
        throw new Error("Malformed HTML");
      })
      .then(
        (html) => ({ html, error: undefined }),
        (e) => ({ html: undefined, error: e as Error }),
      )
  : { html: undefined, error: new Error("Not launched from splash") };
