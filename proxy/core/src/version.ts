declare const UPTOKEY_BUILD_VERSION: string | undefined;
const compiledVersion = typeof UPTOKEY_BUILD_VERSION === "string" ? UPTOKEY_BUILD_VERSION : "0.1.0";
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(compiledVersion)) throw new Error("compiled_version_invalid");
export const PACKAGE_VERSION = compiledVersion;
export const RELEASE_VERSION = `v${PACKAGE_VERSION}`;
