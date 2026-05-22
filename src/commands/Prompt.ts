import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface PromptService {
  prompt(question: string, defaultValue?: string): Promise<string>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
}

let service: PromptService | null = null;

function ensureInteractive(defaultValueProvided: boolean): void {
  if (input.isTTY && output.isTTY) return;
  if (defaultValueProvided) return;
  throw new Error("Interactive prompt requires a TTY.");
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function normalizeConfirm(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "y" || normalized === "yes") return true;
  if (normalized === "n" || normalized === "no") return false;
  return null;
}

const defaultService: PromptService = {
  async prompt(question: string, defaultValue?: string): Promise<string> {
    ensureInteractive(defaultValue !== undefined);
    if (!input.isTTY || !output.isTTY) return defaultValue ?? "";
    const suffix = defaultValue !== undefined ? ` (${defaultValue})` : "";
    const raw = await ask(`${question}${suffix}: `);
    const value = raw.trim();
    if (!value && defaultValue !== undefined) return defaultValue;
    return value;
  },

  async confirm(question: string, defaultValue = false): Promise<boolean> {
    ensureInteractive(true);
    if (!input.isTTY || !output.isTTY) return defaultValue;
    const hint = defaultValue ? " [Y/n] " : " [y/N] ";
    for (;;) {
      const raw = await ask(`${question}${hint}`);
      const trimmed = raw.trim();
      if (!trimmed) return defaultValue;
      const parsed = normalizeConfirm(trimmed);
      if (parsed !== null) return parsed;
      output.write("Please answer yes or no.\n");
    }
  },
};

export function getPromptService(): PromptService {
  return service ?? defaultService;
}

export function setPromptService(next: PromptService | null): void {
  service = next;
}
