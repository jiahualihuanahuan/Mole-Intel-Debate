import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const engine = path.join(__dirname, "engine.mjs");

describe("debate engine CLI", () => {
  it("prints usage and exits 2 with no args", () => {
    const r = spawnSync(process.execPath, [engine], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Usage/);
  });

  it("rejects an unknown flag gracefully", () => {
    const r = spawnSync(process.execPath, [engine, "--nope"], { encoding: "utf8" });
    assert.notEqual(r.status, 0);
  });
});

describe("JSON extraction helpers (inlined copy for unit testing)", () => {
  function stripThink(raw) {
    return String(raw || "")
      .replace(/<think>[\s\S]*?<\/think>/gi, " ")
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, " ")
      .replace(/<think>[\s\S]*$/i, " ")
      .trim();
  }
  function extractJson(raw) {
    const text = stripThink(raw);
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  it("strips think tags and parses JSON", () => {
    const raw = `<think>step 1</think>\n{"thesis":"x","confidence":0.7}`;
    assert.deepEqual(extractJson(raw), { thesis: "x", confidence: 0.7 });
  });

  it("returns null for non-JSON", () => {
    assert.equal(extractJson("no json here"), null);
  });

  it("takes the last complete object when multiple appear", () => {
    const raw = `{"a":1} trailing {"b":2}`;
    assert.deepEqual(extractJson(raw), { b: 2 });
  });
});
