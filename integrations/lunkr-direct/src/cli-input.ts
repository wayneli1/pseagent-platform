import { createInterface } from "node:readline/promises";

export async function promptLine(label: string, defaultValue = ""): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue === "" ? "" : ` [${defaultValue}]`;
    const value = (await terminal.question(`${label}${suffix}: `)).trim();
    return value || defaultValue;
  } finally {
    terminal.close();
  }
}

export async function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("密码只能在交互式终端中输入");
  }
  process.stdout.write(`${label}: `);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    const characters: string[] = [];
    const restore = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") {
          restore();
          resolve(characters.join(""));
          return;
        }
        if (character === "\u0003") {
          restore();
          reject(new Error("登录已取消"));
          return;
        }
        if (character === "\b" || character === "\u007f") {
          characters.pop();
        } else {
          characters.push(character);
        }
      }
    };
    process.stdin.on("data", onData);
  });
}
