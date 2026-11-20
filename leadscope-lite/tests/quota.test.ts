// Uruchom: node --test tests/quota.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileQuota } from "../src/quota.ts";
import { runJob, type Job } from "../src/job.ts";
import { mockProviders } from "../src/providers.ts";
import { REGIONS } from "../../leadscope/supabase/functions/_shared/core/regions.ts";

test("limit zatrzymuje się dokładnie na progu i przetrwa restart", () => {
  const file = join(mkdtempSync(join(tmpdir(), "q-")), "usage.json");
  const q = fileQuota(file, 3);
  assert.equal(q.take(), true); assert.equal(q.take(), true); assert.equal(q.take(), true);
  assert.equal(q.take(), false);
  const again = fileQuota(file, 3); // "restart programu"
  assert.equal(again.take(), false);
  assert.equal(again.status().remaining, 0);
});

test("nowy miesiąc zeruje licznik", () => {
  const file = join(mkdtempSync(join(tmpdir(), "q-")), "usage.json");
  writeFileSync(file, JSON.stringify({ month: "2000-01", used: 999 }));
  const q = fileQuota(file, 5);
  assert.equal(q.take(), true);
  assert.equal(JSON.parse(readFileSync(file, "utf-8")).used, 1);
});

test("wyszukiwanie nie przekracza limitu i zwraca zebrane firmy", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "q-")), "usage.json");
  const q = fileQuota(file, 2);
  const job: Job = {
    id: "t", status: "running", stage: "", progress: 0, places_requests: 0, biala_lista_requests: 0, leads: [], created_at: Date.now(), cancel: false,
    params: { phrases: ["a", "b", "c"], region: REGIONS.find((r) => r.code === "12")!, crawl_websites: false, use_biala_lista: false, max_results: 200 },
  };
  await runJob(job, mockProviders(), q);
  assert.equal(job.places_requests, 2);
  assert.ok(job.quota_note?.includes("limit"));
  assert.ok(job.leads.length > 0);
  assert.equal(job.status, "done");
});
