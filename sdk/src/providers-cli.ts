import { probeAnthropic, probeOpenAI, resourcePolicyFromEnv, selectProviderFromAvailability } from "./provider-routing";
import { refreshCodexEntitlementIfStale } from "./codex-entitlement";
import { northSourceIdentity } from "./providers/source-identity";

function sourceIdentity(): string {
  const root = new URL("../..", import.meta.url).pathname;
  return northSourceIdentity(root);
}

try {
  await refreshCodexEntitlementIfStale();
  const policy = resourcePolicyFromEnv();
  const availability = [probeAnthropic(), probeOpenAI()];
  console.log(`source     ${sourceIdentity()}`);
  for (const p of availability) {
    const headroom = policy.pressures[p.provider] ?? "unknown";
    const routing = p.reason === "disabled" ? "disabled" : p.available ? "eligible" : "unavailable";
    console.log(`${p.provider.padEnd(10)} installed=${p.installed ? "yes" : "no"}  authenticated=${p.authenticated ? "yes" : "no"}  headroom=${headroom}  routing=${routing}${p.detail ? `  ${p.detail}` : ""}`);
  }
  try {
    const d = selectProviderFromAvailability("auto", availability, policy);
    console.log(`auto       ${d.provider}  ${d.reason}`);
  } catch (error: any) {
    console.log(`auto       unavailable  ${error?.message ?? error}`);
  }
} catch (err: any) {
  console.error(err?.message ?? err);
  process.exit(1);
}
