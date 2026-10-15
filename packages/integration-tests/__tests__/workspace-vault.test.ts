import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { startWorkspaceVaultFixture } from "../src/workspace-vault-fixture.js";

it("restores authenticated workspace RPC state, registers/reopens the new copy and fences retries by caller", async () => {
  const network = new NetworkInterceptor({ handlers: [] });
  network.install();
  let fixture: Awaited<ReturnType<typeof startWorkspaceVaultFixture>> | undefined;
  try {
    fixture = await startWorkspaceVaultFixture("https://os.example");
    const snapshot = JSON.parse(fixture.snapshot);
    expect(snapshot.records).toContainEqual(["version", 5]);
    expect(snapshot.gadgets).toHaveLength(1);
    expect(snapshot.gadgets[0].state.schema.map((entry: { name: string }) => entry.name))
        .toEqual(["notes"]);
    const operationId = randomUUID();
    const id = await fixture.restore(fixture.snapshot, operationId);
    await expect(fixture.restoreRaw(JSON.stringify({ ...snapshot, title: "Changed retry" }), operationId))
        .rejects.toThrow("does not match");
    // Operation IDs are scoped to the authenticated caller: a second owner receives a different copy.
    expect(await fixture.restoreAsOther(fixture.snapshot, operationId)).not.toBe(id);
    await expect(fixture.restoreRaw(fixture.snapshot, "invalid-operation")).rejects.toThrow();
  } finally {
    await fixture?.close();
    try { expect(network.getUnmockedCalls()).toEqual([]); }
    finally { network.uninstall(); }
  }
});
