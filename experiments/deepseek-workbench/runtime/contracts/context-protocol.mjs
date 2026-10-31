//#region ../../proxy/core/vendor/sync-contract/plain-data.js
function isDataRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	return Reflect.ownKeys(value).every((key) => typeof key === "string" && descriptors[key].enumerable && Object.hasOwn(descriptors[key], "value"));
}
new Uint32Array([
	1116352408,
	1899447441,
	3049323471,
	3921009573,
	961987163,
	1508970993,
	2453635748,
	2870763221,
	3624381080,
	310598401,
	607225278,
	1426881987,
	1925078388,
	2162078206,
	2614888103,
	3248222580,
	3835390401,
	4022224774,
	264347078,
	604807628,
	770255983,
	1249150122,
	1555081692,
	1996064986,
	2554220882,
	2821834349,
	2952996808,
	3210313671,
	3336571891,
	3584528711,
	113926993,
	338241895,
	666307205,
	773529912,
	1294757372,
	1396182291,
	1695183700,
	1986661051,
	2177026350,
	2456956037,
	2730485921,
	2820302411,
	3259730800,
	3345764771,
	3516065817,
	3600352804,
	4094571909,
	275423344,
	430227734,
	506948616,
	659060556,
	883997877,
	958139571,
	1322822218,
	1537002063,
	1747873779,
	1955562222,
	2024104815,
	2227730452,
	2361852424,
	2428436474,
	2756734187,
	3204031479,
	3329325298
]);
new TextEncoder();
const id = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(v);
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const isUtcIsoDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v) && Number.isFinite(Date.parse(v));
function parseProjectRootBinding(input) {
	const invalid = () => {
		throw new Error("project_root_binding_invalid");
	};
	if (!isDataRecord(input)) invalid();
	const keys = Object.keys(input).sort();
	const hasRevoked = keys.includes("revokedAt");
	const expectedKeys = hasRevoked ? [
		"accessMode",
		"displayName",
		"expiresAt",
		"grantedAt",
		"id",
		"principalId",
		"projectId",
		"revision",
		"revokedAt",
		"rootIdentityDigest"
	] : [
		"accessMode",
		"displayName",
		"expiresAt",
		"grantedAt",
		"id",
		"principalId",
		"projectId",
		"revision",
		"rootIdentityDigest"
	];
	if (keys.join(",") !== expectedKeys.join(",")) invalid();
	if (!id(input.id) || !id(input.projectId) || !id(input.principalId)) invalid();
	if (!Number.isSafeInteger(input.revision) || input.revision < 1) invalid();
	if (typeof input.displayName !== "string" || input.displayName.length < 1 || input.displayName.length > 100) invalid();
	if (!digest(input.rootIdentityDigest)) invalid();
	if (!isUtcIsoDate(input.grantedAt) || !isUtcIsoDate(input.expiresAt)) invalid();
	if (Date.parse(input.expiresAt) <= Date.parse(input.grantedAt)) invalid();
	if (hasRevoked && input.revokedAt !== null && !isUtcIsoDate(input.revokedAt)) invalid();
	if (!["read_write", "read_only"].includes(input.accessMode)) invalid();
	return Object.freeze({
		id: input.id,
		projectId: input.projectId,
		principalId: input.principalId,
		revision: input.revision,
		displayName: input.displayName,
		rootIdentityDigest: input.rootIdentityDigest,
		grantedAt: input.grantedAt,
		expiresAt: input.expiresAt,
		...hasRevoked ? { revokedAt: input.revokedAt } : {},
		accessMode: input.accessMode
	});
}
//#endregion
//#region uptokey-context-protocol.ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
var WorkspaceContextLinkError = class extends Error {
	status;
	type;
	constructor(status, type) {
		super(type);
		this.status = status;
		this.type = type;
	}
};
function record(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceContextLinkError(502, "context_link_invalid_response");
	return value;
}
function parseWorkspaceContextLink(input) {
	const value = record(input);
	if (typeof value.clientId !== "string" || !UUID.test(value.clientId) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new WorkspaceContextLinkError(502, "context_link_invalid_response");
	const base = {
		clientId: value.clientId,
		revision: Number(value.revision)
	};
	if (value.linked === false) {
		if (value.reason !== void 0 && value.reason !== "context_link_invalid") throw new WorkspaceContextLinkError(502, "context_link_invalid_response");
		return {
			...base,
			linked: false,
			...value.reason ? { reason: "context_link_invalid" } : {}
		};
	}
	if (value.linked !== true || typeof value.conversationId !== "string" || !CONVERSATION_ID.test(value.conversationId) || !Array.isArray(value.projectIds) || !value.projectIds.length || value.projectIds.length > 32 || value.projectIds.some((id) => typeof id !== "string" || !PROJECT.test(id)) || new Set(value.projectIds).size !== value.projectIds.length) throw new WorkspaceContextLinkError(502, "context_link_invalid_response");
	return {
		...base,
		linked: true,
		conversationId: value.conversationId,
		projectIds: value.projectIds
	};
}
//#endregion
export { WorkspaceContextLinkError, parseProjectRootBinding, parseWorkspaceContextLink };
