import assert from 'node:assert/strict';

// Build-only adaptation of dsh-client-ui-model-selection 0.2.1-rc.2.
// Preserve session directories and their selection/draft ownership. Account
// generations invalidate only the resolver-owned shared catalog.
const START = 'var ModelDirectoryResolver = class extends _deepseek_ai_cordis.Service {';
const PREFIX = START + '\n' + [
  '\t\t\tstatic inject = [',
  '\t\t\t\t"sessions",',
  '\t\t\t\t"remote",',
  '\t\t\t\t"remote.session"',
  '\t\t\t];',
  '\t\t\tlive = { directories: new WeakMapWithValues() };',
  '\t\t\tcatalog;',
].join('\n');
const SEAT = [
  '\t\t\t\tctx.remote.$on("credentials/reference-updated", () => {',
  '\t\t\t\t\tthis.catalog.refresh();',
  '\t\t\t\t});',
  '\t\t\t}',
  '\t\t\t/**',
  '\t\t\t* Resolve the per-session shared directory (lazy; the scope disposer',
  '\t\t\t* removes and disposes it). Unknown sessions fail loud.',
  '\t\t\t* @param sessionId - the owning session.',
  '\t\t\t* @returns the resident directory both entries share.',
  '\t\t\t*/',
  '\t\t\tdirectoryFor(sessionId) {',
].join('\n');
const PREFETCH = [
  '\t\t\t// Startup and selectors share the original catalog promise and cache.',
  '\t\t\tprefetchCatalog() {',
  '\t\t\t\treturn this.catalog.load();',
  '\t\t\t}',
].join('\n') + '\n';
const RESET_MARKER = '\t\t\t// Uptokey: invalidate the account catalog without resetting sessions.';
const METHOD = PREFETCH + [
  RESET_MARKER,
  '\t\t\tresetCatalog() {',
  '\t\t\t\tthis.catalogRefreshStop?.();',
  '\t\t\t\tthis.catalogRefreshStop = void 0;',
  '\t\t\t\tthis.catalog.resetGeneration();',
  '\t\t\t}',
  '\t\t\t// Same-account refresh keeps the SDK catalog usable and shares its load.',
  '\t\t\trefreshCatalog(afterLoading = false) {',
  '\t\t\t\tif (this.catalog.store.getSnapshot().status !== "loading") { this.catalog.refresh(); return; }',
  '\t\t\t\tif (!afterLoading || this.catalogRefreshStop) return;',
  '\t\t\t\tthis.catalogRefreshStop = this.catalog.store.subscribe(() => {',
  '\t\t\t\t\tif (this.catalog.store.getSnapshot().status === "loading") return;',
  '\t\t\t\t\tthis.catalogRefreshStop?.(); this.catalogRefreshStop = void 0;',
  '\t\t\t\t\tthis.catalog.refresh();',
  '\t\t\t\t});',
  '\t\t\t}',
].join('\n') + '\n';

/** Narrow delta over the already accepted responsive resolver, never a second owner. */
export function patchModelCatalogPrefetch(source) {
  assert.equal(typeof source, 'string', 'Model catalog source must be text');
  assert.equal(source.split(START).length, 2, 'Model catalog pinned resolver changed');
  assert.equal(source.split(RESET_MARKER).length, 2, 'Model catalog accepted reset seat changed');
  assert.ok(!/\bprefetchCatalog\s*\(/.test(source), 'Model catalog already exposes prefetchCatalog');
  return source.replace(RESET_MARKER, PREFETCH + RESET_MARKER);
}

export function patchModelCatalogReset(source) {
  assert.equal(typeof source, 'string', 'Model catalog source must be text');
  assert.equal(source.split(START).length, 2, 'Model catalog pinned resolver changed');
  assert.equal(source.split(PREFIX).length, 2, 'Model catalog pinned state changed');
  const start = source.indexOf(START);
  const end = source.indexOf('\n\t\t};\n\t\t//#endregion', start);
  assert.ok(end > start, 'Model catalog pinned resolver boundary changed');
  const resolver = source.slice(start, end);
  assert.ok(!/\bresetCatalog\s*\(/.test(resolver), 'Model catalog already exposes resetCatalog');
  assert.equal(resolver.split(SEAT).length, 2, 'Model catalog pinned method seat changed');
  const seat = SEAT.replace('\t\t\t}\n\t\t\t/**', '\t\t\t\tctx.effect(() => () => this.catalogRefreshStop?.());\n\t\t\t}\n' + METHOD + '\t\t\t/**');
  const patched = resolver.replace(PREFIX, PREFIX + '\n\t\t\tcatalogRefreshStop;').replace(SEAT, seat);
  let result = source.slice(0, start) + patched + source.slice(end);
  const waiting='const waiting = currentChoice === void 0 && state.status === "loading";';
  const banner='state.status === "loading" && (0, react_jsx_runtime.jsx)("div", {';
  assert.equal(result.split(waiting).length,2,'Model catalog trigger seat changed');
  assert.equal(result.split(banner).length,2,'Model catalog loading banner seat changed');
  result=result.replace(waiting,'const waiting = false;').replace(banner,'false && (0, react_jsx_runtime.jsx)("div", {');
  // Show the already-selected model while its metadata refreshes.
  const label='currentChoice?.model.name ?? t("trigger.fallback")';
  assert.equal(result.split(label).length,2,'Model catalog retained label seat changed');
  result=result.replace(label,'currentChoice?.model.name ?? state.current?.model ?? t("trigger.fallback")');
  const load='if (available) directory.load().catch(() => {});';
  assert.equal(result.split(load).length,2,'Model catalog retry seat changed');
  result=result.replace(load,'if (available) { if (directory.store.getSnapshot().failures.length) models.refreshCatalog(); directory.load().catch(() => {}); }');
  for(const side of ['left','right']) {
    const rank=side+'.id === "deepseek-account"';
    assert.equal(result.split(rank).length,2,'Model catalog provider order seat changed');
    result=result.replace(rank,'('+side+'.id === "uptokey-hosted" || '+rank+')');
  }
  return result;
}
