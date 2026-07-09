// Smooth window reveal. Windows are created hidden so the native window never
// shows before the webview has painted (that pre-paint flash is the "black
// box"). Each window calls revealWindow() once its content is rendered: we wait
// for a real paint, start the enter animation, then ask the backend to show the
// window. If this never runs (e.g. a script error), a backend safety-net still
// shows the main window, and other windows simply stay hidden until retried.

export async function revealWindow() {
  // Two frames guarantees the browser has actually painted the content.
  await new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
  document.querySelectorAll(".win-enter").forEach((el) => el.classList.add("win-in"));
  try {
    await window.__TAURI__.core.invoke("show_self");
  } catch {
    // Non-main windows: harmless. Main window: covered by the backend safety-net.
  }
}
