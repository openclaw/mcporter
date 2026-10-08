import path from 'node:path';
import { loadConfigSnapshot } from '../../config.js';
import { readJsonFile } from '../../fs-json.js';
import { getOAuthVaultPath } from '../../oauth-vault.js';
import {
  VAULT_ENCRYPTION_POLICY_ENV,
  VAULT_PASSWORD_ENV,
  VaultEncryptionError,
  describeVaultSecrets,
  readVaultEncryptionSettings,
} from '../../oauth-vault-encryption.js';
import { MCPORTER_VERSION } from '../../version.js';
import { logConfigLocations, resolveConfigLocations } from './shared.js';
import type { ConfigCliOptions } from './types.js';

// Mirrors the vault reader's shape check; anything else is repaired on the next write.
function isVaultDocument(document: unknown): document is { entries: Record<string, unknown> } {
  if (!document || typeof document !== 'object') return false;
  const { version, entries } = document as { version?: unknown; entries?: unknown };
  return (version === 1 || version === 2) && !!entries && typeof entries === 'object';
}

async function reportVault(issues: string[], configuredPolicy: 'optional' | 'required' | undefined): Promise<void> {
  const vaultPath = getOAuthVaultPath();
  let stats: ReturnType<typeof describeVaultSecrets> | 'absent' | 'unreadable';
  let problem: string | undefined;
  try {
    const document = await readJsonFile(vaultPath);
    if (document === undefined) {
      stats = 'absent';
    } else if (isVaultDocument(document)) {
      stats = describeVaultSecrets(document.entries);
    } else {
      // Same shape check as the vault reader, which treats this as needing repair.
      stats = 'unreadable';
      problem =
        'The OAuth vault is not a valid OAuth vault document; mcporter will rewrite it on the next credential write.';
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    stats = 'unreadable';
    problem = 'The OAuth vault is not valid JSON; mcporter will rewrite it on the next credential write.';
  }
  const label =
    typeof stats === 'string'
      ? stats
      : `${stats.entries} entries, ${stats.sealed} sealed values, ${stats.plaintext} plaintext values`;
  console.log(`OAuth vault: ${vaultPath} (${label})`);
  if (problem) issues.push(problem);
  try {
    const settings = readVaultEncryptionSettings(process.env, configuredPolicy);
    console.log(
      `Vault encryption: policy ${settings.policy}, ${VAULT_PASSWORD_ENV} ${settings.password === undefined ? 'unset' : 'set'}`
    );
    if (typeof stats === 'string') return;
    if (stats.sealed > 0 && settings.password === undefined) {
      issues.push(
        `The OAuth vault holds ${stats.sealed} sealed values but ${VAULT_PASSWORD_ENV} is unset; OAuth-backed servers will fail until it is set.`
      );
    }
    if (stats.plaintext > 0 && settings.password !== undefined) {
      const source = process.env[VAULT_ENCRYPTION_POLICY_ENV]
        ? `${VAULT_ENCRYPTION_POLICY_ENV}=required`
        : 'oauthVaultEncryption "required"';
      issues.push(
        `The OAuth vault holds ${stats.plaintext} plaintext secret values${settings.policy === 'required' ? ` under ${source}` : ''}; they are sealed on the next vault write.`
      );
    }
  } catch (error) {
    if (!(error instanceof VaultEncryptionError)) throw error;
    issues.push(error.message);
  }
}

export async function handleDoctorCommand(options: ConfigCliOptions, _args: string[]): Promise<void> {
  console.log(`MCPorter ${MCPORTER_VERSION}`);
  logConfigLocations(await resolveConfigLocations(options.loadOptions), { leadingNewline: false });
  console.log('');
  const issues: string[] = [];
  const snapshot = await loadConfigSnapshot(options.loadOptions);
  for (const server of snapshot.servers) {
    if (server.command.kind === 'stdio' && !path.isAbsolute(server.command.cwd)) {
      issues.push(`Server '${server.name}' has a non-absolute working directory.`);
    }
  }
  await reportVault(issues, snapshot.vaultEncryption);
  if (issues.length === 0) {
    console.log('Config looks good.');
    return;
  }
  console.log('Config issues detected:');
  for (const issue of issues) console.log(`  - ${issue}`);
}
