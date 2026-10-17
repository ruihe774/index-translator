#!/usr/bin/env python3
"""a11y_check.py - static accessibility checks for the a11y-acceptance skill.

Stdlib only. Two subcommands:

  lint <path> [<path> ...]   Static checks on .html/.htm files (dirs are walked).
                             Prints FAIL/WARN lines tagged with criterion IDs.
                             Exit code 1 if any FAIL.
  contrast <fg> <bg>         WCAG 2.2 contrast ratio. Colors: #rgb, #rrggbb,
                             rgb(r,g,b). Prints ratio and pass/fail per threshold.

The linter covers a subset of AUTO criteria only. A clean lint is necessary,
not sufficient: BROWSER and MANUAL criteria still need verification.
It does not parse JSX/Vue/Svelte; for those, lint the built HTML output and
use the framework's linter (e.g. eslint-plugin-jsx-a11y, eslint-plugin-vuejs-accessibility).
"""
import os
import re
import sys
from html.parser import HTMLParser

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "param", "source", "track", "wbr"}
NATIVE_INTERACTIVE = {"a", "button", "input", "select", "textarea", "summary",
                      "details", "option", "label"}
GENERIC_LINK_TEXT = {"click here", "here", "read more", "more", "learn more",
                     "link", "this", "continue", "details", "click"}
AUTOCOMPLETE_HINTS = {
    "email": "email", "e-mail": "email", "phone": "tel", "tel": "tel",
    "firstname": "given-name", "first_name": "given-name", "fname": "given-name",
    "lastname": "family-name", "last_name": "family-name", "lname": "family-name",
    "fullname": "name", "zip": "postal-code", "postcode": "postal-code",
    "postal": "postal-code", "address": "street-address", "city": "address-level2",
    "country": "country", "username": "username", "birthday": "bday",
}
ARIA_REF_ATTRS = ("aria-labelledby", "aria-describedby", "aria-controls",
                  "aria-owns", "aria-activedescendant", "aria-errormessage")


class Node:
    __slots__ = ("tag", "attrs", "line", "children", "parent", "text")

    def __init__(self, tag, attrs, line, parent):
        self.tag, self.attrs, self.line, self.parent = tag, attrs, line, parent
        self.children, self.text = [], []

    def a(self, k, default=None):
        return self.attrs.get(k, default)

    def iter(self):
        yield self
        for c in self.children:
            if isinstance(c, Node):
                yield from c.iter()

    def all_text(self):
        out = []
        for c in self.children:
            if isinstance(c, Node):
                if c.a("aria-hidden") == "true":
                    continue
                if c.tag == "img" and c.a("alt"):
                    out.append(c.a("alt"))
                out.append(c.all_text())
            else:
                out.append(c)
        return re.sub(r"\s+", " ", " ".join(out)).strip()

    def ancestors(self):
        p = self.parent
        while p is not None:
            yield p
            p = p.parent


class TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root", {}, 0, None)
        self.cur = self.root
        self.css = []  # (line, text) from <style> and style=""

    def handle_starttag(self, tag, attrs):
        attrs = {k: (v if v is not None else "") for k, v in attrs}
        node = Node(tag, attrs, self.getpos()[0], self.cur)
        self.cur.children.append(node)
        if "style" in attrs:
            self.css.append((node.line, attrs["style"]))
        if tag not in VOID:
            self.cur = node

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID and self.cur.tag == tag:
            self.cur = self.cur.parent

    def handle_endtag(self, tag):
        n = self.cur
        while n is not None and n.tag != tag:
            n = n.parent
        if n is not None and n.parent is not None:
            self.cur = n.parent

    def handle_data(self, data):
        self.cur.children.append(data)
        if self.cur.tag == "style":
            self.css.append((self.cur.line, data))


def accessible_name(n, by_id):
    if n.a("aria-labelledby"):
        parts = [by_id[i].all_text() for i in n.a("aria-labelledby").split() if i in by_id]
        if any(parts):
            return " ".join(parts)
    if n.a("aria-label", "").strip():
        return n.a("aria-label").strip()
    if n.tag == "input" and n.a("type") in ("submit", "button", "reset"):
        return n.a("value", n.a("type"))
    if n.tag == "input" and n.a("type") == "image":
        return n.a("alt", "")
    txt = n.all_text()
    if txt:
        return txt
    for c in n.iter():
        if c.tag == "svg":
            for t in c.iter():
                if t.tag == "title" and t.all_text():
                    return t.all_text()
    return n.a("title", "").strip()


def is_focusable(n):
    if n.a("tabindex") is not None:
        try:
            return int(n.a("tabindex")) >= 0
        except ValueError:
            return False
    if n.tag == "a":
        return "href" in n.attrs
    if n.tag in ("button", "select", "textarea", "summary", "iframe"):
        return "disabled" not in n.attrs
    if n.tag == "input":
        return n.a("type") != "hidden" and "disabled" not in n.attrs
    return False


def lint_file(path, extra_css=""):
    findings = []

    def add(level, cid, line, msg):
        findings.append((level, cid, f"{path}:{line}", msg))

    with open(path, encoding="utf-8", errors="replace") as f:
        src = f.read()
    tb = TreeBuilder()
    tb.feed(src)
    nodes = list(tb.root.iter())[1:]
    by_tag = {}
    for n in nodes:
        by_tag.setdefault(n.tag, []).append(n)
    ids = {}
    for n in nodes:
        if "id" in n.attrs:
            ids.setdefault(n.a("id"), []).append(n)
    by_id = {k: v[0] for k, v in ids.items()}
    css = "\n".join(t for _, t in tb.css) + "\n" + extra_css
    is_fragment = "html" not in by_tag

    # A11Y-01 language
    if not is_fragment:
        html = by_tag["html"][0]
        lang = html.a("lang", "").strip()
        if not lang:
            add("FAIL", "A11Y-01", html.line, "<html> has no lang attribute")
        elif not re.fullmatch(r"[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*", lang):
            add("FAIL", "A11Y-01", html.line, f"lang='{lang}' is not a valid BCP 47 tag")

    # A11Y-03 title
    if not is_fragment:
        titles = by_tag.get("title", [])
        titles = [t for t in titles if not any(a.tag == "svg" for a in t.ancestors())]
        if len(titles) != 1 or not titles[0].all_text():
            add("FAIL", "A11Y-03", 1, f"expected exactly 1 non-empty <title>, found {len(titles)}")

    # A11Y-04 landmarks
    if not is_fragment:
        mains = by_tag.get("main", []) + [n for n in nodes if n.a("role") == "main"]
        if len(mains) != 1:
            add("FAIL", "A11Y-04", 1, f"expected exactly 1 <main>, found {len(mains)}")
    navs = by_tag.get("nav", [])
    if len(navs) > 1:
        names = [accessible_name_label_only(n, by_id) for n in navs]
        if not all(names) or len(set(names)) != len(names):
            add("FAIL", "A11Y-04", navs[0].line, "multiple <nav> need distinct aria-label/aria-labelledby")

    # A11Y-05 headings
    heads = [n for n in nodes if re.fullmatch(r"h[1-6]", n.tag)]
    if not is_fragment:
        h1 = [h for h in heads if h.tag == "h1"]
        if len(h1) != 1:
            add("WARN", "A11Y-05", 1, f"BP: expected exactly 1 <h1>, found {len(h1)}")
    prev = 0
    for h in heads:
        lvl = int(h.tag[1])
        if prev and lvl > prev + 1:
            add("WARN", "A11Y-05", h.line, f"BP: heading level skips h{prev} -> h{lvl}")
        if not h.all_text():
            add("FAIL", "A11Y-05", h.line, f"empty <{h.tag}>")
        prev = lvl

    # A11Y-08 ids, refs, aria-hidden focusable
    for i, ns in ids.items():
        if len(ns) > 1:
            add("FAIL", "A11Y-08", ns[1].line, f"duplicate id '{i}' ({len(ns)}x)")
    for n in nodes:
        for attr in ARIA_REF_ATTRS:
            for ref in n.a(attr, "").split():
                if ref not in ids:
                    add("FAIL", "A11Y-08", n.line, f"{attr} references missing id '{ref}'")
        if n.tag == "label" and n.a("for") and n.a("for") not in ids:
            add("FAIL", "A11Y-08", n.line, f"<label for='{n.a('for')}'> references missing id")
        if is_focusable(n) and (n.a("aria-hidden") == "true" or
                                any(a.a("aria-hidden") == "true" for a in n.ancestors())):
            if not any("inert" in a.attrs for a in n.ancestors()):
                add("FAIL", "A11Y-08", n.line, f"focusable <{n.tag}> inside aria-hidden='true'")

    # A11Y-09 images
    for n in by_tag.get("img", []):
        if "alt" not in n.attrs:
            add("FAIL", "A11Y-09", n.line, f"<img src='{n.a('src', '')[:40]}'> has no alt")
        elif re.search(r"\.(png|jpe?g|gif|svg|webp)$|^(image|photo|picture|img)( of)?\b",
                       n.a("alt").strip(), re.I):
            add("WARN", "A11Y-09", n.line, f"alt='{n.a('alt')}' looks like a filename or 'image of'")
    for n in by_tag.get("area", []) + [i for i in by_tag.get("input", []) if i.a("type") == "image"]:
        if not n.a("alt", "").strip():
            add("FAIL", "A11Y-09", n.line, f"<{n.tag}> needs alt text")

    # A11Y-10 svg
    for n in by_tag.get("svg", []):
        if any(a.tag == "svg" for a in n.ancestors()):
            continue
        hidden = n.a("aria-hidden") == "true"
        named = n.a("role") == "img" and (n.a("aria-label") or n.a("aria-labelledby") or
                                          any(c.tag == "title" for c in n.children if isinstance(c, Node)))
        if not hidden and not named:
            add("WARN", "A11Y-10", n.line, "<svg> neither aria-hidden='true' nor role='img' with a name")

    # A11Y-13 keyboard operable
    for n in nodes:
        handlers = [k for k in n.attrs if k in ("onclick", "@click", "v-on:click", "(click)", "ng-click")]
        if handlers and n.tag not in NATIVE_INTERACTIVE:
            if not (n.a("role") and n.a("tabindex") is not None):
                add("FAIL", "A11Y-13", n.line, f"<{n.tag}> has click handler but no role+tabindex (use <button>)")
        if n.tag == "a" and "href" not in n.attrs and handlers:
            add("FAIL", "A11Y-13", n.line, "<a> without href used as a control (use <button>)")
        if n.tag == "a" and n.a("href", "").strip().lower().startswith("javascript:"):
            add("FAIL", "A11Y-13", n.line, "href='javascript:' link (use <button>)")

    # A11Y-16 tabindex
    for n in nodes:
        t = n.a("tabindex")
        if t is not None and re.fullmatch(r"\d+", t.strip()) and int(t) > 0:
            add("FAIL", "A11Y-16", n.line, f"tabindex='{t}' > 0")

    # A11Y-17 focus outline removal
    if re.search(r"outline\s*:\s*(none|0)\b", css) and ":focus-visible" not in css and ":focus" not in css.replace(":focus-within", ""):
        add("FAIL", "A11Y-17", 1, "CSS removes outline with no :focus/:focus-visible replacement")
    elif re.search(r"outline\s*:\s*(none|0)\b", css):
        add("WARN", "A11Y-17", 1, "CSS removes outline somewhere; verify every focusable element has a visible replacement")

    # A11Y-19 skip link
    if not is_fragment:
        focusables = [n for n in nodes if is_focusable(n)]
        first = focusables[0] if focusables else None
        if first is None or first.tag != "a" or not first.a("href", "").startswith("#") \
                or first.a("href")[1:] not in ids:
            add("FAIL", "A11Y-19", first.line if first else 1,
                "first focusable element is not a skip link to an existing #id")

    # A11Y-24 viewport
    for n in by_tag.get("meta", []):
        if n.a("name", "").lower() == "viewport":
            c = n.a("content", "").replace(" ", "").lower()
            if "user-scalable=no" in c or "user-scalable=0" in c:
                add("FAIL", "A11Y-24", n.line, "viewport disables zoom (user-scalable=no)")
            m = re.search(r"maximum-scale=([\d.]+)", c)
            if m and float(m.group(1)) < 2:
                add("FAIL", "A11Y-24", n.line, f"viewport maximum-scale={m.group(1)} < 2")

    # A11Y-30 labels, A11Y-31 autocomplete, A11Y-37 paste
    labelled_for = {n.a("for") for n in by_tag.get("label", []) if n.a("for")}
    for n in by_tag.get("input", []) + by_tag.get("select", []) + by_tag.get("textarea", []):
        typ = n.a("type", "text").lower()
        if n.tag == "input" and typ in ("hidden", "submit", "button", "reset", "image"):
            continue
        has_label = (n.a("id") in labelled_for or any(a.tag == "label" for a in n.ancestors())
                     or n.a("aria-labelledby") or n.a("aria-label", "").strip())
        if not has_label:
            add("FAIL", "A11Y-30", n.line, f"<{n.tag} name='{n.a('name', '')}'> has no label")
        elif not (n.a("id") in labelled_for or any(a.tag == "label" for a in n.ancestors())
                  or n.a("aria-labelledby")):
            add("WARN", "A11Y-30", n.line, f"<{n.tag}> labelled only by aria-label: confirm a visible label exists")
        key = (n.a("name", "") + " " + n.a("id", "")).lower()
        want = {"email": "email", "tel": "tel", "password": "current-password|new-password"}.get(typ)
        if not want:
            want = next((v for k, v in AUTOCOMPLETE_HINTS.items() if k in key), None)
        if want and not n.a("autocomplete"):
            add("WARN", "A11Y-31", n.line, f"<{n.tag} name='{n.a('name', '')}'> likely needs autocomplete='{want}'")
        if "onpaste" in n.attrs:
            add("FAIL", "A11Y-37", n.line, "onpaste handler on input (paste must not be blocked)")

    # A11Y-38 accessible names
    for n in nodes:
        role = n.a("role", "")
        if n.tag in ("button", "a") and (n.tag == "button" or "href" in n.attrs) or \
                role in ("button", "link", "tab", "menuitem", "checkbox", "switch", "radio"):
            if not accessible_name(n, by_id):
                add("FAIL", "A11Y-38", n.line, f"<{n.tag}{' role=' + role if role else ''}> has no accessible name")
            elif n.a("aria-label") and n.all_text() and \
                    n.all_text().lower() not in n.a("aria-label").lower():
                add("FAIL", "A11Y-38", n.line,
                    f"aria-label '{n.a('aria-label')}' doesn't contain visible text '{n.all_text()}' (2.5.3)")

    # A11Y-39 link text
    for n in by_tag.get("a", []):
        txt = accessible_name(n, by_id).lower().strip(" .:>»→")
        if txt in GENERIC_LINK_TEXT:
            add("WARN", "A11Y-39", n.line, f"generic link text '{txt}': ensure context makes purpose clear")
        if n.a("target") == "_blank" and not re.search(r"new (tab|window)", accessible_name(n, by_id), re.I):
            add("WARN", "A11Y-39", n.line, "target=_blank without 'opens in new tab/window' in the name")

    # A11Y-47 reduced motion
    if re.search(r"(@keyframes|animation\s*:|transition\s*:|scroll-behavior\s*:\s*smooth)", css) \
            and "prefers-reduced-motion" not in css:
        add("WARN", "A11Y-47", 1, "BP: animations/transitions without prefers-reduced-motion handling")

    # A11Y-48 autoplay
    for n in by_tag.get("video", []) + by_tag.get("audio", []):
        if "autoplay" in n.attrs and "muted" not in n.attrs:
            add("WARN", "A11Y-48", n.line, f"<{n.tag} autoplay> with sound: needs pause/stop or mute control")
        if "autoplay" in n.attrs and "controls" not in n.attrs:
            add("WARN", "A11Y-45", n.line, f"<{n.tag} autoplay> without controls: needs pause/stop")
        if n.tag == "video" and not any(c.tag == "track" and c.a("kind", "subtitles") in ("captions", "subtitles")
                                        for c in n.iter()):
            add("WARN", "A11Y-11", n.line, "<video> has no captions <track> (fine only if no audio or captions are burned in)")

    return findings


def accessible_name_label_only(n, by_id):
    if n.a("aria-labelledby"):
        return " ".join(by_id[i].all_text() for i in n.a("aria-labelledby").split() if i in by_id)
    return n.a("aria-label", "").strip()


def collect(paths, exts):
    for p in paths:
        if os.path.isdir(p):
            for root, dirs, files in os.walk(p):
                dirs[:] = [d for d in dirs if d not in ("node_modules", ".git")]
                for f in sorted(files):
                    if f.lower().endswith(exts):
                        yield os.path.join(root, f)
        else:
            yield p


def cmd_lint(paths):
    css_files = list(collect(paths, (".css",)))
    extra_css = ""
    for c in css_files:
        with open(c, encoding="utf-8", errors="replace") as f:
            extra_css += f.read() + "\n"
    files = [f for f in collect(paths, (".html", ".htm")) if f.lower().endswith((".html", ".htm"))]
    if not files:
        print("No .html/.htm files found. Build the page first or lint the rendered output.")
        return 2
    all_f = []
    for f in files:
        all_f += lint_file(f, extra_css)
    for level, cid, loc, msg in sorted(all_f, key=lambda x: (x[0] != "FAIL", x[1], x[2])):
        print(f"{level} {cid} {loc} {msg}")
    nfail = sum(1 for x in all_f if x[0] == "FAIL")
    nwarn = len(all_f) - nfail
    print(f"\n{len(files)} file(s): {nfail} FAIL, {nwarn} WARN. "
          "Static lint covers a subset of AUTO criteria; BROWSER/MANUAL checks still required.")
    return 1 if nfail else 0


def parse_color(s):
    s = s.strip().lower()
    m = re.fullmatch(r"#([0-9a-f]{3}|[0-9a-f]{6})", s)
    if m:
        h = m.group(1)
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    m = re.fullmatch(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(,\s*[\d.]+\s*)?\)", s)
    if m:
        return tuple(int(m.group(i)) for i in (1, 2, 3))
    raise ValueError(f"unsupported color '{s}' (use #rgb, #rrggbb or rgb())")


def luminance(rgb):
    def ch(c):
        c = c / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(fg, bg):
    l1, l2 = sorted((luminance(parse_color(fg)), luminance(parse_color(bg))), reverse=True)
    return (l1 + 0.05) / (l2 + 0.05)


def cmd_contrast(fg, bg):
    r = contrast_ratio(fg, bg)
    shown = int(r * 100) / 100  # truncate, never round up to a pass
    ok = lambda t: "PASS" if r >= t else "FAIL"
    print(f"{fg} on {bg}: {shown}:1")
    print(f"  A11Y-21 normal text (>=4.5): {ok(4.5)}")
    print(f"  A11Y-21 large text  (>=3.0): {ok(3.0)}")
    print(f"  A11Y-22 non-text/UI (>=3.0): {ok(3.0)}")
    return 0 if r >= 4.5 else 1


def main(argv):
    if len(argv) >= 2 and argv[0] == "lint":
        return cmd_lint(argv[1:])
    if len(argv) == 3 and argv[0] == "contrast":
        return cmd_contrast(argv[1], argv[2])
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
