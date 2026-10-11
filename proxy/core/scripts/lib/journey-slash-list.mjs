export async function slashList({ term, capture }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model", 30000);
  await term.send("/");
  await new Promise((r) => setTimeout(r, 600));
  capture("lista /");
  for (let i = 0; i < 6; i++) { await term.send("\x1b[6~"); }
  await new Promise((r) => setTimeout(r, 400));
  capture("lista / pagina");
}
