export interface MacosKeychainEvidence { schema: string; verifiedAt: string; accountFingerprint: string; protectedWrite: boolean; legacyCrossProcessRead: boolean; cleanup: string }
export function runMacosKeychainAcceptance(appPath: string, outputPath?: string): MacosKeychainEvidence;
