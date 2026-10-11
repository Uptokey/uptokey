/**
 * Uptokey TUI — Distribution and packaging utilities.
 *
 * T39: Package the TUI as a standalone executable using
 * Node.js SEA (Single Executable Applications) or pkg.
 *
 * This module provides the build configuration and entry
 * point for creating standalone binaries.
 */

export interface DistConfig {
  name: string;
  version: string;
  entry: string;
  targets: DistTarget[];
  output: string;
}

export interface DistTarget {
  platform: "win" | "mac" | "linux";
  arch: "x64" | "arm64";
  ext: string;
}

export const DEFAULT_TARGETS: DistTarget[] = [
  { platform: "win", arch: "x64", ext: ".exe" },
  { platform: "mac", arch: "arm64", ext: "" },
  { platform: "linux", arch: "x64", ext: "" },
  { platform: "linux", arch: "arm64", ext: "" },
];

/**
 * Generate the SEA (Single Executable Application) config.
 * Uses Node.js built-in SEA support (node >= 20).
 */
export function generateSeaConfig(config: DistConfig): Record<string, unknown> {
  return {
    main: config.entry,
    output: `${config.output}/${config.name}-sea-prep.blob`,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
    assets: {
      // Include any runtime assets needed
    },
  };
}

/**
 * Generate a minimal package.json for distribution.
 */
export function generateDistPackageJson(config: DistConfig): Record<string, unknown> {
  return {
    name: config.name,
    version: config.version,
    bin: { [config.name]: config.entry },
    scripts: {
      "build:sea": [
        `node --experimental-sea-config sea-config.json`,
        `node -e "require('fs').copyFileSync(process.execPath, '${config.output}/${config.name}')"`,
        `npx postject ${config.output}/${config.name} NODE_SEA_BLOB ${config.output}/${config.name}-sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
      ].join(" && "),
    },
    engines: { node: ">=22.0.0" },
  };
}

/**
 * Get the recommended build command for the current platform.
 */
export function getBuildInstructions(): string {
  return [
    "# Uptokey TUI — Build Instructions",
    "",
    "## Option 1: Node.js SEA (recommended, node >= 22)",
    "```bash",
    "# 1. Bundle with esbuild",
    "npx esbuild src/tui/index.ts --bundle --platform=node --target=node22 --outfile=dist/tui.cjs",
    "",
    "# 2. Generate SEA blob",
    "echo '{\"main\":\"dist/tui.cjs\",\"output\":\"dist/sea-prep.blob\",\"disableExperimentalSEAWarning\":true}' > sea-config.json",
    "node --experimental-sea-config sea-config.json",
    "",
    "# 3. Create executable",
    "cp $(which node) dist/uptokey-tui",
    "npx postject dist/uptokey-tui NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    "```",
    "",
    "## Option 2: npm distribution",
    "Use the installation command documented for a published Uptokey release. A separate @uptokey/tui package is not established by this build configuration.",
    "",
    "## Option 3: Direct execution (dev)",
    "```bash",
    "npm --prefix proxy/core run tui",
    "```",
  ].join("\n");
}
