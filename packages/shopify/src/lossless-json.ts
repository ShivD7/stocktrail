export type LosslessNumber = { readonly kind: 'number'; readonly raw: string };
export type LosslessJson =
  | null
  | boolean
  | string
  | LosslessNumber
  | LosslessJson[]
  | { [key: string]: LosslessJson };

const MAX_DEPTH = 100;

class Parser {
  #index = 0;

  constructor(private readonly source: string) {}

  parse(): LosslessJson {
    const value = this.#parseValue(0);
    this.#skipWhitespace();
    if (this.#index !== this.source.length) throw new Error('Invalid JSON.');
    return value;
  }

  #parseValue(depth: number): LosslessJson {
    if (depth > MAX_DEPTH) throw new Error('Invalid JSON.');
    this.#skipWhitespace();
    const character = this.source[this.#index];
    if (character === '"') return this.#parseString();
    if (character === '{') return this.#parseObject(depth + 1);
    if (character === '[') return this.#parseArray(depth + 1);
    if (character === 't') return this.#parseLiteral('true', true);
    if (character === 'f') return this.#parseLiteral('false', false);
    if (character === 'n') return this.#parseLiteral('null', null);
    if (character === '-' || (character !== undefined && /\d/.test(character))) {
      return this.#parseNumber();
    }
    throw new Error('Invalid JSON.');
  }

  #parseString(): string {
    const start = this.#index;
    this.#index += 1;
    let escaped = false;
    while (this.#index < this.source.length) {
      const character = this.source[this.#index]!;
      if (!escaped && character === '"') {
        this.#index += 1;
        try {
          return JSON.parse(this.source.slice(start, this.#index)) as string;
        } catch {
          throw new Error('Invalid JSON.');
        }
      }
      if (!escaped && character.charCodeAt(0) < 0x20) throw new Error('Invalid JSON.');
      if (!escaped && character === '\\') escaped = true;
      else escaped = false;
      this.#index += 1;
    }
    throw new Error('Invalid JSON.');
  }

  #parseObject(depth: number): { [key: string]: LosslessJson } {
    this.#index += 1;
    const object: { [key: string]: LosslessJson } = Object.create(null) as { [key: string]: LosslessJson };
    const keys = new Set<string>();
    this.#skipWhitespace();
    if (this.source[this.#index] === '}') {
      this.#index += 1;
      return object;
    }
    while (true) {
      this.#skipWhitespace();
      if (this.source[this.#index] !== '"') throw new Error('Invalid JSON.');
      const key = this.#parseString();
      if (keys.has(key)) throw new Error('Invalid JSON.');
      keys.add(key);
      this.#skipWhitespace();
      if (this.source[this.#index] !== ':') throw new Error('Invalid JSON.');
      this.#index += 1;
      object[key] = this.#parseValue(depth);
      this.#skipWhitespace();
      const delimiter = this.source[this.#index];
      if (delimiter === '}') {
        this.#index += 1;
        return object;
      }
      if (delimiter !== ',') throw new Error('Invalid JSON.');
      this.#index += 1;
    }
  }

  #parseArray(depth: number): LosslessJson[] {
    this.#index += 1;
    const array: LosslessJson[] = [];
    this.#skipWhitespace();
    if (this.source[this.#index] === ']') {
      this.#index += 1;
      return array;
    }
    while (true) {
      array.push(this.#parseValue(depth));
      this.#skipWhitespace();
      const delimiter = this.source[this.#index];
      if (delimiter === ']') {
        this.#index += 1;
        return array;
      }
      if (delimiter !== ',') throw new Error('Invalid JSON.');
      this.#index += 1;
    }
  }

  #parseNumber(): LosslessNumber {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.#index));
    if (!match) throw new Error('Invalid JSON.');
    this.#index += match[0].length;
    return { kind: 'number', raw: match[0] };
  }

  #parseLiteral<T extends boolean | null>(literal: string, value: T): T {
    if (!this.source.startsWith(literal, this.#index)) throw new Error('Invalid JSON.');
    this.#index += literal.length;
    return value;
  }

  #skipWhitespace(): void {
    while (this.#index < this.source.length &&
      [' ', '\t', '\r', '\n'].includes(this.source[this.#index]!)) {
      this.#index += 1;
    }
  }
}

export function parseLosslessJson(source: string): LosslessJson {
  return new Parser(source).parse();
}
