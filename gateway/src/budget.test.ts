import { expect, test } from "bun:test";
import { OwnerBudget, reserve, type Storage } from "./budget";

test("global daily budget, expired leases and UTC rollover", () => {
  const first = reserve(undefined, 100000, "first");
  expect(first.status).toBe("allowed"); expect(first.record.count).toBe(1);
  expect(reserve(first.record, 100001, "second").status).toBe("busy");
  expect(reserve(first.record, 165001, "second").status).toBe("allowed");
  const full = { ...first.record, count: 200, lease: null };
  expect(reserve(full, 200000, "next").status).toBe("daily_limit");
  expect(reserve(full, 86400000, "next").record.count).toBe(1);
  expect(reserve({ ...full, lease: "old", expires: 86401000 }, 86400000, "next").status).toBe("busy");
});
test("late release cannot unlock a newer in-flight request", async () => {
  let value: unknown;
  const storage: Storage = { get: async <T>() => structuredClone(value) as T | undefined, put: async (_key, v) => { value = structuredClone(v); }, transaction: async callback => callback(storage) };
  const budget = new OwnerBudget({ storage });
  const acquire = () => budget.fetch(new Request("https://budget/acquire", { method: "POST" })).then(r => r.json()) as Promise<any>;
  const first = await acquire();
  await budget.fetch(new Request("https://budget/release", { method: "POST", body: "forged-or-old" }));
  expect((await acquire()).status).toBe("busy");
  await budget.fetch(new Request("https://budget/release", { method: "POST", body: first.lease }));
  const second = await acquire(); expect(second.status).toBe("allowed");
  await budget.fetch(new Request("https://budget/release", { method: "POST", body: first.lease }));
  expect((await acquire()).status).toBe("busy");
});
