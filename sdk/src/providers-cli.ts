import { selectProvider } from "./providers";

try {
  const d = selectProvider("auto");
  for (const p of d.availability) {
    console.log(`${p.provider.padEnd(10)} ${p.available ? "ready" : p.reason}${p.detail ? `  ${p.detail}` : ""}`);
  }
  console.log(`auto       ${d.provider}  ${d.reason}`);
} catch (err: any) {
  console.error(err?.message ?? err);
  process.exit(1);
}
