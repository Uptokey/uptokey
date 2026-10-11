/** Portable callable fetch contract for injected transports; runtime-only helpers are not required. */
export type FetchTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
