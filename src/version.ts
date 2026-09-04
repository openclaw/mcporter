import packageMetadata from '../package.json' with { type: 'json' };

// A static import also embeds the generating version in standalone bundles.
export const MCPORTER_VERSION = packageMetadata.version;
