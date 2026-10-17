import { describe, expect, it, vi } from "vitest";

// Completely fake MTProto methods. No credentials, network or recipients are used.
vi.mock("telegram", () => ({
  Api: {
    InputUser: class {
      constructor(public options: unknown) {}
    },
    channels: {
      InviteToChannel: class {
        constructor(public options: unknown) {}
      },
    },
  },
}));

import { inviteUsers } from "./tginvite-mtproto";

function fakeClient(reply: (call: number) => Promise<unknown>) {
  let calls = 0;
  const invoke = vi.fn(async (_request: unknown) => {
    calls += 1;
    return reply(calls);
  });
  const getEntity = vi.fn(async (_name: string) => ({ id: 444 }));
  return { client: { connected: true, getEntity, invoke }, invoke, getEntity };
}
const recipients = Array.from({ length: 12 }, (_, i) => ({
  id: 1000 + i, accessHash: "fake-hash",
}));

describe("mocked Telegram invitation transport", () => {
  it("reconciles missing recipients instead of counting full batch as success", async () => {
    const { client, invoke, getEntity } = fakeClient(async (count) => ({
      updates: { updates: [] },
      missingInvitees: count === 1 ? [{ userId: 1005 }] : [],
    }));
    const result = await inviteUsers(client, "@owned_sandbox", recipients);
    expect(result).toMatchObject({
      invited: 11, failed: 1, unknown: 0, unattempted: 0,
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(getEntity).toHaveBeenCalledWith("owned_sandbox");
  });

  it("never retries an RPC error or claims a failed call succeeded", async () => {
    const { client, invoke } = fakeClient(async () => {
      throw new Error("FLOOD_WAIT_600");
    });
    const result = await inviteUsers(client, "@owned_sandbox", recipients);
    expect(result).toMatchObject({
      invited: 0, failed: 0, unknown: 10, unattempted: 2,
    });
    expect(result.errors[0]).toContain("FLOOD_WAIT");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("halts when MTProto response has no verifiable recipient information", async () => {
    const { client, invoke } = fakeClient(async () => ({ updates: [] }));
    const result = await inviteUsers(client, "@owned_sandbox", recipients);
    expect(result).toMatchObject({
      invited: 0, failed: 0, unknown: 10, unattempted: 2,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("recipient validation before any Telegram call", () => {
  it("rejects duplicate recipient IDs without network effects", async () => {
    const { client, invoke, getEntity } = fakeClient(async () => ({
      updates: {}, missingInvitees: [],
    }));
    const res = await inviteUsers(client, "@owned_sandbox", [
      { id: 1, accessHash: "x" }, { id: 1, accessHash: "y" },
    ]);
    expect(res).toMatchObject({ invited: 0, unknown: 0, unattempted: 2 });
    expect(getEntity).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects unsafe JavaScript integer IDs without trying to invite anyone", async () => {
    const { client, invoke, getEntity } = fakeClient(async () => ({
      updates: {}, missingInvitees: [],
    }));
    const res = await inviteUsers(client, "@owned_sandbox", [{
      id: Number.MAX_SAFE_INTEGER + 2, accessHash: "x",
    }]);
    expect(res.unattempted).toBe(1);
    expect(invoke).not.toHaveBeenCalled();
    expect(getEntity).not.toHaveBeenCalled();
  });
});
