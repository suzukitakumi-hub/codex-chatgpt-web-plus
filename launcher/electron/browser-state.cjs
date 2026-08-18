function browserViewVisible(requestedVisible, surfaceActive, boundsReady = true) {
  return requestedVisible === true && surfaceActive === true && boundsReady === true;
}

function constrainBrowserBounds(bounds, contentSize) {
  const contentWidth = Math.max(1, Math.round(contentSize?.width || 0));
  const contentHeight = Math.max(1, Math.round(contentSize?.height || 0));
  const x = Math.min(contentWidth - 1, Math.max(0, Math.round(bounds.x)));
  const y = Math.min(contentHeight - 1, Math.max(0, Math.round(bounds.y)));
  return {
    x,
    y,
    width: Math.min(contentWidth - x, Math.max(1, Math.round(bounds.width))),
    height: Math.min(contentHeight - y, Math.max(1, Math.round(bounds.height))),
  };
}

function readBrowserNavigationState(contents, fallback) {
  if (!contents || contents.isDestroyed()) return { ...fallback };
  const history = contents.navigationHistory;
  return {
    ...fallback,
    url: contents.getURL() || fallback.url,
    title: contents.getTitle() || fallback.title || "ChatGPT",
    loading: contents.isLoading(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
  };
}

function navigateBrowser(contents, action) {
  const history = contents.navigationHistory;
  if (action === "back") {
    if (history.canGoBack()) history.goBack();
  } else if (action === "forward") {
    if (history.canGoForward()) history.goForward();
  } else if (action === "reload") {
    contents.reload();
  } else {
    throw new Error(`Unknown browser navigation action: ${action}`);
  }
}

// A scheme is only treated as already present when it is followed by "//" (http://, https://,
// file://, chrome://, devtools://, ...) or is one of the no-authority schemes that are dangerous
// specifically because they never use "//" (javascript:, data:, blob:, vbscript:). Anything else
// -- including a bare "host:port" like "localhost:5173", where the part before the colon is not a
// URI scheme at all -- falls through to having "https://" prepended, which is the documented,
// safe behavior for a user typing a bare hostname.
const SCHEME_WITH_AUTHORITY_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const NO_AUTHORITY_SCHEME_PATTERN = /^(javascript|data|blob|vbscript):/i;

function withInferredScheme(candidate) {
  if (SCHEME_WITH_AUTHORITY_PATTERN.test(candidate) || NO_AUTHORITY_SCHEME_PATTERN.test(candidate)) {
    return candidate;
  }
  return `https://${candidate}`;
}

// Validates a user-supplied address-bar string for navigating the HOME browser surface. This is
// the only gate between free-form renderer input and an Electron navigation, so it is
// deliberately an allow-list, not a deny-list: only absolute http:/https: URLs pass. A bare
// hostname (no scheme) is accepted by inferring https:// first, but file:, javascript:, data:,
// blob:, chrome:, devtools:, and every other scheme are rejected outright, however they were
// spelled. Never throws anything but a plain Error with a message safe to show the user.
function validateNavigableUrl(rawValue) {
  if (typeof rawValue !== "string") throw new Error("A URL is required");
  const candidate = rawValue.trim();
  if (!candidate) throw new Error("Enter a URL to navigate to");
  let parsed;
  try {
    parsed = new URL(withInferredScheme(candidate));
  } catch {
    throw new Error(`"${candidate}" is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http:// and https:// links can be opened here, not ${parsed.protocol}`);
  }
  return parsed.toString();
}

module.exports = {
  browserViewVisible,
  constrainBrowserBounds,
  navigateBrowser,
  readBrowserNavigationState,
  validateNavigableUrl,
};
