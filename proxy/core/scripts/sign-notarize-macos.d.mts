export function signAndNotarizeMacos(options: {
  appPath: string;
  identity: string | undefined;
  notaryProfile: string | undefined;
  provisioningProfile: string | undefined;
  teamId: string | undefined;
  archivePath?: string;
}): { app: string; archive: string };
export function validateProvisioningProfileClaims(claims: {
  teamIds: string[];
  applicationIdentifier: string;
  keychainAccessGroups: string[];
  getTaskAllow?: unknown;
  expirationDate: string;
}, teamId: string, now?: number): void;
export function assertCertificateTeam(subject: string, teamId: string): void;
export function selectSigningIdentityFingerprint(listed: string, identity: string): string;
export function assertCertificateFingerprint(output: string, expected: string): void;

export function validateDebugClaims(values: Record<string, unknown>): false;

export function signMacosEmbeddedCore(options: { appPath: string; identity: string | undefined; provisioningProfile: string | undefined; teamId: string | undefined }): { app: string; teamId: string };

export function signMacosComputer(options: { executable: string; identity: string | undefined; teamId: string | undefined }): void;

export function embeddedNativeModules(directory: string): string[];
export function embeddedCoreEntitlementPlist(teamId: string): string;
