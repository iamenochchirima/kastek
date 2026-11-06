import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppSwitcher,
  KasitekAppList,
  buildKasitekAppLinks,
  isSafeAppUrl,
} from "../dist/app-switcher.js";

test("only safe absolute and root-relative app URLs are accepted", () => {
  assert.equal(isSafeAppUrl("https://agents.example.com"), true);
  assert.equal(isSafeAppUrl("http://localhost:3100/app/overview"), true);
  assert.equal(isSafeAppUrl("/app/overview"), true);
  for (const unsafe of [
    "",
    "javascript:alert(1)",
    "data:text/html,hi",
    "//evil.example/path",
    "ftp://files.example/x",
    "/\\evil.example",
    "agents.example.com/app",
  ]) {
    assert.equal(isSafeAppUrl(unsafe), false);
  }
});

test("sibling links omit missing or unsafe URLs but the current app always renders", () => {
  const links = buildKasitekAppLinks({
    current: "growth",
    agentsUrl: "javascript:alert(1)",
  });
  assert.deepEqual(
    links.map((link) => link.id),
    ["growth"],
  );
  assert.equal(links[0].current, true);
});

test("all three apps resolve in a fixed order with the current app marked", () => {
  const links = buildKasitekAppLinks({
    current: "agents",
    growthUrl: "https://growth.example.com/workspace/",
    agentsUrl: "https://agents.example.com/app/overview",
    agencyUrl: "https://agency.example.com/",
  });
  assert.deepEqual(
    links.map((link) => link.id),
    ["growth", "agents", "agency"],
  );
  assert.equal(links[1].current, true);
  assert.equal(links[0].href, "https://growth.example.com/workspace");
  assert.equal(links[2].href, "https://agency.example.com");
});

test("app list links to siblings with plain anchors and marks the current app", () => {
  const links = buildKasitekAppLinks({
    current: "growth",
    growthUrl: "https://growth.example.com/workspace",
    agentsUrl: "https://agents.example.com/app/overview",
    agencyUrl: "https://agency.example.com/",
  });
  const html = renderToStaticMarkup(createElement(KasitekAppList, { apps: links }));
  assert.match(html, /href="https:\/\/agents\.example\.com\/app\/overview"/);
  assert.match(html, /href="https:\/\/agency\.example\.com"/);
  assert.doesNotMatch(html, /href="https:\/\/growth\.example\.com/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /Current/);
  assert.doesNotMatch(html, /javascript:/);
});

test("switcher trigger names the current app for assistive technology", () => {
  const links = buildKasitekAppLinks({
    current: "agency",
    agencyUrl: "https://agency.example.com/",
  });
  const html = renderToStaticMarkup(
    createElement(AppSwitcher, { current: "agency", apps: links }),
  );
  assert.match(html, /aria-label="Switch apps, current app Agency"/);
});
