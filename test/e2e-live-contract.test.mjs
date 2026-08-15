import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("automated extension E2E stays separate from the operator-only live smoke", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const readme = await readFile("README.md", "utf8");
  const gitignore = await readFile(".gitignore", "utf8");
  const automatedE2E = packageJson.scripts["test:e2e"];
  const liveSmoke = packageJson.scripts["test:e2e:live"];

  assert.equal(packageJson.scripts.test, "node --test test/*.test.mjs");
  assert.match(automatedE2E, /run-extension-e2e/);
  assert.doesNotMatch(automatedE2E, /run-live-smoke/);
  assert.match(liveSmoke, /run-live-smoke/);
  assert.doesNotMatch(liveSmoke, /run-extension-e2e/);
  assert.match(readme, /npm run test:e2e:live/);
  assert.match(readme, /log in.*yourself/i);
  assert.match(gitignore, /^\.playwright\/$/m);
});
