export function onceEffect(effect: () => void): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    try { effect(); } catch { /* chamador governa o estado público */ }
  };
}
