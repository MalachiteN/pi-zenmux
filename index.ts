import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model, ModelCost, ModelCostTier, ModelPromptCache, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/**
 * ZenMux provider extension.
 *
 * ZenMux exposes OpenAI Chat Completions (`/api/v1`) and Anthropic Messages
 * (`/api/anthropic`) for the same catalog, so this extension only supplies
 * endpoints, model metadata, and catalog discovery; requests are converted and
 * streamed by pi's built-in API implementations.
 */

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_768;
/** ZenMux documents a 5 minute default prompt-cache TTL and an optional 1 hour TTL. */
const CACHE_SHORT_TTL_SECONDS = 5 * 60;
const CACHE_LONG_TTL_SECONDS = 60 * 60;
const FETCH_TIMEOUT_MS = 8_000;
/**
 * Cache schema marker. A snapshot written by an older plugin version can carry
 * a retired `api` id, so only snapshots written by this scheme are restored.
 */
const SNAPSHOT_TAG = "pi-zenmux/2";
export const ZENMUX_MODELS_CACHE_FILENAME = "zenmux-models.json";

export function getZenmuxModelsCachePath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, ZENMUX_MODELS_CACHE_FILENAME);
}

type ZenmuxModelsCache = {
	schema: string;
	checkedAt: number;
	models: Model<Api>[];
};

export const ZENMUX_BASE_URL = (process.env.ZENMUX_BASE_URL || "https://zenmux.ai").replace(/\/$/, "");
export const ZENMUX_OPENAI_BASE_URL = `${ZENMUX_BASE_URL}/api/v1`;
export const ZENMUX_ANTHROPIC_BASE_URL = `${ZENMUX_BASE_URL}/api/anthropic`;
export const ZENMUX_MODELS_URL = `${ZENMUX_OPENAI_BASE_URL}/models`;
/** Per-endpoint catalog ZenMux's own agent plugins read; it carries the real output cap per model. */
export const ZENMUX_ENDPOINT_CATALOG_URL = `${ZENMUX_BASE_URL}/api/frontend/model/available/list`;
export const MODELS_DEV_URL = "https://models.dev/api.json";
export const ZENMUX_PROVIDER_ID = "zenmux";
export const ZENMUX_OPENAI_API = "openai-completions";
export const ZENMUX_ANTHROPIC_API = "anthropic-messages";

/** Cache-write pricing keys, most accurate first: pi's default Anthropic cache TTL is 5 minutes. */
const CACHE_WRITE_KEYS = ["input_cache_write_5_min", "input_cache_write", "input_cache_write_1_h"] as const;

type PromptTokenCondition = {
	gte?: number | string | null;
	gt?: number | string | null;
	lt?: number | string | null;
	lte?: number | string | null;
};

type ZenmuxPricing = {
	value?: number;
	unit?: string;
	conditions?: { prompt_tokens?: PromptTokenCondition | null } | null;
};

type ZenmuxPricings = {
	prompt?: ZenmuxPricing[];
	completion?: ZenmuxPricing[];
	input_cache_read?: ZenmuxPricing[];
	input_cache_write?: ZenmuxPricing[];
	input_cache_write_5_min?: ZenmuxPricing[];
	input_cache_write_1_h?: ZenmuxPricing[];
};

type ZenmuxRawModel = {
	id?: string;
	display_name?: string;
	owned_by?: string;
	input_modalities?: string[];
	output_modalities?: string[];
	capabilities?: { reasoning?: boolean };
	pricings?: ZenmuxPricings;
	context_length?: number | string;
};

type ZenmuxModelsPayload = {
	data?: ZenmuxRawModel[];
};

/**
 * A catalog model always carries routing, which `ProviderModelConfig` leaves optional.
 * Pi stores catalog snapshots as `Model` rows, so the narrow type keeps that conversion honest.
 */
export type ZenmuxModel = ProviderModelConfig & { api: Api; baseUrl: string };

function toPositiveInt(value: unknown, fallback: number): number {
	const num = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(num) || num <= 0) return fallback;
	return Math.floor(num);
}

function toNonNegativeNumber(value: unknown): number | undefined {
	if (value === null || value === undefined) return undefined;
	const num = typeof value === "number" ? value : Number(value);
	return Number.isFinite(num) && num >= 0 ? num : undefined;
}

function finitePrice(item: ZenmuxPricing | undefined): number | undefined {
	const value = item?.value;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Lower bound of the prompt-token range a pricing row applies to, in kTokens. */
function priceLowerBound(item: ZenmuxPricing): number {
	const condition = item?.conditions?.prompt_tokens;
	return toNonNegativeNumber(condition?.gte) ?? toNonNegativeNumber(condition?.gt) ?? 0;
}

/** Row that applies below every other row: the cheapest prompt size the provider prices. */
function baselineEntry(items: ZenmuxPricing[] | undefined): ZenmuxPricing | undefined {
	let baseline: ZenmuxPricing | undefined;
	let lowestBound = Number.POSITIVE_INFINITY;
	for (const item of items ?? []) {
		if (!item || typeof item !== "object") continue;
		const bound = priceLowerBound(item);
		if (bound < lowestBound) {
			baseline = item;
			lowestBound = bound;
		}
	}
	return baseline;
}

function basePrice(items: ZenmuxPricing[] | undefined): number {
	return finitePrice(baselineEntry(items)) ?? 0;
}

function pricedField(pricings: ZenmuxPricings | undefined, keys: readonly (keyof ZenmuxPricings)[]): number | undefined {
	for (const key of keys) {
		const items = pricings?.[key];
		if (!Array.isArray(items) || items.length === 0) continue;
		const value = finitePrice(baselineEntry(items));
		if (value !== undefined) return value;
	}
	return undefined;
}

function tieredPrice(items: ZenmuxPricing[] | undefined, threshold: number, fallback: number): number {
	if (threshold <= 0) return fallback;
	for (const item of items ?? []) {
		if (priceLowerBound(item) !== threshold) continue;
		const value = finitePrice(item);
		if (value !== undefined) return value;
	}
	return fallback;
}

function tieredCacheWrite(pricings: ZenmuxPricings | undefined, threshold: number, fallback: number): number {
	for (const key of CACHE_WRITE_KEYS) {
		const items = pricings?.[key];
		if (!Array.isArray(items) || items.length === 0) continue;
		return tieredPrice(items, threshold, fallback);
	}
	return fallback;
}

/**
 * ZenMux selects pricing rows by prompt-token range and applies one row to the
 * whole request, which matches pi's request-wide `cost.tiers`. Tiers are only
 * emitted when prompt and completion pricing agree on the same thresholds.
 */
function buildCostTiers(pricings: ZenmuxPricings | undefined): ModelCostTier[] | undefined {
	const thresholds = new Set<number>();
	for (const item of pricings?.prompt ?? []) {
		const bound = priceLowerBound(item);
		if (bound > 0) thresholds.add(bound);
	}
	if (thresholds.size === 0) return undefined;

	const completionThresholds = new Set<number>();
	for (const item of pricings?.completion ?? []) {
		const bound = priceLowerBound(item);
		if (bound > 0) completionThresholds.add(bound);
	}
	if ([...thresholds].some((threshold) => !completionThresholds.has(threshold))) return undefined;

	const input = basePrice(pricings?.prompt);
	const output = basePrice(pricings?.completion);
	const cacheRead = basePrice(pricings?.input_cache_read);
	const cacheWrite = pricedField(pricings, CACHE_WRITE_KEYS) ?? 0;

	return [...thresholds]
		.sort((a, b) => a - b)
		.map((threshold) => ({
			inputTokensAbove: Math.round(threshold * 1000),
			input: tieredPrice(pricings?.prompt, threshold, input),
			output: tieredPrice(pricings?.completion, threshold, output),
			cacheRead: tieredPrice(pricings?.input_cache_read, threshold, cacheRead),
			cacheWrite: tieredCacheWrite(pricings, threshold, cacheWrite),
		}));
}

function buildCost(pricings: ZenmuxPricings | undefined): ModelCost {
	const cost: ModelCost = {
		input: basePrice(pricings?.prompt),
		output: basePrice(pricings?.completion),
		cacheRead: basePrice(pricings?.input_cache_read),
		cacheWrite: pricedField(pricings, CACHE_WRITE_KEYS) ?? 0,
	};
	const tiers = buildCostTiers(pricings);
	if (tiers) cost.tiers = tiers;
	return cost;
}

/**
 * ZenMux omits `pricings` for some catalog entries, so those models fall back to
 * the models.dev pricing. Cache warming is only enabled for models whose cache
 * writes are priced, because warming re-sends a request and pays that price.
 */
function resolvePricing(
	pricings: ZenmuxPricings | undefined,
	fallback: ModelCost | undefined,
): { cost: ModelCost; promptCache: ModelPromptCache | undefined } {
	const hasOwnPricing = (pricings?.prompt?.length ?? 0) > 0 || (pricings?.completion?.length ?? 0) > 0;
	if (!hasOwnPricing && fallback) {
		return { cost: fallback, promptCache: fallback.cacheWrite > 0 ? { short: CACHE_SHORT_TTL_SECONDS } : undefined };
	}

	const cacheWrite = pricedField(pricings, CACHE_WRITE_KEYS);
	const longTtl = pricedField(pricings, ["input_cache_write_1_h"]);
	return {
		cost: buildCost(pricings),
		promptCache:
			cacheWrite === undefined
				? undefined
				: longTtl === undefined
					? { short: CACHE_SHORT_TTL_SECONDS }
					: { short: CACHE_SHORT_TTL_SECONDS, long: CACHE_LONG_TTL_SECONDS },
	};
}

export function routingFor(rawModel: ZenmuxRawModel): { api: string; baseUrl: string } {
	const id = String(rawModel?.id ?? "");
	const isAnthropic = rawModel?.owned_by === "anthropic" || id.startsWith("anthropic/");
	return isAnthropic
		? { api: ZENMUX_ANTHROPIC_API, baseUrl: ZENMUX_ANTHROPIC_BASE_URL }
		: { api: ZENMUX_OPENAI_API, baseUrl: ZENMUX_OPENAI_BASE_URL };
}

/**
 * Smallest `max_completion_tokens` ZenMux advertises across a model's endpoints.
 * The documented catalog carries no output cap, and models.dev reports the upstream
 * vendor's limit, which differs from what ZenMux accepts on 95 of 168 chat models.
 */
export function buildEndpointOutputLimits(payload: unknown): Map<string, number> {
	const limits = new Map<string, number>();
	const rows = (payload as { data?: unknown } | undefined)?.data;
	if (!Array.isArray(rows)) return limits;

	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		const id = String((row as { slug?: unknown }).slug ?? "").trim();
		const cap = toPositiveInt((row as { max_completion_tokens?: unknown }).max_completion_tokens, 0);
		if (!id || cap === 0) continue;
		const current = limits.get(id);
		if (current === undefined || cap < current) limits.set(id, cap);
	}
	return limits;
}

/** Output limits and prices are missing for some ZenMux catalog entries, so models.dev fills them in. */
export function buildModelsDevFallbacks(payload: unknown): Map<string, { outputLimit?: number; cost?: ModelCost }> {
	const fallbacks = new Map<string, { outputLimit?: number; cost?: ModelCost }>();
	const models = (payload as { zenmux?: { models?: Record<string, unknown> } } | undefined)?.zenmux?.models;
	for (const [id, entry] of Object.entries(models ?? {})) {
		if (!entry || typeof entry !== "object") continue;
		const outputLimit = toPositiveInt((entry as { limit?: { output?: unknown } }).limit?.output, 0);
		const rawCost = (entry as { cost?: { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown } }).cost;
		const input = toNonNegativeNumber(rawCost?.input);
		const output = toNonNegativeNumber(rawCost?.output);
		const cost =
			input === undefined || output === undefined
				? undefined
				: {
						input,
						output,
						cacheRead: toNonNegativeNumber(rawCost?.cache_read) ?? 0,
						cacheWrite: toNonNegativeNumber(rawCost?.cache_write) ?? 0,
					};
		if (outputLimit > 0 || cost) {
			fallbacks.set(id, { ...(outputLimit > 0 ? { outputLimit } : {}), ...(cost ? { cost } : {}) });
		}
	}
	return fallbacks;
}

export function toProviderModel(
	rawModel: ZenmuxRawModel,
	outputLimits: Map<string, number>,
	fallbacks: Map<string, { outputLimit?: number; cost?: ModelCost }>,
): ZenmuxModel | null {
	const id = String(rawModel?.id ?? "").trim();
	if (!id) return null;
	// ZenMux serves image, video, speech, embedding, and rerank models from the same catalog.
	const outputs = rawModel.output_modalities;
	if (Array.isArray(outputs) && outputs.length > 0 && !outputs.includes("text")) return null;

	const fallback = fallbacks.get(id);
	const { cost, promptCache } = resolvePricing(rawModel.pricings, fallback?.cost);
	const routing = routingFor(rawModel);
	const supportsImage = Array.isArray(rawModel.input_modalities) && rawModel.input_modalities.includes("image");

	return {
		id,
		name: String(rawModel.display_name || id),
		api: routing.api,
		baseUrl: routing.baseUrl,
		reasoning: rawModel.capabilities?.reasoning === true,
		input: supportsImage ? ["text", "image"] : ["text"],
		cost,
		contextWindow: toPositiveInt(rawModel.context_length, DEFAULT_CONTEXT_WINDOW),
		maxTokens: outputLimits.get(id) ?? fallback?.outputLimit ?? DEFAULT_MAX_TOKENS,
		...(promptCache ? { promptCache } : {}),
	};
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	const response = await fetch(url, {
		method: "GET",
		headers: { Accept: "application/json" },
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});

	if (!response.ok) {
		throw new Error(`${url} -> HTTP ${response.status}`);
	}

	return (await response.json()) as T;
}

export async function fetchZenmuxProviderModels(options: { signal?: AbortSignal } = {}): Promise<ZenmuxModel[]> {
	const [zenmuxPayload, endpointsPayload, modelsDevPayload] = await Promise.all([
		fetchJson<ZenmuxModelsPayload>(ZENMUX_MODELS_URL, options.signal),
		fetchJson<Record<string, unknown>>(ZENMUX_ENDPOINT_CATALOG_URL, options.signal).catch(() => undefined),
		fetchJson<Record<string, unknown>>(MODELS_DEV_URL, options.signal).catch(() => undefined),
	]);

	const rawModels = Array.isArray(zenmuxPayload?.data) ? zenmuxPayload.data : [];
	if (rawModels.length === 0) {
		throw new Error("ZenMux model list is empty");
	}

	const outputLimits = endpointsPayload ? buildEndpointOutputLimits(endpointsPayload) : new Map<string, number>();
	const fallbacks = modelsDevPayload
		? buildModelsDevFallbacks(modelsDevPayload)
		: new Map<string, { outputLimit?: number; cost?: ModelCost }>();

	const uniqueModels = new Map<string, ZenmuxModel>();
	for (const rawModel of rawModels) {
		const model = toProviderModel(rawModel, outputLimits, fallbacks);
		if (!model) continue;
		uniqueModels.set(model.id, model);
	}

	const models = [...uniqueModels.values()].sort((a, b) => a.id.localeCompare(b.id));
	if (models.length === 0) {
		throw new Error("No ZenMux chat models found");
	}

	return models;
}

/**
 * Restore a persisted snapshot. Routing is re-derived so a snapshot written for
 * a different `ZENMUX_BASE_URL` still points at the configured endpoints.
 */
export function restoreModels(storedModels: readonly Model<Api>[]): ZenmuxModel[] {
	return storedModels.map((model) => {
		const routing = routingFor({ id: model.id, owned_by: (model as { owned_by?: string }).owned_by });
		return { ...model, api: routing.api, baseUrl: routing.baseUrl };
	});
}

/** Load only the extension-owned cache; pi's global model store is not required. */
export function loadZenmuxModelsCache(path = getZenmuxModelsCachePath()): ZenmuxModel[] | undefined {
	try {
		const cache = JSON.parse(readFileSync(path, "utf8")) as Partial<ZenmuxModelsCache>;
		if (cache.schema !== SNAPSHOT_TAG || !Array.isArray(cache.models) || cache.models.length === 0) {
			return undefined;
		}
		return restoreModels(cache.models);
	} catch {
		// A missing, unreadable, or incomplete cache is rebuilt from the network.
		return undefined;
	}
}

let cacheWriteCounter = 0;

async function saveZenmuxModelsCache(models: readonly ZenmuxModel[], path = getZenmuxModelsCachePath()): Promise<void> {
	const cache: ZenmuxModelsCache = {
		schema: SNAPSHOT_TAG,
		checkedAt: Date.now(),
		models: models.map((model): Model<Api> => ({ ...model, provider: ZENMUX_PROVIDER_ID })),
	};
	const temporaryPath = `${path}.${process.pid}.${cacheWriteCounter++}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
		await rename(temporaryPath, path);
	} finally {
		// After rename the temporary path no longer exists; ignore cleanup races.
		await unlink(temporaryPath).catch(() => undefined);
	}
}

/** Current in-memory catalog, initialized synchronously from the extension-owned cache when present. */
let discoveredModels: ZenmuxModel[] = [];

async function fetchAndCacheZenmuxModels(signal?: AbortSignal): Promise<ZenmuxModel[]> {
	const models = await fetchZenmuxProviderModels({ signal });
	if (signal?.aborted) return discoveredModels;
	await saveZenmuxModelsCache(models);
	discoveredModels = models;
	return models;
}

export async function refreshZenmuxModels(context: RefreshModelsContext): Promise<ZenmuxModel[]> {
	if (!context.allowNetwork || context.signal.aborted) return discoveredModels;
	// On failure, let pi retain the currently registered list and surface the error
	// to a manual refresh; background refresh deliberately ignores that error.
	return fetchAndCacheZenmuxModels(context.signal);
}

export default async function registerZenmuxProvider(pi: ExtensionAPI): Promise<void> {
	const cachedModels = loadZenmuxModelsCache();
	discoveredModels = cachedModels ?? [];
	let shouldRefreshAfterStartup = cachedModels !== undefined;

	// Network access is only needed for first-time initialization. Once a cache
	// exists, extension loading never waits for ZenMux or models.dev.
	if (!cachedModels) {
		try {
			discoveredModels = await fetchAndCacheZenmuxModels();
		} catch {
			// Register an empty provider rather than preventing pi from starting.
			// session_start retries the initial discovery in the background.
			shouldRefreshAfterStartup = true;
		}
	}

	pi.registerProvider(ZENMUX_PROVIDER_ID, {
		name: "ZenMux",
		baseUrl: ZENMUX_OPENAI_BASE_URL,
		apiKey: "$ZENMUX_API_KEY",
		api: ZENMUX_OPENAI_API,
		models: discoveredModels,
		refreshModels: refreshZenmuxModels,
	});

	let sessionAbort: AbortController | undefined;
	let refreshTask: Promise<void> | undefined;
	const refresh = (ctx: ExtensionContext, signal?: AbortSignal): Promise<void> => {
		if (refreshTask) return refreshTask;
		refreshTask = (async () => {
			const result = await ctx.modelRegistry.refresh({
				providers: [ZENMUX_PROVIDER_ID],
				force: true,
				signal,
			});
			const error = result.errors.get(ZENMUX_PROVIDER_ID);
			if (error) throw error;
		})().finally(() => {
			refreshTask = undefined;
		});
		return refreshTask;
	};

	pi.on("session_start", (_event, ctx) => {
		sessionAbort = new AbortController();
		if (!shouldRefreshAfterStartup) return;
		// One background check per extension runtime; later startups load the new cache.
		shouldRefreshAfterStartup = false;
		void refresh(ctx, sessionAbort.signal).catch(() => {
			// Cached models remain usable offline. /zenmux-refresh reports failures explicitly.
		});
	});
	pi.on("session_shutdown", () => {
		sessionAbort?.abort();
	});

	pi.registerCommand("zenmux-refresh", {
		description: "Refresh the ZenMux model catalog now",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			ctx.ui.notify("Refreshing the ZenMux model catalog…", "info");
			try {
				await refresh(ctx);
				ctx.ui.notify(`ZenMux model catalog refreshed (${discoveredModels.length} models).`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`ZenMux model refresh failed: ${message}`, "error");
			}
		},
	});
}
