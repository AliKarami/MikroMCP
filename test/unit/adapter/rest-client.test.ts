import { describe, it, expect, vi, beforeEach } from "vitest";
import { RouterOSRestClient } from "../../../src/adapter/rest-client.js";
import type { RouterConfig } from "../../../src/types.js";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock("undici", () => ({
  request: requestMock,
  buildConnector: vi.fn(),
  Agent: class {
    close(): void {}
  },
}));

function jsonResponse(body: unknown): {
  statusCode: number;
  body: { text: () => Promise<string> };
} {
  return { statusCode: 200, body: { text: () => Promise.resolve(JSON.stringify(body)) } };
}

function emptyResponse(): { statusCode: number; body: { text: () => Promise<string> } } {
  return { statusCode: 200, body: { text: () => Promise.resolve("") } };
}

const config: RouterConfig = {
  id: "test-router",
  host: "192.0.2.1",
  port: 80,
  tls: { enabled: false, rejectUnauthorized: true },
  credentials: { source: "env", envPrefix: "ROUTER_TEST" },
  tags: [],
  rosVersion: "7",
};

function makeClient(): RouterOSRestClient {
  return new RouterOSRestClient(config, { username: "admin", password: "secret" });
}

describe("RouterOSRestClient.get", () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it("GETs the bare collection path without options", async () => {
    requestMock.mockResolvedValue(jsonResponse([{ ".id": "*1", name: "ether1" }]));
    const records = await makeClient().get("interface");
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0]).toBe("http://192.0.2.1:80/rest/interface");
    expect(requestMock.mock.calls[0][1]).toMatchObject({ method: "GET" });
    expect(records).toHaveLength(1);
  });

  it("GETs with query params for a simple filter", async () => {
    requestMock.mockResolvedValue(jsonResponse([]));
    await makeClient().get("interface", { filter: { name: "ether1" } });
    expect(requestMock.mock.calls[0][0]).toBe("http://192.0.2.1:80/rest/interface?name=ether1");
    expect(requestMock.mock.calls[0][1]).toMatchObject({ method: "GET" });
  });

  it("percent-encodes spaces in filter values instead of using +", async () => {
    // Regression: RouterOS does not decode `+` as a space, so a comment-keyed
    // lookup like comment="DNS -> AGH:53" matched nothing and broke idempotency.
    requestMock.mockResolvedValue(jsonResponse([]));
    await makeClient().get("ip/firewall/nat", { filter: { comment: "DNS -> AGH:53" } });
    expect(requestMock.mock.calls[0][0]).toBe(
      "http://192.0.2.1:80/rest/ip/firewall/nat?comment=DNS%20-%3E%20AGH%3A53",
    );
  });

  it("POSTs proplist queries to the /print command endpoint", async () => {
    // Regression: RouterOS rejects a POST to the bare collection path with
    // HTTP 400 — .proplist/.query bodies must target <path>/print.
    requestMock.mockResolvedValue(jsonResponse([{ protocol: "tcp" }]));
    await makeClient().get("ip/firewall/connection", { proplist: ["protocol", "src-address"] });
    expect(requestMock.mock.calls[0][0]).toBe(
      "http://192.0.2.1:80/rest/ip/firewall/connection/print",
    );
    expect(requestMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(requestMock.mock.calls[0][1].body as string)).toEqual({
      ".proplist": "protocol,src-address",
    });
  });

  it("returns an empty list for an empty 200 body", async () => {
    requestMock.mockResolvedValue(emptyResponse());
    const records = await makeClient().get("ip/firewall/connection", { proplist: ["protocol"] });
    expect(records).toEqual([]);
  });

  it("parses record values (numbers and booleans) from wire strings", async () => {
    requestMock.mockResolvedValue(
      jsonResponse([{ ".id": "*1", distance: "1", disabled: "false" }]),
    );
    const records = await makeClient().get<Record<string, unknown>>("ip/route");
    expect(records[0].distance).toBe(1);
    expect(records[0].disabled).toBe(false);
  });
});

describe("RouterOSRestClient write methods", () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it("execute POSTs to the command path (set-menu singletons have no .id)", async () => {
    requestMock.mockResolvedValue(emptyResponse());
    await makeClient().execute("ip/dns/set", { servers: "1.1.1.1" });
    expect(requestMock.mock.calls[0][0]).toBe("http://192.0.2.1:80/rest/ip/dns/set");
    expect(requestMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ servers: "1.1.1.1" }),
    });
  });

  it("execute uses the default request timeout unless the call overrides it", async () => {
    requestMock.mockResolvedValue(jsonResponse([]));
    await makeClient().execute("tool/torch", { interface: "ether1" });
    await makeClient().execute("tool/torch", { interface: "ether1" }, { timeoutMs: 45_000 });
    expect(requestMock.mock.calls[0][1]).toMatchObject({
      bodyTimeout: 30_000,
      headersTimeout: 30_000,
    });
    expect(requestMock.mock.calls[1][1]).toMatchObject({
      bodyTimeout: 45_000,
      headersTimeout: 45_000,
    });
  });

  it("executeFinal returns the records of the last .section", async () => {
    requestMock.mockResolvedValue(
      jsonResponse([
        { ".section": "0", status: "connecting" },
        { ".section": "1", status: "finished", code: "200" },
      ]),
    );
    const records = await makeClient().executeFinal("tool/fetch", { url: "https://x" });
    expect(records).toEqual([{ ".section": "1", status: "finished", code: "200" }]);
  });

  it.each([
    ["an empty body", emptyResponse(), []],
    ["a single object", jsonResponse({ status: "finished" }), [{ status: "finished" }]],
    [
      "sections out of order",
      jsonResponse([
        { ".section": "1", status: "finished" },
        { ".section": "0", status: "connecting" },
      ]),
      [{ ".section": "1", status: "finished" }],
    ],
  ])("executeFinal handles %s", async (_label, response, expected) => {
    requestMock.mockResolvedValue(response);
    expect(await makeClient().executeFinal("tool/fetch", {})).toEqual(expected);
  });

  it("update PATCHes the record path by .id", async () => {
    requestMock.mockResolvedValue(emptyResponse());
    await makeClient().update("interface/vlan", "*1", { disabled: "true" });
    expect(requestMock.mock.calls[0][0]).toBe("http://192.0.2.1:80/rest/interface/vlan/*1");
    expect(requestMock.mock.calls[0][1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ disabled: "true" }),
    });
  });

  it("create PUTs to the collection path", async () => {
    requestMock.mockResolvedValue(jsonResponse({ ".id": "*1", name: "vlan10" }));
    await makeClient().create("interface/vlan", { name: "vlan10" });
    expect(requestMock.mock.calls[0][0]).toBe("http://192.0.2.1:80/rest/interface/vlan");
    expect(requestMock.mock.calls[0][1]).toMatchObject({ method: "PUT" });
  });

  it("remove DELETEs the record path by .id", async () => {
    requestMock.mockResolvedValue(emptyResponse());
    await makeClient().remove("interface/vlan", "*1");
    expect(requestMock.mock.calls[0][0]).toBe("http://192.0.2.1:80/rest/interface/vlan/*1");
    expect(requestMock.mock.calls[0][1]).toMatchObject({ method: "DELETE" });
  });
});
