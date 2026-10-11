export function which(cmd: string, env?: NodeJS.ProcessEnv) {
  return Bun.which(cmd, { PATH: env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? "" }) ?? null
}
