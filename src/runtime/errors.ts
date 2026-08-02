import { ProtocolErrorCode as ErrorCode } from '@modelcontextprotocol/client';

const NON_FATAL_MCP_ERROR_CODES = new Set([
  ErrorCode.InvalidRequest,
  ErrorCode.MethodNotFound,
  ErrorCode.InvalidParams,
]);

export function shouldResetConnection(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const code = protocolErrorCode(error);
  if (code !== undefined) {
    return !NON_FATAL_MCP_ERROR_CODES.has(code);
  }
  return error instanceof Error;
}

function protocolErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'number' ? error.code : undefined;
}
