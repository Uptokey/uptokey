export namespace Glob {
  export interface Options {
    cwd?: string
    absolute?: boolean
    include?: "file" | "all"
    dot?: boolean
    symlink?: boolean
  }

  export async function scan(pattern: string, options: Options = {}): Promise<string[]> {
    const glob = new Bun.Glob(pattern)
    const results: string[] = []
    for await (const entry of glob.scan({
      cwd: options.cwd ?? process.cwd(),
      absolute: options.absolute,
      dot: options.dot,
      followSymlinks: options.symlink ?? false,
      onlyFiles: options.include !== "all",
    }))
      results.push(entry)
    return results
  }

  export function scanSync(pattern: string, options: Options = {}): string[] {
    return [
      ...new Bun.Glob(pattern).scanSync({
        cwd: options.cwd ?? process.cwd(),
        absolute: options.absolute,
        dot: options.dot,
        followSymlinks: options.symlink ?? false,
        onlyFiles: options.include !== "all",
      }),
    ]
  }

  export function match(pattern: string, filepath: string): boolean {
    return new Bun.Glob(pattern).match(filepath)
  }
}
