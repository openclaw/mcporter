import { resolveConfigPath, writeRawConfig } from '../../config.js';
import { withFileLock } from '../../fs-json.js';
import { CliUsageError } from '../errors.js';
import { cloneConfig, findServerNameWithFuzzyMatch, loadOrCreateConfig } from './shared.js';
import type { ConfigCliOptions } from './types.js';

export async function handleRemoveCommand(options: ConfigCliOptions, args: string[]): Promise<void> {
  const name = args.shift();
  if (!name) {
    throw new CliUsageError('Usage: mcporter config remove <name>');
  }
  const rootDir = options.loadOptions.rootDir ?? process.cwd();
  const lockPath = resolveConfigPath(options.loadOptions.configPath, rootDir).path;
  let configPath = lockPath;
  let targetName = name;
  await withFileLock(lockPath, async () => {
    const loaded = await loadOrCreateConfig({ ...options.loadOptions, configPath: lockPath });
    configPath = loaded.path;
    const matched = findServerNameWithFuzzyMatch(name, Object.keys(loaded.config.mcpServers ?? {}));
    if (!matched) {
      throw new CliUsageError(`Server '${name}' does not exist in ${configPath}.`);
    }
    targetName = matched;
    const nextConfig = cloneConfig(loaded.config);
    delete nextConfig.mcpServers[targetName];
    await writeRawConfig(configPath, nextConfig);
  });
  console.log(`Removed '${targetName}' from ${configPath}`);
}
