// e2e helpers for what only a person does: a click on the site, and an approval window actually looked at.

/** Runs `fn(...args)` in the page with user activation, as if right after a click, and returns its result. */
export async function afterClick(page, fn, ...args) {
  const cdp = await page.createCDPSession();
  try {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(${fn.toString()})(...${JSON.stringify(args)})`,
      userGesture: true,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** Makes an approval window count as seen: focus, pointer moves, then the delay its buttons wait for. */
export async function lookAt(page) {
  const cdp = await page.createCDPSession();
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 150));
  await page.mouse.move(40, 120).catch(() => undefined);
  await page.mouse.move(60, 140).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1000));
}
