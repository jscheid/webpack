/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

"use strict";

const { SyncWaterfallHook } = require("tapable");
const { ConcatSource } = require("webpack-sources");
const Compilation = require("../Compilation");
const HotUpdateChunk = require("../HotUpdateChunk");
const RuntimeGlobals = require("../RuntimeGlobals");
const Template = require("../Template");
const JavascriptModulesPlugin = require("../javascript/JavascriptModulesPlugin");
const JsonpChunkLoadingRuntimeModule = require("./JsonpChunkLoadingRuntimeModule");
const { getEntryInfo, needEntryDeferringCode } = require("./JsonpHelpers");

/** @typedef {import("../Chunk")} Chunk */
/** @typedef {import("../Compilation")} Compilation */
/** @typedef {import("../Compiler")} Compiler */

/**
 * @typedef {Object} JsonpCompilationPluginHooks
 * @property {SyncWaterfallHook<[string, Chunk, string]>} jsonpScript
 * @property {SyncWaterfallHook<[string, Chunk, string]>} linkPreload
 * @property {SyncWaterfallHook<[string, Chunk, string]>} linkPrefetch
 * @property {SyncWaterfallHook<[string, any]>} mutateTag
 */

/** @type {WeakMap<Compilation, JsonpCompilationPluginHooks>} */
const compilationHooksMap = new WeakMap();

class JsonpTemplatePlugin {
	/**
	 * @param {Compilation} compilation the compilation
	 * @returns {JsonpCompilationPluginHooks} hooks
	 */
	static getCompilationHooks(compilation) {
		if (!(compilation instanceof Compilation)) {
			throw new TypeError(
				"The 'compilation' argument must be an instance of Compilation"
			);
		}
		let hooks = compilationHooksMap.get(compilation);
		if (hooks === undefined) {
			hooks = {
				jsonpScript: new SyncWaterfallHook(["source", "chunk", "hash"]),
				linkPreload: new SyncWaterfallHook(["source", "chunk", "hash"]),
				linkPrefetch: new SyncWaterfallHook(["source", "chunk", "hash"]),
				mutateTag: new SyncWaterfallHook(["tag", "attributes"])
			};
			compilationHooksMap.set(compilation, hooks);
		}
		return hooks;
	}

	static renderAttributes(varName, attributes) {
		return Array.prototype.concat.apply(
			[],
			Object.entries(attributes).map(([key, valueCondition]) => {
				const setter = `${varName}.${key} = ${valueCondition[0]};`;
				return valueCondition.length > 1
					? [`if (${valueCondition[1]}) {`, Template.indent(setter), "}"]
					: [setter];
			})
		);
	}

	/**
	 * @param {Compiler} compiler the compiler instance
	 * @returns {void}
	 */
	apply(compiler) {
		compiler.hooks.thisCompilation.tap("JsonpTemplatePlugin", compilation => {
			const hooks = JavascriptModulesPlugin.getCompilationHooks(compilation);
			hooks.renderChunk.tap("JsonpTemplatePlugin", (modules, renderContext) => {
				const { chunk, chunkGraph, runtimeTemplate } = renderContext;
				const hotUpdateChunk = chunk instanceof HotUpdateChunk ? chunk : null;
				const globalObject = runtimeTemplate.outputOptions.globalObject;
				const source = new ConcatSource();
				const runtimeModules = chunkGraph.getChunkRuntimeModulesInOrder(chunk);
				const runtimePart =
					runtimeModules.length > 0 &&
					Template.renderChunkRuntimeModules(runtimeModules, renderContext);
				if (hotUpdateChunk) {
					const jsonpFunction = runtimeTemplate.outputOptions.hotUpdateFunction;
					source.add(`${globalObject}[${JSON.stringify(jsonpFunction)}](`);
					source.add(`${JSON.stringify(chunk.id)},`);
					source.add(modules);
					if (runtimePart) {
						source.add(",\n");
						source.add(runtimePart);
					}
					source.add(")");
				} else {
					const jsonpFunction = runtimeTemplate.outputOptions.jsonpFunction;
					source.add(
						`(${globalObject}[${JSON.stringify(
							jsonpFunction
						)}] = ${globalObject}[${JSON.stringify(
							jsonpFunction
						)}] || []).push([`
					);
					source.add(`${JSON.stringify(chunk.ids)},`);
					source.add(modules);
					const entries = getEntryInfo(chunkGraph, chunk);
					const entriesPart =
						entries.length > 0 && `,${JSON.stringify(entries)}`;
					if (entriesPart || runtimePart) {
						source.add(entriesPart || ",0");
					}
					if (runtimePart) {
						source.add(",\n");
						source.add(runtimePart);
					}
					source.add("])");
				}
				return source;
			});
			hooks.chunkHash.tap(
				"JsonpTemplatePlugin",
				(chunk, hash, { chunkGraph, runtimeTemplate }) => {
					if (chunk.hasRuntime()) return;
					hash.update("JsonpTemplatePlugin");
					hash.update("1");
					hash.update(JSON.stringify(getEntryInfo(chunkGraph, chunk)));
					hash.update(`${runtimeTemplate.outputOptions.jsonpFunction}`);
					hash.update(`${runtimeTemplate.outputOptions.hotUpdateFunction}`);
					hash.update(`${runtimeTemplate.outputOptions.globalObject}`);
				}
			);

			const {
				jsonpScript,
				linkPreload,
				linkPrefetch,
				mutateTag
			} = JsonpTemplatePlugin.getCompilationHooks(compilation);
			const { runtimeTemplate } = compilation;

			jsonpScript.tap("JsonpTemplatePlugin", (_, chunk, hash) => {
				const {
					crossOriginLoading,
					chunkLoadTimeout,
					jsonpScriptType
				} = compilation.outputOptions;

				const [tagName, attributes] = mutateTag.call(JSON.stringify("script"), {
					...(jsonpScriptType
						? { type: [JSON.stringify(jsonpScriptType)] }
						: {}),
					charset: [JSON.stringify("utf-8")],
					timeout: [JSON.stringify(String(chunkLoadTimeout / 1000))],
					nonce: [RuntimeGlobals.scriptNonce, RuntimeGlobals.scriptNonce],
					src: ["url"],
					...(crossOriginLoading
						? {
								crossOrigin: [
									JSON.stringify(crossOriginLoading),
									"script.src.indexOf(window.location.origin + '/') !== 0"
								]
						  }
						: {}),
					onload: "onScriptComplete",
					onerror: "onScriptComplete"
				});

				return Template.asString([
					`var script = document.createElement(${tagName});`,
					"var onScriptComplete;",
					"// create error before stack unwound to get useful stacktrace later",
					"var error = new Error();",
					"onScriptComplete = " +
						runtimeTemplate.basicFunction(
							"event",
							Template.asString([
								`onScriptComplete = ${runtimeTemplate.basicFunction("", "")}`,
								"// avoid mem leaks in IE.",
								"script.onerror = script.onload = null;",
								"clearTimeout(timeout);",
								"var reportError = loadingEnded();",
								"if(reportError) {",
								Template.indent([
									"var errorType = event && (event.type === 'load' ? 'missing' : event.type);",
									"var realSrc = event && event.target && event.target.src;",
									"error.message = 'Loading chunk ' + chunkId + ' failed.\\n(' + errorType + ': ' + realSrc + ')';",
									"error.name = 'ChunkLoadError';",
									"error.type = errorType;",
									"error.request = realSrc;",
									"reportError(error);"
								]),
								"}"
							])
						),
					";",
					`var timeout = setTimeout(${runtimeTemplate.basicFunction(
						"",
						"onScriptComplete({ type: 'timeout', target: script })"
					)}, ${chunkLoadTimeout});`,
					...JsonpTemplatePlugin.renderAttributes("script", attributes)
				]);
			});
			linkPreload.tap("JsonpTemplatePlugin", (_, chunk, hash) => {
				const {
					crossOriginLoading,
					jsonpScriptType
				} = compilation.outputOptions;

				const [tagName, attributes] = mutateTag.call(JSON.stringify("link"), {
					...(jsonpScriptType
						? { type: [JSON.stringify(jsonpScriptType)] }
						: {}),
					charset: [JSON.stringify("utf-8")],
					nonce: [RuntimeGlobals.scriptNonce, RuntimeGlobals.scriptNonce],
					rel: [JSON.stringify("preload")],
					as: [JSON.stringify("script")],
					href: [
						`${RuntimeGlobals.publicPath} + ${RuntimeGlobals.getChunkScriptFilename}(chunkId)`
					],
					...(crossOriginLoading
						? {
								crossOrigin: [
									JSON.stringify(crossOriginLoading),
									"link.href.indexOf(window.location.origin + '/') !== 0"
								]
						  }
						: {})
				});

				return Template.asString([
					`var link = document.createElement(${tagName});`,
					...JsonpTemplatePlugin.renderAttributes("link", attributes)
				]);
			});
			linkPrefetch.tap("JsonpTemplatePlugin", (_, chunk, hash) => {
				const { crossOriginLoading } = compilation.outputOptions;

				const [tagName, attributes] = mutateTag.call(JSON.stringify("link"), {
					nonce: [RuntimeGlobals.scriptNonce, RuntimeGlobals.scriptNonce],
					rel: [JSON.stringify("prefetch")],
					as: [JSON.stringify("script")],
					href: [
						`${RuntimeGlobals.publicPath} + ${RuntimeGlobals.getChunkScriptFilename}(chunkId)`
					],
					...(crossOriginLoading
						? {
								crossOrigin: [JSON.stringify(crossOriginLoading)]
						  }
						: {})
				});

				return Template.asString([
					`var link = document.createElement(${tagName});`,
					...JsonpTemplatePlugin.renderAttributes("link", attributes)
				]);
			});

			const onceForChunkSet = new WeakSet();
			const handler = (chunk, set) => {
				if (onceForChunkSet.has(chunk)) return;
				onceForChunkSet.add(chunk);
				set.add(RuntimeGlobals.moduleFactoriesAddOnly);
				set.add(RuntimeGlobals.hasOwnProperty);
				compilation.addRuntimeModule(
					chunk,
					new JsonpChunkLoadingRuntimeModule(
						set,
						jsonpScript,
						linkPreload,
						linkPrefetch
					)
				);
			};
			compilation.hooks.runtimeRequirementInTree
				.for(RuntimeGlobals.ensureChunkHandlers)
				.tap("JsonpTemplatePlugin", handler);
			compilation.hooks.runtimeRequirementInTree
				.for(RuntimeGlobals.hmrDownloadUpdateHandlers)
				.tap("JsonpTemplatePlugin", handler);
			compilation.hooks.runtimeRequirementInTree
				.for(RuntimeGlobals.hmrDownloadManifest)
				.tap("JsonpTemplatePlugin", handler);

			compilation.hooks.runtimeRequirementInTree
				.for(RuntimeGlobals.ensureChunkHandlers)
				.tap("JsonpTemplatePlugin", (chunk, set) => {
					set.add(RuntimeGlobals.publicPath);
					set.add(RuntimeGlobals.getChunkScriptFilename);
				});
			compilation.hooks.runtimeRequirementInTree
				.for(RuntimeGlobals.hmrDownloadUpdateHandlers)
				.tap("JsonpTemplatePlugin", (chunk, set) => {
					set.add(RuntimeGlobals.publicPath);
					set.add(RuntimeGlobals.getChunkUpdateScriptFilename);
					set.add(RuntimeGlobals.moduleCache);
					set.add(RuntimeGlobals.hmrModuleData);
					set.add(RuntimeGlobals.moduleFactoriesAddOnly);
				});
			compilation.hooks.runtimeRequirementInTree
				.for(RuntimeGlobals.hmrDownloadManifest)
				.tap("JsonpTemplatePlugin", (chunk, set) => {
					set.add(RuntimeGlobals.publicPath);
					set.add(RuntimeGlobals.getUpdateManifestFilename);
				});

			compilation.hooks.additionalTreeRuntimeRequirements.tap(
				"JsonpTemplatePlugin",
				(chunk, set) => {
					const withDefer = needEntryDeferringCode(compilation, chunk);
					if (withDefer) {
						set.add(RuntimeGlobals.startup);
						set.add(RuntimeGlobals.startupNoDefault);
						handler(chunk, set);
					}
					if (withDefer) {
						set.add(RuntimeGlobals.require);
					}
				}
			);
		});
	}
}

module.exports = JsonpTemplatePlugin;
