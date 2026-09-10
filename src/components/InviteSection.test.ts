import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { InviteSection } from "./InviteSection";

afterEach(() => vi.unstubAllGlobals());

it("renders Usage's invite section without starting requests or entering a render loop", () => {
  const fetch = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetch);

  const markup = renderToStaticMarkup(createElement(InviteSection));

  expect(markup).toContain("Invite &amp; Share");
  expect(markup).toContain("Loading invite link…");
  expect(markup).not.toContain("Link copied");
  expect(fetch).not.toHaveBeenCalled();
});
