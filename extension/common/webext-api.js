(function (global) {
  const rawApi =
    typeof global.browser !== "undefined"
      ? global.browser
      : typeof global.chrome !== "undefined"
        ? global.chrome
        : null;

  if (!rawApi) {
    throw new Error("AutoDOM: WebExtension API is not available.");
  }

  const CALLBACK_LAST_ERROR_APIS = new Set([
    "sendMessage",
    "get",
    "getCurrent",
    "getLastFocused",
    "query",
    "create",
    "update",
    "remove",
    "reload",
    "goBack",
    "goForward",
    "executeScript",
    "insertCSS",
    "removeCSS",
    "attach",
    "detach",
    "sendCommand",
  ]);

  function getLastError() {
    try {
      return rawApi.runtime && rawApi.runtime.lastError
        ? rawApi.runtime.lastError
        : null;
    } catch (_) {
      return null;
    }
  }

  function toErrorMessage(error, fallback) {
    if (!error) return fallback || "Unknown extension API error";
    if (typeof error === "string") return error;
    if (typeof error.message === "string") return error.message;
    try {
      return String(error);
    } catch (_) {
      return fallback || "Unknown extension API error";
    }
  }

  function isThenable(value) {
    return (
      value &&
      (typeof value === "object" || typeof value === "function") &&
      typeof value.then === "function"
    );
  }

  function callMethod(context, methodName, args) {
    if (!context || typeof context[methodName] !== "function") {
      return Promise.reject(
        new Error(`AutoDOM: extension method not available: ${methodName}`),
      );
    }

    const method = context[methodName];

    try {
      if (typeof global.browser !== "undefined") {
        const result = method.apply(context, args);
        return isThenable(result) ? result : Promise.resolve(result);
      }

      return new Promise((resolve, reject) => {
        let settled = false;

        const callback = (...callbackArgs) => {
          if (settled) return;
          settled = true;

          const lastError = getLastError();
          if (lastError) {
            reject(new Error(toErrorMessage(lastError)));
            return;
          }

          if (callbackArgs.length === 0) {
            resolve(undefined);
          } else if (callbackArgs.length === 1) {
            resolve(callbackArgs[0]);
          } else {
            resolve(callbackArgs);
          }
        };

        const shouldUseCallback = CALLBACK_LAST_ERROR_APIS.has(methodName);

        if (shouldUseCallback) {
          method.apply(context, [...args, callback]);
          return;
        }

        const result = method.apply(context, args);
        if (isThenable(result)) {
          result.then(resolve, reject);
        } else {
          const lastError = getLastError();
          if (lastError) {
            reject(new Error(toErrorMessage(lastError)));
            return;
          }
          resolve(result);
        }
      });
    } catch (error) {
      return Promise.reject(new Error(toErrorMessage(error)));
    }
  }

  function wrapNamespace(namespace) {
    if (!namespace) return namespace;

    return new Proxy(namespace, {
      get(target, prop, receiver) {
        if (prop === "__raw") return target;

        const value = Reflect.get(target, prop, receiver);

        if (typeof value === "function") {
          return (...args) => callMethod(target, prop, args);
        }

        if (value && typeof value === "object") {
          return wrapNamespace(value);
        }

        return value;
      },
    });
  }

  function addListener(eventObject, listener) {
    if (!eventObject || typeof eventObject.addListener !== "function") {
      throw new Error("AutoDOM: event target does not support addListener.");
    }
    eventObject.addListener(listener);
  }

  function removeListener(eventObject, listener) {
    if (!eventObject || typeof eventObject.removeListener !== "function") {
      return;
    }
    eventObject.removeListener(listener);
  }

  function hasListener(eventObject, listener) {
    if (!eventObject || typeof eventObject.hasListener !== "function") {
      return false;
    }
    return eventObject.hasListener(listener);
  }

  function sendMessage(message, options) {
    const runtime = rawApi.runtime;
    if (!runtime || typeof runtime.sendMessage !== "function") {
      return Promise.reject(
        new Error("AutoDOM: runtime.sendMessage is not available."),
      );
    }

    const args = [message];
    if (typeof options !== "undefined") args.push(options);
    return callMethod(runtime, "sendMessage", args);
  }

  function sendTabMessage(tabId, message, options) {
    const tabs = rawApi.tabs;
    if (!tabs || typeof tabs.sendMessage !== "function") {
      return Promise.reject(
        new Error("AutoDOM: tabs.sendMessage is not available."),
      );
    }

    const args = [tabId, message];
    if (typeof options !== "undefined") args.push(options);
    return callMethod(tabs, "sendMessage", args);
  }

  function storageGet(area, keys) {
    const storageArea = rawApi.storage && rawApi.storage[area];
    if (!storageArea || typeof storageArea.get !== "function") {
      return Promise.reject(
        new Error(`AutoDOM: storage.${area}.get is not available.`),
      );
    }
    return callMethod(storageArea, "get", [keys]);
  }

  function storageSet(area, items) {
    const storageArea = rawApi.storage && rawApi.storage[area];
    if (!storageArea || typeof storageArea.set !== "function") {
      return Promise.reject(
        new Error(`AutoDOM: storage.${area}.set is not available.`),
      );
    }
    return callMethod(storageArea, "set", [items]);
  }

  function storageRemove(area, keys) {
    const storageArea = rawApi.storage && rawApi.storage[area];
    if (!storageArea || typeof storageArea.remove !== "function") {
      return Promise.reject(
        new Error(`AutoDOM: storage.${area}.remove is not available.`),
      );
    }
    return callMethod(storageArea, "remove", [keys]);
  }

  function storageClear(area) {
    const storageArea = rawApi.storage && rawApi.storage[area];
    if (!storageArea || typeof storageArea.clear !== "function") {
      return Promise.reject(
        new Error(`AutoDOM: storage.${area}.clear is not available.`),
      );
    }
    return callMethod(storageArea, "clear", []);
  }

  function isFirefox() {
    const runtime = rawApi.runtime;
    const hasGeckoId =
      !!(
        runtime &&
        runtime.getManifest &&
        runtime.getManifest().browser_specific_settings &&
        runtime.getManifest().browser_specific_settings.gecko
      );

    const ua =
      typeof navigator !== "undefined" && navigator.userAgent
        ? navigator.userAgent
        : "";

    return hasGeckoId || /firefox/i.test(ua);
  }

  function isChromium() {
    return !isFirefox();
  }

  function getBrowserInfo() {
    const runtime = rawApi.runtime;
    if (runtime && typeof runtime.getBrowserInfo === "function") {
      return callMethod(runtime, "getBrowserInfo", []);
    }

    return Promise.resolve({
      name: isFirefox() ? "Firefox" : "Chromium",
      vendor: "",
      version: "",
      buildID: "",
    });
  }

  async function injectScript(details) {
    const scripting = rawApi.scripting;
    if (scripting && typeof scripting.executeScript === "function") {
      return callMethod(scripting, "executeScript", [details]);
    }

    return Promise.reject(
      new Error("AutoDOM: scripting.executeScript is not available."),
    );
  }

  async function sendDebuggerCommand(target, method, commandParams) {
    const debuggerApi = rawApi.debugger;
    if (!debuggerApi || typeof debuggerApi.sendCommand !== "function") {
      return Promise.reject(
        new Error("AutoDOM: debugger.sendCommand is not available."),
      );
    }
    return callMethod(debuggerApi, "sendCommand", [
      target,
      method,
      commandParams || {},
    ]);
  }

  const api = {
    raw: rawApi,
    browser: wrapNamespace(rawApi),

    runtime: wrapNamespace(rawApi.runtime),
    tabs: wrapNamespace(rawApi.tabs),
    storage: wrapNamespace(rawApi.storage),
    scripting: wrapNamespace(rawApi.scripting),
    debugger: wrapNamespace(rawApi.debugger),
    commands: wrapNamespace(rawApi.commands),
    action: wrapNamespace(rawApi.action),

    sendMessage,
    sendTabMessage,

    storageGet,
    storageSet,
    storageRemove,
    storageClear,

    addListener,
    removeListener,
    hasListener,

    callMethod,
    wrapNamespace,

    injectScript,
    sendDebuggerCommand,

    getLastError,
    getBrowserInfo,
    isFirefox,
    isChromium,
  };

  global.AutoDOMWebExt = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
