export function linuxFlatpakLayout(outputRoot?: string): { stage: string; executable: string; nativeModule: string; license: string; build: string; repository: string; bundle: string };
export function buildLinuxFlatpak(outputRoot?: string): ReturnType<typeof linuxFlatpakLayout>;
