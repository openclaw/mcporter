import type { CliArtifactMetadata } from '../../cli-metadata.js';
import { type GenerateCliOptions, generateCli } from '../../generate-cli.js';

export async function performGenerateFromArtifact(
  metadata: CliArtifactMetadata,
  request: GenerateCliOptions
): Promise<void> {
  const { outputPath, bundlePath, compilePath } = await generateCli(request);
  if (metadata.artifact.kind === 'binary' && compilePath) {
    console.log(`Regenerated compiled CLI at ${compilePath}`);
  } else if (metadata.artifact.kind === 'bundle' && bundlePath) {
    console.log(`Regenerated bundled CLI at ${bundlePath}`);
  } else {
    console.log(`Regenerated template at ${outputPath}`);
  }
}

export async function performGenerateFromRequest(request: GenerateCliOptions): Promise<void> {
  const { outputPath, bundlePath, compilePath } = await generateCli(request);
  if (request.outputPath || (!bundlePath && !compilePath)) {
    console.log(`Generated CLI at ${outputPath}`);
  }
  if (bundlePath) {
    console.log(`Bundled executable created at ${bundlePath}`);
  }
  if (compilePath) {
    console.log(`Compiled executable created at ${compilePath}`);
  }
}
