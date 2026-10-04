# DSH OpenAI subscription plugin

Connect a ChatGPT subscription to DeepSeek Harness, choose chat models, see remaining allowance, and generate images. An optional OpenAI API key enables separately billed API chat and image models.

## Install

Tested with **DSH 0.1.5-rc.2**, pi-ai 0.85.1, and Node 26.8.2. Requires Node 22.19 or newer and a base-backed DSH profile with the standard credentials, settings, attachment, and pi-ai services.

From this directory:

```sh
dsh plugin --profile web add /home/spider/Downloads/dsh-codex-oauth
dsh web
```

Restart DSH if already running. Use `--profile desktop` instead of `web` if that is your active profile. The package is a native DSH bundle; installing it adds its `cordis.patch.yml` layer automatically. It activates the existing `openai-codex` provider and adds this plugin's settings section and tools. Existing providers in DSH's user settings remain available.

Open **Settings → OpenAI Connect** in the left sidebar, between Models and Plugins. The section uses DSH's existing settings shell, React runtime, buttons, inputs, menus and theme. There is no separate page or floating link.

Connection management requires a localhost HTTP connection; remote browsers and non-loopback hostnames are refused. The profile must include DSH's standard webServer, client modules and settings UI services.

## Connect and choose models

1. Click **Connect ChatGPT** and choose browser or device-code login. Complete the OpenAI sign-in yourself.
2. The plugin refreshes your subscription model catalog after sign-in. **Refresh models** checks the latest published `@openai/codex` release version, then fetches the account's complete subscription catalog using that version, including model IDs newer than the adapter's bundled catalog. New releases need no plugin update. The panel shows the refreshed model count. Refresh requires access to `registry.npmjs.org` and `chatgpt.com`; a failed refresh keeps your existing choices.
3. Choose the chat model in the chat’s bottom-left model picker → **Model** → **ChatGPT subscription**. **Refresh models** is beside the ChatGPT connection controls in OpenAI Connect.
4. Optionally expand **Optional API key**, save your OpenAI Platform key, and select the **openai** provider in DSH's model picker. **Check API models** limits the installed adapter's catalog to model IDs your API key lists. Add newer/custom IDs using DSH Settings → Models.

Chat messages, streamed reasoning, tool calls, conversation replay, image inputs and cancellation use DSH's existing pi-ai adapter. This plugin doesn't replace the harness or run a second Codex agent. Login and token refresh use the same credential record as that adapter, under its cross-process lock.

In the chat’s bottom-left **model picker**, choose **Speed** and select a mode. It saves immediately for the current model. Standard is always offered; additional modes such as Fast and Ultra come from the subscription catalog, including future tiers. The setting applies to that model's next subscription requests in new and existing chats. It doesn't change reasoning effort or API/image requests. Faster modes consume more allowance and remain subject to account access; see [OpenAI speed modes](https://learn.chatgpt.com/docs/agent-configuration/speed). Refresh models updates the choices. On DSH 0.1.5-rc.2, a small compatibility bridge forwards `serviceTier` through the existing pi-ai provider; it preserves DSH's persona, history, tools, authentication and transport. This bridge needs verification when upgrading DSH.

**Model access:** a ChatGPT subscription is not an unrestricted API key. The plugin offers the subscription endpoint's complete returned chat catalog, without a hardcoded chat-model allowlist. OpenAI still decides which models are available; catalog membership doesn't guarantee a successful request. The ChatGPT web picker and subscription/Codex endpoints may expose different models. API model access is also account-specific.

## Usage limits

The panel refreshes every minute while visible. It shows **remaining**, not used, percentages, plus local reset times. Windows are identified by their actual durations, including five hours and a week. Additional buckets and other window lengths are shown when reported. Missing windows/counters are **Unavailable**, never fabricated as zero usage or full allowance. Usage is account-wide, not specific to this plugin.

The DSH agent can also call `openai_subscription_usage` to read the same data. API token costs and billing balances are not subscription quotas and are not included in these meters.

## Images in chat

In **Settings → OpenAI Connect → Image model**, choose the connection and image model from the dropdowns, then click **Save image model**. The model picker is selection-only. The preference is stored in DSH settings and applies to subsequent image requests, including existing chats.

Then ask normally in chat, for example: **“Generate an image of a quiet mountain lake in watercolor.”** The chat agent calls `openai_generate_image` and returns the generated image inline. There is no extra chat control, special mode or settings generator. A working chat model with tool access is required. Size and quality can be requested naturally in your message; otherwise they default to Auto. Use the normal chat Stop control to cancel the active turn.

The image tool reads the saved connection and model at execution time. Those values are not tool arguments, so the chat model cannot override your selection or switch to a paid connection after a failure.

- **Subscription:** the known Codex image model, `gpt-image-2`. Account and endpoint availability determine whether a request succeeds.
- **API:** image model choices are fetched using the saved API key. Selecting and saving **OpenAI API · paid** enables separately billed image requests from chat. Neither connection silently falls back to the other.

Image generation saves DSH attachments and returns inline image output. Image editing is not included. Subscription and API endpoints may reject requests for plan, quota, model or feature-access reasons; the tool reports the error.

Example tool input (connection and model come from settings):

```json
{"prompt":"A quiet mountain lake in watercolor","size":"1024x1024","quality":"auto"}
```

The API key stays in the DSH host credential store as `DSH_OPENAI_API_KEY`; OAuth tokens never return to the browser. Subscription sign-out also signs out that shared DSH provider. It does not sign out the separate Codex app.

## Development and verification

```sh
npm install
npm test
npm pack
```

No build step or bundled frontend dependencies: the client module uses DSH's shared React and UI primitives. Tests exercise quota conversion, absent/reversed windows, dynamic model metadata, the real DSH adapter's model resolution, credential persistence, subscription/API routing, no paid fallback, secret-safe errors, localhost/CSRF checks and native settings registration. The section was also verified in an isolated DSH instance, including the sidebar entry, model menu, login-method prompt, sign-in cancellation, API controls and the selection-only image model preferences. Tests verify saved selection, rejection of unlisted choices, routing from the saved settings and inline attachment results without sending a live model request.

Live account sign-in, authenticated model generation and paid API generation must be verified with your account. Automated tests use fake credentials and mocked image/usage responses; they don't spend subscription allowance or API funds.

The chat/credential integration is versioned through DSH. The subscription models, usage and image endpoints are backend interfaces, not a stability guarantee; an upstream change may require updating this plugin. The public API route follows the documented OpenAI API.

References: [OpenAI authentication](https://learn.chatgpt.com/docs/auth), [image API](https://developers.openai.com/api/docs/guides/image-generation), [Codex image tool](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/tool.rs), [Codex image endpoint](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/images.rs), [DSH](https://github.com/deepseek-ai/deepseek-harness).
