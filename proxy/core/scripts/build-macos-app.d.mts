export interface MacosBundleLayout { app: string; executable: string; nativeModule: string; updateHelper: string; infoPlist: string; license: string }
export function macosBundleLayout(outputRoot?: string): MacosBundleLayout;
export function buildMacosApp(outputRoot?: string): MacosBundleLayout;
export function materializeMacosInfoPlist(templatePath: string, outputPath: string, buildVersion: string): void;
