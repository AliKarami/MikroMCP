import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slugForWikiName,
  extractTitle,
  transform,
  rewriteWikiLinks,
} from "./sync-wiki.mjs";

test("slugForWikiName maps Home to index slug", () => {
  assert.equal(slugForWikiName("Home"), "");
});

test("slugForWikiName lowercases and keeps hyphens", () => {
  assert.equal(slugForWikiName("Getting-Started"), "getting-started");
  assert.equal(slugForWikiName("RouterOS-API-Setup"), "routeros-api-setup");
});

test("extractTitle returns first H1 text", () => {
  assert.equal(
    extractTitle("# Getting Started with MikroMCP\n\nbody"),
    "Getting Started with MikroMCP",
  );
});

test("extractTitle falls back to filename-derived title when no H1", () => {
  assert.equal(extractTitle("no heading here", "Some-Page"), "Some Page");
});

test("transform strips the leading H1 and adds frontmatter", () => {
  const out = transform("# Architecture\n\nSome text.", "Architecture", 3);
  assert.match(out, /^---\ntitle: Architecture\nsidebar:\n  order: 3\n---\n/);
  assert.doesNotMatch(out, /^# Architecture/m);
  assert.match(out, /Some text\./);
});

test("transform escapes a title containing a colon", () => {
  const out = transform("# Foo: Bar\n\nx", "Foo: Bar", 1);
  assert.match(out, /title: "Foo: Bar"/);
});

test("rewriteWikiLinks rewrites a bare wiki link to a root route", () => {
  assert.equal(
    rewriteWikiLinks("see [Architecture](Architecture)."),
    "see [Architecture](/architecture/).",
  );
});

test("rewriteWikiLinks preserves anchors", () => {
  assert.equal(
    rewriteWikiLinks("[setup](RouterOS-API-Setup#required-policies-by-tool-category)"),
    "[setup](/routeros-api-setup/#required-policies-by-tool-category)",
  );
});

test("rewriteWikiLinks maps Home to site root", () => {
  assert.equal(rewriteWikiLinks("[home](Home)"), "[home](/)");
});

test("rewriteWikiLinks leaves external links untouched", () => {
  const s = "[mcp](https://modelcontextprotocol.io) and [x](Architecture)";
  assert.equal(
    rewriteWikiLinks(s),
    "[mcp](https://modelcontextprotocol.io) and [x](/architecture/)",
  );
});

test("rewriteWikiLinks leaves unknown targets untouched", () => {
  assert.equal(rewriteWikiLinks("[y](Not-A-Wiki-Page)"), "[y](Not-A-Wiki-Page)");
});
