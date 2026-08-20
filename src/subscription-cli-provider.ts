import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  executeBufferedCommand,
  type BufferedCommandExecutor,
  type BufferedCommandResult,
} from "./buffered-command.js";
import {
  getLlmProviderDefinition,
  type EnabledLlmProviderMode,
} from "./llm-provider-config.js";
import {
  LlmProviderError,
  type LlmProviderAdapter,
  type LlmProviderErrorCode,
  type StructuredCompletionRequest,
  type StructuredCompletionResponse,
} from "./llm-provider.js";

export const DEFAULT_SUBSCRIPTION_CLI_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
export const DEFAULT_SUBSCRIPTION_CLI_TIMEOUT_MS = 120_000;
export const DEFAULT_SUBSCRIPTION_AUTH_TIMEOUT_MS = 15_000;

const PROVIDER_CREDENTIAL_ENVIRONMENT_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
  "GROK_CODE_XAI_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "XAI_API_KEY",
] as const;

const PROVIDER_CREDENTIAL_ENVIRONMENT_VARIABLE_NAMES = new Set<string>(
  PROVIDER_CREDENTIAL_ENVIRONMENT_VARIABLES,
);
const UNSAFE_OBJECT_PROPERTY_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const SAFE_ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export interface SubscriptionCliProviderAdapterOptions {
  readonly defaultModel?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly executable?: string;
  readonly executor?: BufferedCommandExecutor;
  readonly maxBufferBytes?: number;
  readonly timeoutMs?: number;
}

export interface SubscriptionCliInvocationContext {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly model: string;
  readonly request: StructuredCompletionRequest;
  readonly temporaryDirectory: string;
}

export interface SubscriptionCliParsedOutput {
  readonly model?: string;
  readonly outputText: string;
  readonly responseId?: string;
}

export interface SubscriptionCliInvocation {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly input?: string;
  parseOutput(
    result: BufferedCommandResult,
  ): Promise<SubscriptionCliParsedOutput>;
}

export interface SubscriptionCliProviderDefinition {
  readonly cliExecutable: string;
  readonly displayName: string;
  readonly provider: EnabledLlmProviderMode;
  createInvocation(
    context: SubscriptionCliInvocationContext,
  ): Promise<SubscriptionCliInvocation>;
}

/** Shared transport for provider CLIs authenticated with user subscriptions. */
export class SubscriptionCliProviderAdapter implements LlmProviderAdapter {
  readonly provider: EnabledLlmProviderMode;

  private readonly defaultModel: string | undefined;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly executable: string;
  private readonly executor: BufferedCommandExecutor;
  private readonly maxBufferBytes: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly definition: SubscriptionCliProviderDefinition,
    options: SubscriptionCliProviderAdapterOptions = {},
  ) {
    this.provider = definition.provider;
    this.defaultModel = optionalNonEmpty(options.defaultModel, "defaultModel");
    this.environment = options.environment ?? process.env;
    this.executable =
      optionalNonEmpty(options.executable, "executable") ??
      definition.cliExecutable;
    this.executor = options.executor ?? executeBufferedCommand;
    this.maxBufferBytes = positiveInteger(
      options.maxBufferBytes ?? DEFAULT_SUBSCRIPTION_CLI_MAX_BUFFER_BYTES,
      "maxBufferBytes",
    );
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_SUBSCRIPTION_CLI_TIMEOUT_MS,
      "timeoutMs",
    );
  }

  async completeStructured(
    request: StructuredCompletionRequest,
  ): Promise<StructuredCompletionResponse> {
    const model = optionalNonEmpty(request.model, "model") ?? this.defaultModel;
    if (model === undefined) {
      throw this.error(
        "INVALID_CONFIGURATION",
        `a ${this.definition.displayName} subscription model must be configured`,
      );
    }

    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), `repo-knowledge-${this.provider}-`),
    );
    const outcome = await (async () => {
      await chmod(temporaryDirectory, 0o700);
      return this.executeInTemporaryDirectory(
        request,
        model,
        temporaryDirectory,
      );
    })().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    try {
      await rm(temporaryDirectory, { force: true, recursive: true });
    } catch (error) {
      throw this.error(
        "PROVIDER_REQUEST_FAILED",
        "temporary subscription CLI files could not be removed",
        error,
      );
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  private async executeInTemporaryDirectory(
    request: StructuredCompletionRequest,
    model: string,
    temporaryDirectory: string,
  ): Promise<StructuredCompletionResponse> {
    let invocation: SubscriptionCliInvocation;
    try {
      invocation = await this.definition.createInvocation({
        environment: subscriptionOnlyEnvironment(this.environment),
        model,
        request,
        temporaryDirectory,
      });
    } catch (error) {
      if (error instanceof LlmProviderError) throw error;
      throw this.error(
        "PROVIDER_REQUEST_FAILED",
        "subscription CLI input could not be prepared",
        error,
      );
    }

    let result: BufferedCommandResult;
    try {
      result = await this.executor({
        args: invocation.args,
        cwd: invocation.cwd ?? temporaryDirectory,
        environment: subscriptionOnlyEnvironment(
          this.environment,
          invocation.environment,
        ),
        executable: this.executable,
        ...(invocation.input === undefined ? {} : { input: invocation.input }),
        maxBuffer: this.maxBufferBytes,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        shell: false,
        timeout: this.timeoutMs,
      });
    } catch (error) {
      throw this.commandError(undefined, error);
    }
    if (result.failed || (result.exitCode ?? 0) !== 0) {
      throw this.commandError(result);
    }

    let parsed: SubscriptionCliParsedOutput;
    try {
      parsed = await invocation.parseOutput(result);
    } catch (error) {
      if (error instanceof SubscriptionCliOutputError) {
        throw this.error(error.code, error.message, error);
      }
      if (error instanceof LlmProviderError) throw error;
      throw this.error(
        "PROVIDER_RESPONSE_INVALID",
        `${this.definition.displayName} CLI returned invalid structured output`,
        error,
      );
    }
    const outputText = parsed.outputText.trim();
    if (outputText.length === 0) {
      throw this.error(
        "PROVIDER_RESPONSE_INVALID",
        `${this.definition.displayName} CLI returned empty structured output`,
      );
    }
    const resolvedModel =
      optionalNonEmpty(parsed.model, "response model") ?? model;
    const responseId = optionalNonEmpty(parsed.responseId, "responseId");
    return {
      model: resolvedModel,
      outputText,
      provider: this.provider,
      ...(responseId === undefined ? {} : { responseId }),
    };
  }

  private commandError(
    result?: BufferedCommandResult,
    cause?: unknown,
  ): LlmProviderError {
    if (isMissingExecutable(result, cause)) {
      return this.error(
        "INVALID_CONFIGURATION",
        `${this.definition.displayName} CLI (${this.executable}) is not installed or executable`,
        cause,
      );
    }
    const diagnostic = [result?.stdout, result?.stderr, result?.message]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    if (looksLikeAuthenticationFailure(diagnostic)) {
      return this.error(
        "AUTHENTICATION_MISSING",
        `${this.definition.displayName} CLI has no usable subscription login`,
        cause,
      );
    }
    return this.error(
      "PROVIDER_REQUEST_FAILED",
      `${this.definition.displayName} subscription CLI command failed`,
      cause,
    );
  }

  private error(
    code: LlmProviderErrorCode,
    message: string,
    cause?: unknown,
  ): LlmProviderError {
    return new LlmProviderError(
      code,
      "system",
      this.provider,
      message,
      undefined,
      undefined,
      cause === undefined ? undefined : { cause },
    );
  }
}

export class SubscriptionCliOutputError extends Error {
  constructor(
    readonly code: "PROVIDER_RESPONSE_INVALID" | "PROVIDER_RESPONSE_TRUNCATED",
    message: string,
  ) {
    super(message);
    this.name = "SubscriptionCliOutputError";
  }
}

export async function writePrivateSubscriptionFile(
  directory: string,
  name: string,
  content: string,
): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/u.test(name)) {
    throw new TypeError("subscription CLI temporary file name is invalid");
  }
  const path = join(directory, name);
  await writeFile(path, content, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return path;
}

export function subscriptionOnlyEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  additions: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> {
  const environment = new Map<string, string>();
  for (const [name, value] of Object.entries(base)) {
    if (isAllowedSubscriptionEnvironmentVariable(name) && value !== undefined) {
      environment.set(name, value);
    }
  }
  for (const [name, value] of Object.entries(additions)) {
    if (
      !isAllowedSubscriptionEnvironmentVariable(name) ||
      value === undefined
    ) {
      environment.delete(name);
    } else {
      environment.set(name, value);
    }
  }
  return Object.fromEntries(environment);
}

function isAllowedSubscriptionEnvironmentVariable(name: string): boolean {
  return (
    SAFE_ENVIRONMENT_VARIABLE_NAME.test(name) &&
    !UNSAFE_OBJECT_PROPERTY_NAMES.has(name) &&
    !PROVIDER_CREDENTIAL_ENVIRONMENT_VARIABLE_NAMES.has(name.toUpperCase())
  );
}

export interface LlmSubscriptionInspection {
  readonly authenticated: boolean;
  readonly cliAvailable: boolean;
  readonly method?: string;
}

export interface LlmSubscriptionInspectorLike {
  inspect(mode: EnabledLlmProviderMode): Promise<LlmSubscriptionInspection>;
}

export interface CliLlmSubscriptionInspectorOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly executor?: BufferedCommandExecutor;
  readonly timeoutMs?: number;
}

/** Checks CLI presence and subscription login without running a model prompt. */
export class CliLlmSubscriptionInspector implements LlmSubscriptionInspectorLike {
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly executor: BufferedCommandExecutor;
  private readonly timeoutMs: number;

  constructor(options: CliLlmSubscriptionInspectorOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.executor = options.executor ?? executeBufferedCommand;
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_SUBSCRIPTION_AUTH_TIMEOUT_MS,
      "timeoutMs",
    );
  }

  async inspect(
    mode: EnabledLlmProviderMode,
  ): Promise<LlmSubscriptionInspection> {
    const definition = getLlmProviderDefinition(mode);
    const check = authenticationCheck(mode);
    let result: BufferedCommandResult;
    try {
      result = await this.executor({
        args: check.args,
        environment: subscriptionOnlyEnvironment(
          this.environment,
          check.environment,
        ),
        executable: definition.cliExecutable,
        maxBuffer: 1024 * 1024,
        shell: false,
        timeout: this.timeoutMs,
      });
    } catch (error) {
      return {
        authenticated: false,
        cliAvailable: !isMissingExecutable(undefined, error),
      };
    }
    if (isMissingExecutable(result) || result.code === "ENOENT") {
      return { authenticated: false, cliAvailable: false };
    }
    if (result.failed || (result.exitCode ?? 0) !== 0) {
      return { authenticated: false, cliAvailable: true };
    }
    return parseAuthenticationStatus(mode, result.stdout);
  }
}

function authenticationCheck(mode: EnabledLlmProviderMode): {
  readonly args: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
} {
  switch (mode) {
    case "anthropic":
      return { args: ["auth", "status", "--json"] };
    case "openai":
      return { args: ["login", "status"] };
    case "xai":
      return {
        args: ["models"],
        environment: { GROK_DISABLE_API_KEY_AUTH: "1" },
      };
  }
}

function parseAuthenticationStatus(
  mode: EnabledLlmProviderMode,
  stdout: string,
): LlmSubscriptionInspection {
  if (mode === "openai") {
    const authenticated = /logged in using chatgpt/iu.test(stdout);
    return {
      authenticated,
      cliAvailable: true,
      ...(authenticated ? { method: "ChatGPT" } : {}),
    };
  }
  if (mode === "xai") {
    const authenticated = /logged in with (?:grok\.com|x\.ai)/iu.test(stdout);
    return {
      authenticated,
      cliAvailable: true,
      ...(authenticated ? { method: "grok.com" } : {}),
    };
  }
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    const subscriptionType = value.subscriptionType;
    const authenticated =
      value.loggedIn === true &&
      value.authMethod === "claude.ai" &&
      value.apiProvider === "firstParty" &&
      typeof subscriptionType === "string" &&
      subscriptionType.length > 0 &&
      subscriptionType !== "free";
    return {
      authenticated,
      cliAvailable: true,
      ...(authenticated ? { method: "claude.ai" } : {}),
    };
  } catch {
    return { authenticated: false, cliAvailable: true };
  }
}

function isMissingExecutable(
  result?: BufferedCommandResult,
  error?: unknown,
): boolean {
  return (
    result?.code === "ENOENT" ||
    (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
  );
}

function looksLikeAuthenticationFailure(value: string): boolean {
  return /(?:auth(?:entication)? required|not (?:authenticated|logged in)|run [`']?(?:claude auth login|codex login|grok login)|sign in)/iu.test(
    value,
  );
}

function optionalNonEmpty(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}
