# ZenMux Provider Extension for pi

Adds a `zenmux` provider to [pi](https://pi.dev) as a [pi package](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md), as requested in [badlogic/pi-mono#1811](https://github.com/badlogic/pi-mono/issues/1811).

ZenMux speaks both the OpenAI Chat Completions and the Anthropic Messages protocol for the same catalog, so this extension only supplies endpoints, model metadata, and catalog discovery: requests are converted and streamed by pi's built-in API implementations.

## Features

- Registers provider `zenmux`, API key env var `ZENMUX_API_KEY`
- Discovers the live catalog from `https://zenmux.ai/api/v1/models` only when its local cache is missing; existing caches make startup independent of the network
- Stores the catalog in `~/.pi/agent/zenmux-models.json` and checks for updates in a background task after the session starts
- Supports `/zenmux-refresh` for an immediate forced update; failed updates preserve the last good catalog
- Routes `anthropic/*` models to `https://zenmux.ai/api/anthropic` (`anthropic-messages`) and every other model to `https://zenmux.ai/api/v1` (`openai-completions`)
- Registers chat models only: image, video, speech, transcription, embedding, and rerank models from the same catalog are skipped
- Maps tiered ZenMux pricing to pi's request-wide cost tiers, cache prices (5 minute, generic, 1 hour) to `cost.cacheWrite`, and prompt-cache TTLs to `promptCache` so pi can warm caches
- Fills in output limits and prices from the `zenmux` provider in [models.dev](https://models.dev) for the catalog entries where ZenMux publishes none
- Takes the output cap from ZenMux's own per-endpoint catalog (`/api/frontend/model/available/list`), because models.dev reports the upstream vendor's limit, which differs on most models; the fetch is best-effort and falls back to models.dev, then to a built-in default

## Install

```bash
pi install npm:pi-zenmux
pi install /absolute/path/to/pi-zenmux
```

Requires pi `0.87.1` or newer (`@earendil-works/pi-coding-agent`); the former `@mariozechner/pi-coding-agent` scope is deprecated.

## Configure

```bash
export ZENMUX_API_KEY="sk-ai-v1-..."
```

Or store the key in `~/.pi/agent/auth.json`:

```json
{
  "zenmux": {
    "type": "api_key",
    "key": "sk-ai-v1-..."
  }
}
```

## Use

```bash
pi --provider zenmux --model anthropic/claude-opus-5
pi --list-models zenmux
```

You can also start `pi` normally and switch with `/model`.

## Model catalog cache

The extension owns a separate cache at `~/.pi/agent/zenmux-models.json` (or `$PI_CODING_AGENT_DIR/zenmux-models.json`). Startup reads this file directly and never waits for a network refresh when it exists. A background refresh runs after `session_start`, so the registered catalog can become stale between checks but remains available offline.

On the first run, when the cache does not exist, the extension fetches the catalog before registering models. Discovery has an 8-second timeout and a failure does not prevent pi from starting; the provider is registered with an empty list and discovery is retried in the background.

Run `/zenmux-refresh` to force an immediate update. The command reports success or failure, and a failed update leaves the current models and cache intact. Delete `zenmux-models.json` to reinitialize the cache from scratch.

## Optional endpoint override

```bash
export ZENMUX_BASE_URL="https://zenmux.ai"
```

The extension derives `${ZENMUX_BASE_URL}/api/v1`, `${ZENMUX_BASE_URL}/api/anthropic`, and the catalog URL `${ZENMUX_BASE_URL}/api/v1/models`.

## Related

ZenMux also publishes an OAuth PKCE plugin, `@zenmux/pi-zenmux-oauth`, which signs in through `/login` instead of an API key. Install only one of the two: both register the provider id `zenmux`.

## Breaking changes in 0.3.0

- Requires pi `0.87.1`+ and imports `@earendil-works/pi-*`
- The retired custom `zenmux-router` API and its `streamSimple` router are gone; models now carry their own `api` and `baseUrl`
- `routeModel`, `asZenmuxRouterModels`, `streamSimpleZenmux`, and `ZENMUX_ROUTER_API` are no longer exported; use `routingFor` for the routing rule
- Non-chat models are no longer registered

## Publish

```bash
npm run check
npm login
npm publish --access public
```

## Dev / Test

```bash
npm install
npm run typecheck
npm test
```
