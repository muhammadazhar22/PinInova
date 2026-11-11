import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PURGED_TABLES } from "./purge";

// SPEC-074 option A: backups leave out exactly the Pinterest data that "disconnect = delete" purges. If a table is
// added to the purge but not to the backup exclusion list, backups would keep that data after a disconnect.
describe("backup exclusion list", () => {
  it("matches the tables the disconnect purge deletes", () => {
    const file = fileURLToPath(new URL("../../../../../infra/backup/pinterest-data-tables.txt", import.meta.url));
    const listed = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    expect([...listed].sort()).toEqual([...PURGED_TABLES].sort());
  });
});
