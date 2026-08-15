import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("e2e script is registered", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.match(packageJson.scripts["test:e2e"], /run-extension-e2e/);
});
