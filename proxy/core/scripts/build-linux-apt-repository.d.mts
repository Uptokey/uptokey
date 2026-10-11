export interface LinuxAptLayout { repository: string; poolPackage: string; packages: string; packagesGzip: string; release: string; inRelease: string; releaseSignature: string; publicKey: string; archive: string; version: string; architecture: "amd64"; suite: "stable"; component: "main" }
export function linuxAptLayout(outputRoot?: string, version?: string): LinuxAptLayout;
export function buildLinuxAptRepository(debPath: string, outputRoot?: string): LinuxAptLayout;
export function archiveLinuxAptRepository(repositoryRoot: string, archivePath: string): string;
