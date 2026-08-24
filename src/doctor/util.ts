import { GhCommandError } from "../gh-runner.js";

export function isSupportedNodeVersion(value: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 13) || major >= 24;
}

export function unsignedFilesystemType(value: bigint | number): number {
  return Number(BigInt.asUintN(32, BigInt(value)));
}

export function octal(value: number): string {
  return `0${value.toString(8).padStart(3, "0")}`;
}

export function errorCode(error: unknown): string {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}

export function ghErrorCode(error: unknown): string {
  return error instanceof GhCommandError ? error.code : errorCode(error);
}

export function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n\u2028\u2029]+/gu, " ").slice(0, 2_048);
}

export function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

export function parseJsonObject(value: string): Record<string, unknown> {
  return asObject(JSON.parse(value) as unknown);
}

export function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected an object");
  }
  return value as Record<string, unknown>;
}

export function asOptionalObject(
  value: unknown,
): Record<string, unknown> | null {
  return value === null || typeof value !== "object" || Array.isArray(value)
    ? null
    : (value as Record<string, unknown>);
}

export function objectProperty(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return asObject(value[key]);
}

export function stringProperty(
  value: Record<string, unknown>,
  key: string,
): string {
  const item = value[key];
  if (typeof item !== "string" || item.length === 0) {
    throw new TypeError(`${key} must be a non-empty string`);
  }
  return item;
}

export function stringArrayProperty(
  value: Record<string, unknown>,
  key: string,
): string[] {
  const item = value[key];
  if (
    !Array.isArray(item) ||
    !item.every((entry) => typeof entry === "string")
  ) {
    throw new TypeError(`${key} must be a string array`);
  }
  return item;
}
