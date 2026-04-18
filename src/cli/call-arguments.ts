import type { EphemeralServerSpec } from "./adhoc-server.js";
import { parseLeadingCallExpression } from "./call-argument-expression.js";
import {
  type CoercionMode,
  coerceValue,
  parseKeyValueToken,
  shouldPromoteSelectorToCommand,
} from "./call-argument-values.js";
import { buildUnknownCallFlagMessage } from "./call-help.js";
import { extractEphemeralServerFlags } from "./ephemeral-flags.js";
import { CliUsageError } from "./errors.js";
import { consumeOutputFormat } from "./output-format.js";
import type { OutputFormat } from "./output-utils.js";
import { consumeTimeoutFlag } from "./timeouts.js";

export interface CallArgsParseResult {
  selector?: string;
  server?: string;
  tool?: string;
  args: Record<string, unknown>;
  positionalArgs?: unknown[];
  tailLog: boolean;
  output: OutputFormat;
  timeoutMs?: number;
  ephemeral?: EphemeralServerSpec;
  rawStrings?: boolean;
  saveImagesDir?: string;
}

interface FlagParseState {
  coercionMode: CoercionMode;
}

interface FlagHandlerContext {
  args: string[];
  index: number;
  result: CallArgsParseResult;
  state: FlagParseState;
}

type FlagHandler = (context: FlagHandlerContext) => number;

interface ScannedCallTokens {
  positional: string[];
  literalPositional: string[];
}

interface CallExpressionResolution {
  callExpressionProvidedServer: boolean;
  callExpressionProvidedTool: boolean;
}

const FLAG_HANDLERS: Record<string, FlagHandler> = {
  "--server": handleServerFlag,
  "--mcp": handleServerFlag,
  "--tool": handleToolFlag,
  "--timeout": handleTimeoutFlag,
  "--tail-log": handleTailLogFlag,
  "--save-images": handleSaveImagesFlag,
  "--yes": handleNoopFlag,
  "--raw-strings": handleRawStringsFlag,
  "--no-coerce": handleNoCoerceFlag,
  "--args": handleArgsFlag,
};

export function parseCallArguments(args: string[]): CallArgsParseResult {
  const result: CallArgsParseResult = {
    args: {},
    tailLog: false,
    output: "auto",
  };
  const flagState: FlagParseState = { coercionMode: "default" };
  const ephemeral = extractEphemeralServerFlags(args);
  result.ephemeral = ephemeral;
  result.output = consumeOutputFormat(args, {
    defaultFormat: "auto",
  });
  const { positional, literalPositional } = scanCallTokens(
    args,
    result,
    flagState,
  );
  const { callExpressionProvidedServer, callExpressionProvidedTool } =
    applyLeadingCallExpression(positional, result);
  resolveSelectorAndTool(
    positional,
    result,
    callExpressionProvidedServer,
    callExpressionProvidedTool,
  );
  applyTrailingArguments(positional, result, flagState);
  appendLiteralPositionalArguments(literalPositional, result, flagState);
  return result;
}

function scanCallTokens(
  args: string[],
  result: CallArgsParseResult,
  state: FlagParseState,
): ScannedCallTokens {
  const positional: string[] = [];
  const literalPositional: string[] = [];
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (!token) {
      index += 1;
      continue;
    }
    if (token === "--") {
      literalPositional.push(...args.slice(index + 1).filter(Boolean));
      break;
    }
    const flagHandler = FLAG_HANDLERS[token];
    if (flagHandler) {
      index = flagHandler({ args, index, result, state });
      continue;
    }
    if (token.startsWith("--")) {
      throw new CliUsageError(buildUnknownCallFlagMessage(token));
    }
    positional.push(token);
    index += 1;
  }
  return { positional, literalPositional };
}

function applyLeadingCallExpression(
  positional: string[],
  result: CallArgsParseResult,
): CallExpressionResolution {
  if (positional.length === 0) {
    return {
      callExpressionProvidedServer: false,
      callExpressionProvidedTool: false,
    };
  }
  const rawToken = positional[0] ?? "";
  const callExpression = parseLeadingCallExpression(rawToken);
  if (!callExpression) {
    return {
      callExpressionProvidedServer: false,
      callExpressionProvidedTool: false,
    };
  }
  positional.shift();
  if (callExpression.server) {
    if (result.server && result.server !== callExpression.server) {
      throw new Error(
        `Conflicting server names: '${result.server}' from flags and '${callExpression.server}' from call expression.`,
      );
    }
    result.server = result.server ?? callExpression.server;
  }
  if (result.tool && result.tool !== callExpression.tool) {
    throw new Error(
      `Conflicting tool names: '${result.tool}' from flags and '${callExpression.tool}' from call expression.`,
    );
  }
  result.tool = callExpression.tool;
  Object.assign(result.args, callExpression.args);
  if (
    callExpression.positionalArgs &&
    callExpression.positionalArgs.length > 0
  ) {
    result.positionalArgs = [
      ...(result.positionalArgs ?? []),
      ...callExpression.positionalArgs,
    ];
  }
  return {
    callExpressionProvidedServer: Boolean(callExpression.server),
    callExpressionProvidedTool: Boolean(callExpression.tool),
  };
}

function resolveSelectorAndTool(
  positional: string[],
  result: CallArgsParseResult,
  callExpressionProvidedServer: boolean,
  callExpressionProvidedTool: boolean,
): void {
  if (
    !result.selector &&
    positional.length > 0 &&
    !callExpressionProvidedServer &&
    !result.server
  ) {
    result.selector = positional.shift();
  }
  if (
    !result.server &&
    result.selector &&
    shouldPromoteSelectorToCommand(result.selector) &&
    !result.ephemeral?.stdioCommand
  ) {
    result.ephemeral = { ...result.ephemeral, stdioCommand: result.selector };
    result.selector = undefined;
  }
  const nextPositional = positional[0];
  if (
    !result.tool &&
    nextPositional !== undefined &&
    !nextPositional.includes("=") &&
    !nextPositional.includes(":") &&
    !callExpressionProvidedTool
  ) {
    result.tool = positional.shift();
  }
}

function applyTrailingArguments(
  positional: string[],
  result: CallArgsParseResult,
  state: FlagParseState,
): void {
  const trailingPositional: unknown[] = [];
  for (let index = 0; index < positional.length; ) {
    const token = positional[index];
    if (!token) {
      index += 1;
      continue;
    }
    const parsed = parseKeyValueToken(token, positional[index + 1]);
    if (!parsed) {
      trailingPositional.push(coerceValue(token, state.coercionMode));
      index += 1;
      continue;
    }
    index += parsed.consumed;
    const value = coerceValue(parsed.rawValue, state.coercionMode);
    if (parsed.key === "tool" && !result.tool) {
      if (typeof value !== "string") {
        throw new Error("Argument 'tool' must be a string value.");
      }
      result.tool = value as string;
      continue;
    }
    if (parsed.key === "server" && !result.server) {
      if (typeof value !== "string") {
        throw new Error("Argument 'server' must be a string value.");
      }
      result.server = value as string;
      continue;
    }
    result.args[parsed.key] = value;
  }
  if (trailingPositional.length > 0) {
    result.positionalArgs = [
      ...(result.positionalArgs ?? []),
      ...trailingPositional,
    ];
  }
}

function appendLiteralPositionalArguments(
  literalPositional: string[],
  result: CallArgsParseResult,
  state: FlagParseState,
): void {
  if (literalPositional.length === 0) {
    return;
  }
  result.positionalArgs = [
    ...(result.positionalArgs ?? []),
    ...literalPositional.map((token) => coerceValue(token, state.coercionMode)),
  ];
}

function handleServerFlag(context: FlagHandlerContext): number {
  const token = context.args[context.index] ?? "--server";
  context.result.server = consumeFlagValue(context.args, context.index, token);
  return context.index + 2;
}

function handleToolFlag(context: FlagHandlerContext): number {
  context.result.tool = consumeFlagValue(context.args, context.index, "--tool");
  return context.index + 2;
}

function handleTimeoutFlag(context: FlagHandlerContext): number {
  context.result.timeoutMs = consumeTimeoutFlag(context.args, context.index, {
    flagName: "--timeout",
    missingValueMessage: "--timeout requires a value (milliseconds).",
  });
  // consumeTimeoutFlag removes the flag/value pair in-place; stay on the same index.
  return context.index;
}

function handleTailLogFlag(context: FlagHandlerContext): number {
  context.result.tailLog = true;
  return context.index + 1;
}

function handleSaveImagesFlag(context: FlagHandlerContext): number {
  context.result.saveImagesDir = consumeFlagValue(
    context.args,
    context.index,
    "--save-images",
    "--save-images requires a directory path.",
  );
  return context.index + 2;
}

function handleNoopFlag(context: FlagHandlerContext): number {
  return context.index + 1;
}

function handleRawStringsFlag(context: FlagHandlerContext): number {
  context.state.coercionMode = "raw-strings";
  context.result.rawStrings = true;
  return context.index + 1;
}

function handleNoCoerceFlag(context: FlagHandlerContext): number {
  context.state.coercionMode = "none";
  context.result.rawStrings = true;
  return context.index + 1;
}

function handleArgsFlag(context: FlagHandlerContext): number {
  const raw = consumeFlagValue(
    context.args,
    context.index,
    "--args",
    "--args requires a JSON value.",
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Unable to parse --args: ${(error as Error).message}`);
  }
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded)
  ) {
    throw new Error("Unable to parse --args: --args must be a JSON object.");
  }
  Object.assign(context.result.args, decoded);
  return context.index + 2;
}

function consumeFlagValue(
  args: string[],
  index: number,
  token: string,
  missingValueMessage?: string,
): string {
  const value = args[index + 1];
  if (value) {
    return value;
  }
  throw new Error(missingValueMessage ?? `Flag '${token}' requires a value.`);
}
