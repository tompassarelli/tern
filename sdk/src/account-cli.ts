import {
  addProviderAccount,
  listProviderAccounts,
  liveStatusProviderAccount,
  loginProviderAccount,
  requireProviderAccount,
  statusProviderAccount,
  type AccountAuthState,
  type ProviderAccount,
} from "./accounts";
import { refreshAccountUsages, type AccountUsageReport } from "./account-usage";
import { automatedPressure } from "./resource-policy";

const USAGE = `usage: north account <command>

  north account add <safe-id> <anthropic|openai>
  north account login <id>
  north account status [id]
  north account usage [id] [--refresh]  subscription windows + reset metadata
  north account list [--verbose]   grouped accounts + live login state

Options:
  --refresh  bypass the five-minute authoritative usage cache
  --verbose  include provider, profile, and storage root diagnostics`;

const ACCOUNT_GROUPS = [
  { provider: "anthropic", label: "Claude / Anthropic" },
  { provider: "openai", label: "Codex / OpenAI" },
] as const;

function authLabel(state: AccountAuthState): string {
  switch (state) {
    case "logged-in": return "logged in";
    case "not-logged-in": return "not logged in";
    case "auth-required": return "auth required";
    case "unverifiable": return "auth unverifiable";
    case "unavailable": return "CLI unavailable";
    case "error": return "auth check failed";
  }
}

function accountStates(accounts: ProviderAccount[]): Map<string, AccountAuthState> {
  return new Map(accounts.map((account) => [account.id, statusProviderAccount(account)]));
}

async function liveAccountStates(accounts: ProviderAccount[]): Promise<Map<string, AccountAuthState>> {
  const states = await Promise.all(accounts.map(async (account) => [
    account.id,
    await liveStatusProviderAccount(account),
  ] as const));
  return new Map(states);
}

export async function runAccountStatus(
  accounts: ProviderAccount[],
  statesFor = liveAccountStates,
): Promise<number> {
  const states = await statesFor(accounts);
  printAccountList(accounts, false, states);
  return accounts.every((account) => states.get(account.id) === "logged-in") ? 0 : 1;
}

function printAccountList(
  accounts: ProviderAccount[],
  verbose: boolean,
  states = accountStates(accounts),
): void {
  let firstGroup = true;
  for (const group of ACCOUNT_GROUPS) {
    const grouped = accounts.filter((account) => account.provider === group.provider);
    if (!grouped.length) continue;
    if (!firstGroup) console.log();
    firstGroup = false;
    console.log(group.label);
    const width = Math.max(...grouped.map((account) => account.id.length));
    for (const account of grouped) {
      console.log(`  ${account.id.padEnd(width)}  ${authLabel(states.get(account.id)!)}`);
      if (verbose) {
        console.log(`    provider: ${account.provider}`);
        console.log(`    profile:  ${account.profile}`);
        console.log(`    root:     ${account.root}`);
      }
    }
  }
}

function usageReasonLabel(reason: AccountUsageReport["reason"]): string {
  switch (reason) {
    case "anthropic_usage_capability_unavailable": return "Claude SDK usage control is unavailable";
    case "anthropic_usage_probe_failed": return "Claude usage control probe failed";
    case "anthropic_usage_probe_timed_out": return "Claude usage control probe timed out";
    case "anthropic_usage_rate_limits_unavailable": return "Claude subscription rate limits are unavailable";
    case "anthropic_usage_response_schema_changed": return "Claude experimental usage response changed";
    case "anthropic_usage_windows_unavailable": return "Claude exposed no complete utilization/reset window";
    case "codex_usage_command_unavailable": return "Codex CLI is unavailable";
    case "codex_usage_probe_failed": return "Codex subscription rate-limit probe failed";
    case "codex_usage_probe_timed_out": return "Codex subscription rate-limit probe timed out";
    case "codex_usage_response_schema_changed": return "Codex rate-limit response changed";
    case "codex_usage_subscription_auth_required": return "Codex is not authenticated through ChatGPT";
    case "codex_usage_transport_failed": return "Codex app-server transport failed";
    case "codex_usage_windows_unavailable": return "Codex exposed no complete subscription window";
    case "usage_observation_store_unavailable": return "North could not persist the usage observation";
    default: return "usage unavailable";
  }
}

function printUsageReports(accounts: ProviderAccount[], reports: AccountUsageReport[]): void {
  let firstGroup = true;
  for (const group of ACCOUNT_GROUPS) {
    const grouped = accounts.filter((account) => account.provider === group.provider);
    if (!grouped.length) continue;
    if (!firstGroup) console.log();
    firstGroup = false;
    console.log(group.label);
    for (const account of grouped) {
      const report = reports.find(({ accountId }) => accountId === account.id)!;
      console.log(`  ${account.id}`);
      const headroom = automatedPressure(report.observation, new Date()) ?? "unknown";
      console.log(`    headroom: ${headroom} (${report.status}${report.cached ? ", cached" : ""})`);
      console.log(`    source:   ${report.source}`);
      if (report.lastSuccessfulObservedAt)
        console.log(`    usage evidence:  ${report.lastSuccessfulObservedAt}${report.cached ? " (cached)" : ""}`);
      if (report.collectionAttemptedAt)
        console.log(`    collection tried: ${report.collectionAttemptedAt}`);
      if (report.observation.windows?.length) {
        console.log("    windows:");
        for (const window of report.observation.windows)
          console.log(`      ${window.limitId ?? "subscription"}: ${window.usedPercent}% used · resets ${window.resetsAt}`);
      }
      for (const component of report.unavailableComponents)
        console.log(`    component unavailable: ${component.limitId} (${component.reason})`);
      if (report.reason)
        console.log(`    reason: ${usageReasonLabel(report.reason)} (${report.reason})`);
    }
  }
}

export async function runAccountCli(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case "add": {
        if (rest.length !== 2) throw new Error(USAGE);
        const account = await addProviderAccount(rest[0], rest[1]);
        console.log(`added isolated ${account.provider} account ${account.id}`);
        console.log(`root ${account.root}`);
        return 0;
      }
      case "login": {
        if (rest.length !== 1) throw new Error(USAGE);
        const account = requireProviderAccount(rest[0]);
        const status = loginProviderAccount(account);
        if (status === 0) console.log(`login complete for ${account.id}`);
        else if (status === 127) console.error(`${account.provider} CLI is not installed`);
        else console.error(`login failed for ${account.id}`);
        return status;
      }
      case "status": {
        if (rest.length > 1) throw new Error(USAGE);
        const accounts = rest.length ? [requireProviderAccount(rest[0])] : listProviderAccounts();
        if (!accounts.length) {
          console.log("no isolated accounts configured");
          return 0;
        }
        return runAccountStatus(accounts);
      }
      case "usage": {
        const refresh = rest.includes("--refresh");
        const ids = rest.filter((entry) => entry !== "--refresh");
        if (ids.length > 1 || rest.some((entry) => entry.startsWith("--") && entry !== "--refresh"))
          throw new Error(USAGE);
        const accounts = ids.length ? [requireProviderAccount(ids[0])] : listProviderAccounts();
        if (!accounts.length) {
          console.log("no isolated accounts configured");
          return 0;
        }
        const reports = await refreshAccountUsages({ accounts, force: refresh });
        printUsageReports(accounts, reports);
        return reports.every(({ status }) => status === "observed") ? 0 : 1;
      }
      case "list": {
        const verbose = rest.length === 1 && rest[0] === "--verbose";
        if (rest.length && !verbose) throw new Error(USAGE);
        const accounts = listProviderAccounts();
        if (!accounts.length) {
          console.log("no isolated accounts configured");
          return 0;
        }
        printAccountList(accounts, verbose);
        return 0;
      }
      case "help":
      case "--help":
      case "-h":
        console.log(USAGE);
        return 0;
      default:
        throw new Error(USAGE);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (import.meta.main) process.exit(await runAccountCli(process.argv.slice(2)));
