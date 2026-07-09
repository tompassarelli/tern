import { execSync } from "child_process";

export interface Fact {
  predicate: string;
  value: string;
}

export function getThreadFacts(threadId: string): Fact[] {
  try {
    const out = execSync(`north json show ${threadId}`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    return JSON.parse(out.trim());
  } catch {
    return [];
  }
}

export function getChildren(parentId: string): string[] {
  try {
    const out = execSync(
      `north json query '{"find":"child","where":[["child","part_of","@${parentId}"]]}'`,
      { encoding: "utf-8", timeout: 5000 }
    );
    const parsed = JSON.parse(out.trim());
    if (Array.isArray(parsed)) return parsed.map((r: any) => r.child ?? r);
    return [];
  } catch {
    return [];
  }
}
