declare const UPTOKEY_LINUX_PACKAGE_CHANNEL: string | undefined;

export type LinuxPackageChannel = "development" | "deb" | "flatpak";

const compiled = typeof UPTOKEY_LINUX_PACKAGE_CHANNEL === "string" ? UPTOKEY_LINUX_PACKAGE_CHANNEL : "development";
if (!(["development", "deb", "flatpak"] as string[]).includes(compiled)) throw new Error("linux_package_channel_invalid");

export const LINUX_PACKAGE_CHANNEL = compiled as LinuxPackageChannel;
