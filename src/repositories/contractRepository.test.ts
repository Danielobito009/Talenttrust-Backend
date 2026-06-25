/**
 * Integration tests for ContractRepository.
 *
 * Each test suite starts with a clean in-memory database so tests are
 * fully isolated and do not write to disk.  We pre-create two user rows to
 * satisfy the foreign-key constraints on `contracts.client_id` and
 * `contracts.freelancer_id`.
 */

import { getDb, closeDb } from "../db/database";
import { ContractRepository } from "./contractRepository";
import { UserRepository } from "./userRepository";

let contractRepo: ContractRepository;
let clientId: string;
let freelancerId: string;

beforeEach(() => {
  const db = getDb(":memory:");
  contractRepo = new ContractRepository(db);

  // Seed two users that contracts can reference
  const userRepo = new UserRepository(db);
  clientId = userRepo.create({
    username: "client1",
    email: "client@example.com",
    role: "client",
  }).id;
  freelancerId = userRepo.create({
    username: "freelancer1",
    email: "freelancer@example.com",
    role: "freelancer",
  }).id;
});

afterEach(() => {
  closeDb();
});

const baseData = () => ({
  title: "Build Stellar integration",
  clientId,
  freelancerId,
  amount: 5_000_000, // 0.5 XLM in stroops
});

// ---------------------------------------------------------------------------
// Existing CRUD tests (unchanged)
// ---------------------------------------------------------------------------

describe("ContractRepository.findAll", () => {
  it("returns an empty array when no contracts exist", () => {
    expect(contractRepo.findAll()).toEqual([]);
  });

  it("returns all created contracts (both present)", () => {
    contractRepo.create({ ...baseData(), title: "First" });
    contractRepo.create({ ...baseData(), title: "Second" });
    const all = contractRepo.findAll();
    expect(all).toHaveLength(2);
    const titles = all.map((c) => c.title).sort();
    expect(titles).toEqual(["First", "Second"]);
  });
});

describe("ContractRepository.create", () => {
  it("creates a contract and returns it with a generated id", () => {
    const contract = contractRepo.create(baseData());
    expect(contract.id).toBeDefined();
    expect(contract.title).toBe("Build Stellar integration");
    expect(contract.clientId).toBe(clientId);
    expect(contract.freelancerId).toBe(freelancerId);
    expect(contract.amount).toBe(5_000_000);
    expect(contract.status).toBe("draft");
    expect(contract.createdAt).toBeDefined();
  });

  it("uses the provided status when given", () => {
    const contract = contractRepo.create({ ...baseData(), status: "active" });
    expect(contract.status).toBe("active");
  });

  it("persists the contract so findAll returns it", () => {
    const created = contractRepo.create(baseData());
    const all = contractRepo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(created.id);
  });

  it("throws when an invalid status is supplied (DB constraint)", () => {
    expect(() =>
      contractRepo.create({ ...baseData(), status: "invalid" as "draft" }),
    ).toThrow();
  });
});

describe("ContractRepository.findById", () => {
  it("returns the contract when the id exists", () => {
    const created = contractRepo.create(baseData());
    const found = contractRepo.findById(created.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
  });

  it("returns undefined for a non-existent id", () => {
    expect(contractRepo.findById("non-existent-id")).toBeUndefined();
  });
});

describe("ContractRepository.findByClientId", () => {
  it("returns contracts matching the client id", () => {
    contractRepo.create(baseData());
    contractRepo.create(baseData());
    const results = contractRepo.findByClientId(clientId);
    expect(results).toHaveLength(2);
    results.forEach((c) => expect(c.clientId).toBe(clientId));
  });

  it("returns empty array when client has no contracts", () => {
    expect(contractRepo.findByClientId("unknown-client")).toEqual([]);
  });
});

describe("ContractRepository.updateStatus", () => {
  it("updates the status and returns the updated contract", () => {
    const created = contractRepo.create(baseData());
    const updated = contractRepo.updateStatus(created.id, "active");
    expect(updated).toBeDefined();
    expect(updated?.status).toBe("active");
    expect(updated?.id).toBe(created.id);
  });

  it("returns undefined for a non-existent id", () => {
    const result = contractRepo.updateStatus("does-not-exist", "completed");
    expect(result).toBeUndefined();
  });

  it("persists status change across subsequent reads", () => {
    const created = contractRepo.create(baseData());
    contractRepo.updateStatus(created.id, "completed");
    const fetched = contractRepo.findById(created.id);
    expect(fetched?.status).toBe("completed");
  });

  it("transitions through all valid statuses", () => {
    const statuses = ["active", "completed", "disputed", "cancelled"] as const;
    const created = contractRepo.create(baseData());
    for (const s of statuses) {
      const updated = contractRepo.updateStatus(created.id, s);
      expect(updated?.status).toBe(s);
    }
  });
});

describe("ContractRepository.delete", () => {
  it("returns true and removes the contract", () => {
    const created = contractRepo.create(baseData());
    const result = contractRepo.delete(created.id);
    expect(result).toBe(true);
    expect(contractRepo.findById(created.id)).toBeUndefined();
  });

  it("returns false for a non-existent id", () => {
    expect(contractRepo.delete("ghost-id")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cursor-paginated findPage tests
// ---------------------------------------------------------------------------

/**
 * Helper: seed `count` contracts with deliberately spaced timestamps so the
 * ordering is deterministic and easy to reason about.
 *
 * Returns them in the order they were inserted (ascending by createdAt).
 * The repository returns them in descending order.
 */
function seedContracts(count: number) {
  const db = (contractRepo as any).db;
  const results: ReturnType<typeof contractRepo.create>[] = [];

  for (let i = 0; i < count; i++) {
    // Insert rows directly with explicit timestamps so ordering is predictable
    const id = require("crypto").randomUUID() as string;
    // Space each row 1 second apart: 2024-01-01T00:00:00Z, T00:00:01Z, …
    const ts = new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString();
    db.prepare(
      `INSERT INTO contracts (id, title, client_id, freelancer_id, amount, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
    ).run(id, `Contract ${i + 1}`, clientId, freelancerId, 1_000_000, ts);
    results.push({ id, title: `Contract ${i + 1}`, clientId, freelancerId, amount: 1_000_000, status: "draft", createdAt: ts });
  }
  return results;
}

describe("ContractRepository.findPage — empty table", () => {
  it("returns an empty page with no nextCursor", () => {
    const page = contractRepo.findPage();
    expect(page.data).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
    expect(page.hasNextPage).toBe(false);
  });

  it("respects limit even on empty table", () => {
    const page = contractRepo.findPage({ limit: 5 });
    expect(page.limit).toBe(5);
    expect(page.data).toHaveLength(0);
  });
});

describe("ContractRepository.findPage — single page (all fits)", () => {
  it("returns all items when count ≤ limit, no nextCursor", () => {
    seedContracts(3);
    const page = contractRepo.findPage({ limit: 10 });
    expect(page.data).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
    expect(page.hasNextPage).toBe(false);
  });

  it("returns items in descending createdAt order", () => {
    seedContracts(3);
    const page = contractRepo.findPage({ limit: 10 });
    // Titles are "Contract 1", "Contract 2", "Contract 3" seeded ascending,
    // so descending order should be 3 → 2 → 1
    expect(page.data.map((c) => c.title)).toEqual([
      "Contract 3",
      "Contract 2",
      "Contract 1",
    ]);
  });

  it("returns correct limit in response metadata", () => {
    seedContracts(2);
    const page = contractRepo.findPage({ limit: 50 });
    expect(page.limit).toBe(50);
  });
});

describe("ContractRepository.findPage — multi-page traversal", () => {
  it("traverses all pages without skipping or duplicating items", () => {
    const total = 25;
    seedContracts(total);
    const pageSize = 10;
    const seen = new Set<string>();
    let cursor: string | undefined = undefined;
    let iterations = 0;

    while (true) {
      const page = contractRepo.findPage({ limit: pageSize, cursor });
      for (const contract of page.data) {
        expect(seen.has(contract.id)).toBe(false); // no duplicates
        seen.add(contract.id);
      }
      iterations++;
      if (!page.hasNextPage) break;
      cursor = page.nextCursor!;
      // Guard against infinite loops
      if (iterations > total) throw new Error("Infinite pagination loop");
    }

    expect(seen.size).toBe(total); // all items seen exactly once
  });

  it("produces a non-null nextCursor when more items exist", () => {
    seedContracts(5);
    const page = contractRepo.findPage({ limit: 3 });
    expect(page.nextCursor).not.toBeNull();
    expect(page.hasNextPage).toBe(true);
    expect(page.data).toHaveLength(3);
  });

  it("last page has null nextCursor", () => {
    seedContracts(5);
    const page1 = contractRepo.findPage({ limit: 3 });
    const page2 = contractRepo.findPage({
      limit: 3,
      cursor: page1.nextCursor!,
    });
    expect(page2.data).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    expect(page2.hasNextPage).toBe(false);
  });

  it("stable ordering: page 1 newest, page 2 older items", () => {
    seedContracts(6);
    const page1 = contractRepo.findPage({ limit: 3 });
    const page2 = contractRepo.findPage({
      limit: 3,
      cursor: page1.nextCursor!,
    });

    // All items on page 1 must be newer than all items on page 2
    const newestOnPage2 = new Date(page2.data[0]!.createdAt).getTime();
    const oldestOnPage1 = new Date(
      page1.data[page1.data.length - 1]!.createdAt,
    ).getTime();
    expect(oldestOnPage1).toBeGreaterThan(newestOnPage2);
  });
});

describe("ContractRepository.findPage — limit validation", () => {
  it("throws when limit exceeds 100", () => {
    expect(() => contractRepo.findPage({ limit: 101 })).toThrow(
      /exceeds maximum/i,
    );
  });

  it("throws when limit is 0", () => {
    expect(() => contractRepo.findPage({ limit: 0 })).toThrow(
      /positive integer/i,
    );
  });

  it("throws when limit is negative", () => {
    expect(() => contractRepo.findPage({ limit: -5 })).toThrow(
      /positive integer/i,
    );
  });

  it("accepts limit = 1 (minimum valid)", () => {
    seedContracts(3);
    const page = contractRepo.findPage({ limit: 1 });
    expect(page.data).toHaveLength(1);
    expect(page.limit).toBe(1);
  });

  it("accepts limit = 100 (maximum valid)", () => {
    seedContracts(5);
    const page = contractRepo.findPage({ limit: 100 });
    expect(page.data).toHaveLength(5);
  });

  it("uses default limit of 20 when limit is omitted", () => {
    const page = contractRepo.findPage({});
    expect(page.limit).toBe(20);
  });
});

describe("ContractRepository.findPage — invalid cursor", () => {
  it("throws on a completely garbage cursor string", () => {
    expect(() =>
      contractRepo.findPage({ cursor: "not-a-valid-cursor" }),
    ).toThrow(/invalid pagination cursor/i);
  });

  it("throws on a base64 string that is not valid JSON", () => {
    const bad = Buffer.from("this is not json", "utf8").toString("base64url");
    expect(() => contractRepo.findPage({ cursor: bad })).toThrow(
      /invalid pagination cursor/i,
    );
  });

  it("throws on a cursor with missing id field", () => {
    const bad = Buffer.from(
      JSON.stringify({ createdAt: "2024-01-01T00:00:00.000Z" }),
      "utf8",
    ).toString("base64url");
    expect(() => contractRepo.findPage({ cursor: bad })).toThrow(
      /invalid pagination cursor/i,
    );
  });

  it("throws on a cursor with an invalid createdAt date", () => {
    const bad = Buffer.from(
      JSON.stringify({ createdAt: "not-a-date", id: "some-uuid" }),
      "utf8",
    ).toString("base64url");
    expect(() => contractRepo.findPage({ cursor: bad })).toThrow(
      /invalid pagination cursor/i,
    );
  });

  it("returns empty page for a cursor past the last item", () => {
    seedContracts(3);
    // Navigate to last page first
    const page1 = contractRepo.findPage({ limit: 2 });
    const page2 = contractRepo.findPage({
      limit: 2,
      cursor: page1.nextCursor!,
    });
    // page2 is the last page; using its cursor (if any) should yield nothing
    if (page2.nextCursor) {
      const page3 = contractRepo.findPage({
        limit: 2,
        cursor: page2.nextCursor,
      });
      expect(page3.data).toHaveLength(0);
      expect(page3.hasNextPage).toBe(false);
    } else {
      // Already confirmed last page
      expect(page2.hasNextPage).toBe(false);
    }
  });
});

describe("ContractRepository.findPage — timestamp collision tie-breaking", () => {
  it("handles multiple rows with identical timestamps without skipping", () => {
    const db = (contractRepo as any).db;
    const sameTs = "2024-06-01T12:00:00.000Z";

    // Insert 5 rows all with the same timestamp; only id differs
    for (let i = 0; i < 5; i++) {
      const id = require("crypto").randomUUID() as string;
      db.prepare(
        `INSERT INTO contracts (id, title, client_id, freelancer_id, amount, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
      ).run(
        id,
        `Collision Contract ${i + 1}`,
        clientId,
        freelancerId,
        1_000_000,
        sameTs,
      );
    }

    const seen = new Set<string>();
    let cursor: string | undefined = undefined;

    for (let i = 0; i < 10; i++) {
      const page = contractRepo.findPage({ limit: 2, cursor });
      for (const c of page.data) {
        expect(seen.has(c.id)).toBe(false);
        seen.add(c.id);
      }
      if (!page.hasNextPage) break;
      cursor = page.nextCursor!;
    }

    expect(seen.size).toBe(5);
  });
});
