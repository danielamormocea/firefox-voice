/* globals buildSettings */
import * as searching from "./searching.js";
import * as content from "./background/content.js";

export async function activeTab() {
  return (await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  }))[0];
}

export async function makeTabActive(tab) {
  let tabId;
  if (typeof tab === "string" || typeof tab === "number") {
    // then it's a tab ID
    tabId = tab;
    tab = await browser.tabs.get(tabId);
  } else {
    tabId = tab.id;
  }
  if (!tabId) {
    throw new Error("Cannot make tab active without ID");
  }
  await browser.tabs.update(tabId, { active: true });
  if (!buildSettings.android) {
    await browser.windows.update(tab.windowId, { focused: true });
  }
}

export async function openOrFocusTab(url) {
  const tabs = await browser.tabs.query({ url, currentWindow: true });
  if (tabs.length) {
    return makeTabActive(tabs[0]);
  }

  return createAndLoadTab({ url });
}

export async function loadUrl(tabId, url) {
  await browser.tabs.update(tabId, { url });
  return new Promise((resolve, reject) => {
    function onUpdated(tabId, changeInfo, tab) {
      if (tab.url === url) {
        onUpdatedRemove(onUpdated, tabId);
        resolve(tab);
      }
    }
    onUpdatedListen(onUpdated, tabId);
  });
}

export async function turnOnReaderMode(tabId) {
  if (!tabId) {
    // eslint-disable-next-line require-atomic-updates
    tabId = (await activeTab()).id;
  }
  const tab = await browser.tabs.get(tabId);
  if (tab.url.startsWith("about:reader")) {
    // It's already in reader mode
    return tab;
  }
  return new Promise((resolve, reject) => {
    function onUpdated(tabId, changeInfo, tab) {
      if (tab.url.startsWith("about:reader")) {
        onUpdatedRemove(onUpdated, tabId);
        resolve(tab);
      }
    }
    onUpdatedListen(onUpdated, tabId);
    browser.tabs.toggleReaderMode(tabId).catch(reject);
  });
}

export async function openOrActivateTab(url) {
  if (!url.includes("://")) {
    url = browser.runtime.getURL(url);
  }
  for (const tab of await browser.tabs.query({
    url: [url],
  })) {
    return makeTabActive(tab);
  }
  return browser.tabs.create({
    url,
  });
}

export async function activateTabClickHandler(event) {
  if (event) {
    event.preventDefault();
    await openOrActivateTab(event.target.href);
  }
}

export async function createTab(options = {}) {
  const active = await activeTab();
  if (
    ["about:blank", "about:home", "about:newtab"].includes(active.url) &&
    !(active.status === "loading") &&
    active.title === ""
  ) {
    return browser.tabs.update(options);
  }
  return browser.tabs.create(options);
}

export async function createAndLoadTab(options = {}) {
  const tab = await createTab(options);
  await loadUrl(tab.id, options.url);
  return tab;
}

export async function createTabGoogleLucky(query, options = {}) {
  const searchUrl = searching.googleSearchUrl(query, true);
  const tab =
    !!options.openInTabId && options.openInTabId > -1
      ? await browser.tabs.update(options.openInTabId, { url: searchUrl })
      : await createTab({ url: searchUrl });
  if (options.hide && !buildSettings.android) {
    await browser.tabs.hide(tab.id);
  }
  return new Promise((resolve, reject) => {
    let forceRedirecting = false;
    function onUpdated(tabId, changeInfo, tab) {
      const url = tab.url;
      if (url.startsWith("about:blank")) {
        return;
      }
      const isGoogle = /^https:\/\/[^\/]*\.google\.[^\/]+\/search/.test(url);
      const isRedirect = /^https:\/\/www.google.com\/url\?/.test(url);
      if (!isGoogle || isRedirect) {
        if (isRedirect) {
          if (forceRedirecting) {
            // We're already sending the user to the new URL
            return;
          }
          // This is a URL redirect:
          const params = new URL(url).searchParams;
          const newUrl = params.get("q");
          forceRedirecting = true;
          browser.tabs.update(tab.id, { url: newUrl });
          return;
        }
        // We no longer need to listen for updates:
        onUpdatedRemove(onUpdated, tab.id);
        resolve(tab);
      }
    }
    try {
      onUpdatedListen(onUpdated, tab.id);
    } catch (e) {
      throw new Error(
        `Error in tabs.onUpdated: ${e}, onUpdated type: ${typeof onUpdated}, args: tabId: ${
          tab.id
        } is ${typeof tab.id}`
      );
    }
  });
}

export class TabRemovalWatcher {
  constructor() {
    this.isWatching = false;
    this.onRemoved = this.onRemoved.bind(this);
    this.watching = new Map();
  }

  watch(tabId, callback) {
    if (!this.isWatching) {
      browser.tabs.onRemoved.addListener(this.onRemoved);
    }
    this.watching.set(tabId, callback);
  }

  onRemoved(tabId) {
    const callback = this.watching.get(tabId);
    this.watching.delete(tabId);
    if (!this.watching.size) {
      browser.tabs.onRemoved.removeListener(this.onRemoved);
      this.isWatching = false;
    }
    if (callback) {
      callback(tabId);
    }
  }
}

export class TabDataMap {
  constructor(delay = 0) {
    this.watcher = new TabRemovalWatcher();
    this.onRemoved = this.onRemoved.bind(this);
    this.map = new Map();
    this.delay = delay;
  }
  set(tabId, value) {
    this.watcher.watch(tabId, this.onRemoved);
    this.map.set(tabId, value);
  }
  get(tabId) {
    return this.map.get(tabId);
  }
  delete(tabId) {
    this.map.delete(tabId);
  }
  onRemoved(tabId) {
    if (this.delay) {
      setTimeout(() => {
        this.map.delete(tabId);
      }, this.delay);
    } else {
      this.map.delete(tabId);
    }
  }
}

export function waitForDocumentComplete(tabId) {
  if (!tabId) {
    throw new Error("Bad waitForDocumentComplete(null)");
  }
  return browser.tabs.executeScript(tabId, {
    code: "null",
    runAt: "document_idle",
  });
}

export async function waitForPageToLoadUsingSelector(tabId, options = {}) {
  await content.inject(tabId, "./content/pageLoadChecker.js");
  return browser.tabs.sendMessage(tabId, { type: "isLoaded", options });
}

/** Wrappers for browser.tabs.onUpdated to handle Android compatibility */
export function onUpdatedListen(callback, tabId) {
  if (buildSettings.android) {
    callback.wrappedFunction = (tabId, changeInfo, tab) => {
      if (tab.id !== tabId) {
        return null;
      }
      return callback(tabId, changeInfo, tab);
    };
    return browser.tabs.onUpdated.addListener(callback.wrappedFunction);
  }
  return browser.tabs.onUpdated.addListener(callback, { tabId });
}

export function onUpdatedRemove(callback, tabId) {
  if (buildSettings.android) {
    return browser.tabs.onUpdated.removeListener(callback.wrappedFunction);
  }
  return browser.tabs.onUpdated.removeListener(callback, { tabId });
}
