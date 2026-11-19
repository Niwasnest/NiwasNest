// npm run hash-password  → prompts for a password and prints ADMIN_PASSWORD_HASH (input is not echoed).
import { createInterface } from "node:readline";
import { hashPassword } from "../web/auth";

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => { if (s.includes("Password")) process.stdout.write(s); };
rl.question("Password (min 12 chars): ", (pw) => {
  rl.close();
  process.stdout.write("\n");
  if (pw.length < 12) { console.error("Too short."); process.exit(1); }
  console.log(`ADMIN_PASSWORD_HASH=${hashPassword(pw)}`);
});
