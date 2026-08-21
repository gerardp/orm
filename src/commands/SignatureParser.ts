export interface ArgumentDefinition {
  name: string;
  required: boolean;
  variadic: boolean;
  defaultValue?: string;
  description?: string;
}

export interface OptionDefinition {
  name: string;
  type: "string" | "boolean";
  defaultValue?: string;
  description?: string;
}

export interface ParsedSignature {
  name: string;
  args: ArgumentDefinition[];
  options: OptionDefinition[];
}

export function parseSignatureName(signature: string): string {
  return signature.trim().split(/\s+/)[0] ?? "";
}

export function parseSignature(signature: string): ParsedSignature {
  const parts = signature.trim().split(/\s+/);
  const name = parts[0] ?? "";
  const args: ArgumentDefinition[] = [];
  const options: OptionDefinition[] = [];

  for (let i = 1; i < parts.length; i++) {
    // Tokens may span multiple parts when description contains spaces: {arg : the desc}
    let token = parts[i];
    if (token.startsWith("{") && !token.endsWith("}")) {
      while (i + 1 < parts.length && !token.endsWith("}")) {
        token += " " + parts[++i];
      }
    }

    if (!token.startsWith("{") || !token.endsWith("}")) continue;

    const inner = token.slice(1, -1).trim();

    // Split on " : " for optional inline description
    const colonIdx = inner.indexOf(" : ");
    const body = colonIdx === -1 ? inner : inner.slice(0, colonIdx).trim();
    const description = colonIdx === -1 ? undefined : inner.slice(colonIdx + 3).trim() || undefined;

    if (body.startsWith("-")) {
      // Option. A single dash is the short form: `{-f}` is a boolean flag, not
      // a positional argument named "-f" that the runner would then demand.
      const optBody = body.startsWith("--") ? body.slice(2) : body.slice(1);
      const eqIdx = optBody.indexOf("=");
      if (eqIdx === -1) {
        options.push({ name: optBody, type: "boolean", description });
      } else {
        const optName = optBody.slice(0, eqIdx);
        // `{--dir= ./app}` is the same declaration as `{--dir=./app}`; keeping
        // the space made the default value literally " ./app".
        const defaultValue = optBody.slice(eqIdx + 1).trim() || undefined;
        options.push({ name: optName, type: "string", defaultValue, description });
      }
    } else {
      // Argument
      if (body.endsWith("*")) {
        args.push({ name: body.slice(0, -1), required: false, variadic: true, description });
      } else if (body.endsWith("?")) {
        args.push({ name: body.slice(0, -1), required: false, variadic: false, description });
      } else {
        const eqIdx = body.indexOf("=");
        if (eqIdx !== -1) {
          const argName = body.slice(0, eqIdx);
          const defaultValue = body.slice(eqIdx + 1) || undefined;
          args.push({ name: argName, required: false, variadic: false, defaultValue, description });
        } else {
          args.push({ name: body, required: true, variadic: false, description });
        }
      }
    }
  }

  return { name, args, options };
}
