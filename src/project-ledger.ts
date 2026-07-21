import { createHash } from "node:crypto";

/** Client-side identity used when calling Linux MCP ledger actions. */
export function projectLedgerIdentity(projectRoot: string, taskId: string, conversationId: string) {
  const projectId = createHash("sha256").update(projectRoot).digest("hex").slice(0, 32);
  return { projectId, taskId, conversationId };
}

export function exactDependencyKey(input: {
  projectId: string; action: string; args: unknown; gitHead: string;
  dependencyHashes: Record<string, string>; toolVersion: string; policy: "read-only";
}) {
  return createHash("sha256").update(JSON.stringify(input, Object.keys(input).sort())).digest("hex");
}
