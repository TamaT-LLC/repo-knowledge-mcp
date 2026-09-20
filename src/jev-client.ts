import { execFileSync } from "node:child_process";

import {
  TypeSafeClient,
  choice,
  type ChoiceQuestion,
  type ChoiceResponse,
  type EntryType,
  type Fetch,
} from "@typesafe-ai/sdk";

export const TYPESAFE_API_KEY_ENVIRONMENT_VARIABLE = "TYPESAFE_API_KEY";
export const TYPESAFE_API_BASE_URL = "https://api.typesafe.ai";
export const TYPESAFE_MACOS_KEYCHAIN_ACCOUNT = "default";
export const TYPESAFE_MACOS_KEYCHAIN_SERVICE =
  "com.tamat.repo-knowledge-mcp.typesafe-api-key";

export type TypeSafeCredentialSource = "environment" | "macos-keychain";

export interface ResolvedTypeSafeCredential {
  readonly apiKey: string;
  readonly source: TypeSafeCredentialSource;
}

export interface ResolveTypeSafeCredentialOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly readMacOsKeychain?: () => string | null;
}

export interface JevChoiceQuestion {
  readonly criteria: Readonly<Record<string, string>>;
  readonly instructions: string;
}

export interface JevClientRequest {
  readonly questions: Readonly<Record<string, JevChoiceQuestion>>;
  readonly signal?: AbortSignal;
  readonly state: EntryType;
}

export interface JevClientResponse {
  readonly answers: Readonly<Record<string, ChoiceResponse>>;
  readonly model: string;
  readonly requestId?: string;
}

export interface JevClient {
  classify(request: JevClientRequest): Promise<JevClientResponse>;
}

export interface TypeSafeJevClientOptions {
  readonly apiKey: string;
  readonly fetch?: Fetch;
  readonly model: string;
}

/** Security-pinned adapter around the TypeSafe SDK. */
export class TypeSafeJevClient implements JevClient {
  private readonly client: TypeSafeClient;
  private readonly model: string;

  constructor(options: TypeSafeJevClientOptions) {
    this.model = requireNonEmpty(options.model, "TypeSafe model");
    this.client = new TypeSafeClient({
      apiKey: requireNonEmpty(options.apiKey, "TypeSafe API key"),
      baseURL: TYPESAFE_API_BASE_URL,
      defaultModel: this.model,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      logLevel: "off",
      retry: { maxRetries: 2 },
      timeout: 5_000,
    });
  }

  async classify(request: JevClientRequest): Promise<JevClientResponse> {
    const questions: Record<string, ChoiceQuestion> = {};
    for (const [name, question] of Object.entries(request.questions)) {
      questions[name] = choice(question.instructions, {
        ...question.criteria,
      });
    }
    const operation = this.client.systemOne(
      {
        model: this.model,
        questions,
        state: request.state,
      },
      request.signal === undefined ? {} : { signal: request.signal },
    );
    const { data, requestId } = await operation.withResponse();
    return {
      answers: data.answers,
      model: data.model,
      ...(requestId === undefined ? {} : { requestId }),
    };
  }
}

export function resolveTypeSafeApiKey(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const value = environment[TYPESAFE_API_KEY_ENVIRONMENT_VARIABLE]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

/** Resolves an environment override, then the dedicated macOS Keychain item. */
export function resolveTypeSafeCredential(
  options: ResolveTypeSafeCredentialOptions = {},
): ResolvedTypeSafeCredential | null {
  const apiKey = resolveTypeSafeApiKey(options.environment ?? process.env);
  if (apiKey !== null) return { apiKey, source: "environment" };
  if ((options.platform ?? process.platform) !== "darwin") return null;

  let persisted: string | null;
  try {
    persisted =
      options.readMacOsKeychain?.() ?? readTypeSafeApiKeyFromMacOsKeychain();
  } catch {
    return null;
  }
  return persisted === null
    ? null
    : { apiKey: persisted, source: "macos-keychain" };
}

export function readTypeSafeApiKeyFromMacOsKeychain(): string | null {
  try {
    const value = execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-a",
        TYPESAFE_MACOS_KEYCHAIN_ACCOUNT,
        "-s",
        TYPESAFE_MACOS_KEYCHAIN_SERVICE,
        "-w",
      ],
      {
        encoding: "utf8",
        maxBuffer: 8_192,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      },
    ).trim();
    return value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0)
    throw new TypeError(`${label} must not be empty`);
  return normalized;
}
