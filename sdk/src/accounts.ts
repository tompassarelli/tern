import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { withFileLease } from "./file-lease";
import type { RoutingTarget } from "./providers/types";
import { providerBilling, checkSpendBudget, spendBudgetEntityId } from "./spend-guard";

export type AccountProvider = "anthropic" | "openai";
export type AccountAuthState =
  | "logged-in"
  | "not-logged-in"
  | "auth-required"
  | "unverifiable"
  | "unavailable"
  | "error";

export interface ProviderAccount {
  id: string;
  provider: AccountProvider;
  profile: string;
  authMode: "isolated";
  root: string;
}

interface RoutingTargetDocument {
  id?: unknown;
  provider?: unknown;
  profile?: unknown;
  authMode?: unknown;
  [key: string]: unknown;
}

type RoutingDocument = Record<string, unknown>;

export interface AccountContext {
  home?: string;
  routingPolicyPath?: string;
  env?: NodeJS.ProcessEnv;
}

export function isClaudeSubscriptionStatus(status: Record<string, unknown>): boolean {
  return status.loggedIn === true
    && status.authMethod === "claude.ai"
    && (status.apiProvider === undefined || status.apiProvider === "firstParty");
}

const PROVIDERS: AccountProvider[] = ["anthropic", "openai"];
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const ACCOUNT_CONFIG_ALLOWLIST: Record<AccountProvider, readonly string[]> = {
  anthropic: [
    "CLAUDE.md",
    "settings.json",
    "agents",
    "commands",
    "hooks",
    "skills",
    "rules",
    "output-styles",
    "keybindings",
    "themes",
  ],
  // A managed Codex lane authenticates from this home, but all executable
  // authority is supplied at CLI/session precedence and proven in the same
  // app-server process that executes the turn. User config and rules therefore
  // must not be projected into an isolated account.
  openai: ["AGENTS.md", "skills"],
};

const OPENAI_LEGACY_AUTHORITY_LINKS = ["config.toml", "hooks.json", "rules"] as const;

function homeOf(context: AccountContext): string {
  return resolve(context.home ?? context.env?.HOME ?? process.env.HOME ?? homedir());
}

export function routingPolicyPath(context: AccountContext = {}): string {
  return resolve(context.routingPolicyPath
    ?? context.env?.NORTH_ROUTING_POLICY
    ?? process.env.NORTH_ROUTING_POLICY
    ?? join(homeOf(context), ".config/north/routing-policy.json"));
}

export function accountsRoot(context: AccountContext = {}): string {
  return join(homeOf(context), ".local/state/north/accounts");
}

export function assertSafeAccountId(id: string, label = "account id"): void {
  if (!SAFE_ID.test(id))
    throw new Error(`${label} must be a lowercase portable slug (letters, digits, _ or -; max 64 characters)`);
}

function assertProvider(provider: string): asserts provider is AccountProvider {
  if (!PROVIDERS.includes(provider as AccountProvider))
    throw new Error(`provider must be anthropic or openai`);
}

function accountRoot(provider: AccountProvider, profile: string, context: AccountContext): string {
  assertSafeAccountId(profile, "account profile");
  const base = accountsRoot(context);
  const root = join(base, provider, profile);
  if (dirname(root) !== join(base, provider)) throw new Error("account profile escapes the account root");
  return root;
}

function readRoutingDocument(path: string): RoutingDocument {
  if (!existsSync(path)) {
    return {
      version: 1,
      mode: "balanced",
      targets: [],
      targetOrder: [],
      providerOrder: ["anthropic", "openai"],
      weights: {},
      pressures: {},
      envelopes: {},
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`could not parse routing policy ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`routing policy ${path} must contain a JSON object`);
  return parsed as RoutingDocument;
}

function targetsOf(document: RoutingDocument, path: string): RoutingTargetDocument[] {
  if (document.targets === undefined) return [];
  if (!Array.isArray(document.targets)) throw new Error(`routing policy ${path} has a non-array targets field`);
  for (const [index, target] of document.targets.entries()) {
    if (!target || typeof target !== "object" || Array.isArray(target))
      throw new Error(`routing policy ${path} has an invalid targets[${index}]`);
  }
  return document.targets as RoutingTargetDocument[];
}

function atomicWriteJson(path: string, document: RoutingDocument): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function ambientConfigRoot(provider: AccountProvider, home: string): string {
  return join(home, provider === "anthropic" ? ".claude" : ".codex");
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function matchesConfigLink(destination: string, source: string): boolean {
  const current = lstatSync(destination);
  return current.isSymbolicLink() && readlinkSync(destination) === source;
}

export function bootstrapAccountConfig(account: ProviderAccount, context: AccountContext = {}): string[] {
  const home = homeOf(context);
  const sourceRoot = ambientConfigRoot(account.provider, home);
  ensurePrivateDirectory(accountsRoot(context));
  ensurePrivateDirectory(join(accountsRoot(context), account.provider));
  ensurePrivateDirectory(account.root);
  if (account.provider === "openai") ensurePrivateDirectory(join(account.root, "sqlite"));

  // Retire only links created by North's former account projection. A bespoke
  // file or differently targeted link is an authority-bearing account state,
  // so admission fails instead of silently ignoring or replacing it.
  if (account.provider === "openai") {
    for (const name of OPENAI_LEGACY_AUTHORITY_LINKS) {
      const legacySource = join(sourceRoot, name);
      const legacyDestination = join(account.root, name);
      try {
        if (!matchesConfigLink(legacyDestination, legacySource))
          throw new Error(`refusing authority-bearing Codex account path ${legacyDestination}`);
        unlinkSync(legacyDestination);
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }
    }
  }

  const linked: string[] = [];
  for (const name of ACCOUNT_CONFIG_ALLOWLIST[account.provider]) {
    const source = join(sourceRoot, name);
    const destination = join(account.root, name);
    try { lstatSync(source); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    try {
      if (matchesConfigLink(destination, source)) {
        linked.push(name);
        continue;
      }
      throw new Error(`refusing to replace existing account path ${destination}`);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    try {
      symlinkSync(source, destination);
    } catch (error) {
      // Multiple provider probes can bootstrap a newly configured target at the
      // same time. EEXIST is success only when the winner installed the exact
      // link this process intended; any other path remains a hard refusal.
      if (!isErrno(error, "EEXIST")) throw error;
      try {
        if (!matchesConfigLink(destination, source))
          throw new Error(`refusing to replace existing account path ${destination}`);
      } catch (inspectionError) {
        if (isErrno(inspectionError, "ENOENT")) throw error;
        throw inspectionError;
      }
    }
    linked.push(name);
  }
  return linked;
}

export async function addProviderAccount(
  id: string,
  providerInput: string,
  context: AccountContext = {},
): Promise<ProviderAccount> {
  assertSafeAccountId(id);
  // Config-time fail-closed (design §2): an API-billed provider target cannot be
  // configured unguarded — a complete `@spend-budget:<id>` must exist first, so
  // an API target structurally cannot come into being without a budget. Runs
  // before assertProvider so an API-billed id is refused on the budget ground,
  // not merely the subscription-only allowlist. (Subscription providers skip
  // this O(1).)
  if (providerBilling(providerInput) === "api-billed") {
    const verdict = checkSpendBudget(id);
    if (!verdict.ok)
      throw new Error(
        `refusing to add API-billed provider '${providerInput}' target '${id}' without a complete spend budget `
        + `(${verdict.reason}). Create it first: north spend init ${id} --cap-usd … --envelope-default-usd … `
        + `--envelope-max-usd … --burn-limit-usd-hr … --i-confirm-layer1 "prepaid, auto-topup off, <date>" `
        + `(then set price facts on @${spendBudgetEntityId(id)}).`,
      );
  }
  assertProvider(providerInput);
  const path = routingPolicyPath(context);
  return withFileLease(`${path}.lock`, async () => {
    const document = readRoutingDocument(path);
    const targets = targetsOf(document, path);
    if (targets.some((target) => target.id === id)) throw new Error(`routing target already exists: ${id}`);

    const currentOrder = document.targetOrder;
    if (currentOrder !== undefined && !Array.isArray(currentOrder))
      throw new Error(`routing policy ${path} has a non-array targetOrder field`);
    const account: ProviderAccount = {
      id,
      provider: providerInput,
      profile: id,
      authMode: "isolated",
      root: accountRoot(providerInput, id, context),
    };
    bootstrapAccountConfig(account, context);

    const nextTargets = [...targets, { id, provider: providerInput, profile: id, authMode: "isolated" }];
    const targetOrder = Array.isArray(currentOrder)
      ? [...currentOrder, id]
      : nextTargets.map((target) => target.id).filter((targetId): targetId is string => typeof targetId === "string");
    atomicWriteJson(path, { ...document, targets: nextTargets, targetOrder });
    return account;
  });
}

export function listProviderAccounts(context: AccountContext = {}): ProviderAccount[] {
  const path = routingPolicyPath(context);
  const document = readRoutingDocument(path);
  const accounts = targetsOf(document, path).flatMap<ProviderAccount>((target, index) => {
    if (target.authMode !== "isolated") return [];
    if (typeof target.id !== "string" || typeof target.profile !== "string" || typeof target.provider !== "string")
      throw new Error(`isolated routing target at targets[${index}] is incomplete`);
    assertSafeAccountId(target.id);
    assertSafeAccountId(target.profile, "account profile");
    assertProvider(target.provider);
    return [{
      id: target.id,
      provider: target.provider,
      profile: target.profile,
      authMode: "isolated",
      root: accountRoot(target.provider, target.profile, context),
    }];
  });
  const ownerByRoot = new Map<string, string>();
  for (const account of accounts) {
    const previous = ownerByRoot.get(account.root);
    if (previous)
      throw new Error(
        `isolated routing targets ${previous} and ${account.id} share provider profile/root ${account.provider}/${account.profile}`,
      );
    ownerByRoot.set(account.root, account.id);
  }
  return accounts;
}

export function requireProviderAccount(id: string, context: AccountContext = {}): ProviderAccount {
  assertSafeAccountId(id);
  const account = listProviderAccounts(context).find((candidate) => candidate.id === id);
  if (!account) throw new Error(`unknown isolated account: ${id}`);
  return account;
}

const PROVIDER_ENV_PREFIX = /^(ANTHROPIC|CLAUDE|OPENAI|CODEX)_/;
const CLOUD_ENV_PREFIX = /^(AWS|GOOGLE|GCLOUD|CLOUDSDK|AZURE)_/;
const SENSITIVE_ENV_NAME = /(^|_)(AUTH|CREDENTIALS?|KEY|PASSWORD|SECRET|TOKEN)(_|$)/;
const TRANSPORT_ENV_NAME = /(^|_)(API_BASE|API_URL|BASE_URL|ENDPOINT|HOST|HEADERS?)(_|$)/;
const CLOUD_SELECTOR_ENV_NAME = /(^|_)(ACCOUNT|PROFILE|PROJECT|REGION|SUBSCRIPTION)(_|$)/;
const PROVIDER_STATE_SELECTOR = /^(CLAUDE_CONFIG_DIR|CODEX_HOME|CODEX_SQLITE_HOME|CODEX_PROFILE|CHATGPT_BASE_URL|OPENAI_API_TYPE|OPENAI_API_VERSION|OPENAI_ORGANIZATION|OPENAI_ORG_ID|OPENAI_PROJECT|OPENAI_PROJECT_ID)$/;
const CLAUDE_CLOUD_TRANSPORT = /^(?:CLAUDE_CODE_(?:USE|SKIP)_(?:BEDROCK|VERTEX|FOUNDRY)(?:_AUTH)?|ANTHROPIC_(?:BEDROCK|VERTEX|FOUNDRY)_)/;
const CLOUD_ACCOUNT_ENV = /^(?:AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN|PROFILE|DEFAULT_PROFILE|REGION|DEFAULT_REGION|CONFIG_FILE|SHARED_CREDENTIALS_FILE|WEB_IDENTITY_TOKEN_FILE|ROLE_ARN|ROLE_SESSION_NAME|CONTAINER_CREDENTIALS_(?:FULL|RELATIVE)_URI|CONTAINER_AUTHORIZATION_TOKEN(?:_FILE)?|EC2_METADATA_SERVICE_ENDPOINT|ENDPOINT_URL(?:_.+)?|BEARER_TOKEN_BEDROCK|SDK_LOAD_CONFIG)|GOOGLE_(?:APPLICATION_CREDENTIALS|CLOUD_PROJECT|CLOUD_QUOTA_PROJECT|CREDENTIALS)|GCLOUD_PROJECT|CLOUDSDK_(?:AUTH_CREDENTIAL_FILE_OVERRIDE|CONFIG|CORE_PROJECT)|CLOUD_ML_REGION|AZURE_(?:OPENAI_.+|CLIENT_ID|CLIENT_SECRET|TENANT_ID|CLIENT_CERTIFICATE_PATH|CLIENT_CERTIFICATE_PASSWORD|FEDERATED_TOKEN_FILE|AUTHORITY_HOST|CONFIG_DIR))$/;
const CLOUD_CREDENTIAL_FILE = /^(?:AWS_CREDENTIAL_FILE|AWS_CREDENTIAL_PROFILES_FILE|BOTO_CONFIG)$/;

function deniedSubscriptionEnvironmentName(key: string): boolean {
  if (PROVIDER_STATE_SELECTOR.test(key) || CLAUDE_CLOUD_TRANSPORT.test(key)
      || CLOUD_ACCOUNT_ENV.test(key) || CLOUD_CREDENTIAL_FILE.test(key)) return true;
  if (CLOUD_ENV_PREFIX.test(key)
      && (SENSITIVE_ENV_NAME.test(key) || TRANSPORT_ENV_NAME.test(key) || CLOUD_SELECTOR_ENV_NAME.test(key))) return true;
  return PROVIDER_ENV_PREFIX.test(key) && (SENSITIVE_ENV_NAME.test(key) || TRANSPORT_ENV_NAME.test(key));
}

function subscriptionEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(source)) {
    if (deniedSubscriptionEnvironmentName(key)) continue;
    env[key] = source[key];
  }
  return env;
}

export function accountEnvironment(account: ProviderAccount, context: AccountContext = {}): NodeJS.ProcessEnv {
  const source = context.env ?? process.env;
  const env = subscriptionEnvironment(source);
  if (account.provider === "anthropic") {
    env.CLAUDE_CONFIG_DIR = account.root;
    delete env.CODEX_HOME;
    delete env.CODEX_SQLITE_HOME;
  } else {
    env.CODEX_HOME = account.root;
    env.CODEX_SQLITE_HOME = join(account.root, "sqlite");
    env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = "1";
    delete env.CLAUDE_CONFIG_DIR;
  }
  return env;
}

export function providerEnvironmentForTarget(
  provider: AccountProvider,
  target: RoutingTarget | undefined,
  context: AccountContext = {},
): NodeJS.ProcessEnv {
  if (target && target.provider !== provider)
    throw new Error(`routing target ${target.id} belongs to ${target.provider}, not ${provider}`);
  const authMode = target?.authMode ?? "ambient";
  if (authMode === "isolated") {
    if (!target?.profile) throw new Error(`isolated routing target ${target?.id ?? "<unknown>"} has no profile`);
    assertSafeAccountId(target.profile, "account profile");
    const account: ProviderAccount = {
      id: target.id,
      provider,
      profile: target.profile,
      authMode: "isolated",
      root: accountRoot(provider, target.profile, context),
    };
    bootstrapAccountConfig(account, context);
    return accountEnvironment(account, context);
  }
  if (authMode !== "ambient") throw new Error(`routing target ${target?.id ?? "<unknown>"} has invalid auth mode`);
  const env = subscriptionEnvironment(context.env ?? process.env);
  if (provider === "openai") {
    env.CODEX_HOME ??= join(homeOf(context), ".codex");
    env.CODEX_SQLITE_HOME ??= env.CODEX_HOME;
    env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = "1";
  }
  return env;
}

export function codexConfigArguments(env: NodeJS.ProcessEnv): string[] {
  const codexHome = env.CODEX_HOME;
  const sqliteHome = env.CODEX_SQLITE_HOME ?? codexHome;
  if (!codexHome || !sqliteHome) throw new Error("Codex target environment is missing its state roots");
  return [
    "-c", 'cli_auth_credentials_store="file"',
    "-c", 'forced_login_method="chatgpt"',
    "-c", 'model_provider="openai"',
    "-c", `sqlite_home=${JSON.stringify(sqliteHome)}`,
  ];
}

export function loginProviderAccount(account: ProviderAccount, context: AccountContext = {}): number {
  bootstrapAccountConfig(account, context);
  const env = accountEnvironment(account, context);
  const command = account.provider === "anthropic"
    ? env.NORTH_CLAUDE_BIN ?? "claude"
    : env.NORTH_CODEX_BIN ?? "codex";
  const args = account.provider === "anthropic"
    ? ["auth", "login", "--claudeai"]
    : ["login", ...codexConfigArguments(env)];
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.error) return result.error && "code" in result.error && result.error.code === "ENOENT" ? 127 : 1;
  return result.status ?? 1;
}

export function statusProviderAccount(account: ProviderAccount, context: AccountContext = {}): AccountAuthState {
  bootstrapAccountConfig(account, context);
  const env = accountEnvironment(account, context);
  const command = account.provider === "anthropic"
    ? env.NORTH_CLAUDE_BIN ?? "claude"
    : env.NORTH_CODEX_BIN ?? "codex";
  const args = account.provider === "anthropic"
    ? ["auth", "status", "--json"]
    : ["login", "status", ...codexConfigArguments(env)];
  const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 10_000 });
  if (result.error) return "code" in result.error && result.error.code === "ENOENT" ? "unavailable" : "error";

  if (account.provider === "anthropic") {
    try {
      const status = JSON.parse(result.stdout || "{}") as Record<string, unknown>;
      if (isClaudeSubscriptionStatus(status)) return "logged-in";
      if (status.loggedIn === false || status.authenticated === false || status.authMethod === "none") return "not-logged-in";
    } catch { /* normalized error below; raw provider output is never printed */ }
    return "error";
  }

  const statusLines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (result.status === 0 && statusLines.includes("Logged in using ChatGPT")) return "logged-in";
  if (statusLines.includes("Not logged in")) return "not-logged-in";
  return "error";
}

/**
 * Verify Codex authentication against ChatGPT without sending a model turn.
 * A successful rate-limit RPC is sufficient even when its usage schema is not.
 */
export async function liveCodexAuthState(
  target: RoutingTarget | undefined,
  context: AccountContext = {},
  readEntitlement?: (options: {
    target?: RoutingTarget;
    targetId?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }) => Promise<unknown>,
): Promise<AccountAuthState> {
  try {
    const entitlement = await import("./codex-entitlement");
    const read = readEntitlement ?? entitlement.readCodexEntitlementObservation;
    await read({
      target,
      targetId: target?.id,
      env: { ...(context.env ?? process.env), HOME: homeOf(context) },
      timeoutMs: entitlement.CODEX_USAGE_PROBE_TIMEOUT_MS,
    });
    return "logged-in";
  } catch (error) {
    const reason = error instanceof Error && "reason" in error
      ? (error as Error & { reason?: unknown }).reason
      : undefined;
    switch (reason) {
      case "codex_usage_subscription_auth_required": return "auth-required";
      case "codex_usage_command_unavailable": return "unavailable";
      case "codex_usage_probe_failed":
      case "codex_usage_probe_timed_out":
      case "codex_usage_transport_failed": return "unverifiable";
      // These failures occur only after account/rateLimits/read returned a
      // successful live response, which is the authentication signal here.
      case "codex_usage_response_schema_changed":
      case "codex_usage_windows_unavailable": return "logged-in";
      default: return "error";
    }
  }
}

export async function liveStatusProviderAccount(
  account: ProviderAccount,
  context: AccountContext = {},
): Promise<AccountAuthState> {
  if (account.provider === "anthropic") return statusProviderAccount(account, context);
  return liveCodexAuthState({
    id: account.id,
    provider: account.provider,
    authMode: account.authMode,
    profile: account.profile,
  }, context);
}
