import { describe, expect, test } from "bun:test";

import { webpageLink } from "../public/webpage-link.ts";

describe("webpageLink", () => {
  test("an address with a scheme, padded or not, is the page", () => {
    expect(webpageLink("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(webpageLink("  \n http://EXAMPLE.com \t\n")).toBe("http://example.com/");
    expect(webpageLink("HTTPS://localhost:3000/x")).toBe("https://localhost:3000/x");
    expect(webpageLink("<https://example.com/a>")).toBe("https://example.com/a");
  });

  test("without a scheme, a host name with a top-level domain is taken as https", () => {
    expect(webpageLink("example.com")).toBe("https://example.com/");
    expect(webpageLink("www.example.org/path/to?q=1")).toBe("https://www.example.org/path/to?q=1");
    expect(webpageLink("sub-domain.example.co.uk:8443/")).toBe("https://sub-domain.example.co.uk:8443/");
    expect(webpageLink("例子.测试/页面")).toBe("https://xn--fsqu00a.xn--0zwm56d/%E9%A1%B5%E9%9D%A2");
    // Permissive: the user is asked before anything is fetched.
    expect(webpageLink("Node.js")).toBe("https://node.js/");
  });

  test("anything else is text", () => {
    for (const text of [
      "",
      "   ",
      "Hello",
      "see https://example.com",
      "https://example.com and more",
      "example.com\nexample.org",
      "3.14",
      "e.g.",
      "v1.2",
      "a@example.com",
      "mailto:a@example.com",
      "ftp://example.com/",
      "https://",
      "https://user:pass@example.com/",
      "-example.com",
      "example.c",
    ]) {
      expect({ text, link: webpageLink(text) }).toStrictEqual({ text, link: null });
    }
  });
});
