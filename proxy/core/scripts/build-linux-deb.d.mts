export interface LinuxDebLayout { stage: string; executable: string; service: string; license: string; readme: string; control: string; postinst: string; prerm: string; package: string; version: string; architecture: "amd64" }
export function linuxDebLayout(outputRoot?: string, version?: string): LinuxDebLayout;
export function debianControl(version: string): string;
export function validateDebianControl(text: string, expectedVersion: string, expectedArchitecture?: string): string[];
export function validateMaintainerScript(text: string, kind: "postinst" | "prerm"): string[];
export function buildLinuxDeb(outputRoot?: string): LinuxDebLayout;
