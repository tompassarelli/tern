import { createHash } from "node:crypto";
import { GAFFER_CAPABILITIES, type GafferCapability } from "./gaffer-capabilities";
import type { BespokeContract } from "./routing-metadata";

const CONTRACT_FIELDS = [
  "responsibility", "deliverable", "capabilities", "mayDecide", "mustEscalate", "doneWhen", "report",
] as const;
export const BESPOKE_FINGERPRINT_DOMAIN = "north:bespoke-contract:v1";
export const BESPOKE_FINGERPRINT_VERSION = "v1";
const EDGE_ASCII_WHITESPACE = /^[\u0009-\u000d\u0020]+|[\u0009-\u000d\u0020]+$/g;

function contractRecord(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    throw new Error("bespoke contract must be an object");
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((field) => !CONTRACT_FIELDS.includes(field as typeof CONTRACT_FIELDS[number]));
  const missing = CONTRACT_FIELDS.filter((field) => !Object.hasOwn(record, field));
  if (unknown.length || missing.length) {
    throw new Error([
      unknown.length ? `unknown fields: ${unknown.join(", ")}` : "",
      missing.length ? `missing fields: ${missing.join(", ")}` : "",
    ].filter(Boolean).join("; "));
  }
  return record;
}

function canonicalText(value: unknown, field: string): string {
  if (typeof value !== "string")
    throw new Error(`bespoke contract ${field} must be a non-empty string`);
  const normalized = value.replace(/\r\n?/g, "\n").normalize("NFC").replace(EDGE_ASCII_WHITESPACE, "");
  if (!normalized) throw new Error(`bespoke contract ${field} must be a non-empty string`);
  return normalized;
}

function canonicalTextSet(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`bespoke contract ${field} must be a non-empty string array`);
  const normalized = value.map((entry) => canonicalText(entry, field));
  if (new Set(normalized).size !== normalized.length)
    throw new Error(`bespoke contract ${field} must not contain duplicates`);
  return [...new Set(normalized)].sort();
}

export function canonicalGafferCapabilities(value: unknown): GafferCapability[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("bespoke contract capabilities must be a non-empty array");
  const normalized = value.map((entry) => canonicalText(entry, "capabilities"));
  if (new Set(normalized).size !== normalized.length)
    throw new Error("bespoke contract capabilities must not contain duplicates");
  const requested = new Set(normalized);
  const unknown = [...requested].filter((entry) => !GAFFER_CAPABILITIES.includes(entry as GafferCapability));
  if (unknown.length)
    throw new Error(`bespoke contract capabilities contain unknown values: ${unknown.join(", ")}`);
  return GAFFER_CAPABILITIES.filter((capability) => requested.has(capability));
}

/**
 * Semantic, provider-independent bespoke contract form. Object field order is
 * part of the cross-language hash contract shared with cli/agents-cli.clj.
 */
export function canonicalBespokeContract(value: unknown): BespokeContract {
  const contract = contractRecord(value);
  return {
    responsibility: canonicalText(contract.responsibility, "responsibility"),
    deliverable: canonicalText(contract.deliverable, "deliverable"),
    capabilities: canonicalGafferCapabilities(contract.capabilities),
    mayDecide: canonicalTextSet(contract.mayDecide, "mayDecide"),
    mustEscalate: canonicalTextSet(contract.mustEscalate, "mustEscalate"),
    doneWhen: canonicalTextSet(contract.doneWhen, "doneWhen"),
    report: canonicalText(contract.report, "report"),
  };
}

export function canonicalBespokeContractJson(value: unknown): string {
  return JSON.stringify(canonicalBespokeContract(value));
}

function frame(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function frameList(values: readonly string[]): string {
  return `${values.length}:${values.map(frame).join("")}`;
}

/** Unambiguous, domain-separated UTF-8 payload mirrored by cli/agents-cli.clj. */
export function canonicalBespokeContractPayload(value: unknown): string {
  const contract = canonicalBespokeContract(value);
  return [
    BESPOKE_FINGERPRINT_DOMAIN,
    `responsibility=${frame(contract.responsibility)}`,
    `deliverable=${frame(contract.deliverable)}`,
    `capabilities=${frameList(contract.capabilities)}`,
    `mayDecide=${frameList(contract.mayDecide)}`,
    `mustEscalate=${frameList(contract.mustEscalate)}`,
    `doneWhen=${frameList(contract.doneWhen)}`,
    `report=${frame(contract.report)}`,
  ].join("\n");
}

export function bespokeContractFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalBespokeContractPayload(value), "utf8").digest("hex");
}
