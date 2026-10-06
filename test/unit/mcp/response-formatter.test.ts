import { describe, it, expect } from "vitest";
import { formatError } from "../../../src/mcp/response-formatter.js";
import { MikroMCPError, ErrorCategory } from "../../../src/domain/errors/error-types.js";
import { checkFleetConfirmation } from "../../../src/middleware/fleet-confirmation.js";

const fleetArgs = {
  toolName: "manage_ntp_client",
  routerIds: ["r1"],
  params: { enabled: true, servers: ["192.168.1.1"] },
  identityId: "op1",
};

function issuedFleetError(): MikroMCPError {
  try {
    checkFleetConfirmation({ ...fleetArgs, submittedToken: undefined }, "test-secret");
  } catch (err) {
    return err as MikroMCPError;
  }
  throw new Error("expected APPROVAL_REQUIRED");
}

function textOf(error: MikroMCPError): string {
  return formatError(error).content[0].text;
}

describe("formatError", () => {
  it("keeps the category, message and suggested action on the first lines", () => {
    const text = textOf(issuedFleetError());
    const [first, second] = text.split("\n");
    expect(first).toBe(
      'Error [APPROVAL_REQUIRED]: This will run write tool "manage_ntp_client" across 1 router(s). Re-submit with confirmationToken to proceed.',
    );
    expect(second).toBe(
      "Suggested action: Re-submit the identical bulk_execute call with details.confirmationToken.",
    );
  });

  it("puts the confirmation token in the text, so a text-only client can confirm", () => {
    // Claude Code passes an error result to the model as text only; before this, the
    // token existed only in structuredContent and a fleet write could never be confirmed.
    const error = issuedFleetError();
    const text = textOf(error);
    const detailsLine = text.split("\n").find((line) => line.startsWith("Details: "));
    expect(detailsLine).toBeDefined();
    const fromText = JSON.parse(detailsLine!.slice("Details: ".length)) as Record<string, unknown>;
    expect(fromText.confirmationToken).toBe(error.details!.confirmationToken);
    expect(() =>
      checkFleetConfirmation(
        { ...fleetArgs, submittedToken: fromText.confirmationToken as string },
        "test-secret",
      ),
    ).not.toThrow();
  });

  it("includes the code, CONFLICT details and alternative tools", () => {
    const error = new MikroMCPError({
      category: ErrorCategory.CONFLICT,
      code: "ROUTE_CONFLICT",
      message: "Route 10.0.0.0/8 already exists with distance=5.",
      details: { existing: { distance: 5 }, requested: { distance: 1 } },
      recoverability: {
        retryable: false,
        suggestedAction: "Remove the existing route first.",
        alternativeTools: ["manage_route with action=remove", "list_routes"],
      },
    });
    expect(textOf(error)).toBe(
      [
        "Error [CONFLICT]: Route 10.0.0.0/8 already exists with distance=5.",
        "Suggested action: Remove the existing route first.",
        "Code: ROUTE_CONFLICT",
        'Details: {"existing":{"distance":5},"requested":{"distance":1}}',
        "Alternative tools: manage_route with action=remove, list_routes",
      ].join("\n"),
    );
  });

  it("includes the retry hint when there is one", () => {
    const error = new MikroMCPError({
      category: ErrorCategory.ROUTER_BUSY,
      code: "CIRCUIT_OPEN",
      message: "Circuit breaker is open.",
      recoverability: { retryable: true, retryAfterMs: 30000, suggestedAction: "Wait." },
    });
    expect(textOf(error)).toContain("\nRetry after: 30000 ms");
  });

  it("omits the details and alternative-tools lines when they are absent or empty", () => {
    for (const details of [undefined, {}]) {
      const error = new MikroMCPError({
        category: ErrorCategory.VALIDATION,
        code: "MISSING_ROUTER_ID",
        message: "No router resolved.",
        details,
        recoverability: { retryable: false, suggestedAction: "", alternativeTools: [] },
      });
      expect(textOf(error)).toBe(
        "Error [VALIDATION]: No router resolved.\nCode: MISSING_ROUTER_ID",
      );
    }
  });

  it("still returns the full error as structuredContent", () => {
    const error = issuedFleetError();
    const response = formatError(error);
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual(error.toJSON());
  });
});
