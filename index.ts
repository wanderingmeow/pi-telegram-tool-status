/**
 * pi-telegram-tool-status
 *
 * Companion extension for pi-telegram that shows a compact service message
 * listing tools used by the agent. One service message is created per
 * user prompt (only Telegram-originated turns) and edited in-place as
 * new tool calls arrive. Lazy creation: the message is sent only when the
 * first tool is actually called.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { registerTelegramActivityHandler } from "@llblab/pi-telegram/activity";
import { registerTelegramSection } from "@llblab/pi-telegram/sections";
import type {
  TelegramActivityContext,
  TelegramActivityEvent,
} from "@llblab/pi-telegram/activity";

// --- Extension Settings ---

interface ExtensionSettings {
	enabled: boolean;
	proactivePushTools: boolean;
}

const DEFAULT_SETTINGS: ExtensionSettings = {
	enabled: true,
	proactivePushTools: true,
};

function getExtensionConfigPath(): string {
	return join(getAgentDir(), "pi-telegram-tool-status.json");
}

async function loadExtensionSettings(): Promise<ExtensionSettings> {
	try {
		const content = await readFile(getExtensionConfigPath(), "utf8");
		const parsed = JSON.parse(content) as Partial<ExtensionSettings>;
		return { ...DEFAULT_SETTINGS, ...parsed };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

async function saveExtensionSettings(settings: ExtensionSettings): Promise<void> {
	try {
		await writeFile(
			getExtensionConfigPath(),
			JSON.stringify(settings, null, "\t") + "\n",
			{ mode: 0o600 },
		);
	} catch {
		// ignore
	}
}

// --- Config (minimal: agent dir only) ---

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR
		? resolve(process.env.PI_CODING_AGENT_DIR)
		: join(homedir(), ".pi", "agent");
}

// --- Formatting ---

const MAX_DETAIL_LEN = 50; // universal compact limit for all tools
const MAX_VISIBLE_ITEMS = 15;

function truncateTail(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, max - 1) + "…";
}

function truncateHead(text: string, max: number): string {
	if (text.length <= max) return text;
	return "…" + text.slice(-(max - 1));
}

function maskBashSecrets(command: string): string {
	let masked = command;

	// Authorization / Cookie headers in -H flags
	masked = masked.replace(
		/(-H\s*["']?\s*(?:Authorization|Cookie):\s*)([^"'\n\r]*)/gi,
		"$1***",
	);

	// Authorization / Cookie headers without -H (e.g. curl --header)
	masked = masked.replace(
		/(\b(?:header|H)\s*["']?\s*(?:Authorization|Cookie):\s*)([^"'\n\r]*)/gi,
		"$1***",
	);

	// Bearer / Basic / Token / ApiKey values
	masked = masked.replace(
		/\b(Bearer|Basic|Token|ApiKey)\s+\S+/gi,
		"$1 ***",
	);

	// API keys / tokens / secrets in query strings
	masked = masked.replace(
		/([?&])(api_?key|token|auth|access_token|refresh_token|secret|password|passwd|pwd)=\S+/gi,
		"$1$2=***",
	);

	// Environment variables with sensitive names
	masked = masked.replace(
		/\b([A-Z_]*(?:TOKEN|KEY|SECRET|PASSWORD|COOKIE)[A-Z_]*)=\S+/g,
		"$1=***",
	);

	return masked;
}

function smartTruncateBashPaths(command: string, maxPathLen = 50): string {
	return command
		.split(/\s+/)
		.map((token) => {
			if (token.length <= maxPathLen) return token;
			if (!token.includes("/")) return token;
			if (/^https?:\/\//i.test(token)) return token;
			const side = Math.floor((maxPathLen - 1) / 2);
			return token.slice(0, side) + "…" + token.slice(-side);
		})
		.join(" ");
}

function getToolEmoji(toolName: string): string {
	switch (toolName) {
		case "read":
			return "📖";
		case "write":
			return "📝";
		case "edit":
			return "✏️";
		case "bash":
			return "💻";
		default:
			return "⚙️";
	}
}

function formatToolDetail(
	toolName: string,
	args: Record<string, unknown>,
): string {
	const isPathTool =
		toolName === "read" || toolName === "write" || toolName === "edit";
	const isBash = toolName === "bash";

	if (args.path && typeof args.path === "string") {
		const path = args.path;
		return isPathTool
			? truncateHead(path, MAX_DETAIL_LEN)
			: truncateTail(path, MAX_DETAIL_LEN);
	}

	if (args.command && typeof args.command === "string") {
		let cmd = maskBashSecrets(args.command);
		cmd = smartTruncateBashPaths(cmd);
		return isBash
			? truncateTail(cmd, MAX_DETAIL_LEN)
			: truncateTail(cmd, MAX_DETAIL_LEN);
	}

	if (args.url && typeof args.url === "string") {
		try {
			const u = new URL(args.url);
			return truncateTail(u.hostname + u.pathname, MAX_DETAIL_LEN);
		} catch {
			return truncateTail(args.url, MAX_DETAIL_LEN);
		}
	}

	if (args.query && typeof args.query === "string") {
		return truncateTail(args.query, MAX_DETAIL_LEN);
	}

	if (args.file && typeof args.file === "string") {
		return truncateTail(args.file, MAX_DETAIL_LEN);
	}

	if (args.tool && typeof args.tool === "string") {
		const server =
			args.server && typeof args.server === "string"
				? args.server
				: undefined;
		const label = server ? `${server}/${args.tool}` : args.tool;
		return truncateTail(label, MAX_DETAIL_LEN);
	}

	if (args.server && typeof args.server === "string") {
		return truncateTail(args.server, MAX_DETAIL_LEN);
	}

	return toolName;
}

interface ToolCallInfo {
	index: number;
	toolName: string;
	emoji: string;
	detail: string;
}

function buildServiceMessageText(calls: ToolCallInfo[]): string {
	if (calls.length === 0) {
		return "🛠 Tools used:\n\n";
	}

	const hiddenCount = calls.length - MAX_VISIBLE_ITEMS;
	const visibleCalls =
		hiddenCount > 0 ? calls.slice(-MAX_VISIBLE_ITEMS) : calls;

	const lines: string[] = ["🛠 Tools used:", ""];

	if (hiddenCount > 0) {
		lines.push(`… ${hiddenCount} more action${hiddenCount !== 1 ? "s" : ""} hidden`);
	}

	for (const call of visibleCalls) {
		const detail = call.detail;
		const separator = detail ? " — " : "";
		lines.push(
			`${call.index}. ${call.emoji} ${call.toolName}${separator}${detail}`,
		);
	}

	return lines.join("\n");
}

// --- State (managed by Activity Handler) ---

// Module-level state for tracking tool calls across activity events.
// Reset on each new agent-start (new activity).
let toolCalls: ToolCallInfo[] = [];
let nextIndex = 1;
// The delivery handle for the live service message (Telegram turns only).
// Stored so we can edit the same message across tool events.
let serviceMessageHandle: { handle: unknown; source: string } | undefined;
// Whether the current activity is Telegram-originated.
let isTelegramActivity = false;

function resetState(): void {
	toolCalls = [];
	nextIndex = 1;
	serviceMessageHandle = undefined;
	isTelegramActivity = false;
}

export default function (pi: ExtensionAPI) {
	const disposers: Array<() => void> = [];
	let sectionSettings: ExtensionSettings = { ...DEFAULT_SETTINGS };
	let registered = false;

	// ── Activity Handler (safe to register immediately) ──

	const unregisterActivity = registerTelegramActivityHandler({
		id: "pi-telegram-tool-status/activity",
		order: 0,
		handle: async (
			event: TelegramActivityEvent,
			ctx: TelegramActivityContext,
		) => {
			const settings = await loadExtensionSettings();
			if (!settings.enabled) return;

			if (event.type === "agent-start") {
				resetState();
				isTelegramActivity = event.source === "telegram";
				return;
			}

			if (event.type === "tool-start") {
				const detail = formatToolDetail(
					event.toolName,
					(event.args as Record<string, unknown>) ?? {},
				);
				toolCalls.push({
					index: nextIndex++,
					toolName: event.toolName,
					emoji: getToolEmoji(event.toolName),
					detail,
				});

				if (!isTelegramActivity) return;

				const text = buildServiceMessageText(toolCalls);

				if (!serviceMessageHandle) {
					const result = await ctx.send(
						{ text, parseMode: "plain" },
						{ scope: ctx.defaultScope },
					);
					if (result.ok) {
						serviceMessageHandle = {
							handle: result.value,
							source: "telegram",
						};
					}
				} else {
					const handle = serviceMessageHandle.handle as any;
					const editResult = await ctx.edit(handle, {
						text,
						parseMode: "plain",
					});
					if (editResult.ok) {
						serviceMessageHandle = {
							handle: editResult.value,
							source: "telegram",
						};
					}
				}
				return;
			}

			if (event.type === "tool-end") {
				return;
			}

			if (event.type === "agent-settled") {
				if (!isTelegramActivity && toolCalls.length > 0) {
					const settingsNow = await loadExtensionSettings();
					if (settingsNow.proactivePushTools) {
						const text = buildServiceMessageText(toolCalls);
						const result = await ctx.send(
							{ text, parseMode: "plain" },
							{ scope: ctx.defaultScope },
						);
						if (!result.ok) { /* best-effort */ }
					}
				}
				resetState();
				return;
			}
		},
	});
	disposers.push(unregisterActivity);

	// ── Settings Section (deferred to session_start so pi-telegram is ready) ──

	pi.on("session_start", () => {
		if (registered) return;
		registered = true;

		const unregisterSection = registerTelegramSection({
			id: "pi-telegram-tool-status",
			label: "🛠 Tool Status",
			order: 10,
			render: async (ctx) => {
				const s = await loadExtensionSettings();
				sectionSettings = s;
				return {
					text: `<b>🛠 Tool Status</b>\n\nShows a live service message listing tools used by the agent during each Telegram prompt.\n\nStatus: <b>${s.enabled ? "🟢 ON" : "⚫️ OFF"}</b>\nProactive push: <b>${s.proactivePushTools ? "🟢 ON" : "⚫️ OFF"}</b>`,
					parseMode: "html",
					replyMarkup: {
						inline_keyboard: [
							[
								{
									text: "⚙️ Settings",
									callback_data: ctx.callbackData("settings", "open"),
								},
							],
						],
					},
				};
			},
			handleCallback: async (ctx) => {
				return "pass";
			},
			settings: {
				label: "🛠 Tool Status",
				order: 10,
				getLabel: () => {
					return `${sectionSettings.enabled ? "🟢" : "⚫️"} Tool Status`;
				},
				open: async (ctx) => {
					const s = await loadExtensionSettings();
					sectionSettings = s;
					return {
						text: `<b>🛠 Tool Status Settings</b>\n\nConfigure when the extension sends tool-usage messages.`,
						parseMode: "html",
						replyMarkup: {
							inline_keyboard: [
								[
									{
										text: `${s.enabled ? "🟢 ON" : "⚫️ OFF"} Extension enabled`,
										callback_data: ctx.callbackData("toggle-enabled"),
									},
								],
								[
									{
										text: `${s.proactivePushTools ? "🟢 ON" : "⚫️ OFF"} Proactive push tools`,
										callback_data: ctx.callbackData("toggle-proactive"),
									},
								],
							],
						},
					};
				},
				handleCallback: async (ctx) => {
					if (ctx.action === "toggle-enabled") {
						sectionSettings.enabled = !sectionSettings.enabled;
						await saveExtensionSettings(sectionSettings);
						await ctx.answerCallback(
							sectionSettings.enabled ? "Extension enabled" : "Extension disabled",
						);
						const s = sectionSettings;
						await ctx.edit({
							text: `<b>🛠 Tool Status Settings</b>\n\nConfigure when the extension sends tool-usage messages.`,
							parseMode: "html",
							replyMarkup: {
								inline_keyboard: [
									[
										{
											text: `${s.enabled ? "🟢 ON" : "⚫️ OFF"} Extension enabled`,
											callback_data: ctx.callbackData("toggle-enabled"),
										},
									],
									[
										{
											text: `${s.proactivePushTools ? "🟢 ON" : "⚫️ OFF"} Proactive push tools`,
											callback_data: ctx.callbackData("toggle-proactive"),
										},
									],
								],
							},
						});
						return "handled";
					}
					if (ctx.action === "toggle-proactive") {
						sectionSettings.proactivePushTools = !sectionSettings.proactivePushTools;
						await saveExtensionSettings(sectionSettings);
						await ctx.answerCallback(
							sectionSettings.proactivePushTools ? "Proactive push tools enabled" : "Proactive push tools disabled",
						);
						const s = sectionSettings;
						await ctx.edit({
							text: `<b>🛠 Tool Status Settings</b>\n\nConfigure when the extension sends tool-usage messages.`,
							parseMode: "html",
							replyMarkup: {
								inline_keyboard: [
									[
										{
											text: `${s.enabled ? "🟢 ON" : "⚫️ OFF"} Extension enabled`,
											callback_data: ctx.callbackData("toggle-enabled"),
										},
									],
									[
										{
											text: `${s.proactivePushTools ? "🟢 ON" : "⚫️ OFF"} Proactive push tools`,
											callback_data: ctx.callbackData("toggle-proactive"),
										},
									],
								],
							},
						});
						return "handled";
					}
					return "pass";
				},
			},
		});
		disposers.push(unregisterSection);
	});

	// ── Cleanup ──

	pi.on("session_shutdown", () => {
		resetState();
		for (const dispose of disposers) dispose();
		registered = false;
	});
}
