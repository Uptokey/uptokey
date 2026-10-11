/** Defense in depth for recipe data; not an HTML sanitizer or authorization boundary. */
export declare function assertNoForbiddenContent(data: unknown): void;
export declare function assertNoSecretSolicitation(data: unknown): void;
export declare function assertNoDangerousLinks(data: unknown): void;
