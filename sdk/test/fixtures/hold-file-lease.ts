import { acquireFileLease } from "../../src/file-lease";

const [path, holdMs] = process.argv.slice(2);
if (!path) throw new Error("lock path required");
const lease = await acquireFileLease(path);
console.log("locked");
await new Promise((resolve) => setTimeout(resolve, Number(holdMs ?? 100)));
await lease.release();
