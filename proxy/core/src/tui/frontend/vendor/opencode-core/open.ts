// Opens http(s) links with the platform opener. The URL is an argument vector entry, never shell text.
import { spawn } from "node:child_process"

export function openUrl(input: string) {
  const url = URL.canParse(input) ? new URL(input) : undefined
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:"))
    return Promise.reject(new Error(`Only http and https links can be opened in the browser: ${input}`))
  const [command, args]: [string, string[]] =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url.href]]
      : process.platform === "darwin"
        ? ["open", [url.href]]
        : ["xdg-open", [url.href]]
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
}
