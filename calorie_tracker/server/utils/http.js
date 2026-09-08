export async function fetchJson(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function allSettledMap(items, fn) {
  const results = await Promise.allSettled(items.map(fn));
  return results.map((result, index) => ({
    item: items[index],
    ok: result.status === "fulfilled",
    value: result.status === "fulfilled" ? result.value : null,
    error: result.status === "rejected" ? result.reason : null
  }));
}
