const ROUTEROS_COMMAND = /^\/[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)+$/;
const ROUTEROS_PARAMETER = /^[a-z][a-z0-9-]*$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export type RouterOsCommandValue = string | number;

export function isRouterOsCommandString(value: string): boolean {
  return !CONTROL_CHARACTER.test(value);
}

function quoteRouterOsString(value: string): string {
  if (!isRouterOsCommandString(value)) {
    throw new Error("RouterOS command values must not contain control characters");
  }

  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
  return `"${escaped}"`;
}

/** Build one RouterOS CLI command from a fixed command name and quoted parameters. */
export function buildRouterOsCommand(
  command: string,
  parameters: Readonly<Record<string, RouterOsCommandValue>>,
): string {
  if (!ROUTEROS_COMMAND.test(command)) {
    throw new Error("Invalid RouterOS command");
  }

  const parts = [command];
  for (const [name, value] of Object.entries(parameters)) {
    if (!ROUTEROS_PARAMETER.test(name)) {
      throw new Error("Invalid RouterOS parameter");
    }

    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        throw new Error("RouterOS numeric command values must be safe integers");
      }
      parts.push(`${name}=${value}`);
    } else {
      parts.push(`${name}=${quoteRouterOsString(value)}`);
    }
  }

  return parts.join(" ");
}
