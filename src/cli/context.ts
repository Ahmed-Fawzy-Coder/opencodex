import { getContextResult } from "../context-results";
import { loadConfig } from "../config";

const USAGE = "ocx context get <handle> [--offset <bytes>] [--max-bytes <bytes>] [--if-none-match <etag>]";

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function printError(error: string): number {
  console.log(JSON.stringify({ ok: false, error }));
  return 1;
}

export function handleContextCommand(args: string[]): number {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    console.log(`Usage: ${USAGE}`);
    return 0;
  }
  if (args[0] !== "get" || !args[1]) return printError("usage");
  const handle = args[1];
  let offset: number | undefined;
  let maxBytes: number | undefined;
  let ifNoneMatch: string | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option === "--offset") {
      const parsed = parseNonNegativeInteger(value);
      if (parsed === null) return printError("invalid_offset");
      offset = parsed;
      index += 1;
    } else if (option === "--max-bytes") {
      const parsed = parseNonNegativeInteger(value);
      if (parsed === null || parsed === 0) return printError("invalid_max_bytes");
      maxBytes = parsed;
      index += 1;
    } else if (option === "--if-none-match") {
      if (!value || value.length > 128) return printError("invalid_if_none_match");
      ifNoneMatch = value;
      index += 1;
    } else {
      return printError("unknown_option");
    }
  }
  const result = getContextResult(
    handle,
    { offset, maxBytes, ifNoneMatch },
    loadConfig().ultimateContext,
  );
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}
