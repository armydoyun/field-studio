// Browser regression helper. The callback is synchronous so real rendering cannot interleave
// with controlled animation frames. Restore the browser APIs even when an assertion throws.
export function withFrameClock(view, run) {
  const realFrame = view.requestAnimationFrame, realCancel = view.cancelAnimationFrame;
  const ownNow = Object.getOwnPropertyDescriptor(view.performance, "now");
  const pending = new Map();
  let frameId = 0, now = 1000;
  const step = elapsed => {
    now = 1000 + elapsed;
    // Requests made during this frame belong to the next frame. Cancellation takes effect
    // even if another callback in this batch cancels one that has not run yet.
    for (const id of [...pending.keys()]) {
      const callback = pending.get(id);
      pending.delete(id);
      callback?.(now);
    }
  };
  try {
    Object.defineProperty(view.performance, "now", { configurable: true, value: () => now });
    view.requestAnimationFrame = callback => { const id = --frameId; pending.set(id, callback); return id; };
    view.cancelAnimationFrame = id => { if (id < 0) pending.delete(id); else realCancel.call(view, id); };
    return run({ step, pendingCount: () => pending.size });
  } finally {
    view.requestAnimationFrame = realFrame;
    view.cancelAnimationFrame = realCancel;
    if (ownNow) Object.defineProperty(view.performance, "now", ownNow);
    else delete view.performance.now;
    for (const callback of pending.values()) realFrame.call(view, callback);
  }
}
