import { z } from "zod";

function validateCidr(value: string): string {
  const withPrefix = value.includes("/") ? value : `${value}/32`;
  const slashIdx = withPrefix.lastIndexOf("/");
  const ipPart = withPrefix.slice(0, slashIdx);
  const prefixStr = withPrefix.slice(slashIdx + 1);

  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid prefix length "${prefixStr}": must be 0–32`);
  }

  const octets = ipPart.split(".");
  if (octets.length !== 4) {
    throw new Error(`Invalid IP address "${ipPart}": expected 4 octets`);
  }
  for (const octet of octets) {
    const n = Number(octet);
    if (!Number.isInteger(n) || n < 0 || n > 255 || String(n) !== octet) {
      throw new Error(`Invalid octet "${octet}" in IP address "${ipPart}"`);
    }
  }

  return withPrefix;
}

export const cidrSchema = z.string().transform((v, ctx) => {
  try {
    return validateCidr(v);
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
    return z.NEVER;
  }
});
