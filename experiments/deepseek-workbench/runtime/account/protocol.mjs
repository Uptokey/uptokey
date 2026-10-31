//#region proxy/core/src/account-login-protocol.ts
const DEFAULT_ACCOUNT_SERVICE_ORIGIN = "https://app.uptokey.com";
const ACCOUNT_REF = /^acc_[a-f0-9]{64}$/;
const ACCOUNT_MAX_AVAILABLE = 256;
const ACCOUNT_MAX_CLIENT_RESPONSE_BYTES = 262144;
function accountRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("account_response_invalid");
	return value;
}
function accountRevision(value) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw Error("account_response_invalid");
	return value;
}
function readAccountAvailable(value) {
	const row = accountRecord(value), revision = accountRevision(row.revision);
	if (!Array.isArray(row.accounts) || row.accounts.length > 256 || !(row.currentAccountRef === null || typeof row.currentAccountRef === "string" && ACCOUNT_REF.test(row.currentAccountRef)) || !(row.currentOwned === null || typeof row.currentOwned === "boolean") || row.currentAccountRef === null !== (row.currentOwned === null)) throw Error("account_response_invalid");
	const seen = /* @__PURE__ */ new Set();
	const accounts = row.accounts.map((value) => {
		const entry = accountRecord(value), session = readAccountPublicSession(entry.session);
		if (typeof entry.accountRef !== "string" || !ACCOUNT_REF.test(entry.accountRef) || seen.has(entry.accountRef) || typeof entry.owned !== "boolean" || !session.authenticated || typeof entry.expiresAt !== "number" || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt <= 0) throw Error("account_response_invalid");
		seen.add(entry.accountRef);
		return {
			accountRef: entry.accountRef,
			owned: entry.owned,
			session,
			expiresAt: entry.expiresAt
		};
	});
	if (row.currentAccountRef !== null && !accounts.some((entry) => entry.accountRef === row.currentAccountRef && entry.owned === row.currentOwned)) throw Error("account_response_invalid");
	return {
		revision,
		currentAccountRef: row.currentAccountRef,
		currentOwned: row.currentOwned,
		accounts
	};
}
function readAccountAdoption(value) {
	const row = accountRecord(value);
	return {
		revision: accountRevision(row.revision),
		session: readAccountPublicSession(row.session)
	};
}
function readAccountAdoptInput(value) {
	const row = accountRecord(value);
	if (Object.keys(row).some((key) => !["accountRef", "expectedRevision"].includes(key)) || typeof row.accountRef !== "string" || !ACCOUNT_REF.test(row.accountRef)) throw Error("account_request_invalid");
	try {
		return {
			accountRef: row.accountRef,
			expectedRevision: accountRevision(row.expectedRevision)
		};
	} catch {
		throw Error("account_request_invalid");
	}
}
function readAccountUnlinkInput(value) {
	const row = accountRecord(value);
	if (Object.keys(row).some((key) => key !== "expectedRevision")) throw Error("account_request_invalid");
	try {
		return { expectedRevision: accountRevision(row.expectedRevision) };
	} catch {
		throw Error("account_request_invalid");
	}
}
function readAccountShareChallenge(value) {
	const row = accountRecord(value);
	if (typeof row.id !== "string" || !ACCOUNT_ID.test(row.id) || typeof row.userCode !== "string" || !/^[A-F0-9]{8}$/.test(row.userCode) || typeof row.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.expiresAt) || !Number.isFinite(Date.parse(row.expiresAt))) throw Error("account_response_invalid");
	return {
		id: row.id,
		userCode: row.userCode,
		expiresAt: row.expiresAt
	};
}
function readAccountShareRequests(value) {
	const row = accountRecord(value);
	if (!Array.isArray(row.requests) || row.requests.length > 20) throw Error("account_response_invalid");
	const seen = /* @__PURE__ */ new Set();
	return { requests: row.requests.map((value) => {
		const entry = accountRecord(value), challenge = readAccountShareChallenge(entry);
		if (seen.has(challenge.id) || typeof entry.clientName !== "string" || entry.clientName.length < 1 || entry.clientName.length > 120 || /[\u0000-\u001f\u007f]/.test(entry.clientName) || ![
			"pwa",
			"tauri",
			"tui",
			"vscode",
			"browser-extension"
		].includes(String(entry.audience))) throw Error("account_response_invalid");
		seen.add(challenge.id);
		return {
			...challenge,
			clientName: entry.clientName,
			audience: entry.audience
		};
	}) };
}
function readAccountShareApproval(value) {
	if (accountRecord(value).approved !== true) throw Error("account_response_invalid");
	return { approved: true };
}
const ACCOUNT_CHALLENGE_TTL_MS = 3e5;
const ACCOUNT_MAX_RESPONSE_BYTES = 16384;
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const accountSubscriptionOperations = /* @__PURE__ */ new Set([
	"subscription.offer",
	"subscription.status",
	"subscription.checkout",
	"subscription.portal"
]);
function isAccountSubscriptionOperation(value) {
	return accountSubscriptionOperations.has(value);
}
const accountControlOperations = /* @__PURE__ */ new Set([
	"team.roster",
	"team.invite",
	"team.accept",
	"team.role",
	"team.revoke",
	"billing.profile",
	"billing.balances",
	"billing.invoices",
	"billing.portal",
	"billing.client-config",
	...accountSubscriptionOperations
]);
const exactKeys = (row, keys) => Object.keys(row).sort().join(",") === keys.slice().sort().join(",");
const accountResourceId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(value) ? value : (() => {
	throw Error("account_request_invalid");
})();
const accountEmail = (value) => typeof value === "string" && value.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) ? value.toLowerCase() : (() => {
	throw Error("account_request_invalid");
})();
const accountExpectedRevision = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : (() => {
	throw Error("account_request_invalid");
})();
function readAccountControlRequest(value) {
	const row = accountRecord(value);
	if (!exactKeys(row, ["operation", "payload"]) || typeof row.operation !== "string" || !accountControlOperations.has(row.operation)) throw Error("account_request_invalid");
	const operation = row.operation, payload = accountRecord(row.payload);
	let clean;
	if ([
		"team.roster",
		"billing.profile",
		"billing.balances",
		"billing.invoices",
		"billing.portal",
		"billing.client-config",
		"subscription.offer",
		"subscription.status"
	].includes(operation)) {
		if (Object.keys(payload).length) throw Error("account_request_invalid");
		clean = {};
	} else if (operation === "subscription.checkout" || operation === "subscription.portal") {
		if (!exactKeys(payload, operation === "subscription.checkout" ? ["accountRef", "requestId"] : ["accountRef"]) || typeof payload.accountRef !== "string" || !/^account_[a-f0-9]{64}$/.test(payload.accountRef) || operation === "subscription.checkout" && (typeof payload.requestId !== "string" || !ACCOUNT_ID.test(payload.requestId))) throw Error("account_request_invalid");
		clean = {
			accountRef: payload.accountRef,
			...operation === "subscription.checkout" ? { requestId: payload.requestId } : {}
		};
	} else if (operation === "team.invite") {
		if (!exactKeys(payload, [
			"email",
			"role",
			"requestId"
		]) || !["member", "admin"].includes(String(payload.role)) || typeof payload.requestId !== "string" || !ACCOUNT_ID.test(payload.requestId)) throw Error("account_request_invalid");
		clean = {
			email: accountEmail(payload.email),
			role: payload.role,
			requestId: payload.requestId
		};
	} else if (operation === "team.accept") {
		if (!exactKeys(payload, ["email", "inviteToken"]) || typeof payload.inviteToken !== "string" || !/^utk_team_invite_[A-Za-z0-9_-]{43}$/.test(payload.inviteToken)) throw Error("account_request_invalid");
		clean = {
			email: accountEmail(payload.email),
			inviteToken: payload.inviteToken
		};
	} else if (operation === "team.role") {
		if (!exactKeys(payload, [
			"memberId",
			"expectedRevision",
			"role"
		]) || !["member", "admin"].includes(String(payload.role))) throw Error("account_request_invalid");
		clean = {
			memberId: accountResourceId(payload.memberId),
			expectedRevision: accountExpectedRevision(payload.expectedRevision),
			role: payload.role
		};
	} else if (operation === "team.revoke") {
		if (!exactKeys(payload, ["seatId", "expectedRevision"])) throw Error("account_request_invalid");
		clean = {
			seatId: accountResourceId(payload.seatId),
			expectedRevision: accountExpectedRevision(payload.expectedRevision)
		};
	} else throw Error("account_request_invalid");
	return {
		operation,
		payload: clean
	};
}
function accountControlProofPayload(proof) {
	const request = readAccountControlRequest(proof.request);
	return JSON.stringify([
		"uptokey.account.control.v1",
		proof.id,
		proof.action,
		proof.nonce,
		proof.issuedAt,
		request.operation,
		request.payload
	]);
}
function isAccountMobilityPath(path) {
	return /^\/v1\/workspace\/mobility\/(?:recovery\/(?:create|restore)|objects\/[A-Za-z0-9_:-]{3,100}\/(?:push|pull|remove|resolve))$/.test(path);
}
function readAccountMobilityRequest(value) {
	const row = accountRecord(value);
	if (Object.keys(row).sort().join(",") !== "accountRef,bodyDigest,path,revision" || typeof row.path !== "string" || !isAccountMobilityPath(row.path) || typeof row.bodyDigest !== "string" || !/^[a-f0-9]{64}$/.test(row.bodyDigest) || typeof row.accountRef !== "string" || !ACCOUNT_REF.test(row.accountRef) || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 0) throw Error("account_request_invalid");
	return {
		path: row.path,
		bodyDigest: row.bodyDigest,
		accountRef: row.accountRef,
		revision: row.revision
	};
}
function accountMobilityProofPayload(proof) {
	const request = readAccountMobilityRequest(proof.request);
	return JSON.stringify([
		"uptokey.account.mobility.v1",
		proof.id,
		proof.action,
		proof.nonce,
		proof.issuedAt,
		request.path,
		request.bodyDigest,
		request.accountRef,
		request.revision
	]);
}
function isAccountAccessToken(value) {
	return typeof value === "string" && value.length >= 8 && value.length <= 16e3 && !/\s/.test(value) && !/^utk_/i.test(value);
}
function readAccountPublicUsage(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("account_usage_invalid");
	const row = value;
	if (![
		"observed",
		"not_configured",
		"link_required",
		"unavailable",
		"reauthentication_required"
	].includes(String(row.state)) || typeof row.verifiedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.verifiedAt) || !Number.isFinite(Date.parse(row.verifiedAt))) throw Error("account_usage_invalid");
	if (row.state === "observed") {
		if (row.currency !== "USD" || row.unit !== "micro_usd" || ![
			row.availableMicros,
			row.reservedMicros,
			row.spentMicros
		].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 0xe8d4a51000)) throw Error("account_usage_invalid");
		return {
			state: "observed",
			verifiedAt: row.verifiedAt,
			currency: "USD",
			unit: "micro_usd",
			availableMicros: row.availableMicros,
			reservedMicros: row.reservedMicros,
			spentMicros: row.spentMicros
		};
	}
	if ([
		"availableMicros",
		"reservedMicros",
		"spentMicros",
		"currency",
		"unit"
	].some((key) => row[key] !== void 0)) throw Error("account_usage_invalid");
	return {
		state: row.state,
		verifiedAt: row.verifiedAt
	};
}
function accountProofPayload(proof) {
	return JSON.stringify([
		"uptokey.account.broker.v1",
		proof.id,
		proof.action,
		proof.nonce,
		proof.issuedAt
	]);
}
function publicAccountProfile(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
	const row = value, result = {};
	if (typeof row.displayName === "string" && row.displayName.length > 0 && row.displayName.length <= 120 && !/[\u0000-\u001f\u007f]/.test(row.displayName)) result.displayName = row.displayName;
	if (typeof row.email === "string" && row.email.length <= 254 && !/[\u0000-\u001f\u007f]/.test(row.email) && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(row.email)) result.email = row.email;
	if (typeof row.plan === "string" && [
		"free",
		"individual",
		"team",
		"enterprise"
	].includes(row.plan)) result.plan = row.plan;
	return Object.keys(result).length ? result : void 0;
}
function readAccountPublicSession(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("account_response_invalid");
	const row = value;
	if (typeof row.configured !== "boolean" || typeof row.authenticated !== "boolean" || typeof row.loginAvailable !== "boolean" || ![
		"signed_out",
		"connecting",
		"connected",
		"unavailable"
	].includes(String(row.state)) || row.authenticated && (!row.configured || row.state !== "connected") || !row.authenticated && (row.profile !== void 0 || row.state === "connected")) throw Error("account_response_invalid");
	const profile = publicAccountProfile(row.profile);
	if (row.profile !== void 0 && !profile) throw Error("account_response_invalid");
	if (row.requiresSignIn !== void 0 && (typeof row.requiresSignIn !== "boolean" || row.authenticated && row.requiresSignIn)) throw Error("account_response_invalid");
	return {
		configured: row.configured,
		authenticated: row.authenticated,
		loginAvailable: row.loginAvailable,
		state: row.state,
		...profile ? { profile } : {},
		...row.requiresSignIn !== void 0 ? { requiresSignIn: row.requiresSignIn } : {}
	};
}
function trustedAccountOrigin(value, production = false) {
	if (!value) return void 0;
	let url;
	try {
		url = new URL(value);
	} catch {
		throw Error("account_service_origin_invalid");
	}
	if (url.origin !== value || url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && !production && [
		"localhost",
		"127.0.0.1",
		"[::1]"
	].includes(url.hostname))) throw Error("account_service_origin_invalid");
	return url.origin;
}
//#endregion
//#region proxy/contratos/plain-data.js
function isDataRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const descriptors = Object.getOwnPropertyDescriptors(value);
	return Reflect.ownKeys(value).every((key) => typeof key === "string" && descriptors[key].enumerable && Object.hasOwn(descriptors[key], "value"));
}
//#endregion
//#region quimera/uptokey/control-plane/src/personal-subscription-view.ts
const PLUS_OFFER = Object.freeze({
	plan: "plus",
	amountMinor: 500,
	currency: "USD",
	interval: "month",
	allowanceMicros: 3e6,
	allowanceUnit: "provider_micro_usd"
});
function accountRefValid(value) {
	return typeof value === "string" && /^account_[a-f0-9]{64}$/.test(value);
}
function exact(value, keys) {
	return isDataRecord(value) && Object.keys(value).sort().join(",") === keys.sort().join(",");
}
function iso(value) {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function invalid() {
	throw Error("subscription_response_invalid");
}
function offer(value) {
	if (value === null) return null;
	if (!exact(value, Object.keys(PLUS_OFFER)) || Object.entries(PLUS_OFFER).some(([key, expected]) => value[key] !== expected)) invalid();
	return { ...PLUS_OFFER };
}
function projectSubscriptionOffer(value) {
	if (!exact(value, ["offer"])) invalid();
	return { offer: offer(value.offer) };
}
function projectPersonalSubscription(value) {
	if (!exact(value, [
		"accountRef",
		"offer",
		"subscription",
		"allowance"
	]) || !accountRefValid(value.accountRef)) invalid();
	const subscription = value.subscription;
	if (!exact(subscription, [
		"status",
		"cancelAtPeriodEnd",
		"currentPeriodEnd"
	]) || ![
		"none",
		"active",
		"past_due",
		"paused",
		"canceled"
	].includes(String(subscription.status)) || typeof subscription.cancelAtPeriodEnd !== "boolean" || subscription.currentPeriodEnd !== null && !iso(subscription.currentPeriodEnd)) invalid();
	let allowance = null;
	if (value.allowance !== null) {
		const row = value.allowance;
		if (!exact(row, [
			"limitMicros",
			"usedMicros",
			"reservedMicros",
			"periodStart",
			"periodEnd"
		]) || ![
			row.limitMicros,
			row.usedMicros,
			row.reservedMicros
		].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 0xe8d4a51000) || !iso(row.periodStart) || !iso(row.periodEnd) || row.periodStart >= row.periodEnd) invalid();
		allowance = {
			limitMicros: row.limitMicros,
			usedMicros: row.usedMicros,
			reservedMicros: row.reservedMicros,
			periodStart: row.periodStart,
			periodEnd: row.periodEnd
		};
	}
	return {
		accountRef: value.accountRef,
		offer: offer(value.offer),
		subscription: {
			status: subscription.status,
			cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
			currentPeriodEnd: subscription.currentPeriodEnd
		},
		allowance
	};
}
function projectPaddleSubscriptionCheckout(value) {
	if (!exact(value, [
		"accountRef",
		"transactionId",
		"checkoutUrl"
	]) || !accountRefValid(value.accountRef) || typeof value.transactionId !== "string" || !/^txn_[a-z0-9]{26}$/.test(value.transactionId) || typeof value.checkoutUrl !== "string") invalid();
	let url;
	try {
		url = new URL(value.checkoutUrl);
	} catch {
		invalid();
	}
	if (url.origin !== "https://uptokey.com" || url.pathname !== "/checkout" || url.username || url.password || url.hash || [...url.searchParams.keys()].join(",") !== "_ptxn" || url.searchParams.get("_ptxn") !== value.transactionId) invalid();
	return {
		accountRef: value.accountRef,
		transactionId: value.transactionId,
		checkoutUrl: url.href
	};
}
function projectPaddleSubscriptionPortal(value) {
	if (!exact(value, ["accountRef", "url"]) || !accountRefValid(value.accountRef) || typeof value.url !== "string" || value.url.length > 4096) invalid();
	let url;
	try {
		url = new URL(value.url);
	} catch {
		invalid();
	}
	if (!["https://customer-portal.paddle.com", "https://sandbox-customer-portal.paddle.com"].includes(url.origin) || url.username || url.password || url.hash || !/^\/cpl_[a-z0-9]{26}$/.test(url.pathname)) invalid();
	return {
		accountRef: value.accountRef,
		url: url.href
	};
}
function projectStripeSubscriptionCheckout(value) {
	if (!exact(value, [
		"accountRef",
		"processor",
		"sessionId",
		"checkoutUrl"
	]) || !accountRefValid(value.accountRef) || value.processor !== "stripe" || typeof value.sessionId !== "string" || !/^cs_(?:live|test)_[A-Za-z0-9]{10,240}$/.test(value.sessionId) || typeof value.checkoutUrl !== "string" || value.checkoutUrl.length > 8192) invalid();
	let url;
	try {
		url = new URL(value.checkoutUrl);
	} catch {
		invalid();
	}
	if (url.origin !== "https://checkout.stripe.com" || url.username || url.password || url.pathname !== "/c/pay/" + value.sessionId || url.search || url.href !== value.checkoutUrl) invalid();
	return {
		accountRef: value.accountRef,
		processor: "stripe",
		sessionId: value.sessionId,
		checkoutUrl: url.href
	};
}
function projectStripeSubscriptionPortal(value) {
	if (!exact(value, [
		"accountRef",
		"processor",
		"url"
	]) || !accountRefValid(value.accountRef) || value.processor !== "stripe" || typeof value.url !== "string" || value.url.length > 4096) invalid();
	let url;
	try {
		url = new URL(value.url);
	} catch {
		invalid();
	}
	if (url.origin !== "https://billing.stripe.com" || url.username || url.password || !/^\/p\/session\/[A-Za-z0-9_]{10,1024}$/.test(url.pathname) || url.search || url.hash || url.href !== value.url) invalid();
	return {
		accountRef: value.accountRef,
		processor: "stripe",
		url: url.href
	};
}
function projectSubscriptionCheckout(value) {
	return isDataRecord(value) && value.processor === "stripe" ? projectStripeSubscriptionCheckout(value) : projectPaddleSubscriptionCheckout(value);
}
function projectSubscriptionPortal(value) {
	return isDataRecord(value) && value.processor === "stripe" ? projectStripeSubscriptionPortal(value) : projectPaddleSubscriptionPortal(value);
}
//#endregion
export { ACCOUNT_CHALLENGE_TTL_MS, ACCOUNT_ID, ACCOUNT_MAX_AVAILABLE, ACCOUNT_MAX_CLIENT_RESPONSE_BYTES, ACCOUNT_MAX_RESPONSE_BYTES, ACCOUNT_REF, DEFAULT_ACCOUNT_SERVICE_ORIGIN, accountControlProofPayload, accountMobilityProofPayload, accountProofPayload, isAccountAccessToken, isAccountMobilityPath, isAccountSubscriptionOperation, projectPersonalSubscription, projectSubscriptionCheckout, projectSubscriptionOffer, projectSubscriptionPortal, publicAccountProfile, readAccountAdoptInput, readAccountAdoption, readAccountAvailable, readAccountControlRequest, readAccountMobilityRequest, readAccountPublicSession, readAccountPublicUsage, readAccountShareApproval, readAccountShareChallenge, readAccountShareRequests, readAccountUnlinkInput, trustedAccountOrigin };
